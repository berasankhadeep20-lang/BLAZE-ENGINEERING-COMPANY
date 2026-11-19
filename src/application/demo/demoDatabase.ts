/**
 * Demo mode: a complete sample business in its OWN database file, so the workflows can be tried without risking real records.
 * Demo and real data never mix:
 *  - the demo lives in <dataDir>/demo/demo.sqlite and is marked inside (app.mode = DEMO); the real database never carries that mark;
 *  - a backup of demo data cannot be restored into the real data, nor the reverse (see BackupService);
 *  - "reset demo" deletes only a file that is proven to be demo data, and refuses to touch anything else;
 *  - demo invoices use their own prefix (DM) and say DEMO in the title, so a demo printout cannot be mistaken for a real invoice.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { addDays, localDateString, systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { dataMode, MODE_KEY } from '../../infrastructure/backup/backupFile';
import { openDatabase, type Db } from '../../infrastructure/db/connection';
import { loadMigrations, migrate } from '../../infrastructure/db/migrate';
import { argon2idHasher, type PasswordHasher } from '../../infrastructure/security/passwordHasher';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import { createServices, type AppServices } from '../composition';

export const demoPaths = (dataDir: string): { dir: string; dbPath: string } => ({ dir: join(dataDir, 'demo'), dbPath: join(dataDir, 'demo', 'demo.sqlite') });

export const isDemoDatabase = (db: Db): boolean => dataMode(db) === 'DEMO';

export interface DemoOptions {
  migrationsDir: string;
  clock?: Clock;
  hasher?: PasswordHasher;
}

const daysAgo = (clock: Clock, n: number): string => addDays(localDateString(clock.now()), -n);

/** Fill an empty, migrated demo database with a small, realistic, entirely fictional business. Dates are relative to today so the demo always looks current. */
function seedDemoData(s: AppServices, token: string, clock: Clock): void {
  s.settings.update(token, {
    businessName: 'DEMO BUSINESS - SAMPLE DATA', businessState: 'West Bengal', invoicePrefix: 'DM', businessAddress: '1 SAMPLE ROAD, DEMO CITY (SAMPLE DATA - NOT REAL)',
    businessPhone: '+91 90000 00000', businessEmail: 'demo@example.invalid', businessGstin: '19ABCDE1234F1ZX', bankName: 'DEMO BANK', bankBranch: 'Demo Branch',
    bankAccountNo: '000000000000', bankIfsc: 'DEMO0000001', invoiceTitle: 'DEMO - Tax Invoice cum Challan (sample data)', invoiceTerms: 'DEMO DATA: this is not a real invoice.', backupReminderDays: 0,
  });
  const dairy = s.items.createCategory(token, 'Dairy equipment');
  const glass = s.items.createCategory(token, 'Lab glassware');
  const chem = s.items.createCategory(token, 'Lab chemicals');
  const item = (code: string, name: string, hsn: string, unit: string, packSize: string | undefined, categoryId: number, cost: number, rate: number, stock: number, reorder: number): number =>
    s.items.create(token, { code, name, hsn, unit, packSize, categoryId, purchaseRatePaise: cost, saleRatePaise: rate, gstRateBp: 1800, openingQtyMilli: stock, reorderQtyMilli: reorder });
  const can40 = item('MC-40', 'PLASTIC MILK CAN', '3923', 'LTR', '40', dairy, 80000, 92500, 25000, 5000);
  const can20 = item('MC-20', 'PLASTIC MILK CAN', '3923', 'LTR', '20', dairy, 45000, 52000, 30000, 5000);
  const strainer = item('STR-1', 'OLD STYLE MILK STRAINER', '7323', 'PCS', undefined, dairy, 3000, 4500, 15000, 0); // never sold: shows up as dead stock
  const buty = item('BUT-10', 'BUTYROMETER FOR MILK 0-10% ISI', '7017', 'PCS', undefined, glass, 4000, 5500, 200000, 50000);
  const lacto = item('LACTO', 'LACTOMETER', '9025', 'PCS', undefined, glass, 9000, 12500, 60000, 10000);
  item('THERMO', 'LAB THERMOMETER', '9025', 'PCS', undefined, glass, 6000, 8500, 0, 5000); // sold out
  const naoh = item('NAOH-500', 'SODIUM HYDROXIDE N/10 SOLUTION', '2815', 'ML', '500', chem, 20000, 24500, 40000, 10000);
  const acid = item('H2SO4-500', 'SULPHURIC ACID 90%', '2807', 'ML', '500', chem, 12000, 16000, 3000, 10000); // low stock
  const amyl = item('AMYL-500', 'AMYL ALCOHOL', '2905', 'ML', '500', chem, 18000, 23000, 0, 5000);
  void strainer;

  const farm = s.customers.create(token, { name: 'DEMO DAIRY FARM', state: 'West Bengal', address: 'Vill Example, Hooghly 712000', placeOfSupply: 'EXAMPLEPUR', phone: '+91 90000 00001' });
  const centre = s.customers.create(token, { name: 'SAMPLE MILK COLLECTION CENTRE', state: 'West Bengal', gstin: '19PQRST5678K1ZZ', address: '22 Sample Lane, Burdwan' });
  const coop = s.customers.create(token, { name: 'EXAMPLE CO-OPERATIVE SOCIETY', state: 'West Bengal', address: 'Demo Market, Bankura' });
  const patna = s.customers.create(token, { name: 'PATNA DEMO DAIRY', state: 'Bihar', address: 'Gandhi Maidan, Patna' });
  const equip = s.suppliers.create(token, { name: 'DEMO DAIRY EQUIPMENT TRADERS', state: 'West Bengal', address: 'Burrabazar, Kolkata' });
  const chemco = s.suppliers.create(token, { name: 'SAMPLE CHEMICALS LTD', state: 'Maharashtra', gstin: '27ABCDE1234F1Z0', address: 'Demo Industrial Estate, Pune' });

  const day = (n: number): string => daysAgo(clock, n);
  const buy = (supplierId: number, n: number, no: string, lines: { itemId: number; invoicedQtyMilli: number; receivedQtyMilli?: number; ratePaise: number }[], paid?: number): void => {
    s.purchases.confirm(token, s.purchases.saveDraft(token, { supplierId, supplierInvoiceNo: no, supplierInvoiceDate: day(n), billDate: day(n), lines, ...(paid ? { paidPaise: paid, paymentMethod: 'Cash' } : {}) }).id);
  };
  const sell = (customerId: number, n: number, lines: { itemId: number; qtyMilli: number }[], extra: { receivedPaise?: number; paymentMethod?: string; delivery?: { amountPaise: number; gstRateBp: number } } = {}): number =>
    s.sales.confirm(token, s.sales.saveDraft(token, { customerId, invoiceDate: day(n), lines, ...extra }).id).id;

  buy(equip, 20, 'DE/2201', [{ itemId: can40, invoicedQtyMilli: 20000, ratePaise: 80000 }, { itemId: lacto, invoicedQtyMilli: 40000, ratePaise: 9000 }], 500000);
  sell(farm, 15, [{ itemId: can40, qtyMilli: 2000 }, { itemId: buty, qtyMilli: 10000 }], { receivedPaise: 100000, paymentMethod: 'UPI' });
  sell(centre, 14, [{ itemId: naoh, qtyMilli: 6000 }, { itemId: lacto, qtyMilli: 2000 }]);
  buy(chemco, 12, 'SC/7781', [{ itemId: acid, invoicedQtyMilli: 12000, receivedQtyMilli: 8000, ratePaise: 12000 }, { itemId: amyl, invoicedQtyMilli: 10000, ratePaise: 18000 }]); // part of the acid is still to arrive
  sell(coop, 10, [{ itemId: can20, qtyMilli: 5000 }], { receivedPaise: 295000, paymentMethod: 'Cash' });
  sell(patna, 8, [{ itemId: naoh, qtyMilli: 4000 }, { itemId: buty, qtyMilli: 20000 }]);
  sell(farm, 5, [{ itemId: can40, qtyMilli: 1000 }]);
  s.sales.cancel(token, sell(centre, 3, [{ itemId: buty, qtyMilli: 30000 }]), 'Demo: entered by mistake');
  sell(farm, 1, [{ itemId: lacto, qtyMilli: 3000 }, { itemId: acid, qtyMilli: 4000 }], { delivery: { amountPaise: 5000, gstRateBp: 1800 } });
  s.payments.record(token, { customerId: farm, amountPaise: 300000, method: 'Bank transfer', paidOn: day(6), reference: 'DEMO-NEFT-1' });
  s.payments.record(token, { customerId: centre, amountPaise: 50000, method: 'Cheque', paidOn: day(2), reference: 'DEMO-CHQ-77' });
  s.sales.saveDraft(token, { customerId: coop, invoiceDate: day(0), lines: [{ itemId: can20, qtyMilli: 2000 }] }); // an unfinished draft
}

export interface DemoHandle {
  db: Db;
  services: AppServices;
  ownerToken: string; // a ready-made owner session: the demo has no real accounts to protect
  dbPath: string;
  created: boolean; // false when an existing demo was opened
}

const removeDbFiles = (dbPath: string): void => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
};

/** True only if the file is a database carrying the demo mark. Anything else (a real database, a random file) is NOT demo data. */
function fileIsDemo(path: string): boolean {
  try {
    const d = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return (d.prepare('SELECT value FROM app_setting WHERE key = ?').get(MODE_KEY) as { value: string } | undefined)?.value === 'DEMO';
    } finally {
      d.close();
    }
  } catch {
    return false;
  }
}

async function buildDemo(dbPath: string, o: DemoOptions, resetNote: string | null): Promise<DemoHandle> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const clock = o.clock ?? systemClock;
  const hasher = o.hasher ?? argon2idHasher;
  const db = openDatabase(dbPath, { synchronous: 'OFF' }); // disposable sample data: no need to flush to disk after every one of the many commits while building
  try {
    migrate(db, loadMigrations(o.migrationsDir));
    db.prepare('INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)').run(MODE_KEY, 'DEMO', clock.now().toISOString());
    const services = createServices({ db, hasher, clock });
    // the demo owner has a random password that nobody ever sees: the demo is entered through a ready-made session
    const { userId } = await services.auth.firstRunSetup({ username: 'demo.owner', displayName: 'Demo Owner', password: randomBytes(18).toString('base64url') });
    const ownerToken = services.sessions.create(userId);
    seedDemoData(services, ownerToken, clock);
    if (resetNote) new UnitOfWork(db, clock).run({ userId, role: 'OWNER' }, (ctx) => recordAudit(ctx, { action: 'DEMO_RESET', entityType: 'demo', detail: { note: resetNote } }));
    db.pragma('synchronous = FULL'); // back to the normal safety level for everyday use of the demo
    return { db, services, ownerToken, dbPath, created: true };
  } catch (e) {
    db.close();
    removeDbFiles(dbPath);
    throw e;
  }
}

function guardPaths(o: { dataDir: string; realDbPath: string }): string {
  const { dbPath } = demoPaths(o.dataDir);
  if (resolve(dbPath) === resolve(o.realDbPath)) throw new AppError('INVARIANT', 'the demo database must never be the real database');
  return dbPath;
}

/** Build a brand-new demo database at `dbPath` (which must not exist yet). */
export async function createDemoDatabase(dbPath: string, o: DemoOptions): Promise<DemoHandle> {
  if (existsSync(dbPath)) throw new AppError('CONFLICT', 'a demo database already exists there; reset it instead');
  return buildDemo(dbPath, o, null);
}

/** Open the demo (building it the first time). Never opens the real database. */
export async function openDemo(o: DemoOptions & { dataDir: string; realDbPath: string }): Promise<DemoHandle> {
  const dbPath = guardPaths(o);
  if (!existsSync(dbPath)) return buildDemo(dbPath, o, null);
  if (!fileIsDemo(dbPath)) throw new AppError('CONFLICT', 'the demo file is not demo data, so it was not opened');
  const clock = o.clock ?? systemClock;
  const db = openDatabase(dbPath);
  try {
    migrate(db, loadMigrations(o.migrationsDir));
    const services = createServices({ db, hasher: o.hasher ?? argon2idHasher, clock });
    const owner = db.prepare("SELECT id FROM user WHERE role = 'OWNER' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!owner) throw new AppError('INVARIANT', 'the demo has no owner account');
    return { db, services, ownerToken: services.sessions.create(owner.id), dbPath, created: false };
  } catch (e) {
    db.close();
    throw e;
  }
}

/**
 * Throw away the demo and build a fresh one. Deletes ONLY a file proven to be demo data; if the file is anything else, or is the real database, nothing is deleted.
 * The caller must have closed any open connection to the old demo first.
 */
export async function resetDemoDatabase(o: DemoOptions & { dataDir: string; realDbPath: string }): Promise<DemoHandle> {
  const dbPath = guardPaths(o);
  if (existsSync(dbPath)) {
    if (!fileIsDemo(dbPath)) throw new AppError('CONFLICT', 'refusing to reset: that file is not demo data, so nothing was deleted');
    removeDbFiles(dbPath);
  }
  return buildDemo(dbPath, o, 'The demo data was reset to the sample dataset.');
}
