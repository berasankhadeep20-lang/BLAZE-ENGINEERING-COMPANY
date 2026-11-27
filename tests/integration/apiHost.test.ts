import { describe, expect, it } from 'vitest';
import { createServices } from '../../src/application/composition';
import { openDatabase } from '../../src/infrastructure/db/connection';
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrate';
import { ApiHost, METHOD_NAMES, type HostHooks } from '../../src/main/apiHost';
import { fakeHasher } from '../helpers/auth';
import { MIGRATIONS_DIR } from '../helpers/fileWorld';

function makeHost(over: Partial<HostHooks> = {}): { host: ApiHost; logs: string[] } {
  const db = openDatabase(':memory:');
  migrate(db, loadMigrations(MIGRATIONS_DIR));
  const logs: string[] = [];
  const hooks: HostHooks = {
    appVersion: '9.9.9', log: (m) => logs.push(m), enterDemo: () => Promise.reject(new Error('no demo here')), exitDemo: () => undefined,
    chooseFolder: () => Promise.resolve(null), saveInvoicePdf: () => Promise.resolve({ saved: false }), printInvoice: () => Promise.resolve({ printed: false }), ...over,
  };
  return { host: new ApiHost(createServices({ db, hasher: fakeHasher }), hooks), logs };
}
const setup = { username: 'owner', displayName: 'Shop Owner', password: 'owner-pass-1' };

describe('the door between the window and the program', () => {
  it('only knows the operations on its list; names like constructor or __proto__ are not operations', async () => {
    const { host } = makeHost();
    for (const m of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'auth.login.__proto__', '']) {
      expect(await host.invoke(m, [])).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    expect(METHOD_NAMES).toContain('dashboard.get');
    expect(METHOD_NAMES.some((m) => m.includes('actorFor') || m.includes('sessions'))).toBe(false);
    expect(await host.invoke('app.state', 'not-an-array' as never)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('sets up the owner once, signs in, and the window never sees a token', async () => {
    const { host } = makeHost();
    expect(await host.invoke('app.state')).toMatchObject({ ok: true, data: { firstRun: true, mode: 'REAL', version: '9.9.9', user: null } });
    const made = await host.invoke('auth.firstRunSetup', [setup]);
    expect(made).toMatchObject({ ok: true });
    expect((made as { data: { recoveryCode: string } }).data.recoveryCode).toMatch(/^([A-Z2-9]{5}-){4}[A-Z2-9]{5}$/);
    expect(await host.invoke('auth.firstRunSetup', [setup])).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const login = await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    expect(login).toMatchObject({ ok: true, data: { username: 'owner', role: 'OWNER' } });
    expect(JSON.stringify(login)).not.toMatch(/token/i);
    const state = await host.invoke('app.state');
    expect(JSON.stringify(state)).not.toMatch(/token/i);
    expect(state).toMatchObject({ data: { firstRun: false, user: { displayName: 'Shop Owner' } } });
    expect(await host.invoke('dashboard.get')).toMatchObject({ ok: true });
    expect(await host.invoke('items.list', [{ search: 'x' }])).toMatchObject({ ok: true, data: { rows: [], total: 0 } });
  });

  it('refuses everything that needs a session until someone has signed in, and again after sign-out', async () => {
    const { host } = makeHost();
    await host.invoke('auth.firstRunSetup', [setup]);
    for (const m of ['dashboard.get', 'items.list', 'customers.list', 'sales.list', 'settings.get', 'backup.status', 'backup.create', 'print.invoicePdf']) {
      expect(await host.invoke(m, [1]), m).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    }
    expect(await host.invoke('auth.login', ['owner', 'wrong-pass-1'])).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    expect(await host.invoke('customers.list')).toMatchObject({ ok: true });
    await host.invoke('auth.logout');
    expect(await host.invoke('customers.list')).toMatchObject({ ok: false, error: { code: 'AUTH_FAILED' } });
    expect(await host.invoke('app.state')).toMatchObject({ data: { user: null } });
  });

  it('turns every failure into a plain message: known errors keep their code, surprises give no technical detail', async () => {
    const { host, logs } = makeHost({ chooseFolder: () => Promise.reject(new Error('C:\\secret\\path blew up')) });
    await host.invoke('auth.firstRunSetup', [setup]);
    await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    expect(await host.invoke('auth.changePassword', ['owner-pass-1', 'short'])).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const boom = await host.invoke('backup.chooseFolder');
    expect(boom).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(boom)).not.toMatch(/secret|blew up|stack/i);
    expect(logs.join(' ')).toContain('backup.chooseFolder'); // but it is written to the log for whoever supports the program
  });

  it('demo mode swaps the services and session, and leaving puts the real ones back', async () => {
    const demo = makeHost();
    await demo.host.invoke('auth.firstRunSetup', [setup]);
    const demoServices = demo.host.realServices;
    const ownerToken = (await demoServices.auth.login('owner', 'owner-pass-1')).token;
    let exited = false;
    const { host } = makeHost({ enterDemo: () => Promise.resolve({ services: demoServices, ownerToken }), exitDemo: () => (exited = true) });
    expect(await host.invoke('demo.enter')).toMatchObject({ ok: true });
    expect(await host.invoke('app.state')).toMatchObject({ data: { mode: 'DEMO', user: { username: 'owner' } } });
    expect(await host.invoke('demo.exit')).toMatchObject({ ok: true });
    expect(exited).toBe(true);
    expect(await host.invoke('app.state')).toMatchObject({ data: { mode: 'REAL', user: null } });
  });
});

describe('the whole working day through the window\'s door', () => {
  it('set up the business, add products, buy stock, make a bill at a typed rate, take payment, and look at the reports', async () => {
    const { host } = makeHost();
    const ok = async <T,>(method: string, ...args: unknown[]): Promise<T> => {
      const r = await host.invoke(method, args);
      if (!r.ok) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
      return r.data as T;
    };
    await host.invoke('auth.firstRunSetup', [setup]);
    await ok('auth.login', 'owner', 'owner-pass-1');
    await ok('settings.update', { businessName: 'TEST CO', businessState: 'West Bengal', invoicePrefix: 'bz', businessAddress: '1 Test Road', businessGstin: '19ABCDE1234F1ZX', bankName: 'TEST BANK', bankAccountNo: '123456789', bankIfsc: 'TEST0000001' });

    // products
    const category = await ok<number>('items.createCategory', 'Dairy equipment');
    const itemId = await ok<number>('items.create', { code: 'MC-40', name: 'PLASTIC MILK CAN', hsn: '3923', unit: 'LTR', packSize: '40', categoryId: category, purchaseRatePaise: 80000, saleRatePaise: 92500, gstRateBp: 1800, reorderQtyMilli: 2000, openingQtyMilli: 0 });
    expect(await ok('items.list', { search: 'milk' })).toMatchObject({ total: 1, rows: [{ code: 'MC-40', category: 'Dairy equipment', stockStatus: 'OUT' }] });
    await ok('items.update', itemId, { name: 'PLASTIC MILK CAN 40 LTR' });

    // people
    const customerId = await ok<number>('customers.create', { name: 'TEST DAIRY FARM', state: 'West Bengal', address: 'Vill Example' });
    const supplierId = await ok<number>('suppliers.create', { name: 'TEST SUPPLIER', state: 'West Bengal' });

    // buying stock
    const pq = await ok<{ currentRatePaise: number }>('purchases.quoteLine', { itemId, supplierId });
    expect(pq.currentRatePaise).toBe(80000);
    const pInput = { supplierId, supplierInvoiceNo: 'S-1', supplierInvoiceDate: '2026-11-01', billDate: '2026-11-01', lines: [{ itemId, invoicedQtyMilli: 10000, receivedQtyMilli: 6000, ratePaise: 80000 }] };
    expect(await ok('purchases.preview', pInput)).toMatchObject({ totals: { totalPaise: 944000 } });
    const draft = await ok<{ id: number }>('purchases.saveDraft', pInput);
    expect(await ok('purchases.confirm', draft.id, {})).toMatchObject({ status: 'CONFIRMED', goodsPending: true });
    expect(await ok('items.get', itemId)).toMatchObject({ qtyMilli: 6000 }); // only what was received
    await ok('purchases.receive', draft.id, { lines: [{ lineNo: 1, qtyMilli: 4000 }] });
    expect(await ok('items.get', itemId)).toMatchObject({ qtyMilli: 10000 });

    // making a bill: the current rate is shown first, then a different rate is typed
    const quote = await ok<{ currentRatePaise: number; canEditRate: boolean }>('sales.quoteLine', { itemId, customerId });
    expect(quote).toMatchObject({ currentRatePaise: 92500, canEditRate: true });
    const sInput = { customerId, invoiceDate: '2026-11-02', lines: [{ itemId, qtyMilli: 2000, ratePaise: 70000 }] }; // below the cost of 800.00
    const sprev = await ok<{ belowCostLines: unknown[]; totals: { totalPaise: number } }>('sales.preview', sInput);
    expect(sprev.belowCostLines).toHaveLength(1);
    const sdraft = await ok<{ id: number }>('sales.saveDraft', sInput);
    const refused = await host.invoke('sales.confirm', [sdraft.id, {}]);
    expect(refused).toMatchObject({ ok: false, error: { code: 'ACK_REQUIRED', details: { kind: 'BELOW_COST', lines: [{ lineNo: 1, itemCode: 'MC-40' }] } } }); // the window can show which lines
    const bill = await ok<{ id: number; billNo: string; totals: { totalPaise: number }; outstandingPaise: number }>('sales.confirm', sdraft.id, { acknowledgeBelowCost: true });
    expect(bill.billNo).toMatch(/^BZ26\d{4}$/);
    expect(await ok('items.get', itemId)).toMatchObject({ qtyMilli: 8000 });

    // payment, statement, stock correction
    await ok('payments.record', { customerId, amountPaise: 100000, method: 'Cash', saleBillId: bill.id });
    expect(await ok('sales.get', bill.id)).toMatchObject({ outstandingPaise: bill.totals.totalPaise - 100000, paymentStatus: 'PARTIAL' });
    expect(await ok('customers.statement', customerId)).toMatchObject({ closingPaise: bill.totals.totalPaise - 100000 });
    await ok('stock.recordCount', { itemId, countedQtyMilli: 7000, note: 'monthly count' });
    expect(await ok('items.get', itemId)).toMatchObject({ qtyMilli: 7000 });

    // reports and the dashboard
    expect(await ok('reports.table', { report: 'BEST_SELLERS' })).toMatchObject({ title: 'Best-selling items', rows: [expect.arrayContaining(['MC-40', 'PLASTIC MILK CAN 40 LTR', 'LTR', 2000, 1])] });
    expect(await ok('reports.table', { report: 'SALES_AND_PURCHASES', groupBy: 'day' })).toMatchObject({ columns: expect.any(Array) });
    expect(await ok('dashboard.get')).toMatchObject({ dues: { customersWithDues: 1 }, sales: expect.any(Object) });
  });

  it('an employee without permissions cannot reach the screens, and a surprise error never leaks details', async () => {
    const { host } = makeHost();
    await host.invoke('auth.firstRunSetup', [setup]);
    await host.invoke('auth.login', ['owner', 'owner-pass-1']);
    await host.realServices.users.createEmployee((host as unknown as { token: string }).token, { username: 'clerk', displayName: 'Clerk', temporaryPassword: 'temp-pass-123', permissions: ['sale.create'] });
    await host.invoke('auth.logout');
    await host.invoke('auth.login', ['clerk', 'temp-pass-123']);
    expect(await host.invoke('items.list')).toMatchObject({ ok: false, error: { code: 'PASSWORD_CHANGE_REQUIRED' } });
    await host.invoke('auth.changePassword', ['temp-pass-123', 'clerk-own-pass-9']);
    expect(await host.invoke('items.list')).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await host.invoke('settings.update', [{ businessName: 'x' }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await host.invoke('sales.preview', [{ customerId: 1, lines: 'not a list' }])).toMatchObject({ ok: false });
  });
});
