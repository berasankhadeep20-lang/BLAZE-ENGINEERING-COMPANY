/** The one place that wires every service to a database. The demo builder uses it, and so will the program's windows. */
import { systemClock, type Clock } from '../shared/clock';
import type { Db } from '../infrastructure/db/connection';
import type { PasswordHasher } from '../infrastructure/security/passwordHasher';
import { AuthService } from './auth/authService';
import { SessionStore } from './auth/sessionStore';
import { UserService } from './auth/userService';
import { BackupService, type BackupServiceOptions } from './backup/backupService';
import { ItemService } from './inventory/itemService';
import { StockService } from './inventory/stockService';
import { CustomerService } from './parties/customerService';
import { SupplierService } from './parties/supplierService';
import { PrintService } from './print/printService';
import { PurchaseService } from './purchases/purchaseService';
import { SupplierPaymentService } from './purchases/supplierPaymentService';
import { ReportService } from './reports/reportService';
import { PaymentService } from './sales/paymentService';
import { SaleService } from './sales/saleService';
import { SettingsService } from './settings/settingsService';

export interface CreateServicesOptions {
  db: Db;
  hasher: PasswordHasher;
  clock?: Clock;
  idleTimeoutMs?: number;
  /** Supply this to get a BackupService; leave it out where backups make no sense (the demo). */
  backup?: Omit<BackupServiceOptions, 'clock'>;
}

export function createServices(o: CreateServicesOptions) {
  const clock = o.clock ?? systemClock;
  const sessions = new SessionStore(clock, o.idleTimeoutMs ?? 0);
  const auth = new AuthService({ db: o.db, hasher: o.hasher, sessions, clock });
  const users = new UserService({ db: o.db, auth, hasher: o.hasher, sessions, clock });
  const items = new ItemService(o.db, auth, clock);
  const stock = new StockService(o.db, auth, clock);
  const customers = new CustomerService(o.db, auth, clock);
  const suppliers = new SupplierService(o.db, auth, clock);
  const sales = new SaleService(o.db, auth, clock);
  const payments = new PaymentService(o.db, auth, clock);
  const purchases = new PurchaseService(o.db, auth, clock);
  const supplierPayments = new SupplierPaymentService(o.db, auth, clock);
  const settings = new SettingsService(o.db, auth, clock);
  const reports = new ReportService(o.db, auth, clock);
  const print = new PrintService(o.db, auth, { sales, customers, items, stock, reports }, clock);
  const backup = o.backup ? new BackupService(o.db, auth, { ...o.backup, clock }) : null;
  return { clock, sessions, auth, users, items, stock, customers, suppliers, sales, payments, purchases, supplierPayments, settings, reports, print, backup };
}

export type AppServices = ReturnType<typeof createServices>;
