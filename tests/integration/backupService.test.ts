import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../../src/application/backup/backupService';
import { sha256 } from '../../src/infrastructure/backup/format';
import { verifyBackupFile } from '../../src/infrastructure/backup/backupFile';
import { applyPendingRestore, pendingPaths } from '../../src/infrastructure/backup/restoreStaging';
import { openAppDatabase } from '../../src/infrastructure/backup/startup';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { LATEST_SCHEMA, MIGRATIONS_DIR, cleanupWorlds, count, dumpAll, fileWorld, openWorld, scratch, sellMore, type FileWorld } from '../helpers/fileWorld';

afterEach(cleanupWorlds);

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const backup = (w: FileWorld): NonNullable<FileWorld['s']['backup']> => {
  if (!w.s.backup) throw new Error('no backup service');
  return w.s.backup;
};
/** "Restart the program": close the database and open the file again exactly as the program does at start-up. */
async function restart(w: FileWorld): Promise<FileWorld> {
  w.db.close();
  return { ...(await openWorld(w.root, w.clock)), ids: w.ids };
}
async function employee(w: FileWorld, name: string, permissions: string[]): Promise<string> {
  await w.s.users.createEmployee(w.token, { username: name, displayName: name, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await w.s.auth.login(name, 'temp-pass-123');
  await w.s.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return token;
}
const pendingFiles = (w: FileWorld): string[] => readdirSync(join(w.root, 'data')).filter((f) => f.includes('restore-pending') || f.includes('restore-applied'));

describe('Back up now', () => {
  it('saves a verified file, logs it, remembers the folder, and the status says so', async () => {
    const w = await fileWorld();
    const r = backup(w).create(w.token, { folder: w.backupDir });
    expect(r.fileName).toMatch(/^blaze-backup-\d{8}-\d{6}\.blazebak$/);
    expect(existsSync(r.path)).toBe(true);
    expect(r.bytes).toBe(readFileSync(r.path).length);
    expect(r.sha256).toBe(sha256(readFileSync(r.path)));
    expect(r.summary).toMatchObject({ mode: 'REAL', kind: 'MANUAL', booksAgree: true, createdBy: 'Shop Owner', businessName: 'TEST ENGINEERING CO', schemaVersion: LATEST_SCHEMA });
    expect(w.db.prepare("SELECT kind, verified, size_bytes, user_id FROM backup_log").all()).toEqual([{ kind: 'MANUAL', verified: 1, size_bytes: r.bytes, user_id: 1 }]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_CREATE'").get()).toEqual({ n: 1 });
    const st = backup(w).status(w.token);
    expect(st).toMatchObject({ mode: 'REAL', folder: w.backupDir, reminderDue: false, lastFailure: null, pendingRestore: null });
    expect(st.lastBackup).toMatchObject({ path: r.path, daysAgo: 0, sizeBytes: r.bytes });
  });

  it('asks for a folder the first time, then remembers it; two backups in one second get different names', async () => {
    const w = await fileWorld();
    expect(codeOf(() => backup(w).create(w.token))).toBe('VALIDATION');
    const a = backup(w).create(w.token, { folder: w.backupDir });
    const b = backup(w).create(w.token); // remembered folder
    expect(b.folder).toBe(w.backupDir);
    expect(b.fileName).not.toBe(a.fileName);
    expect(readdirSync(w.backupDir).filter((f) => f.endsWith('.blazebak'))).toHaveLength(2);
  });

  it('reminds when there is no backup, or the last one is as old as the reminder setting (0 = never remind)', async () => {
    const w = await fileWorld();
    expect(backup(w).status(w.token)).toMatchObject({ lastBackup: null, reminderDays: 7, reminderDue: true });
    backup(w).create(w.token, { folder: w.backupDir });
    expect(backup(w).status(w.token).reminderDue).toBe(false);
    w.clock.advanceMinutes(60 * 24 * 6);
    expect(backup(w).status(w.token)).toMatchObject({ reminderDue: false });
    w.clock.advanceMinutes(60 * 24);
    expect(backup(w).status(w.token)).toMatchObject({ reminderDue: true });
    expect(backup(w).status(w.token).lastBackup?.daysAgo).toBe(7);
    w.s.settings.update(w.token, { backupReminderDays: 0 });
    expect(backup(w).status(w.token).reminderDue).toBe(false);
    w.s.settings.update(w.token, { backupReminderDays: 3 });
    expect(backup(w).status(w.token).reminderDue).toBe(true);
    expect(codeOf(() => w.s.settings.update(w.token, { backupReminderDays: 366 }))).toBe('VALIDATION');
    expect(codeOf(() => w.s.settings.update(w.token, { backupReminderDays: -1 }))).toBe('VALIDATION');
  });

  it('never says it worked when it did not: a file damaged after writing leaves nothing behind and a failure on record', async () => {
    const w = await fileWorld();
    const bad = new BackupService(w.db, w.s.auth, {
      appVersion: 'test', knownSchemaVersion: LATEST_SCHEMA, paths: { dbPath: w.dbPath, dataDir: w.dataDir }, clock: w.clock, hooks: { afterWrite: (p) => truncateSync(p, 50) },
    });
    expect(codeOf(() => bad.create(w.token, { folder: w.backupDir }))).toBe('BACKUP_FAILED');
    expect(readdirSync(w.backupDir)).toEqual([]); // the folder exists but holds nothing, not even a half-written file
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM backup_log').get()).toEqual({ n: 0 });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_CREATE'").get()).toEqual({ n: 0 });
    const st = bad.status(w.token);
    expect(st.lastBackup).toBeNull();
    expect(st.lastFailure?.reason).toMatch(/not saved/);
    w.clock.advanceMinutes(1);
    backup(w).create(w.token, { folder: w.backupDir });
    expect(backup(w).status(w.token).lastFailure).toBeNull(); // a good backup clears the warning
  });

  it('fails clearly if the folder cannot be used (for example a USB drive that was removed), and logs it', async () => {
    const w = await fileWorld();
    const root = scratch();
    writeFileSync(join(root, 'not-a-folder'), 'x');
    expect(codeOf(() => backup(w).create(w.token, { folder: join(root, 'not-a-folder', 'sub') }))).toBe('BACKUP_FAILED');
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM backup_log').get()).toEqual({ n: 0 });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_FAILED'").get()).toEqual({ n: 1 });
    expect(backup(w).status(w.token).lastFailure).not.toBeNull();
  });

  it('who may do what: create, restore, and look are separate permissions', async () => {
    const w = await fileWorld();
    const file = backup(w).create(w.token, { folder: w.backupDir }).path;
    const nobody = await employee(w, 'nobody', ['sale.create']);
    const maker = await employee(w, 'maker', ['backup.create']);
    const restorer = await employee(w, 'restorer', ['backup.restore']);
    for (const t of [nobody]) {
      expect(codeOf(() => backup(w).create(t, { folder: w.backupDir }))).toBe('PERMISSION_DENIED');
      expect(codeOf(() => backup(w).status(t))).toBe('PERMISSION_DENIED');
      expect(codeOf(() => backup(w).history(t))).toBe('PERMISSION_DENIED');
      expect(codeOf(() => backup(w).verify(t, file))).toBe('PERMISSION_DENIED');
    }
    expect(codeOf(() => backup(w).create(maker, { folder: w.backupDir }))).toBe('NO_ERROR');
    expect(codeOf(() => backup(w).status(maker))).toBe('NO_ERROR');
    expect(codeOf(() => backup(w).verify(maker, file))).toBe('NO_ERROR');
    expect(codeOf(() => backup(w).inspect(maker, file))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => backup(w).cancelRestore(maker))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => backup(w).create(restorer, { folder: w.backupDir }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => backup(w).history(restorer))).toBe('NO_ERROR');
    expect(codeOf(() => backup(w).inspect(restorer, file))).toBe('NO_ERROR');
  });

  it('keeps a history, notices a file that is gone, and can check any backup file', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    w.clock.advanceMinutes(1);
    const b = backup(w).create(w.token);
    expect(backup(w).history(w.token).map((r) => [r.path, r.kind, r.verified, r.fileStillThere, r.userName])).toEqual([[b.path, 'MANUAL', true, true, 'Shop Owner'], [a.path, 'MANUAL', true, true, 'Shop Owner']]);
    const gone = readFileSync(a.path);
    writeFileSync(join(scratch(), 'x'), gone);
    renameSync(a.path, `${a.path}.moved`);
    expect(backup(w).history(w.token).find((r) => r.path === a.path)?.fileStillThere).toBe(false);
    expect(backup(w).verify(w.token, b.path)).toMatchObject({ booksAgree: true, mode: 'REAL' });
    const junk = join(scratch(), 'junk.blazebak');
    writeFileSync(junk, 'not a backup');
    expect(codeOf(() => backup(w).verify(w.token, junk))).toBe('BACKUP_INVALID');
  });
});

describe('restoring', () => {
  it('replaces EVERYTHING with the backup, keeps the old data aside, and records what happened; every record comes back exactly', async () => {
    const w = await fileWorld();
    const before = dumpAll(w.db);
    const a = backup(w).create(w.token, { folder: w.backupDir });
    await employee(w, 'later.clerk', ['sale.create']); // a user added after the backup
    sellMore(w);
    expect(count(w.db, 'sale_bill')).toBe(2);

    const pv = backup(w).inspect(w.token, a.path);
    expect(pv.explanation).toMatch(/REPLACES all the data/);
    expect(pv.explanation).toMatch(/does not merge/);
    expect(pv.rows.find((r) => r.label === 'sale bills')).toEqual({ label: 'sale bills', inBackup: 1, now: 2 });
    expect(pv.rows.find((r) => r.label === 'user accounts')).toEqual({ label: 'user accounts', inBackup: 1, now: 2 });
    expect(pv.willBeLost).toEqual(expect.arrayContaining([{ label: 'sale bills', count: 1 }, { label: 'stock movements', count: 1 }]));
    expect(pv.warnings[0]).toMatch(/lost: .*1 sale bills/);
    expect(pv.confirmToken).toMatch(/^[0-9a-f]{32}$/);
    expect(count(w.db, 'sale_bill')).toBe(2); // inspecting changes nothing

    const r = backup(w).restore(w.token, a.path, pv.confirmToken);
    expect(r).toMatchObject({ staged: true, restartRequired: true });
    expect(verifyBackupFile(r.safetyBackup.path, { knownSchemaVersion: LATEST_SCHEMA }).manifest).toMatchObject({ kind: 'PRE_RESTORE', rowCounts: expect.objectContaining({ sale_bill: 2, user: 2 }) });
    expect(count(w.db, 'sale_bill')).toBe(2); // nothing is replaced until the restart
    expect(backup(w).status(w.token).pendingRestore).toMatchObject({ fromFile: a.path, restoredBy: 'Shop Owner (owner)' });
    expect(existsSync(pendingPaths(w.dbPath).db)).toBe(true);

    const w2 = await restart(w);
    expect(w2.opened).toMatchObject({ restoreApplied: true, restoreRecorded: true, restoreDiscarded: null });
    expect(count(w2.db, 'sale_bill')).toBe(1);
    expect(count(w2.db, 'user')).toBe(1); // the user added later is gone, as the backup did not have them
    expect(pendingFiles(w2)).toEqual([]);

    const after = dumpAll(w2.db);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const t of Object.keys(before)) {
      if (t === 'audit_log' || t === 'backup_log') continue;
      expect(after[t], `table ${t} must come back exactly`).toEqual(before[t]);
    }
    expect(after.audit_log?.slice(0, before.audit_log?.length)).toEqual(before.audit_log); // the audit history is preserved...
    // ...plus one entry for the restore itself, and the owner's sign-in after the restart
    expect(after.audit_log?.slice(before.audit_log?.length).map((r) => (JSON.parse(r) as { action: string }).action)).toEqual(['BACKUP_RESTORE', 'LOGIN']);
    const note = w2.db.prepare("SELECT detail_json, user_id FROM audit_log WHERE action = 'BACKUP_RESTORE'").get() as { detail_json: string; user_id: number | null };
    expect(note.user_id).toBeNull();
    expect(JSON.parse(note.detail_json)).toMatchObject({ restoredBy: 'Shop Owner (owner)', fromFile: a.path, safetyBackup: r.safetyBackup.path });
    expect(after.backup_log?.slice(0, before.backup_log?.length)).toEqual(before.backup_log);
    expect(w2.db.prepare("SELECT kind, verified, path FROM backup_log WHERE kind = 'PRE_RESTORE'").get()).toEqual({ kind: 'PRE_RESTORE', verified: 1, path: r.safetyBackup.path });

    // the data that was in use before is kept, not deleted
    const aside = join(w.root, 'data', 'replaced-by-restore');
    const oldFile = readdirSync(aside).find((f) => /^blaze\.sqlite\.\d+$/.test(f));
    expect(oldFile).toBeDefined();
    const old = new Database(join(aside, oldFile ?? ''), { readonly: true });
    expect((old.prepare('SELECT COUNT(*) AS n FROM sale_bill').get() as { n: number }).n).toBe(2);
    old.close();
  });

  it('can be undone: the safety copy taken before a restore brings the newer data back', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    sellMore(w);
    const r1 = backup(w).restore(w.token, a.path, backup(w).inspect(w.token, a.path).confirmToken);
    const w2 = await restart(w);
    expect(count(w2.db, 'sale_bill')).toBe(1);

    const pv = backup(w2).inspect(w2.token, r1.safetyBackup.path);
    expect(pv.backup.kind).toBe('PRE_RESTORE');
    expect(pv.warnings.join(' ')).toMatch(/automatic safety copy \(taken before a restore\)/);
    backup(w2).restore(w2.token, r1.safetyBackup.path, pv.confirmToken);
    const w3 = await restart(w2);
    expect(count(w3.db, 'sale_bill')).toBe(2);
    expect(w3.s.stock.checkIntegrity(w3.token)).toEqual([]);
  });

  it('needs the confirmation that inspecting gave: for this file, once, within 15 minutes, and only if the file is unchanged', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    w.clock.advanceMinutes(1);
    const b = backup(w).create(w.token);
    const fresh = (path: string): string => backup(w).inspect(w.token, path).confirmToken;
    const refused = (token: string, path: string): ErrorCode | 'NO_ERROR' => codeOf(() => backup(w).restore(w.token, path, token));

    expect(refused('not-a-token', a.path)).toBe('VALIDATION');
    expect(refused(fresh(a.path), b.path)).toBe('VALIDATION'); // a confirmation for a different file
    const expired = fresh(a.path);
    w.clock.advanceMinutes(16);
    expect(refused(expired, a.path)).toBe('VALIDATION');
    const changed = fresh(a.path);
    copyFileSync(b.path, a.path); // the file was swapped after it was inspected
    expect(refused(changed, a.path)).toBe('VALIDATION');
    expect(pendingFiles(w)).toEqual([]); // none of the refusals staged anything

    const good = fresh(b.path);
    expect(refused(good, b.path)).toBe('NO_ERROR');
    expect(refused(good, b.path)).toBe('VALIDATION'); // a confirmation works once
  });

  it('refuses files that are damaged, incomplete or from a newer program, naming no restore', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    const junk = join(scratch(), 'junk.blazebak');
    writeFileSync(junk, 'this is not a backup');
    expect(codeOf(() => backup(w).inspect(w.token, junk))).toBe('BACKUP_INVALID');
    const cut = join(scratch(), 'cut.blazebak');
    writeFileSync(cut, readFileSync(a.path).subarray(0, 300));
    expect(codeOf(() => backup(w).inspect(w.token, cut))).toBe('BACKUP_INVALID');
    expect(codeOf(() => backup(w).inspect(w.token, join(scratch(), 'missing.blazebak')))).toBe('BACKUP_INVALID');
    const older = new BackupService(w.db, w.s.auth, { appVersion: 'old', knownSchemaVersion: LATEST_SCHEMA - 1, paths: { dbPath: w.dbPath, dataDir: w.dataDir }, clock: w.clock });
    let err: AppError | undefined;
    try {
      older.inspect(w.token, a.path);
    } catch (e) {
      err = e as AppError;
    }
    expect(err).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(err?.message).toMatch(/newer version of the program/);
    expect(pendingFiles(w)).toEqual([]);
  });

  it('stops if the safety copy of the current data cannot be saved, and changes nothing', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    const root = scratch();
    writeFileSync(join(root, 'blocker'), 'x');
    const broken = new BackupService(w.db, w.s.auth, { appVersion: 'test', knownSchemaVersion: LATEST_SCHEMA, paths: { dbPath: w.dbPath, dataDir: join(root, 'blocker', 'data') }, clock: w.clock });
    const pv = broken.inspect(w.token, a.path);
    expect(codeOf(() => broken.restore(w.token, a.path, pv.confirmToken))).toBe('BACKUP_FAILED');
    expect(pendingFiles(w)).toEqual([]);
    expect(count(w.db, 'sale_bill')).toBe(1);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_RESTORE_STAGED'").get()).toEqual({ n: 0 });
  });

  it('can be cancelled before the restart, and the cancel is on the record', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    backup(w).restore(w.token, a.path, backup(w).inspect(w.token, a.path).confirmToken);
    expect(backup(w).pendingRestore(w.token)).not.toBeNull();
    backup(w).cancelRestore(w.token);
    expect(backup(w).pendingRestore(w.token)).toBeNull();
    expect(pendingFiles(w)).toEqual([]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_RESTORE_CANCELLED'").get()).toEqual({ n: 1 });
    backup(w).cancelRestore(w.token); // nothing pending: nothing happens
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_RESTORE_CANCELLED'").get()).toEqual({ n: 1 });
    const w2 = await restart(w);
    expect(w2.opened.restoreApplied).toBe(false);
  });

  it('is only possible when the database is a real file', async () => {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    const noPaths = new BackupService(w.db, w.s.auth, { appVersion: 'test', knownSchemaVersion: LATEST_SCHEMA, clock: w.clock });
    expect(codeOf(() => noPaths.inspect(w.token, a.path))).toBe('INVARIANT');
  });
});

describe('a restore survives a crash at any step (data is old or new, never a mixture)', () => {
  async function staged(): Promise<{ w: FileWorld; newerBills: number; liveSha: () => string }> {
    const w = await fileWorld();
    const a = backup(w).create(w.token, { folder: w.backupDir });
    sellMore(w);
    backup(w).restore(w.token, a.path, backup(w).inspect(w.token, a.path).confirmToken);
    w.db.close();
    return { w, newerBills: 2, liveSha: () => sha256(readFileSync(w.dbPath)) };
  }

  it('crash after the live files were moved aside but before the new one was put in place', async () => {
    const { w } = await staged();
    renameSync(w.dbPath, `${w.dbPath}.moved-by-crash`);
    for (const suf of ['-wal', '-shm']) if (existsSync(`${w.dbPath}${suf}`)) renameSync(`${w.dbPath}${suf}`, `${w.dbPath}${suf}.moved-by-crash`);
    expect(applyPendingRestore(w.dbPath)).toEqual({ applied: true });
    const w2 = await openWorld(w.root, w.clock);
    expect(count(w2.db, 'sale_bill')).toBe(1);
    expect(w2.opened.restoreRecorded).toBe(true);
  });

  it('crash after the new file was put in place but before the paperwork: running it again changes nothing', async () => {
    const { w, liveSha } = await staged();
    const p = pendingPaths(w.dbPath);
    const marker = readFileSync(p.marker);
    expect(applyPendingRestore(w.dbPath)).toEqual({ applied: true });
    const sha = liveSha();
    writeFileSync(p.marker, marker); // the crash: the pending marker is still there, but the staged file is gone
    expect(applyPendingRestore(w.dbPath)).toEqual({ applied: true });
    expect(liveSha()).toBe(sha); // the restored data was not touched again
    expect(existsSync(p.marker)).toBe(false);
    const w2 = await openWorld(w.root, w.clock);
    expect(count(w2.db, 'sale_bill')).toBe(1);
    expect(w2.opened.restoreRecorded).toBe(true);
  });

  it('a staged file whose marker was never written is thrown away, and the live data stays', async () => {
    const w = await fileWorld();
    sellMore(w);
    w.db.close();
    writeFileSync(pendingPaths(w.dbPath).db, 'half-written junk');
    const sha = sha256(readFileSync(w.dbPath));
    expect(applyPendingRestore(w.dbPath)).toEqual({ applied: false });
    expect(existsSync(pendingPaths(w.dbPath).db)).toBe(false);
    expect(sha256(readFileSync(w.dbPath))).toBe(sha);
    expect(count((await openWorld(w.root, w.clock)).db, 'sale_bill')).toBe(2);
  });

  it('a staged file that was damaged is discarded, and the live data stays', async () => {
    const { w, liveSha } = await staged();
    const sha = liveSha();
    writeFileSync(pendingPaths(w.dbPath).db, Buffer.concat([readFileSync(pendingPaths(w.dbPath).db), Buffer.from('x')]));
    const r = applyPendingRestore(w.dbPath);
    expect(r.applied).toBe(false);
    expect(r.discarded).toMatch(/nothing was changed/);
    expect(liveSha()).toBe(sha);
    expect(pendingFiles(w)).toEqual([]);
    expect(count((await openWorld(w.root, w.clock)).db, 'sale_bill')).toBe(2);
  });
});

describe('start-up: a safety copy before any database upgrade', () => {
  function olderMigrations(upTo: number): string {
    const dir = join(scratch(), 'older-migrations');
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort().slice(0, upTo)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    return dir;
  }
  const open = (root: string, migrationsDir: string, dataDir = join(root, 'data')): ReturnType<typeof openAppDatabase> =>
    openAppDatabase({ dbPath: join(root, 'data', 'blaze.sqlite'), migrationsDir, dataDir, appVersion: 'test' });

  it('a brand-new database needs no safety copy', () => {
    const root = scratch();
    const o = open(root, MIGRATIONS_DIR);
    expect(o.migrated).toEqual(Array.from({ length: LATEST_SCHEMA }, (_, i) => i + 1));
    expect(o.safetyBackup).toBeNull();
    expect(existsSync(join(root, 'data', 'backups'))).toBe(false);
    o.db.close();
    expect(open(root, MIGRATIONS_DIR).safetyBackup).toBeNull(); // already up to date
  });

  it('an existing database is copied (and the copy verified) BEFORE it is upgraded', () => {
    const root = scratch();
    const old = open(root, olderMigrations(2));
    expect(old.migrated).toEqual([1, 2]);
    old.db.prepare("INSERT INTO customer (name, created_at) VALUES ('KEPT CUSTOMER', 't')").run();
    old.db.close();

    const up = open(root, MIGRATIONS_DIR);
    expect(up.migrated).toEqual(Array.from({ length: LATEST_SCHEMA - 2 }, (_, i) => i + 3));
    expect(up.safetyBackup?.path).toContain(join('backups', 'before-upgrade'));
    const v = verifyBackupFile(up.safetyBackup?.path ?? '', { knownSchemaVersion: LATEST_SCHEMA });
    expect(v.manifest).toMatchObject({ kind: 'PRE_MIGRATION', schemaVersion: 2 });
    expect(v.manifest.rowCounts.customer).toBe(1);
    expect(up.db.prepare("SELECT name FROM customer").all()).toEqual([{ name: 'KEPT CUSTOMER' }]);
    expect((up.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(LATEST_SCHEMA);
    up.db.close();
  });

  it('if the safety copy cannot be saved, the database is NOT upgraded', () => {
    const root = scratch();
    const old = open(root, olderMigrations(2));
    old.db.close();
    writeFileSync(join(root, 'blocker'), 'x');
    expect(() => open(root, MIGRATIONS_DIR, join(root, 'blocker', 'data'))).toThrow(/NOT upgraded because a safety copy/);
    const again = open(root, olderMigrations(2)); // the file is still usable, at its old version
    expect((again.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(2);
    again.db.close();
  });
});
