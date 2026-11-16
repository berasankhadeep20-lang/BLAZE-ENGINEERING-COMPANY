import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, type AppServices } from '../../src/application/composition';
import { openAppDatabase, type OpenedAppDatabase } from '../../src/infrastructure/backup/startup';
import type { Db } from '../../src/infrastructure/db/connection';
import { loadMigrations } from '../../src/infrastructure/db/migrate';
import { fakeHasher, TestClock } from './auth';

export const MIGRATIONS_DIR = join(__dirname, '../../src/infrastructure/db/migrations');
export const LATEST_SCHEMA = loadMigrations(MIGRATIONS_DIR).length;
export const OWNER_PW = 'owner-pass-1';

const roots: string[] = [];
const dbs: Db[] = [];

/** A scratch folder, removed after the test (see cleanupWorlds). */
export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blaze-test-'));
  roots.push(dir);
  return dir;
}

export function cleanupWorlds(): void {
  while (dbs.length) {
    const d = dbs.pop();
    if (d?.open) d.close();
  }
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
}

export interface FileWorld {
  root: string;
  dbPath: string;
  dataDir: string;
  backupDir: string; // a pretend USB drive
  clock: TestClock;
  db: Db;
  s: AppServices;
  token: string;
  opened: OpenedAppDatabase;
  ids: { can: number; farm: number; supplier: number };
}

/** Open (or re-open) the database file the way the program does at start-up, with every service wired to it, and sign the owner in. */
export async function openWorld(root: string, clock: TestClock, opts: { migrationsDir?: string; signIn?: boolean } = {}): Promise<Omit<FileWorld, 'ids'>> {
  const dbPath = join(root, 'data', 'blaze.sqlite');
  const dataDir = join(root, 'data');
  const opened = openAppDatabase({ dbPath, migrationsDir: opts.migrationsDir ?? MIGRATIONS_DIR, dataDir, appVersion: 'test', clock });
  dbs.push(opened.db);
  const s = createServices({ db: opened.db, hasher: fakeHasher, clock, backup: { appVersion: 'test', knownSchemaVersion: LATEST_SCHEMA, paths: { dbPath, dataDir } } });
  let token = '';
  if (opts.signIn !== false && !s.auth.isFirstRun()) token = (await s.auth.login('owner', OWNER_PW)).token;
  return { root, dbPath, dataDir, backupDir: join(root, 'usb'), clock, db: opened.db, s, token, opened };
}

/** A small real shop in a database FILE: owner, settings, one item, one customer, one supplier, one sale (part paid) and one purchase. */
export async function fileWorld(): Promise<FileWorld> {
  const root = scratch();
  const clock = new TestClock();
  const w = await openWorld(root, clock, { signIn: false });
  await w.s.auth.firstRunSetup({ username: 'owner', displayName: 'Shop Owner', password: OWNER_PW });
  const token = (await w.s.auth.login('owner', OWNER_PW)).token;
  const s = w.s;
  s.settings.update(token, { businessName: 'TEST ENGINEERING CO', businessState: 'West Bengal', invoicePrefix: 'bz' });
  const can = s.items.create(token, { code: 'MC-40', name: 'PLASTIC MILK CAN', hsn: '3923', unit: 'LTR', packSize: '40', purchaseRatePaise: 80000, saleRatePaise: 92500, gstRateBp: 1800, reorderQtyMilli: 2000, openingQtyMilli: 10000 });
  const farm = s.customers.create(token, { name: 'TEST DAIRY FARM', state: 'West Bengal', address: 'Vill Example' });
  const supplier = s.suppliers.create(token, { name: 'SAMPLE SUPPLIER', state: 'West Bengal' });
  s.sales.confirm(token, s.sales.saveDraft(token, { customerId: farm, invoiceDate: '2026-11-01', lines: [{ itemId: can, qtyMilli: 2000 }], receivedPaise: 100000, paymentMethod: 'Cash' }).id);
  s.purchases.confirm(token, s.purchases.saveDraft(token, { supplierId: supplier, supplierInvoiceNo: 'S-1', supplierInvoiceDate: '2026-11-02', billDate: '2026-11-02', lines: [{ itemId: can, invoicedQtyMilli: 5000, ratePaise: 80000 }] }).id);
  return { ...w, token, ids: { can, farm, supplier } };
}

/** Add one more confirmed sale (to make "data recorded after a backup"). */
export function sellMore(w: FileWorld, qtyMilli = 1000): void {
  w.s.sales.confirm(w.token, w.s.sales.saveDraft(w.token, { customerId: w.ids.farm, invoiceDate: '2026-11-03', lines: [{ itemId: w.ids.can, qtyMilli }] }).id);
}

export const count = (db: Db, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

/** Every row of every table as JSON, in a stable order: used to prove a restore brought back everything exactly. */
export function dumpAll(db: Db): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) out[t] = (db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as object[]).map((r) => JSON.stringify(r));
  return out;
}
