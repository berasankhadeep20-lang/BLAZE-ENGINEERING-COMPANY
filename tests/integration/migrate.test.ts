import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/infrastructure/db/connection';
import { MigrationError, loadMigrations, migrate, type MigrationFile } from '../../src/infrastructure/db/migrate';

const REAL_DIR = join(__dirname, '../../src/infrastructure/db/migrations');
const dirs: string[] = [];
const dbs: Db[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'blaze-mig-'));
  dirs.push(d);
  return d;
}
function memDb(): Db {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies the real migrations and records them', () => {
    const db = memDb();
    const applied = migrate(db, loadMigrations(REAL_DIR));
    expect(applied).toEqual([1]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ['item', 'customer', 'sale_bill', 'purchase_bill', 'stock_movement', 'customer_ledger', 'audit_log', 'schema_migrations']) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', () => {
    const db = memDb();
    const m = loadMigrations(REAL_DIR);
    migrate(db, m);
    expect(migrate(db, m)).toEqual([]);
  });

  it('applies only new migrations on a later run', () => {
    const db = memDb();
    const dir = tmpDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    migrate(db, loadMigrations(dir));
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (id INTEGER);');
    expect(migrate(db, loadMigrations(dir))).toEqual([2]);
  });

  it('rolls back a failing migration completely', () => {
    const db = memDb();
    const dir = tmpDir();
    writeFileSync(join(dir, '001_bad.sql'), 'CREATE TABLE ok_table (id INTEGER); CREATE TABLE ok_table (id INTEGER);');
    expect(() => migrate(db, loadMigrations(dir))).toThrow(MigrationError);
    const t = db.prepare("SELECT name FROM sqlite_master WHERE name='ok_table'").all();
    expect(t).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()).toEqual({ c: 0 });
  });

  it('refuses to run if an applied migration file was modified', () => {
    const db = memDb();
    const dir = tmpDir();
    const f = join(dir, '001_a.sql');
    writeFileSync(f, 'CREATE TABLE a (id INTEGER);');
    migrate(db, loadMigrations(dir));
    writeFileSync(f, 'CREATE TABLE a (id INTEGER, extra TEXT);');
    expect(() => migrate(db, loadMigrations(dir))).toThrow(/modified/);
  });

  it('refuses a database that is newer than the app', () => {
    const db = memDb();
    const dir = tmpDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (id INTEGER);');
    migrate(db, loadMigrations(dir));
    const older = loadMigrations(dir).slice(0, 1);
    expect(() => migrate(db, older)).toThrow(/newer than the app/);
  });

  it('calls beforeMigrate with the pending list, and aborts if it throws', () => {
    const db = memDb();
    const dir = tmpDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    let seen: MigrationFile[] = [];
    expect(() =>
      migrate(db, loadMigrations(dir), {
        beforeMigrate: (p) => {
          seen = p;
          throw new Error('backup failed');
        },
      }),
    ).toThrow('backup failed');
    expect(seen.map((m) => m.version)).toEqual([1]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='a'").all()).toHaveLength(0);
  });

  it('rejects gaps in migration numbering', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '003_c.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/contiguous/);
  });
});
