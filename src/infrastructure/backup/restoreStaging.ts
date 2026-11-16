/**
 * Restoring replaces the whole database, and SQLite cannot safely swap its file under a running program. So a restore is done in two crash-safe halves:
 *   1. STAGE (while running): the verified database is written next to the live one as `<db>.restore-pending`, and a small marker file is written LAST (that is the commit point).
 *   2. APPLY (at the next start, before the database is opened): the live files are moved aside (never deleted) and the staged file is renamed into place.
 * A crash at any point leaves either the old data or the new data in place, never a mixture; each half can be repeated safely.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sha256, type DataMode } from './format';
import type { Db } from '../db/connection';
import { recordAudit } from '../db/audit';
import { UnitOfWork } from '../db/unitOfWork';
import { systemClock, type Clock } from '../../shared/clock';

export interface RestoreMarker {
  stagedAt: string;
  restoredBy: string;
  fromFile: string;
  backupCreatedAt: string;
  backupAppVersion: string;
  backupSchemaVersion: number;
  mode: DataMode;
  dbSha256: string;
  preRestoreBackup: { path: string; sha256: string; bytes: number; createdAt: string } | null;
}

export interface AppliedRestore extends RestoreMarker {
  appliedAt: string;
  replacedDatabase: string | null; // where the data that was in use before the restore was moved to
}

export const pendingPaths = (dbPath: string): { db: string; partial: string; marker: string; applied: string } => ({
  db: `${dbPath}.restore-pending`,
  partial: `${dbPath}.restore-pending.partial`,
  marker: `${dbPath}.restore-pending.json`,
  applied: `${dbPath}.restore-applied.json`,
});

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** Half 1. `extractedPath` must be the verified database already written beside the live one (same folder, so the rename is atomic). */
export function stageRestore(dbPath: string, extractedPath: string, marker: RestoreMarker): void {
  const p = pendingPaths(dbPath);
  renameSync(extractedPath, p.db);
  writeJsonAtomic(p.marker, marker); // the commit point
}

export function readPendingRestore(dbPath: string): RestoreMarker | null {
  const p = pendingPaths(dbPath);
  if (!existsSync(p.db)) return null;
  return readJson<RestoreMarker>(p.marker);
}

export function cancelPendingRestore(dbPath: string): void {
  const p = pendingPaths(dbPath);
  for (const f of [p.db, p.partial, p.marker, `${p.marker}.tmp`]) rmSync(f, { force: true });
}

const stampName = (d: Date): string => d.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

/** Half 2: run at start-up BEFORE the database is opened. Returns what happened so the program can tell the user. */
export function applyPendingRestore(dbPath: string, now: Date = new Date()): { applied: boolean; discarded?: string } {
  const p = pendingPaths(dbPath);
  const marker = readJson<RestoreMarker>(p.marker);
  const haveDb = existsSync(p.db);

  if (!marker) {
    // a staged file without its marker was never committed: throw it away
    if (haveDb) rmSync(p.db, { force: true });
    rmSync(p.partial, { force: true });
    return { applied: false };
  }
  if (!haveDb) {
    // the staged database is gone but the marker is not: a previous start-up got as far as renaming it into place. Finish the paperwork.
    if (!existsSync(p.applied)) writeJsonAtomic(p.applied, { ...marker, appliedAt: now.toISOString(), replacedDatabase: null } satisfies AppliedRestore);
    rmSync(p.marker, { force: true });
    return { applied: true };
  }
  if (sha256(readFileSync(p.db)) !== marker.dbSha256) {
    cancelPendingRestore(dbPath);
    return { applied: false, discarded: 'the restored data was damaged before it could be put in place; nothing was changed' };
  }

  const dir = dirname(dbPath);
  const aside = join(dir, 'replaced-by-restore');
  const stamp = stampName(now);
  let replaced: string | null = null;
  for (const suffix of ['', '-wal', '-shm']) {
    const live = `${dbPath}${suffix}`;
    if (!existsSync(live)) continue;
    mkdirSync(aside, { recursive: true });
    const target = join(aside, `${basename(dbPath)}${suffix}.${stamp}`);
    renameSync(live, target);
    if (suffix === '') replaced = target;
  }
  renameSync(p.db, dbPath);
  writeJsonAtomic(p.applied, { ...marker, appliedAt: now.toISOString(), replacedDatabase: replaced } satisfies AppliedRestore);
  rmSync(p.marker, { force: true });
  return { applied: true };
}

/**
 * Run after the restored database has been opened and migrated: record in IT that a restore happened (the audit entry written before the swap belongs to the
 * old data), and re-add the safety copy to its backup history. Returns true if there was something to record.
 */
export function finishPendingRestore(db: Db, dbPath: string, clock: Clock = systemClock): boolean {
  const p = pendingPaths(dbPath);
  const a = readJson<AppliedRestore>(p.applied);
  if (!a) return false;
  new UnitOfWork(db, clock).run(null, (ctx) => {
    if (a.preRestoreBackup) {
      ctx.db
        .prepare("INSERT INTO backup_log (at, kind, path, sha256, size_bytes, verified, user_id) VALUES (?, 'PRE_RESTORE', ?, ?, ?, 1, NULL)")
        .run(a.preRestoreBackup.createdAt, a.preRestoreBackup.path, a.preRestoreBackup.sha256, a.preRestoreBackup.bytes);
    }
    recordAudit(ctx, {
      action: 'BACKUP_RESTORE', entityType: 'backup',
      detail: {
        restoredBy: a.restoredBy, fromFile: a.fromFile, backupCreatedAt: a.backupCreatedAt, backupAppVersion: a.backupAppVersion, stagedAt: a.stagedAt, appliedAt: a.appliedAt,
        previousDataKeptAt: a.replacedDatabase, safetyBackup: a.preRestoreBackup?.path ?? null,
      },
    });
  });
  rmSync(p.applied, { force: true });
  return true;
}
