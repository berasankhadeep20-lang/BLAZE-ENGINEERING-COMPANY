import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import { countRows, createSafetyBackup, createVerifiedBackup, dataMode, fileStamp, freshFileName, verifyBackupFile, type VerifiedBackup } from '../../infrastructure/backup/backupFile';
import { sha256, type BackupKind, type BackupManifest } from '../../infrastructure/backup/format';
import { cancelPendingRestore, pendingPaths, readPendingRestore, stageRestore, type RestoreMarker } from '../../infrastructure/backup/restoreStaging';
import type { AuthService } from '../auth/authService';
import { readSettings } from '../settings/settingsService';

export interface BackupPaths {
  dbPath: string; // the live database file (restore needs a real file)
  dataDir: string; // the program's own folder, for automatic safety copies
}

export interface BackupServiceOptions {
  appVersion: string;
  knownSchemaVersion: number; // the newest database version this program knows
  paths?: BackupPaths;
  clock?: Clock;
  /** Test hook: runs after a backup file is written and before it is verified. */
  hooks?: { afterWrite?: (path: string) => void };
}

export interface BackupSummary {
  createdAt: string;
  kind: BackupKind;
  appVersion: string;
  schemaVersion: number;
  mode: 'REAL' | 'DEMO';
  businessName: string | null;
  createdBy: string | null;
  rowCounts: Record<string, number>;
  booksAgree: boolean;
  latestActivityAt: string | null;
}

export interface BackupResult {
  path: string;
  fileName: string;
  folder: string;
  bytes: number;
  sha256: string;
  summary: BackupSummary;
}

export interface BackupStatus {
  mode: 'REAL' | 'DEMO';
  folder: string | null;
  lastBackup: { at: string; path: string; sizeBytes: number | null; daysAgo: number } | null;
  reminderDays: number;
  reminderDue: boolean; // true when there is no backup yet, or the last one is as old as the reminder setting
  lastFailure: { at: string; reason: string } | null; // only shown while it is newer than the last good backup
  pendingRestore: RestoreMarker | null;
}

export interface BackupHistoryRow {
  id: number;
  at: string;
  kind: string;
  path: string;
  sizeBytes: number | null;
  sha256: string | null;
  verified: boolean;
  fileStillThere: boolean;
  userName: string | null;
}

export interface RestorePreview {
  file: { path: string; bytes: number; sha256: string };
  backup: BackupSummary;
  rows: { label: string; inBackup: number; now: number }[];
  /** What is in the live data but NOT in the backup, and would be lost. */
  willBeLost: { label: string; count: number }[];
  warnings: string[];
  explanation: string;
  confirmToken: string; // valid for 15 minutes, for this file only
}

const KEY_TABLES: [string, string][] = [
  ['user', 'user accounts'], ['item', 'items'], ['customer', 'customers'], ['supplier', 'suppliers'], ['sale_bill', 'sale bills'], ['purchase_bill', 'purchase bills'],
  ['customer_payment', 'customer payments'], ['supplier_payment', 'supplier payments'], ['stock_movement', 'stock movements'], ['audit_log', 'audit entries'],
];
const LOSS_TABLES: [string, string][] = [
  ['sale_bill', 'sale bills'], ['purchase_bill', 'purchase bills'], ['customer_payment', 'customer payments'], ['supplier_payment', 'supplier payments'],
  ['stock_movement', 'stock movements'], ['customer', 'customers'], ['item', 'items'],
];
const TOKEN_MINUTES = 15;

const summarize = (m: BackupManifest, v: VerifiedBackup): BackupSummary => ({
  createdAt: m.createdAt, kind: m.kind, appVersion: m.appVersion, schemaVersion: m.schemaVersion, mode: m.mode, businessName: m.businessName, createdBy: m.createdBy,
  rowCounts: m.rowCounts, booksAgree: v.booksAgree, latestActivityAt: v.latestActivityAt,
});

/**
 * Owner-controlled backup and restore. "Back up now" reports success only after the file has been written, read back from disk and verified.
 * Restore REPLACES all current data (merging financial records would be unsafe): it is inspected first, needs an explicit confirmation token,
 * takes a verified safety copy of the current data before doing anything, and completes when the program next starts (see restoreStaging).
 */
export class BackupService {
  private readonly uow: UnitOfWork;
  private readonly clock: Clock;
  private readonly tokens = new Map<string, { path: string; fileSha256: string; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly opts: BackupServiceOptions,
  ) {
    this.clock = opts.clock ?? systemClock;
    this.uow = new UnitOfWork(db, this.clock);
  }

  // ------------------------------------------------------------------ status and history
  status(token: string): BackupStatus {
    this.auth.authorizeAny(token, ['backup.create', 'backup.restore']);
    const settings = readSettings(this.db);
    const now = this.clock.now().getTime();
    const last = this.db.prepare("SELECT at, path, size_bytes FROM backup_log WHERE kind = 'MANUAL' AND verified = 1 ORDER BY id DESC LIMIT 1").get() as { at: string; path: string; size_bytes: number | null } | undefined;
    const daysAgo = last ? Math.max(0, Math.floor((now - new Date(last.at).getTime()) / 86_400_000)) : null;
    const failure = this.db.prepare("SELECT at, reason, detail_json FROM audit_log WHERE action = 'BACKUP_FAILED' ORDER BY id DESC LIMIT 1").get() as { at: string; reason: string | null; detail_json: string | null } | undefined;
    const failureIsCurrent = !!failure && (!last || failure.at > last.at);
    return {
      mode: dataMode(this.db),
      folder: settings.backupFolder,
      lastBackup: last && daysAgo !== null ? { at: last.at, path: last.path, sizeBytes: last.size_bytes, daysAgo } : null,
      reminderDays: settings.backupReminderDays,
      reminderDue: settings.backupReminderDays > 0 && (!last || (daysAgo ?? 0) >= settings.backupReminderDays),
      lastFailure: failureIsCurrent && failure ? { at: failure.at, reason: failure.reason ?? 'unknown' } : null,
      pendingRestore: this.opts.paths ? readPendingRestore(this.opts.paths.dbPath) : null,
    };
  }

  history(token: string, limit = 50): BackupHistoryRow[] {
    this.auth.authorizeAny(token, ['backup.create', 'backup.restore']);
    const rows = this.db
      .prepare(`SELECT l.id, l.at, l.kind, l.path, l.size_bytes, l.sha256, l.verified, u.display_name AS user_name FROM backup_log l LEFT JOIN user u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?`)
      .all(Math.max(1, limit)) as { id: number; at: string; kind: string; path: string; size_bytes: number | null; sha256: string | null; verified: number; user_name: string | null }[];
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, path: r.path, sizeBytes: r.size_bytes, sha256: r.sha256, verified: r.verified === 1, fileStillThere: existsSync(r.path), userName: r.user_name }));
  }

  // ------------------------------------------------------------------ back up now
  /** Save a verified backup in `folder` (or the remembered folder). Throws BACKUP_FAILED, leaving no file behind, if anything is wrong. */
  create(token: string, input: { folder?: string } = {}): BackupResult {
    const user = this.auth.authorize(token, 'backup.create');
    const settings = readSettings(this.db);
    const folder = (input.folder ?? settings.backupFolder ?? '').trim();
    if (!folder) throw new AppError('VALIDATION', 'choose a folder to save the backup in (for example a USB drive)');
    const now = this.clock.now();
    const mode = dataMode(this.db);
    const fail = (e: unknown): never => {
      const reason = e instanceof AppError ? e.message : (e as Error).message;
      this.uow.run(this.auth.actorFor(user), (ctx) => recordAudit(ctx, { action: 'BACKUP_FAILED', entityType: 'backup', reason, detail: { folder } }));
      throw e instanceof AppError && e.code === 'BACKUP_FAILED' ? e : new AppError('BACKUP_FAILED', `the backup could not be completed and was not saved: ${reason}`, { cause: reason });
    };
    let name: string;
    try {
      mkdirSync(folder, { recursive: true });
      name = freshFileName(folder, `blaze${mode === 'DEMO' ? '-DEMO' : ''}-backup-${fileStamp(now)}`, '.blazebak');
    } catch (e) {
      return fail(e);
    }
    let result: ReturnType<typeof createVerifiedBackup>;
    try {
      result = createVerifiedBackup(this.db, {
        destPath: join(folder, name), kind: 'MANUAL', appVersion: this.opts.appVersion, createdBy: user.displayName, now, knownSchemaVersion: this.opts.knownSchemaVersion,
        ...(this.opts.hooks?.afterWrite ? { afterWrite: this.opts.hooks.afterWrite } : {}),
      });
    } catch (e) {
      return fail(e);
    }
    const { backup, verified } = result;
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      ctx.db
        .prepare("INSERT INTO backup_log (at, kind, path, sha256, size_bytes, verified, user_id) VALUES (?, 'MANUAL', ?, ?, ?, 1, ?)")
        .run(ctx.now, backup.path, backup.fileSha256, backup.fileBytes, user.id);
      ctx.db
        .prepare(`INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES ('backup.folder', ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(folder, user.id, ctx.now);
      recordAudit(ctx, { action: 'BACKUP_CREATE', entityType: 'backup', detail: { path: backup.path, bytes: backup.fileBytes, sha256: backup.fileSha256, schemaVersion: backup.manifest.schemaVersion, booksAgree: verified.booksAgree } });
    });
    return { path: backup.path, fileName: name, folder, bytes: backup.fileBytes, sha256: backup.fileSha256, summary: summarize(backup.manifest, verified) };
  }

  // ------------------------------------------------------------------ checking a file
  /** Check any backup file without restoring it. Throws BACKUP_INVALID (with the reason) if it cannot be trusted. */
  verify(token: string, path: string): BackupSummary {
    this.auth.authorizeAny(token, ['backup.create', 'backup.restore']);
    const v = verifyBackupFile(path, { knownSchemaVersion: this.opts.knownSchemaVersion });
    return summarize(v.manifest, v);
  }

  // ------------------------------------------------------------------ restoring
  /** Step 1 of a restore: check the file and show exactly what restoring would replace and lose. Changes nothing. */
  inspect(token: string, path: string): RestorePreview {
    this.auth.authorize(token, 'backup.restore');
    this.requireRestorable();
    const v = verifyBackupFile(path, { knownSchemaVersion: this.opts.knownSchemaVersion });
    this.requireSameMode(v.manifest.mode);
    const fileBytes = readFileSync(path);
    const fileSha = sha256(fileBytes);

    const nowCounts = countRows(this.db);
    const inBackup = v.manifest.rowCounts;
    const rows = KEY_TABLES.map(([t, label]) => ({ label, inBackup: inBackup[t] ?? 0, now: nowCounts[t] ?? 0 }));
    const willBeLost = LOSS_TABLES.flatMap(([t, label]) => ((nowCounts[t] ?? 0) > (inBackup[t] ?? 0) ? [{ label, count: (nowCounts[t] ?? 0) - (inBackup[t] ?? 0) }] : []));
    const warnings: string[] = [];
    if (willBeLost.length) warnings.push(`Everything recorded since this backup was made will be lost: ${willBeLost.map((x) => `${String(x.count)} ${x.label}`).join(', ')}.`);
    if (!v.booksAgree) warnings.push('The stock and balances inside this backup do not all agree with its own records. It is still your data as it was, but ask for help before relying on it.');
    if (v.manifest.schemaVersion < this.opts.knownSchemaVersion) warnings.push('This backup is from an older version of the program. It will be brought up to date automatically after the restore (a safety copy is taken first).');
    if (v.manifest.kind !== 'MANUAL') warnings.push(`This is an automatic safety copy (${v.manifest.kind === 'PRE_RESTORE' ? 'taken before a restore' : 'taken before a program upgrade'}).`);

    const confirmToken = randomBytes(16).toString('hex');
    this.tokens.set(confirmToken, { path, fileSha256: fileSha, expires: this.clock.now().getTime() + TOKEN_MINUTES * 60_000 });
    return {
      file: { path, bytes: fileBytes.length, sha256: fileSha },
      backup: summarize(v.manifest, v),
      rows, willBeLost, warnings,
      explanation:
        `Restoring REPLACES all the data in the program (users, settings, items, customers, suppliers, bills, payments, stock and the audit history) with the data in this backup, made on ${v.manifest.createdAt}. ` +
        'It does not merge: nothing recorded after the backup is kept. A verified safety copy of your current data is saved first, and your current data is also kept aside, so a restore can be undone. ' +
        'The program will restart to finish, and everyone will have to sign in again, with the accounts and passwords as they were in the backup.',
      confirmToken,
    };
  }

  /** Step 2: after the owner has confirmed. Saves a safety copy of the current data (and stops if that fails), then stages the restore; it completes at the next start. */
  restore(token: string, path: string, confirmToken: string): { staged: true; restartRequired: true; safetyBackup: { path: string; bytes: number; sha256: string }; message: string } {
    const user = this.auth.authorize(token, 'backup.restore');
    const paths = this.requireRestorable();
    const t = this.tokens.get(confirmToken);
    if (!t || t.path !== path || t.expires < this.clock.now().getTime() || t.fileSha256 !== sha256(readFileSync(path))) {
      throw new AppError('VALIDATION', 'please check the backup again and confirm; the confirmation has expired or does not match this file');
    }
    this.tokens.delete(confirmToken);

    const p = pendingPaths(paths.dbPath);
    cancelPendingRestore(paths.dbPath); // replace any earlier, unfinished staging
    let verified: VerifiedBackup;
    try {
      verified = verifyBackupFile(path, { knownSchemaVersion: this.opts.knownSchemaVersion, extractTo: p.partial });
    } catch (e) {
      cancelPendingRestore(paths.dbPath);
      throw e;
    }
    try {
      this.requireSameMode(verified.manifest.mode);
      const now = this.clock.now();
      const safety = createSafetyBackup(this.db, {
        dir: join(paths.dataDir, 'backups', 'before-restore'), kind: 'PRE_RESTORE', appVersion: this.opts.appVersion, createdBy: user.displayName, now,
        knownSchemaVersion: this.opts.knownSchemaVersion, keep: 50,
      });
      const marker: RestoreMarker = {
        stagedAt: now.toISOString(), restoredBy: `${user.displayName} (${user.username})`, fromFile: path, backupCreatedAt: verified.manifest.createdAt,
        backupAppVersion: verified.manifest.appVersion, backupSchemaVersion: verified.manifest.schemaVersion, mode: verified.manifest.mode, dbSha256: verified.manifest.dbSha256,
        preRestoreBackup: { path: safety.path, sha256: safety.fileSha256, bytes: safety.fileBytes, createdAt: safety.manifest.createdAt },
      };
      stageRestore(paths.dbPath, p.partial, marker);
      this.uow.run(this.auth.actorFor(user), (ctx) =>
        recordAudit(ctx, { action: 'BACKUP_RESTORE_STAGED', entityType: 'backup', detail: { fromFile: path, backupCreatedAt: verified.manifest.createdAt, safetyBackup: safety.path } }),
      );
      return {
        staged: true, restartRequired: true, safetyBackup: { path: safety.path, bytes: safety.fileBytes, sha256: safety.fileSha256 },
        message: 'The backup is ready to be restored. The program must restart to finish; your current data has been saved first and nothing has been changed yet.',
      };
    } catch (e) {
      cancelPendingRestore(paths.dbPath);
      throw e instanceof AppError ? e : new AppError('BACKUP_FAILED', `the restore could not be prepared and nothing was changed: ${(e as Error).message}`);
    }
  }

  pendingRestore(token: string): RestoreMarker | null {
    this.auth.authorizeAny(token, ['backup.create', 'backup.restore']);
    return this.opts.paths ? readPendingRestore(this.opts.paths.dbPath) : null;
  }

  /** Change of mind before the restart: remove the staged restore. */
  cancelRestore(token: string): void {
    const user = this.auth.authorize(token, 'backup.restore');
    const paths = this.requireRestorable();
    if (!readPendingRestore(paths.dbPath)) return;
    cancelPendingRestore(paths.dbPath);
    this.uow.run(this.auth.actorFor(user), (ctx) => recordAudit(ctx, { action: 'BACKUP_RESTORE_CANCELLED', entityType: 'backup' }));
  }

  // ------------------------------------------------------------------ internals
  private requireRestorable(): BackupPaths {
    const paths = this.opts.paths;
    if (!paths || paths.dbPath === ':memory:' || paths.dbPath === '') throw new AppError('INVARIANT', 'restore needs the database to be a file on disk');
    return paths;
  }

  /** Real data and demo data must never be mixed. */
  private requireSameMode(backupMode: 'REAL' | 'DEMO'): void {
    const mine = dataMode(this.db);
    if (backupMode !== mine) {
      throw new AppError('CONFLICT', backupMode === 'DEMO' ? 'this is a backup of DEMO data and cannot be restored into your real business data' : 'this is a backup of real business data and cannot be restored into demo mode', { backupMode, currentMode: mine });
    }
  }
}
