import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertCustomerUsable, type CustomerInput } from '../../src/application/parties/customerService';
import { postCustomerLedger } from '../../src/infrastructure/db/ledgers';
import { UnitOfWork } from '../../src/infrastructure/db/unitOfWork';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { setupHarness, type Harness } from '../helpers/auth';

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const farm: CustomerInput = { name: 'TEST DAIRY FARM', state: 'West Bengal', address: 'Vill Example, Hooghly 712000', placeOfSupply: 'EXAMPLEPUR' };

async function employee(h: Harness, username: string, permissions: string[]): Promise<string> {
  await h.users.createEmployee(h.ownerToken, { username, displayName: `Clerk ${username}`, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await h.auth.login(username, 'temp-pass-123');
  await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return token;
}
/** Post to a customer's ledger at a chosen instant. */
function post(h: Harness, iso: string, customerId: number, entryType: 'SALE' | 'PAYMENT', amountPaise: number, refNo?: string): void {
  new UnitOfWork(h.db, { now: () => new Date(iso) }).run({ userId: 1, role: 'OWNER' }, (ctx) => postCustomerLedger(ctx, { partyId: customerId, entryType, amountPaise, refNo }));
}

// the shop is in India: day boundaries below are local days in UTC+5:30
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('creating customers', () => {
  it('the owner creates an approved customer; an employee creates a pending one', async () => {
    const h = await setupHarness();
    const a = h.customers.create(h.ownerToken, farm);
    const clerk = await employee(h, 'clerk', ['customer.create', 'customer.view']);
    const b = h.customers.create(clerk, { ...farm, name: 'CLERK ADDED FARM' });
    expect(h.customers.get(h.ownerToken, a)).toMatchObject({ approvalStatus: 'APPROVED', createdByName: 'Shop Owner', gstinDisplay: 'UN-REGD', balancePaise: 0, isActive: true });
    expect(h.customers.get(h.ownerToken, b)).toMatchObject({ approvalStatus: 'PENDING', createdByName: 'Clerk clerk' });
    expect(h.db.prepare('SELECT approved_by FROM customer WHERE id = ?').get(b)).toEqual({ approved_by: null });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'CUSTOMER_CREATE'").get()).toEqual({ n: 2 });
  });

  it('needs customer.create', async () => {
    const h = await setupHarness();
    const viewer = await employee(h, 'viewer', ['customer.view']);
    expect(codeOf(() => h.customers.create(viewer, farm))).toBe('PERMISSION_DENIED');
  });

  it('requires a state, but can take it from the GSTIN', async () => {
    const h = await setupHarness();
    expect(codeOf(() => h.customers.create(h.ownerToken, { name: 'NO STATE' }))).toBe('VALIDATION');
    const id = h.customers.create(h.ownerToken, { name: 'GST FIRM', gstin: '27abcde1234f1z0' });
    expect(h.customers.get(h.ownerToken, id)).toMatchObject({ state: 'Maharashtra', stateCode: '27', gstin: '27ABCDE1234F1Z0', gstinDisplay: '27ABCDE1234F1Z0' });
  });

  it('rejects a bad GSTIN, a GSTIN that disagrees with the state, and an unknown state', async () => {
    const h = await setupHarness();
    expect(codeOf(() => h.customers.create(h.ownerToken, { ...farm, gstin: '19ABCDE1234F1ZY' }))).toBe('VALIDATION'); // check digit
    expect(codeOf(() => h.customers.create(h.ownerToken, { ...farm, gstin: '27ABCDE1234F1Z0' }))).toBe('VALIDATION'); // Maharashtra GSTIN, West Bengal state
    expect(codeOf(() => h.customers.create(h.ownerToken, { ...farm, state: 'Atlantis' }))).toBe('VALIDATION');
    expect(h.customers.list(h.ownerToken).total).toBe(0);
  });

  it('refuses a second customer with the same GSTIN, in the service and in the database', async () => {
    const h = await setupHarness();
    h.customers.create(h.ownerToken, { ...farm, gstin: '19ABCDE1234F1ZX' });
    expect(codeOf(() => h.customers.create(h.ownerToken, { ...farm, name: 'OTHER', gstin: '19abcde1234f1zx' }))).toBe('CONFLICT');
    expect(() => h.db.prepare("INSERT INTO customer (name, gstin, created_at) VALUES ('RAW', '19ABCDE1234F1ZX', 't')").run()).toThrow(/UNIQUE/);
    h.customers.create(h.ownerToken, { ...farm, name: 'NO GSTIN 1' });
    h.customers.create(h.ownerToken, { ...farm, name: 'NO GSTIN 2' }); // several unregistered customers are fine
  });

  it('lists every validation problem together', async () => {
    const h = await setupHarness();
    let err: AppError | undefined;
    try {
      h.customers.create(h.ownerToken, { name: '  ', phone: 'abc', email: 'nope', state: 'Atlantis' });
    } catch (e) {
      err = e as AppError;
    }
    expect((err?.details?.problems as string[]).length).toBeGreaterThanOrEqual(4);
  });

  it('opening balance: owner only, posted as an OPENING ledger entry, books still agree', async () => {
    const h = await setupHarness();
    const id = h.customers.create(h.ownerToken, { ...farm, openingBalancePaise: 250000 });
    expect(h.customers.get(h.ownerToken, id).balancePaise).toBe(250000);
    expect(h.db.prepare('SELECT entry_type, amount_paise FROM customer_ledger').get()).toEqual({ entry_type: 'OPENING', amount_paise: 250000 });
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
    const clerk = await employee(h, 'clerk', ['customer.create']);
    expect(codeOf(() => h.customers.create(clerk, { ...farm, name: 'X', openingBalancePaise: 100 }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.customers.create(h.ownerToken, { ...farm, name: 'Y', openingBalancePaise: -5 }))).toBe('VALIDATION');
  });
});

describe('owner approval', () => {
  it('only the owner sees the queue; approve and reject are audited and reject needs a reason', async () => {
    const h = await setupHarness();
    const clerk = await employee(h, 'clerk', ['customer.create', 'customer.view']);
    const a = h.customers.create(clerk, { ...farm, name: 'PENDING A' });
    const b = h.customers.create(clerk, { ...farm, name: 'PENDING B' });
    expect(codeOf(() => h.customers.pendingApprovals(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.customers.approve(clerk, a))).toBe('PERMISSION_DENIED');
    expect(h.customers.pendingApprovals(h.ownerToken).map((c) => c.name)).toEqual(['PENDING A', 'PENDING B']);

    h.customers.approve(h.ownerToken, a);
    expect(codeOf(() => h.customers.reject(h.ownerToken, b, ' '))).toBe('VALIDATION');
    h.customers.reject(h.ownerToken, b, 'duplicate of an existing customer');
    expect(h.customers.pendingApprovals(h.ownerToken)).toEqual([]);
    expect(h.customers.get(h.ownerToken, a).approvalStatus).toBe('APPROVED');
    expect(h.db.prepare('SELECT approved_by FROM customer WHERE id = ?').get(a)).toEqual({ approved_by: 1 });
    expect(h.db.prepare("SELECT reason FROM audit_log WHERE action = 'CUSTOMER_REJECT'").get()).toEqual({ reason: 'duplicate of an existing customer' });
    expect(codeOf(() => h.customers.reject(h.ownerToken, a, 'too late'))).toBe('CONFLICT'); // only pending ones
    expect(codeOf(() => h.customers.approve(h.ownerToken, 999))).toBe('NOT_FOUND');
  });

  it('rejected customers are hidden by default but can be found and re-approved', async () => {
    const h = await setupHarness();
    const clerk = await employee(h, 'clerk', ['customer.create', 'customer.view']);
    const id = h.customers.create(clerk, farm);
    h.customers.reject(h.ownerToken, id, 'wrong details');
    expect(h.customers.list(h.ownerToken).total).toBe(0);
    expect(h.customers.list(h.ownerToken, { approval: 'REJECTED' }).total).toBe(1);
    h.customers.approve(h.ownerToken, id);
    expect(h.customers.list(h.ownerToken).total).toBe(1);
  });

  it('a pending customer can be drafted against but not confirmed; a rejected one cannot be used at all', async () => {
    const h = await setupHarness();
    const clerk = await employee(h, 'clerk', ['customer.create']);
    const pending = h.customers.create(clerk, farm);
    expect(codeOf(() => assertCustomerUsable(h.db, pending, 'DRAFT'))).toBe('NO_ERROR');
    expect(codeOf(() => assertCustomerUsable(h.db, pending, 'CONFIRM'))).toBe('CUSTOMER_NOT_APPROVED');
    h.customers.approve(h.ownerToken, pending);
    expect(codeOf(() => assertCustomerUsable(h.db, pending, 'CONFIRM'))).toBe('NO_ERROR');

    const other = h.customers.create(clerk, { ...farm, name: 'OTHER' });
    h.customers.reject(h.ownerToken, other, 'not a real customer');
    expect(codeOf(() => assertCustomerUsable(h.db, other, 'DRAFT'))).toBe('CUSTOMER_NOT_APPROVED');
    expect(codeOf(() => assertCustomerUsable(h.db, 999, 'DRAFT'))).toBe('NOT_FOUND');
    h.customers.setActive(h.ownerToken, pending, false);
    expect(codeOf(() => assertCustomerUsable(h.db, pending, 'DRAFT'))).toBe('CONFLICT');
  });
});

describe('editing customers', () => {
  it('whoever created a pending customer may correct it; once approved, editing needs customer.edit', async () => {
    const h = await setupHarness();
    const clerk = await employee(h, 'clerk', ['customer.create', 'customer.view']);
    const other = await employee(h, 'other', ['customer.create', 'customer.view']);
    const id = h.customers.create(clerk, farm);
    expect(h.customers.update(clerk, id, { name: 'TEST DAIRY FARM (CORRECTED)' }).name).toBe('TEST DAIRY FARM (CORRECTED)');
    expect(codeOf(() => h.customers.update(other, id, { phone: '9830012345' }))).toBe('PERMISSION_DENIED');
    h.customers.approve(h.ownerToken, id);
    expect(codeOf(() => h.customers.update(clerk, id, { phone: '9830012345' }))).toBe('PERMISSION_DENIED');
    const editor = await employee(h, 'editor', ['customer.edit', 'customer.view']);
    expect(h.customers.update(editor, id, { phone: '9830012345' }).phone).toBe('9830012345');
  });

  it('audits only what changed, with old and new values, and does nothing for a no-op', async () => {
    const h = await setupHarness();
    const id = h.customers.create(h.ownerToken, farm);
    h.customers.update(h.ownerToken, id, { phone: '+91 98300-12345', name: farm.name });
    const row = h.db.prepare("SELECT detail_json, user_id FROM audit_log WHERE action = 'CUSTOMER_UPDATE'").get() as { detail_json: string; user_id: number };
    expect(JSON.parse(row.detail_json).changes).toEqual({ phone: { from: null, to: '+91 98300-12345' } });
    expect(row.user_id).toBe(1);
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    h.customers.update(h.ownerToken, id, { phone: '+91 98300-12345' });
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(before);
  });

  it('keeps the state and GSTIN consistent when either one changes', async () => {
    const h = await setupHarness();
    const id = h.customers.create(h.ownerToken, farm);
    expect(codeOf(() => h.customers.update(h.ownerToken, id, { gstin: '27ABCDE1234F1Z0' }))).toBe('VALIDATION'); // still West Bengal
    h.customers.update(h.ownerToken, id, { gstin: '19ABCDE1234F1ZX' });
    expect(codeOf(() => h.customers.update(h.ownerToken, id, { state: 'Bihar' }))).toBe('VALIDATION');
    h.customers.update(h.ownerToken, id, { gstin: '27ABCDE1234F1Z0', state: 'Maharashtra' });
    expect(h.customers.get(h.ownerToken, id)).toMatchObject({ state: 'Maharashtra', gstin: '27ABCDE1234F1Z0' });
    expect(codeOf(() => h.customers.update(h.ownerToken, id, { state: null }))).toBe('NO_ERROR'); // state is re-derived from the GSTIN
    expect(h.customers.get(h.ownerToken, id).state).toBe('Maharashtra');
    const other = h.customers.create(h.ownerToken, { ...farm, name: 'OTHER' });
    expect(codeOf(() => h.customers.update(h.ownerToken, other, { state: 'Maharashtra', gstin: '27ABCDE1234F1Z0' }))).toBe('CONFLICT'); // already taken
  });

  it('never changes bills that were already issued', async () => {
    const h = await setupHarness();
    const id = h.customers.create(h.ownerToken, { ...farm, gstin: '19ABCDE1234F1ZX' });
    h.db
      .prepare(
        `INSERT INTO sale_bill (id, status, bill_no, invoice_date, customer_id, cust_name, cust_address, cust_gstin, cust_state, tax_type, total_paise, created_by, created_at)
         VALUES (1, 'CONFIRMED', 'BZ260001', '2026-10-31', ?, ?, ?, ?, ?, 'INTRA', 100, 1, 't')`,
      )
      .run(id, 'TEST DAIRY FARM', 'Vill Example, Hooghly 712000', '19ABCDE1234F1ZX', 'West Bengal');
    h.customers.update(h.ownerToken, id, { name: 'RENAMED FARM', address: 'A completely new address', gstin: '19PQRST5678K1ZZ' });
    expect(h.customers.get(h.ownerToken, id)).toMatchObject({ name: 'RENAMED FARM', gstin: '19PQRST5678K1ZZ' });
    expect(h.db.prepare('SELECT cust_name, cust_address, cust_gstin, cust_state FROM sale_bill WHERE id = 1').get()).toEqual({
      cust_name: 'TEST DAIRY FARM', cust_address: 'Vill Example, Hooghly 712000', cust_gstin: '19ABCDE1234F1ZX', cust_state: 'West Bengal',
    });
  });

  it('cannot make a customer with a balance inactive', async () => {
    const h = await setupHarness();
    const id = h.customers.create(h.ownerToken, { ...farm, openingBalancePaise: 5000 });
    expect(codeOf(() => h.customers.setActive(h.ownerToken, id, false))).toBe('CONFLICT');
    post(h, '2026-11-07T10:00:00.000Z', id, 'PAYMENT', -5000);
    h.customers.setActive(h.ownerToken, id, false);
    expect(h.customers.list(h.ownerToken).total).toBe(0);
    expect(h.customers.list(h.ownerToken, { active: false }).total).toBe(1);
  });
});

describe('searching customers', () => {
  async function seeded(): Promise<Harness> {
    const h = await setupHarness();
    h.customers.create(h.ownerToken, { name: 'ALPHA DAIRY', state: 'West Bengal', phone: '+91 98300-12345', address: 'Burdwan', gstin: '19ABCDE1234F1ZX' });
    h.customers.create(h.ownerToken, { name: '10% DISCOUNT TRADERS', state: 'Bihar', placeOfSupply: 'Patna' });
    h.customers.create(h.ownerToken, { name: 'CHARLIE FARM', state: 'West Bengal', openingBalancePaise: 70000 });
    return h;
  }
  it('finds by name, GSTIN, address, place of supply and phone digits (ignoring spaces and dashes)', async () => {
    const h = await seeded();
    const find = (search: string): string[] => h.customers.list(h.ownerToken, { search }).rows.map((r) => r.name);
    expect(find('alpha')).toEqual(['ALPHA DAIRY']);
    expect(find('19abcde')).toEqual(['ALPHA DAIRY']);
    expect(find('burdwan')).toEqual(['ALPHA DAIRY']);
    expect(find('patna')).toEqual(['10% DISCOUNT TRADERS']);
    expect(find('9830012345')).toEqual(['ALPHA DAIRY']);
    expect(find('98300 123')).toEqual(['ALPHA DAIRY']);
    expect(find('%')).toEqual(['10% DISCOUNT TRADERS']); // literal percent sign
    expect(find('_')).toEqual([]);
  });
  it('filters by dues, sorts by balance and pages with a total', async () => {
    const h = await seeded();
    expect(h.customers.list(h.ownerToken, { hasDues: true }).rows.map((r) => r.name)).toEqual(['CHARLIE FARM']);
    expect(h.customers.list(h.ownerToken, { sortBy: 'balance', descending: true }).rows[0]?.name).toBe('CHARLIE FARM');
    const page = h.customers.list(h.ownerToken, { limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.name)).toEqual(['CHARLIE FARM']);
  });
  it('requires customer.view', async () => {
    const h = await seeded();
    const nobody = await employee(h, 'nobody', ['sale.create']);
    expect(codeOf(() => h.customers.list(nobody))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.customers.dues(nobody))).toBe('PERMISSION_DENIED');
  });
});

describe('dues and statements', () => {
  async function ledgerWorld(): Promise<{ h: Harness; a: number; b: number; c: number }> {
    const h = await setupHarness();
    const a = h.customers.create(h.ownerToken, { ...farm, name: 'ALPHA DAIRY' });
    const b = h.customers.create(h.ownerToken, { ...farm, name: 'BRAVO MILK CENTRE' });
    const c = h.customers.create(h.ownerToken, { ...farm, name: 'CHARLIE FARM' });
    h.customers.create(h.ownerToken, { ...farm, name: 'DELTA TRADERS' }); // never owes
    h.db.prepare('UPDATE customer SET advance_allowed = 1 WHERE id = ?').run(c);
    post(h, '2026-11-01T04:30:00.000Z', a, 'SALE', 100000, 'BZ260001'); // 1 Nov, 10:00 IST
    post(h, '2026-11-02T06:30:00.000Z', b, 'SALE', 50000, 'BZ260002'); // 2 Nov, 12:00 IST
    post(h, '2026-11-03T06:30:00.000Z', a, 'PAYMENT', -40000, 'RC260001'); // 3 Nov
    post(h, '2026-11-03T07:30:00.000Z', c, 'PAYMENT', -20000, 'RC260002'); // an advance
    post(h, '2026-11-05T06:30:00.000Z', a, 'SALE', 20000, 'BZ260003'); // 5 Nov
    return { h, a, b, c };
  }

  it('lists who owes what, largest first, with the total outstanding', async () => {
    const { h } = await ledgerWorld();
    const d = h.customers.dues(h.ownerToken);
    expect(d.rows.map((r) => [r.name, r.balancePaise])).toEqual([['ALPHA DAIRY', 80000], ['BRAVO MILK CENTRE', 50000]]);
    expect(d.totalOutstandingPaise).toBe(130000);
    expect(d.customerCount).toBe(2);
    expect(d.rows[0]).toMatchObject({ lastSaleAt: '2026-11-05T06:30:00.000Z', lastPaymentAt: '2026-11-03T06:30:00.000Z' });
    expect(d.rows[1]?.lastPaymentAt).toBeNull();
    expect(h.customers.dues(h.ownerToken, { includeAdvances: true }).customerCount).toBe(3);
    expect(h.customers.dues(h.ownerToken, { sortBy: 'name' }).rows[0]?.name).toBe('ALPHA DAIRY');
  });

  it('rebuilds balances as at the end of a past local day, with search combined', async () => {
    const { h } = await ledgerWorld();
    expect(h.customers.dues(h.ownerToken, { asOfDate: '2026-11-01' }).rows.map((r) => [r.name, r.balancePaise])).toEqual([['ALPHA DAIRY', 100000]]);
    const nov2 = h.customers.dues(h.ownerToken, { asOfDate: '2026-11-02' });
    expect(nov2.totalOutstandingPaise).toBe(150000);
    expect(nov2.rows[0]).toMatchObject({ name: 'ALPHA DAIRY', lastPaymentAt: null });
    const onlyBravo = h.customers.dues(h.ownerToken, { asOfDate: '2026-11-04', search: 'bravo' });
    expect(onlyBravo.rows.map((r) => [r.name, r.balancePaise])).toEqual([['BRAVO MILK CENTRE', 50000]]);
    expect(h.customers.dues(h.ownerToken, { asOfDate: '2026-11-04', search: 'alpha' }).rows[0]).toMatchObject({ balancePaise: 60000, lastPaymentAt: '2026-11-03T06:30:00.000Z' });
    expect(codeOf(() => h.customers.dues(h.ownerToken, { asOfDate: 'last week' }))).toBe('VALIDATION');
  });

  it('statement: opening + entries = closing, for any range', async () => {
    const { h, a } = await ledgerWorld();
    const all = h.customers.statement(h.ownerToken, a);
    expect(all).toMatchObject({ openingPaise: 0, closingPaise: 80000, increasesPaise: 120000, reducesPaise: 40000 });
    expect(all.entries.map((e) => [e.label, e.refNo, e.amountPaise, e.balanceAfterPaise])).toEqual([
      ['Sale', 'BZ260001', 100000, 100000], ['Payment', 'RC260001', -40000, 60000], ['Sale', 'BZ260003', 20000, 80000],
    ]);
    expect(all.customer.name).toBe('ALPHA DAIRY');

    const mid = h.customers.statement(h.ownerToken, a, '2026-11-02', '2026-11-04');
    expect(mid).toMatchObject({ openingPaise: 100000, closingPaise: 60000, increasesPaise: 0, reducesPaise: 40000 });
    expect(mid.entries).toHaveLength(1);
    const after = h.customers.statement(h.ownerToken, a, '2026-11-06');
    expect(after).toMatchObject({ openingPaise: 80000, closingPaise: 80000, entries: [] });
    for (const s of [all, mid, after]) expect(s.openingPaise + s.increasesPaise - s.reducesPaise).toBe(s.closingPaise);
    expect(codeOf(() => h.customers.statement(h.ownerToken, 999))).toBe('NOT_FOUND');
    expect(codeOf(() => h.customers.statement(h.ownerToken, a, '2026-11-05', '2026-11-01'))).toBe('VALIDATION');
  });

  it('exports statements and dues as CSV with real numbers', async () => {
    const { h, a } = await ledgerWorld();
    const csv = h.customers.exportStatementCsv(h.ownerToken, a);
    expect(csv.startsWith('\uFEFFDate and time,Entry,Reference,Note,Debit (Rs),Credit (Rs),Balance (Rs)\r\n')).toBe(true);
    expect(csv).toContain(',Opening balance,,,,,0\r\n');
    expect(csv).toContain('2026-11-01 10:00,Sale,BZ260001,,1000,,1000\r\n');
    expect(csv).toContain('2026-11-03 12:00,Payment,RC260001,,,400,600\r\n');
    expect(csv).toContain(',Closing balance,,,1200,400,800\r\n');
    const dues = h.customers.exportDuesCsv(h.ownerToken);
    expect(dues).toContain('ALPHA DAIRY,,800,2026-11-05 12:00,2026-11-03 12:00');
  });
});
