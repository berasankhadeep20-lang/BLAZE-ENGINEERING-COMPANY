import { describe, expect, it } from 'vitest';
import { assertSupplierUsable, type SupplierInput } from '../../src/application/parties/supplierService';
import { postSupplierLedger } from '../../src/infrastructure/db/ledgers';
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
const mill: SupplierInput = { name: 'SAMPLE DAIRY EQUIPMENT CO', state: 'Maharashtra', gstin: '27ABCDE1234F1Z0', phone: '022 5550 1234', address: 'Plot 1, Example Estate' };

async function employee(h: Harness, username: string, permissions: string[]): Promise<string> {
  await h.users.createEmployee(h.ownerToken, { username, displayName: username, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await h.auth.login(username, 'temp-pass-123');
  await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return token;
}
function post(h: Harness, iso: string, supplierId: number, entryType: 'PURCHASE' | 'PAYMENT', amountPaise: number): void {
  new UnitOfWork(h.db, { now: () => new Date(iso) }).run({ userId: 1, role: 'OWNER' }, (ctx) => postSupplierLedger(ctx, { partyId: supplierId, entryType, amountPaise }));
}

describe('suppliers', () => {
  it('creates a supplier, takes the state from the GSTIN, and records who created it', async () => {
    const h = await setupHarness();
    const id = h.suppliers.create(h.ownerToken, { ...mill, state: undefined });
    expect(h.suppliers.get(h.ownerToken, id)).toMatchObject({ state: 'Maharashtra', stateCode: '27', gstin: '27ABCDE1234F1Z0', createdByName: 'Shop Owner', balancePaise: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SUPPLIER_CREATE'").get()).toEqual({ n: 1 });
  });

  it('applies the same rules as customers: state, GSTIN check digit, one supplier per GSTIN', async () => {
    const h = await setupHarness();
    h.suppliers.create(h.ownerToken, mill);
    expect(codeOf(() => h.suppliers.create(h.ownerToken, { name: 'NO STATE' }))).toBe('VALIDATION');
    expect(codeOf(() => h.suppliers.create(h.ownerToken, { ...mill, name: 'BAD', gstin: '27ABCDE1234F1Z1' }))).toBe('VALIDATION');
    expect(codeOf(() => h.suppliers.create(h.ownerToken, { ...mill, name: 'MISMATCH', state: 'Bihar' }))).toBe('VALIDATION');
    expect(codeOf(() => h.suppliers.create(h.ownerToken, { ...mill, name: 'DUPLICATE' }))).toBe('CONFLICT');
    expect(h.suppliers.list(h.ownerToken).total).toBe(1);
  });

  it('needs supplier.edit to add or change, supplier.view to look', async () => {
    const h = await setupHarness();
    const viewer = await employee(h, 'viewer', ['supplier.view']);
    const buyer = await employee(h, 'buyer', ['supplier.edit', 'supplier.view']);
    const nobody = await employee(h, 'nobody', ['sale.create']);
    expect(codeOf(() => h.suppliers.create(viewer, mill))).toBe('PERMISSION_DENIED');
    const id = h.suppliers.create(buyer, mill);
    expect(codeOf(() => h.suppliers.update(viewer, id, { notes: 'x' }))).toBe('PERMISSION_DENIED');
    expect(h.suppliers.get(viewer, id).name).toBe(mill.name);
    expect(codeOf(() => h.suppliers.list(nobody))).toBe('PERMISSION_DENIED');
  });

  it('audits edits with old and new values; a no-op writes nothing', async () => {
    const h = await setupHarness();
    const id = h.suppliers.create(h.ownerToken, mill);
    h.suppliers.update(h.ownerToken, id, { phone: '022 5550 9999', name: mill.name });
    const row = h.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'SUPPLIER_UPDATE'").get() as { detail_json: string };
    expect(JSON.parse(row.detail_json).changes).toEqual({ phone: { from: '022 5550 1234', to: '022 5550 9999' } });
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    h.suppliers.update(h.ownerToken, id, { phone: '022 5550 9999' });
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(before);
    expect(codeOf(() => h.suppliers.update(h.ownerToken, 999, { notes: 'x' }))).toBe('NOT_FOUND');
  });

  it('opening balance is owner only and posts to the supplier ledger; books agree', async () => {
    const h = await setupHarness();
    const buyer = await employee(h, 'buyer', ['supplier.edit']);
    expect(codeOf(() => h.suppliers.create(buyer, { ...mill, openingBalancePaise: 100 }))).toBe('PERMISSION_DENIED');
    const id = h.suppliers.create(h.ownerToken, { ...mill, openingBalancePaise: 450000 });
    expect(h.suppliers.get(h.ownerToken, id).balancePaise).toBe(450000);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('lists with search and totals owed; cannot hide a supplier with a balance', async () => {
    const h = await setupHarness();
    const a = h.suppliers.create(h.ownerToken, { ...mill, openingBalancePaise: 450000 });
    h.suppliers.create(h.ownerToken, { name: 'GLASSWARE TRADERS', state: 'West Bengal', address: 'Kolkata' });
    const all = h.suppliers.list(h.ownerToken);
    expect(all).toMatchObject({ total: 2, totalOwedPaise: 450000 });
    expect(h.suppliers.list(h.ownerToken, { search: 'glass' }).rows.map((r) => r.name)).toEqual(['GLASSWARE TRADERS']);
    expect(h.suppliers.list(h.ownerToken, { search: '27ABCDE' }).total).toBe(1);
    expect(h.suppliers.list(h.ownerToken, { owedOnly: true }).rows.map((r) => r.id)).toEqual([a]);
    expect(codeOf(() => h.suppliers.setActive(h.ownerToken, a, false))).toBe('CONFLICT');
    post(h, '2026-11-07T10:00:00.000Z', a, 'PAYMENT', -450000);
    h.suppliers.setActive(h.ownerToken, a, false);
    expect(h.suppliers.list(h.ownerToken).total).toBe(1);
    expect(codeOf(() => assertSupplierUsable(h.db, a))).toBe('CONFLICT');
    h.suppliers.setActive(h.ownerToken, a, true);
    expect(codeOf(() => assertSupplierUsable(h.db, a))).toBe('NO_ERROR');
    expect(codeOf(() => assertSupplierUsable(h.db, 999))).toBe('NOT_FOUND');
  });

  it('statement shows purchases and payments; opening + entries = closing; exports to CSV', async () => {
    const h = await setupHarness();
    const id = h.suppliers.create(h.ownerToken, mill);
    post(h, '2026-11-01T04:30:00.000Z', id, 'PURCHASE', 300000);
    post(h, '2026-11-04T04:30:00.000Z', id, 'PAYMENT', -100000);
    const s = h.suppliers.statement(h.ownerToken, id);
    expect(s).toMatchObject({ openingPaise: 0, closingPaise: 200000, increasesPaise: 300000, reducesPaise: 100000 });
    expect(s.entries.map((e) => e.label)).toEqual(['Purchase', 'Payment']);
    expect(s.supplier.name).toBe(mill.name);
    expect(h.suppliers.exportStatementCsv(h.ownerToken, id)).toContain(',Closing balance,,,3000,1000,2000\r\n');
  });
});
