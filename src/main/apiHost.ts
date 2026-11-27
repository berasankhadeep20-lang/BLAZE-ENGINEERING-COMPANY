/**
 * The only door between the window (renderer) and the program's services.
 *  - The window may call ONLY the operations listed in METHODS (an allowlist), never a service directly.
 *  - The signed-in session lives here, in the main process; the window never sees a token.
 *  - Every failure comes back as a plain { ok: false, error } (never a thrown error or a stack trace).
 */
import type { AppServices } from '../application/composition';
import { AppError } from '../shared/errors';

export type ApiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface HostHooks {
  appVersion: string;
  enterDemo(): Promise<{ services: AppServices; ownerToken: string }>;
  exitDemo(): void;
  chooseFolder(): Promise<string | null>;
  saveInvoicePdf(billId: number): Promise<{ saved: boolean; path?: string }>;
  printInvoice(billId: number): Promise<{ printed: boolean }>;
  log(message: string, error?: unknown): void;
}

interface Ctx {
  s: AppServices;
  token: string;
  host: ApiHost;
}
type Handler = (c: Ctx, ...args: never[]) => unknown;

const auth = <A extends unknown[], R>(fn: (c: Ctx, ...a: A) => R): { auth: true; fn: (c: Ctx, ...a: A) => R } => ({ auth: true, fn });
const open = <A extends unknown[], R>(fn: (c: Ctx, ...a: A) => R): { auth: false; fn: (c: Ctx, ...a: A) => R } => ({ auth: false, fn });

export class ApiHost {
  private services: AppServices;
  private token: string | null = null;
  mode: 'REAL' | 'DEMO' = 'REAL';

  constructor(
    private readonly real: AppServices,
    readonly hooks: HostHooks,
  ) {
    this.services = real;
  }

  setSession(token: string | null): void {
    this.token = token;
  }

  sessionToken(): string {
    return this.token ?? '';
  }

  activeServices(): AppServices {
    return this.services;
  }

  get realServices(): AppServices {
    return this.real;
  }

  useServices(s: AppServices, mode: 'REAL' | 'DEMO', token: string | null): void {
    this.services = s;
    this.mode = mode;
    this.token = token;
  }

  /** Who is signed in (null if nobody, or if the session ended). */
  currentUser(): ReturnType<AppServices['auth']['getSession']> | null {
    if (!this.token) return null;
    try {
      return this.services.auth.getSession(this.token);
    } catch {
      this.token = null;
      return null;
    }
  }

  async invoke(method: string, args: unknown[] = []): Promise<ApiResult> {
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(METHODS, method)) return { ok: false, error: { code: 'NOT_FOUND', message: `unknown operation: ${String(method)}` } };
    if (!Array.isArray(args)) return { ok: false, error: { code: 'VALIDATION', message: 'bad request' } };
    const entry = (METHODS as Record<string, { auth: boolean; fn: Handler }>)[method];
    if (!entry) return { ok: false, error: { code: 'NOT_FOUND', message: 'unknown operation' } };
    try {
      if (entry.auth && !this.currentUser()) return { ok: false, error: { code: 'AUTH_FAILED', message: 'please sign in again' } };
      const data = await (entry.fn as (c: Ctx, ...a: unknown[]) => unknown)({ s: this.services, token: this.token ?? '', host: this }, ...args);
      return { ok: true, data: data === undefined ? null : data };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } };
      this.hooks.log(`operation ${method} failed`, e);
      return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again; if it keeps happening, tell the person who looks after this program.' } };
    }
  }
}

const METHODS = {
  // ---- who and where am I
  'app.state': open((c) => ({ firstRun: c.s.auth.isFirstRun(), mode: c.host.mode, version: c.host.hooks.appVersion, user: c.host.currentUser() })),
  'auth.firstRunSetup': open((c, input: { username: string; displayName: string; password: string }) => c.s.auth.firstRunSetup(input)),
  'auth.login': open(async (c, username: string, password: string) => {
    const r = await c.s.auth.login(username, password);
    c.host.setSession(r.token);
    return r.user;
  }),
  'auth.logout': open((c) => {
    if (c.host.currentUser()) c.s.auth.logout(c.token);
    c.host.setSession(null);
  }),
  'auth.changePassword': auth((c, current: string, next: string) => c.s.auth.changePassword(c.token, current, next)),
  'auth.recoverOwnerPassword': open((c, username: string, code: string, next: string) => c.s.auth.recoverOwnerPassword(username, code, next)),
  // ---- demo
  'demo.enter': open(async (c) => {
    const d = await c.host.hooks.enterDemo();
    c.host.useServices(d.services, 'DEMO', d.ownerToken);
  }),
  'demo.exit': open((c) => {
    c.host.hooks.exitDemo();
    c.host.useServices(c.host.realServices, 'REAL', null);
  }),
  // ---- screens
  'dashboard.get': auth((c) => c.s.reports.dashboard(c.token)),
  'items.list': auth((c, f: object | undefined) => c.s.items.list(c.token, { limit: 300, ...(f ?? {}) })),
  'customers.list': auth((c, f: object | undefined) => c.s.customers.list(c.token, { limit: 300, ...(f ?? {}) })),
  'sales.list': auth((c, f: object | undefined) => c.s.sales.list(c.token, { limit: 200, ...(f ?? {}) })),
  'settings.get': auth((c) => c.s.settings.get(c.token)),
  // ---- settings
  'settings.update': auth((c, patch: object) => c.s.settings.update(c.token, patch as never)),
  // ---- items and stock
  'items.get': auth((c, id: number) => c.s.items.get(c.token, id)),
  'items.create': auth((c, input: object) => c.s.items.create(c.token, input as never)),
  'items.update': auth((c, id: number, patch: object) => c.s.items.update(c.token, id, patch as never)),
  'items.setActive': auth((c, id: number, active: boolean) => c.s.items.setActive(c.token, id, active)),
  'items.categories': auth((c) => c.s.items.listCategories(c.token)),
  'items.createCategory': auth((c, name: string) => c.s.items.createCategory(c.token, name)),
  'stock.recordLoss': auth((c, input: object) => c.s.stock.recordLoss(c.token, input as never)),
  'stock.recordCount': auth((c, input: object) => c.s.stock.recordCount(c.token, input as never)),
  // ---- customers, suppliers, payments
  'customers.get': auth((c, id: number) => c.s.customers.get(c.token, id)),
  'customers.create': auth((c, input: object) => c.s.customers.create(c.token, input as never)),
  'customers.update': auth((c, id: number, patch: object) => c.s.customers.update(c.token, id, patch as never)),
  'customers.approve': auth((c, id: number) => c.s.customers.approve(c.token, id)),
  'customers.reject': auth((c, id: number, reason: string) => c.s.customers.reject(c.token, id, reason)),
  'customers.statement': auth((c, id: number) => c.s.customers.statement(c.token, id)),
  'suppliers.list': auth((c, f: object | undefined) => c.s.suppliers.list(c.token, { limit: 300, ...(f ?? {}) })),
  'suppliers.create': auth((c, input: object) => c.s.suppliers.create(c.token, input as never)),
  'suppliers.update': auth((c, id: number, patch: object) => c.s.suppliers.update(c.token, id, patch as never)),
  'suppliers.statement': auth((c, id: number) => c.s.suppliers.statement(c.token, id)),
  'payments.record': auth((c, input: object) => c.s.payments.record(c.token, input as never)),
  'payments.reverse': auth((c, id: number, reason: string) => c.s.payments.reverse(c.token, id, reason)),
  'supplierPayments.record': auth((c, input: object) => c.s.supplierPayments.record(c.token, input as never)),
  // ---- sale bills
  'sales.quoteLine': auth((c, input: object) => c.s.sales.quoteLine(c.token, input as never)),
  'sales.preview': auth((c, input: object) => c.s.sales.preview(c.token, input as never)),
  'sales.saveDraft': auth((c, input: object) => c.s.sales.saveDraft(c.token, input as never)),
  'sales.get': auth((c, id: number) => c.s.sales.get(c.token, id)),
  'sales.confirm': auth((c, id: number, opts: object | undefined) => c.s.sales.confirm(c.token, id, (opts ?? {}) as never)),
  'sales.cancel': auth((c, id: number, reason: string) => c.s.sales.cancel(c.token, id, reason)),
  'sales.deleteDraft': auth((c, id: number) => c.s.sales.deleteDraft(c.token, id)),
  // ---- purchase bills
  'purchases.list': auth((c, f: object | undefined) => c.s.purchases.list(c.token, { limit: 200, ...(f ?? {}) })),
  'purchases.quoteLine': auth((c, input: object) => c.s.purchases.quoteLine(c.token, input as never)),
  'purchases.preview': auth((c, input: object) => c.s.purchases.preview(c.token, input as never)),
  'purchases.saveDraft': auth((c, input: object) => c.s.purchases.saveDraft(c.token, input as never)),
  'purchases.get': auth((c, id: number) => c.s.purchases.get(c.token, id)),
  'purchases.confirm': auth((c, id: number, opts: object | undefined) => c.s.purchases.confirm(c.token, id, (opts ?? {}) as never)),
  'purchases.receive': auth((c, id: number, input: object) => c.s.purchases.receive(c.token, id, input as never)),
  'purchases.cancel': auth((c, id: number, reason: string) => c.s.purchases.cancel(c.token, id, reason)),
  'purchases.deleteDraft': auth((c, id: number) => c.s.purchases.deleteDraft(c.token, id)),
  // ---- reports
  'reports.table': auth((c, req: object) => c.s.reports.table(c.token, req as never)),
  // ---- backup
  'backup.status': auth((c) => (c.s.backup ? c.s.backup.status(c.token) : null)),
  'backup.history': auth((c) => (c.s.backup ? c.s.backup.history(c.token, 10) : [])),
  'backup.chooseFolder': auth((c) => c.host.hooks.chooseFolder()),
  'backup.create': auth(async (c, folder?: string) => {
    if (!c.s.backup) throw new AppError('INVARIANT', 'backups are not available here');
    const chosen = folder ?? c.s.settings.get(c.token).backupFolder ?? (await c.host.hooks.chooseFolder());
    if (!chosen) return null; // the user cancelled the folder dialog
    return c.s.backup.create(c.token, { folder: chosen });
  }),
  // ---- printing
  'print.invoicePdf': auth((c, billId: number) => c.host.hooks.saveInvoicePdf(billId)),
  'print.invoicePrint': auth((c, billId: number) => c.host.hooks.printInvoice(billId)),
} satisfies Record<string, { auth: boolean; fn: Handler }>;

export const METHOD_NAMES = Object.keys(METHODS);
