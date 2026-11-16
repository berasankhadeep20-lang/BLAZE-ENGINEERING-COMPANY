import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackupFile, createSafetyBackup, createVerifiedBackup, dataMode, pruneBackups, verifyBackupFile } from '../../src/infrastructure/backup/backupFile';
import { MAGIC, decodeBackup, encodeBackup, sha256, type BackupManifest } from '../../src/infrastructure/backup/format';
import { openDatabase } from '../../src/infrastructure/db/connection';
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrate';
import { AppError } from '../../src/shared/errors';
import { LATEST_SCHEMA, MIGRATIONS_DIR, cleanupWorlds, count, fileWorld, scratch } from '../helpers/fileWorld';

afterEach(cleanupWorlds);

function reason(fn: () => unknown): { code: string; reason: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return { code: e.code, reason: String(e.details?.reason ?? e.details?.cause ?? e.message) };
    throw e;
  }
  return { code: 'NO_ERROR', reason: '' };
}

const baseManifest = (over: Partial<Omit<BackupManifest, 'dbBytes' | 'dbSha256' | 'payloadBytes' | 'payloadSha256'>> = {}): Omit<BackupManifest, 'dbBytes' | 'dbSha256' | 'payloadBytes' | 'payloadSha256'> => ({
  format: 'blaze-engineering-backup', formatVersion: 1, createdAt: '2026-11-07T10:00:00.000Z', appVersion: 'test', schemaVersion: 4, kind: 'MANUAL', mode: 'REAL', businessName: null, createdBy: null, rowCounts: {}, ...over,
});

describe('the backup container', () => {
  it('round-trips, and notices every kind of damage', () => {
    const data = Buffer.from('pretend this is a database '.repeat(500));
    const { file, manifest } = encodeBackup(baseManifest(), data);
    expect(file.subarray(0, MAGIC.length).toString()).toBe('BLAZEBAK1\n');
    const back = decodeBackup(file);
    expect(back.dbBytes.equals(data)).toBe(true);
    expect(back.manifest).toEqual(manifest);

    const flipped = Buffer.from(file);
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 0xff;
    expect(reason(() => decodeBackup(flipped))).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(reason(() => decodeBackup(file.subarray(0, file.length - 10)))).toMatchObject({ code: 'BACKUP_INVALID' }); // cut short while copying
    expect(reason(() => decodeBackup(Buffer.concat([file, Buffer.from('extra')])))).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(reason(() => decodeBackup(Buffer.from('not a backup at all')))).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(reason(() => decodeBackup(Buffer.alloc(0)))).toMatchObject({ code: 'BACKUP_INVALID' });
    const hugeLen = Buffer.from(file);
    hugeLen.writeUInt32BE(0x7fffffff, MAGIC.length);
    expect(reason(() => decodeBackup(hugeLen))).toMatchObject({ code: 'BACKUP_INVALID' });
  });

  it('rejects files from another program or a future format, and a damaged description', () => {
    const data = Buffer.from('x'.repeat(100));
    const craft = (manifestJson: object, payload: Buffer): Buffer => {
      const json = Buffer.from(JSON.stringify(manifestJson));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(json.length);
      return Buffer.concat([MAGIC, len, json, payload]);
    };
    const payload = gzipSync(data);
    const m = { ...baseManifest(), dbBytes: data.length, dbSha256: sha256(data), payloadBytes: payload.length, payloadSha256: sha256(payload) };
    expect(reason(() => decodeBackup(craft({ ...m, format: 'something-else' }, payload))).reason).toMatch(/not made by this program/);
    expect(reason(() => decodeBackup(craft({ ...m, formatVersion: 99 }, payload))).reason).toMatch(/backup format 99/);
    expect(reason(() => decodeBackup(craft({ ...m, kind: 'WEIRD' }, payload)))).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(reason(() => decodeBackup(craft({ ...m, rowCounts: { a: 'many' } }, payload)))).toMatchObject({ code: 'BACKUP_INVALID' });
    expect(reason(() => decodeBackup(craft({ format: 'blaze-engineering-backup' }, payload)))).toMatchObject({ code: 'BACKUP_INVALID' });
    const notJson = Buffer.concat([MAGIC, Buffer.from([0, 0, 0, 5]), Buffer.from('{oops'), payload]);
    expect(reason(() => decodeBackup(notJson)).reason).toMatch(/damaged/);
  });

  it('never inflates beyond what the description promises (a compression bomb is refused)', () => {
    const bomb = gzipSync(Buffer.alloc(20_000_000)); // 20 MB of zeros, tiny when compressed
    const m = { ...baseManifest(), dbBytes: 10, dbSha256: 'x', payloadBytes: bomb.length, payloadSha256: sha256(bomb) };
    const json = Buffer.from(JSON.stringify(m));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    expect(reason(() => decodeBackup(Buffer.concat([MAGIC, len, json, bomb]))).reason).toMatch(/could not be unpacked/);
  });
});

describe('creating and verifying a backup file', () => {
  it('captures a consistent snapshot of the live database, with an accurate description', async () => {
    const w = await fileWorld();
    const dest = join(scratch(), 'one.blazebak');
    const b = createBackupFile(w.db, { destPath: dest, kind: 'MANUAL', appVersion: 'test', createdBy: 'Shop Owner', now: new Date('2026-11-07T10:00:00Z') });
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    expect(b.fileSha256).toBe(sha256(readFileSync(dest)));
    expect(b.manifest).toMatchObject({ schemaVersion: LATEST_SCHEMA, mode: 'REAL', businessName: 'TEST ENGINEERING CO', createdBy: 'Shop Owner', kind: 'MANUAL' });
    for (const t of ['user', 'item', 'customer', 'supplier', 'sale_bill', 'sale_bill_line', 'purchase_bill', 'purchase_bill_line', 'stock_movement', 'customer_payment', 'supplier_payment', 'payment_allocation', 'purchase_receipt', 'customer_ledger', 'supplier_ledger', 'audit_log', 'app_setting', 'number_series', 'schema_migrations']) {
      expect(b.manifest.rowCounts[t], t).toBe(count(w.db, t));
    }
    const v = verifyBackupFile(dest, { knownSchemaVersion: LATEST_SCHEMA });
    expect(v).toMatchObject({ integrity: 'ok', booksAgree: true, reconcileIssues: 0 });
    expect(v.latestActivityAt).not.toBeNull();
  });

  it('works while the program is busy (WAL mode, uncommitted changes elsewhere are not captured) and for an in-memory database', async () => {
    const w = await fileWorld();
    expect((w.db.pragma('journal_mode') as { journal_mode: string }[])[0]?.journal_mode).toBe('wal');
    const d = scratch();
    const a = createBackupFile(w.db, { destPath: join(d, 'a.blazebak'), kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date() });
    expect(verifyBackupFile(a.path, { knownSchemaVersion: LATEST_SCHEMA }).manifest.rowCounts.sale_bill).toBe(1);
    const mem = openDatabase(':memory:');
    migrate(mem, loadMigrations(MIGRATIONS_DIR));
    const m = createBackupFile(mem, { destPath: join(d, 'mem.blazebak'), kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date() });
    expect(verifyBackupFile(m.path, { knownSchemaVersion: LATEST_SCHEMA }).manifest.rowCounts.user).toBe(0);
    mem.close();
    expect(dataMode(mem.open ? mem : w.db)).toBe('REAL');
  });

  it('refuses to back up in the middle of a transaction', async () => {
    const w = await fileWorld();
    w.db.exec('BEGIN');
    expect(reason(() => createBackupFile(w.db, { destPath: join(scratch(), 'x.blazebak'), kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date() })).code).toBe('INVARIANT');
    w.db.exec('ROLLBACK');
  });

  it('refuses files that are not sound: garbage inside, a description that lies about the contents, or a newer version', async () => {
    const w = await fileWorld();
    const dir = scratch();
    const good = createBackupFile(w.db, { destPath: join(dir, 'good.blazebak'), kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date() });

    // right container, nonsense inside
    const junk = encodeBackup(baseManifest(), Buffer.from('this is not sqlite '.repeat(200)));
    writeFileSync(join(dir, 'junk.blazebak'), junk.file);
    expect(reason(() => verifyBackupFile(join(dir, 'junk.blazebak'), { knownSchemaVersion: 9 }))).toMatchObject({ code: 'BACKUP_INVALID', reason: 'not a database' });

    // a real database but the description claims different row counts
    const lie = encodeBackup(baseManifest({ schemaVersion: LATEST_SCHEMA, rowCounts: { ...good.manifest.rowCounts, sale_bill: 99 } }), decodeBackup(readFileSync(good.path)).dbBytes);
    writeFileSync(join(dir, 'lie.blazebak'), lie.file);
    expect(reason(() => verifyBackupFile(join(dir, 'lie.blazebak'), { knownSchemaVersion: 9 }))).toMatchObject({ code: 'BACKUP_INVALID', reason: 'row counts' });

    // made by a newer version of the program than this one
    expect(reason(() => verifyBackupFile(good.path, { knownSchemaVersion: LATEST_SCHEMA - 1 }))).toMatchObject({ code: 'BACKUP_INVALID', reason: 'newer' });
    expect(reason(() => verifyBackupFile(join(dir, 'missing.blazebak'), { knownSchemaVersion: 9 }))).toMatchObject({ code: 'BACKUP_INVALID', reason: 'unreadable' });
  });

  it('reports (without refusing) a backup whose stock or balances do not match their own records', async () => {
    const w = await fileWorld();
    w.db.prepare('UPDATE item SET qty_milli = qty_milli + 777').run(); // damage the cached figure behind the ledger's back
    const b = createBackupFile(w.db, { destPath: join(scratch(), 'bad-books.blazebak'), kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date() });
    const v = verifyBackupFile(b.path, { knownSchemaVersion: LATEST_SCHEMA });
    expect(v.booksAgree).toBe(false);
    expect(v.reconcileIssues).toBeGreaterThan(0);
  });
});

describe('a backup is never claimed unless it is verified', () => {
  it('a file damaged after writing is deleted and the attempt fails', async () => {
    const w = await fileWorld();
    const dest = join(scratch(), 'damaged.blazebak');
    const r = reason(() => createVerifiedBackup(w.db, { destPath: dest, kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date(), knownSchemaVersion: LATEST_SCHEMA, afterWrite: (p) => truncateSync(p, 100) }));
    expect(r.code).toBe('BACKUP_FAILED');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it('fails cleanly when the destination cannot be written, leaving nothing behind', async () => {
    const w = await fileWorld();
    const root = scratch();
    writeFileSync(join(root, 'a-file-not-a-folder'), 'x');
    const r = reason(() => createVerifiedBackup(w.db, { destPath: join(root, 'a-file-not-a-folder', 'x.blazebak'), kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date(), knownSchemaVersion: LATEST_SCHEMA }));
    expect(r.code).toBe('BACKUP_FAILED');
  });

  it('succeeds normally and the finished file is readable from disk', async () => {
    const w = await fileWorld();
    const dest = join(scratch(), 'ok.blazebak');
    const { backup, verified } = createVerifiedBackup(w.db, { destPath: dest, kind: 'MANUAL', appVersion: 't', createdBy: null, now: new Date(), knownSchemaVersion: LATEST_SCHEMA });
    expect(statSync(dest).size).toBe(backup.fileBytes);
    expect(verified.booksAgree).toBe(true);
  });
});

describe('safety copies', () => {
  it('are created, verified, named by purpose, and pruned to the newest few', async () => {
    const w = await fileWorld();
    const dir = join(scratch(), 'auto');
    const mk = (n: number): string => {
      const b = createSafetyBackup(w.db, { dir, kind: 'PRE_RESTORE', appVersion: 't', createdBy: null, now: new Date(2026, 10, 7, 10, 0, n), knownSchemaVersion: LATEST_SCHEMA, keep: 3 });
      utimesSync(b.path, new Date(2026, 10, 7, 10, 0, n), new Date(2026, 10, 7, 10, 0, n)); // distinct ages, regardless of how fast the test runs
      return b.path;
    };
    const first = mk(1);
    expect(first).toMatch(/blaze-safety-before-restore-20261107-100001\.blazebak$/);
    for (const n of [2, 3, 4, 5]) mk(n);
    const left = readdirSync(dir).filter((f) => f.endsWith('.blazebak')).sort();
    expect(left).toHaveLength(3);
    expect(left[0]).toContain('100003');
    expect(left[2]).toContain('100005');
    expect(existsSync(first)).toBe(false);
    expect(pruneBackups(join(dir, 'nothing-here'), 3)).toEqual([]);
    mkdirSync(join(dir, 'sub'));
    expect(pruneBackups(dir, 10)).toEqual([]); // nothing more to remove
  });
});
