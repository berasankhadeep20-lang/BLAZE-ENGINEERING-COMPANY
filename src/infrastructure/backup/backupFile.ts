import Database from 'better-sqlite3';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppError } from '../../shared/errors';
import type { Db } from '../db/connection';
import { reconcile } from '../db/reconcile';
import { decodeBackup, encodeBackup, sha256, type BackupKind, type BackupManifest, type DataMode } from './format';

export const MODE_KEY = 'app.mode'; // set to DEMO inside demo databases; absent in real ones

export interface CreatedBackup {
  path: string;
  manifest: BackupManifest;
  fileBytes: number;
  fileSha256: string;
}

export interface VerifiedBackup {
  manifest: BackupManifest;
  integrity: 'ok';
  booksAgree: boolean; // every cached stock/balance figure matches its ledger inside the backup
  reconcileIssues: number;
  latestActivityAt: string | null; // the most recent audit entry inside the backup
}

function userTables(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

export function countRows(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of userTables(db)) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
  return out;
}

export function dataMode(db: Db): DataMode {
  const row = db.prepare('SELECT value FROM app_setting WHERE key = ?').get(MODE_KEY) as { value: string } | undefined;
  return row?.value === 'DEMO' ? 'DEMO' : 'REAL';
}

function writeDurably(path: string, data: Buffer): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd); // make sure the bytes are really on disk before we call this finished
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a backup file: a consistent snapshot of the live database (VACUUM INTO, safe while the app is running), compressed, with its manifest.
 * The file is written under a temporary name and renamed only when complete, so a half-written backup never looks like a real one.
 * This does NOT verify the result; use createVerifiedBackup for that.
 */
export function createBackupFile(db: Db, o: { destPath: string; kind: BackupKind; appVersion: string; createdBy: string | null; now: Date }): CreatedBackup {
  if (db.inTransaction) throw new AppError('INVARIANT', 'a backup cannot be taken in the middle of a transaction');
  const work = mkdtempSync(join(tmpdir(), 'blaze-snap-'));
  try {
    const snap = join(work, 'snapshot.sqlite');
    db.prepare('VACUUM INTO ?').run(snap);
    const dbBytes = readFileSync(snap);
    const copy = new Database(snap, { readonly: true, fileMustExist: true });
    let meta: { rowCounts: Record<string, number>; schemaVersion: number; mode: DataMode; businessName: string | null };
    try {
      const setting = (k: string): string | null => (copy.prepare('SELECT value FROM app_setting WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
      meta = {
        rowCounts: countRows(copy),
        schemaVersion: (copy.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v,
        mode: setting(MODE_KEY) === 'DEMO' ? 'DEMO' : 'REAL',
        businessName: setting('business.name'),
      };
    } finally {
      copy.close();
    }
    const { file, manifest } = encodeBackup(
      { format: 'blaze-engineering-backup', formatVersion: 1, createdAt: o.now.toISOString(), appVersion: o.appVersion, schemaVersion: meta.schemaVersion, kind: o.kind, mode: meta.mode, businessName: meta.businessName, createdBy: o.createdBy, rowCounts: meta.rowCounts },
      dbBytes,
    );
    mkdirSync(dirname(o.destPath), { recursive: true });
    const partial = `${o.destPath}.partial`;
    writeDurably(partial, file);
    renameSync(partial, o.destPath);
    return { path: o.destPath, manifest, fileBytes: file.length, fileSha256: sha256(file) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Open a backup file and check it thoroughly, without touching the live data: container and checksums, then unpack it to a temporary database and check that
 * SQLite considers it sound, that the foreign keys hold, that every table has exactly the number of rows the manifest promises, that it was not made by a
 * NEWER version of the program, and whether the books inside agree. If `extractTo` is given the verified database is left there (for restoring).
 */
export function verifyBackupFile(path: string, o: { knownSchemaVersion: number; extractTo?: string }): VerifiedBackup {
  let file: Buffer;
  try {
    file = readFileSync(path);
  } catch {
    throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: it could not be read', { reason: 'unreadable' });
  }
  const { manifest, dbBytes } = decodeBackup(file);
  if (manifest.schemaVersion > o.knownSchemaVersion) {
    throw new AppError('BACKUP_INVALID', 'this backup was made by a newer version of the program; please update the program first', { reason: 'newer', backupSchema: manifest.schemaVersion, knownSchema: o.knownSchemaVersion });
  }
  const work = mkdtempSync(join(tmpdir(), 'blaze-verify-'));
  try {
    const tmp = join(work, 'backup.sqlite');
    writeFileSync(tmp, dbBytes);
    let db: Db;
    try {
      db = new Database(tmp, { readonly: true, fileMustExist: true });
    } catch {
      throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: the data inside is not a database', { reason: 'not a database' });
    }
    try {
      let integrity: unknown;
      let fkProblems: unknown[];
      let counts: Record<string, number>;
      let schema: number;
      try {
        integrity = (db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check;
        fkProblems = db.pragma('foreign_key_check') as unknown[];
        counts = countRows(db);
        schema = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
      } catch {
        throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: the data inside is not a complete database', { reason: 'not a database' });
      }
      if (integrity !== 'ok') throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: the database inside is damaged', { reason: 'integrity', detail: String(integrity) });
      if (fkProblems.length) throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: records inside refer to things that are missing', { reason: 'foreign keys' });
      const expected = manifest.rowCounts;
      const names = new Set([...Object.keys(counts), ...Object.keys(expected)]);
      const off = [...names].filter((t) => counts[t] !== expected[t]);
      if (off.length) throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: its contents do not match its description', { reason: 'row counts', tables: off });
      if (schema !== manifest.schemaVersion) throw new AppError('BACKUP_INVALID', 'this is not a usable backup file: its version information is inconsistent', { reason: 'schema' });
      const issues = reconcile(db).length;
      const latest = (db.prepare('SELECT MAX(at) AS at FROM audit_log').get() as { at: string | null }).at;
      if (o.extractTo) {
        db.close();
        writeFileSync(o.extractTo, dbBytes);
        return { manifest, integrity: 'ok', booksAgree: issues === 0, reconcileIssues: issues, latestActivityAt: latest };
      }
      return { manifest, integrity: 'ok', booksAgree: issues === 0, reconcileIssues: issues, latestActivityAt: latest };
    } finally {
      if (db.open) db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Create a backup AND prove it: re-read the finished file from disk and verify it. If anything is wrong the file is deleted and the attempt fails: success is never claimed otherwise. */
export function createVerifiedBackup(
  db: Db,
  o: { destPath: string; kind: BackupKind; appVersion: string; createdBy: string | null; now: Date; knownSchemaVersion: number; afterWrite?: (path: string) => void },
): { backup: CreatedBackup; verified: VerifiedBackup } {
  let backup: CreatedBackup | undefined;
  try {
    backup = createBackupFile(db, o);
    o.afterWrite?.(backup.path);
    const verified = verifyBackupFile(backup.path, { knownSchemaVersion: o.knownSchemaVersion });
    if (verified.manifest.dbSha256 !== backup.manifest.dbSha256) throw new AppError('BACKUP_FAILED', 'the saved file does not match what was backed up');
    return { backup, verified };
  } catch (e) {
    for (const p of [backup?.path ?? o.destPath, `${o.destPath}.partial`]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* nothing more can be done */
      }
    }
    const why = e instanceof AppError ? e.message : (e as Error).message;
    throw new AppError('BACKUP_FAILED', `the backup could not be completed and was not saved: ${why}`, { cause: why });
  }
}

/** Keep only the newest `keep` backup files in a folder (used for the automatic safety copies). */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.blazebak'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  const removed: string[] = [];
  for (const old of files.slice(keep)) {
    unlinkSync(join(dir, old.f));
    removed.push(old.f);
  }
  return removed;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local time as yyyymmdd-hhmmss, for file names. */
export function fileStamp(d: Date): string {
  return `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A file name in `dir` that does not exist yet (adds -2, -3... if the same second was used twice). */
export function freshFileName(dir: string, base: string, ext: string): string {
  let name = `${base}${ext}`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${String(i)}${ext}`;
  return name;
}

/**
 * The automatic safety copies (before a database upgrade, before a restore): created and verified like any backup, kept in the program's own data folder,
 * and pruned so the folder does not grow forever. If this fails the caller must not go ahead.
 */
export function createSafetyBackup(
  db: Db,
  o: { dir: string; kind: 'PRE_MIGRATION' | 'PRE_RESTORE'; appVersion: string; createdBy: string | null; now: Date; knownSchemaVersion: number; keep?: number },
): CreatedBackup {
  const label = o.kind === 'PRE_RESTORE' ? 'before-restore' : 'before-upgrade';
  const mode = dataMode(db) === 'DEMO' ? '-DEMO' : '';
  mkdirSync(o.dir, { recursive: true });
  const name = freshFileName(o.dir, `blaze${mode}-safety-${label}-${fileStamp(o.now)}`, '.blazebak');
  const { backup } = createVerifiedBackup(db, { destPath: join(o.dir, name), kind: o.kind, appVersion: o.appVersion, createdBy: o.createdBy, now: o.now, knownSchemaVersion: o.knownSchemaVersion });
  pruneBackups(o.dir, o.keep ?? 30);
  return backup;
}
