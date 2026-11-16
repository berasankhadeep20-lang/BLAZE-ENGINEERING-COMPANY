import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BackupService } from '../../src/application/backup/backupService';
import { createDemoDatabase, demoPaths, isDemoDatabase, openDemo, resetDemoDatabase, type DemoHandle } from '../../src/application/demo/demoDatabase';
import { openDatabase } from '../../src/infrastructure/db/connection';
import { migrate, loadMigrations } from '../../src/infrastructure/db/migrate';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { fakeHasher, TestClock } from '../helpers/auth';
import { LATEST_SCHEMA, MIGRATIONS_DIR, cleanupWorlds, dumpAll, fileWorld, scratch } from '../helpers/fileWorld';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const handles: DemoHandle[] = [];
afterEach(() => {
  while (handles.length) {
    const h = handles.pop();
    if (h?.db.open) h.db.close();
  }
  cleanupWorlds();
});

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function codeOfAsync(p: Promise<unknown>): Promise<ErrorCode | 'NO_ERROR'> {
  try {
    await p;
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

const opts = (): { migrationsDir: string; clock: TestClock; hasher: typeof fakeHasher } => ({ migrationsDir: MIGRATIONS_DIR, clock: new TestClock(), hasher: fakeHasher });
const track = (h: DemoHandle): DemoHandle => {
  handles.push(h);
  return h;
};

describe('the sample business', () => {
  it('is complete, consistent and entirely fictional', async () => {
    const dir = scratch();
    const d = track(await createDemoDatabase(join(dir, 'demo.sqlite'), opts()));
    const s = d.services;
    const t = d.ownerToken;
    expect(isDemoDatabase(d.db)).toBe(true);
    expect(s.auth.getSession(t)).toMatchObject({ role: 'OWNER', username: 'demo.owner' });
    expect(s.settings.get(t)).toMatchObject({ businessName: 'DEMO BUSINESS - SAMPLE DATA', invoicePrefix: 'DM', businessState: 'West Bengal', invoiceTitle: 'DEMO - Tax Invoice cum Challan (sample data)' });

    expect(s.items.list(t, { status: 'ALL' }).total).toBe(9);
    expect(s.customers.list(t).total).toBe(4);
    expect(s.suppliers.list(t).total).toBe(2);
    const bills = s.sales.list(t);
    expect(bills.rows.filter((b) => b.status === 'CONFIRMED')).toHaveLength(6);
    expect(bills.rows.filter((b) => b.status === 'CANCELLED')).toHaveLength(1);
    expect(bills.rows.filter((b) => b.status === 'DRAFT')).toHaveLength(1);
    expect(s.purchases.list(t).total).toBe(2);
    expect(bills.rows.filter((b) => b.billNo).every((b) => b.billNo?.startsWith('DM26'))).toBe(true); // a demo number can never be mistaken for a real invoice number

    expect(s.stock.checkIntegrity(t)).toEqual([]); // the books agree
    expect((d.db.prepare('SELECT COUNT(*) AS n FROM item WHERE qty_milli < 0').get() as { n: number }).n).toBe(0);
    for (const b of bills.rows) {
      expect(b.invoiceDate >= '2026-10-18' && b.invoiceDate <= '2026-11-07').toBe(true); // dates are relative to today
    }
  });

  it('shows every feature at work: IGST, partial receipt, part payments, low and dead stock, a cancelled bill, an open draft', async () => {
    const dir = scratch();
    const d = track(await createDemoDatabase(join(dir, 'demo.sqlite'), opts()));
    const s = d.services;
    const t = d.ownerToken;
    const confirmed = s.sales.list(t, { statuses: ['CONFIRMED'] }).rows;
    expect(confirmed.map((b) => s.sales.get(t, b.id).taxType)).toContain('INTER'); // the Bihar customer
    expect(s.purchases.list(t, { pendingGoodsOnly: true }).total).toBe(1); // part of the acid has not arrived
    expect(s.payments.list(t).total).toBe(4);
    expect(s.supplierPayments.list(t).total).toBe(1);
    const dash = s.reports.dashboard(t);
    expect(dash.stock).toMatchObject({ outOfStock: 1, lowStock: 1 });
    expect(dash.dues?.customersWithDues).toBeGreaterThanOrEqual(3);
    expect(dash.openDrafts).toBe(1);
    expect(s.reports.lowMovement(t).rows.map((r) => r.code)).toContain('STR-1'); // never sold
    expect(s.reports.bestSellers(t).length).toBeGreaterThan(3);
    const first = confirmed[confirmed.length - 1];
    const html = s.print.invoice(t, first?.id ?? 0).html;
    expect(html).toContain('DEMO - Tax Invoice cum Challan (sample data)');
    expect(html).toContain('DEMO DATA: this is not a real invoice.');
    expect(html).toContain('DM260001');
  });

  it('real data is never marked as demo', async () => {
    const real = await fileWorld();
    expect(isDemoDatabase(real.db)).toBe(false);
    expect(real.db.prepare("SELECT COUNT(*) AS n FROM app_setting WHERE key = 'app.mode'").get()).toEqual({ n: 0 });
  });
});

describe('demo and real data never mix', () => {
  it('reset replaces the demo with a fresh copy, and touches nothing else', async () => {
    const real = await fileWorld();
    const realBefore = dumpAll(real.db);
    const base = { ...opts(), dataDir: real.dataDir, realDbPath: real.dbPath };
    const d1 = track(await openDemo(base));
    expect(d1).toMatchObject({ created: true, dbPath: demoPaths(real.dataDir).dbPath });
    d1.services.customers.create(d1.ownerToken, { name: 'MY EXPERIMENT', state: 'West Bengal' });
    expect(d1.services.customers.list(d1.ownerToken).total).toBe(5);
    d1.db.close();

    const d2 = track(await resetDemoDatabase(base));
    expect(d2.services.customers.list(d2.ownerToken).total).toBe(4); // the experiment is gone
    expect(d2.services.customers.list(d2.ownerToken, { search: 'EXPERIMENT' }).total).toBe(0);
    const note = d2.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'DEMO_RESET'").get() as { detail_json: string };
    expect(JSON.parse(note.detail_json).note).toMatch(/reset to the sample dataset/);
    expect(dumpAll(real.db)).toEqual(realBefore); // the real data was not touched in any way
    expect(existsSync(real.dbPath)).toBe(true);
  });

  it('opening the demo again keeps the changes made in it; the demo database is its own file', async () => {
    const real = await fileWorld();
    const base = { ...opts(), dataDir: real.dataDir, realDbPath: real.dbPath };
    const d1 = track(await openDemo(base));
    d1.services.customers.create(d1.ownerToken, { name: 'KEPT IN DEMO', state: 'West Bengal' });
    d1.db.close();
    const d2 = track(await openDemo(base));
    expect(d2.created).toBe(false);
    expect(d2.services.customers.list(d2.ownerToken, { search: 'KEPT IN DEMO' }).total).toBe(1);
    expect(d2.services.auth.getSession(d2.ownerToken).role).toBe('OWNER');
    expect(real.s.customers.list(real.token, { search: 'KEPT IN DEMO' }).total).toBe(0); // never leaks into the real data
    expect(d2.dbPath).not.toBe(real.dbPath);
  });

  it('reset refuses to delete anything that is not demo data', async () => {
    const real = await fileWorld();
    const base = { ...opts(), dataDir: real.dataDir, realDbPath: real.dbPath };
    const { dir, dbPath } = demoPaths(real.dataDir);
    // 1. a real-looking database (no demo mark) sitting at the demo path
    mkdirSync(dir, { recursive: true });
    const db = openDatabase(dbPath);
    migrate(db, loadMigrations(MIGRATIONS_DIR));
    db.close();
    expect(await codeOfAsync(resetDemoDatabase(base))).toBe('CONFLICT');
    expect(await codeOfAsync(openDemo(base))).toBe('CONFLICT');
    expect(existsSync(dbPath)).toBe(true);
    // 2. a file that is not a database at all
    writeFileSync(dbPath, 'not a database');
    expect(await codeOfAsync(resetDemoDatabase(base))).toBe('CONFLICT');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('the demo can never be the real database', async () => {
    const dir = scratch();
    const realDbPath = demoPaths(dir).dbPath; // pretend the real database lives where the demo would
    expect(await codeOfAsync(resetDemoDatabase({ ...opts(), dataDir: dir, realDbPath }))).toBe('INVARIANT');
    expect(await codeOfAsync(openDemo({ ...opts(), dataDir: dir, realDbPath }))).toBe('INVARIANT');
    expect(existsSync(realDbPath)).toBe(false); // nothing was even created
  });

  it('will not build over an existing demo file', async () => {
    const dir = scratch();
    const path = join(dir, 'demo.sqlite');
    track(await createDemoDatabase(path, opts())).db.close();
    expect(await codeOfAsync(createDemoDatabase(path, opts()))).toBe('CONFLICT');
  });

  it('a demo backup cannot be restored into real data, and a real backup cannot be restored into the demo', async () => {
    const real = await fileWorld();
    const base = { ...opts(), dataDir: real.dataDir, realDbPath: real.dbPath };
    const demo = track(await openDemo(base));
    const demoBackup = new BackupService(demo.db, demo.services.auth, { appVersion: 'test', knownSchemaVersion: LATEST_SCHEMA, paths: { dbPath: demo.dbPath, dataDir: real.dataDir }, clock: base.clock });

    const fromDemo = demoBackup.create(demo.ownerToken, { folder: real.backupDir });
    expect(fromDemo.fileName).toMatch(/^blaze-DEMO-backup-/); // named so it cannot be confused with a real one
    expect(fromDemo.summary.mode).toBe('DEMO');
    expect(codeOf(() => real.s.backup?.inspect(real.token, fromDemo.path))).toBe('CONFLICT');

    const fromReal = real.s.backup?.create(real.token, { folder: real.backupDir });
    expect(fromReal?.summary.mode).toBe('REAL');
    expect(codeOf(() => demoBackup.inspect(demo.ownerToken, fromReal?.path ?? ''))).toBe('CONFLICT');
    expect(demo.db.prepare("SELECT value FROM app_setting WHERE key = 'app.mode'").get()).toEqual({ value: 'DEMO' });
  });
});
