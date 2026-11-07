import { describe, expect, it } from 'vitest';
import type { ItemInput } from '../../src/application/inventory/itemService';
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

const milkCan: ItemInput = {
  code: 'MC-40', name: 'PLASTIC MILK CAN', hsn: '3923', unit: 'ltr', packSize: '40',
  purchaseRatePaise: 80000, saleRatePaise: 92500, gstRateBp: 1800, reorderQtyMilli: 5000,
};

async function employee(h: Harness, username: string, permissions: string[]): Promise<{ id: number; token: string }> {
  const id = await h.users.createEmployee(h.ownerToken, { username, displayName: username, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await h.auth.login(username, 'temp-pass-123');
  await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return { id, token };
}
const audit = (h: Harness, action: string): { detail_json: string; user_id: number }[] =>
  h.db.prepare('SELECT detail_json, user_id FROM audit_log WHERE action = ? ORDER BY id').all(action) as { detail_json: string; user_id: number }[];

describe('creating items', () => {
  it('stores the item with a normalised unit, and records who created it', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, milkCan);
    const item = h.items.get(h.ownerToken, id);
    expect(item).toMatchObject({ code: 'MC-40', unit: 'LTR', uomLabel: '40 - LTR', qtyMilli: 0, stockStatus: 'OUT', isActive: true, gstRateBp: 1800 });
    expect(h.db.prepare('SELECT created_by FROM item WHERE id = ?').get(id)).toEqual({ created_by: 1 });
    expect(audit(h, 'ITEM_CREATE')).toHaveLength(1);
  });

  it('needs both item.create and price.edit', async () => {
    const h = await setupHarness();
    const a = await employee(h, 'only.create', ['item.create']);
    const b = await employee(h, 'only.price', ['price.edit']);
    const c = await employee(h, 'both', ['item.create', 'price.edit']);
    expect(codeOf(() => h.items.create(a.token, milkCan))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.items.create(b.token, milkCan))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.items.create(c.token, milkCan))).toBe('NO_ERROR');
  });

  it('opening stock posts an OPENING movement, and needs stock.adjust', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, { ...milkCan, openingQtyMilli: 12000 });
    expect(h.items.get(h.ownerToken, id).qtyMilli).toBe(12000);
    expect(h.db.prepare('SELECT reason, qty_after_milli FROM stock_movement WHERE item_id = ?').get(id)).toEqual({ reason: 'OPENING', qty_after_milli: 12000 });
    const c = await employee(h, 'clerk', ['item.create', 'price.edit']);
    expect(codeOf(() => h.items.create(c.token, { ...milkCan, code: 'MC-41', openingQtyMilli: 1000 }))).toBe('PERMISSION_DENIED');
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM item WHERE code = 'MC-41'").get()).toEqual({ n: 0 }); // nothing half-created
  });

  it('rejects duplicate codes (case-insensitive) and bad input, listing every problem', () => {
    return setupHarness().then((h) => {
      h.items.create(h.ownerToken, milkCan);
      expect(codeOf(() => h.items.create(h.ownerToken, { ...milkCan, code: 'mc-40' }))).toBe('CONFLICT');
      let err: AppError | undefined;
      try {
        h.items.create(h.ownerToken, { ...milkCan, code: 'bad code', name: ' ', hsn: '39A', unit: '12', purchaseRatePaise: -1, gstRateBp: 10001 });
      } catch (e) {
        err = e as AppError;
      }
      expect(err?.code).toBe('VALIDATION');
      expect((err?.details?.problems as string[]).length).toBeGreaterThanOrEqual(6);
      expect(codeOf(() => h.items.create(h.ownerToken, { ...milkCan, code: 'X1', categoryId: 99 }))).toBe('NOT_FOUND');
      expect(codeOf(() => h.items.create(h.ownerToken, { ...milkCan, code: 'X2', supplierId: 99 }))).toBe('NOT_FOUND');
    });
  });

  it('accepts any GST rate up to 100% (the app never hard-codes legal tax slabs)', async () => {
    const h = await setupHarness();
    expect(codeOf(() => h.items.create(h.ownerToken, { ...milkCan, code: 'T40', gstRateBp: 4000 }))).toBe('NO_ERROR');
    expect(codeOf(() => h.items.create(h.ownerToken, { ...milkCan, code: 'T0', gstRateBp: 0 }))).toBe('NO_ERROR');
  });
});

describe('editing items', () => {
  it('splits permissions: item.edit for details, price.edit for rates and GST', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, milkCan);
    const editor = await employee(h, 'editor', ['item.edit']);
    h.items.update(editor.token, id, { name: 'PLASTIC MILK CAN 40 LTR', location: 'Rack 2' });
    expect(codeOf(() => h.items.update(editor.token, id, { saleRatePaise: 1 }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.items.update(editor.token, id, { gstRateBp: 500 }))).toBe('PERMISSION_DENIED');
    // sending the unchanged price along with a real edit is fine
    expect(codeOf(() => h.items.update(editor.token, id, { saleRatePaise: 92500, description: 'ISI marked' }))).toBe('NO_ERROR');
    const pricer = await employee(h, 'pricer', ['price.edit']);
    expect(codeOf(() => h.items.update(pricer.token, id, { saleRatePaise: 95000 }))).toBe('NO_ERROR');
    expect(codeOf(() => h.items.update(pricer.token, id, { name: 'renamed by pricer' }))).toBe('PERMISSION_DENIED');
    expect(h.items.get(h.ownerToken, id)).toMatchObject({ name: 'PLASTIC MILK CAN 40 LTR', saleRatePaise: 95000, location: 'Rack 2' });
  });

  it('audits price changes separately, with old and new values and the user', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, milkCan);
    h.items.update(h.ownerToken, id, { saleRatePaise: 99000, name: 'MILK CAN' });
    const price = audit(h, 'PRICE_CHANGE');
    expect(price).toHaveLength(1);
    expect(JSON.parse(price[0]?.detail_json ?? '{}')).toEqual({ code: 'MC-40', changes: { saleRatePaise: { from: 92500, to: 99000 } } });
    expect(price[0]?.user_id).toBe(1);
    expect(JSON.parse(audit(h, 'ITEM_UPDATE')[0]?.detail_json ?? '{}').changes).toEqual({ name: { from: 'PLASTIC MILK CAN', to: 'MILK CAN' } });
  });

  it('does nothing (and audits nothing) when nothing changes', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, milkCan);
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    h.items.update(h.ownerToken, id, { name: 'PLASTIC MILK CAN', saleRatePaise: 92500 });
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(before);
  });

  it('refuses a unit change once the item has stock history, and a code that is taken', async () => {
    const h = await setupHarness();
    const a = h.items.create(h.ownerToken, { ...milkCan, openingQtyMilli: 1000 });
    h.items.create(h.ownerToken, { ...milkCan, code: 'OTHER' });
    expect(codeOf(() => h.items.update(h.ownerToken, a, { unit: 'kg' }))).toBe('CONFLICT');
    expect(codeOf(() => h.items.update(h.ownerToken, a, { code: 'other' }))).toBe('CONFLICT');
    const fresh = h.items.create(h.ownerToken, { ...milkCan, code: 'FRESH' });
    expect(codeOf(() => h.items.update('not-a-real-token', fresh, { name: 'x' }))).toBe('AUTH_FAILED'); // a bad token is refused
    expect(codeOf(() => h.items.update(h.ownerToken, fresh, { unit: 'kg' }))).toBe('NO_ERROR'); // no history yet
  });

  it('validates edits and reports missing items', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, milkCan);
    expect(codeOf(() => h.items.update(h.ownerToken, id, { hsn: 'abc' }))).toBe('VALIDATION');
    expect(codeOf(() => h.items.update(h.ownerToken, id, { categoryId: 42 }))).toBe('NOT_FOUND');
    expect(codeOf(() => h.items.update(h.ownerToken, 999, { name: 'x' }))).toBe('NOT_FOUND');
    h.items.update(h.ownerToken, id, { hsn: null, description: '   ' });
    expect(h.items.get(h.ownerToken, id)).toMatchObject({ hsn: null, description: null });
  });

  it('deactivates and reactivates', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, milkCan);
    h.items.setActive(h.ownerToken, id, false);
    expect(h.items.list(h.ownerToken).total).toBe(0);
    expect(h.items.list(h.ownerToken, { status: 'INACTIVE' }).total).toBe(1);
    expect(h.items.list(h.ownerToken, { status: 'ALL' }).total).toBe(1);
    h.items.setActive(h.ownerToken, id, true);
    expect(h.items.list(h.ownerToken).total).toBe(1);
  });
});

describe('searching and listing', () => {
  async function seeded(): Promise<Harness> {
    const h = await setupHarness();
    const dairy = h.items.createCategory(h.ownerToken, 'Dairy equipment');
    const chem = h.items.createCategory(h.ownerToken, 'Chemicals');
    const mk = (over: Partial<ItemInput>): number => h.items.create(h.ownerToken, { ...milkCan, ...over });
    mk({ code: 'MC-40', name: 'PLASTIC MILK CAN', categoryId: dairy, openingQtyMilli: 20000, reorderQtyMilli: 5000, hsn: '3923' });
    mk({ code: 'BUT-10', name: 'BUTYROMETER 0-10%', categoryId: dairy, openingQtyMilli: 3000, reorderQtyMilli: 5000, hsn: '7017' });
    mk({ code: 'NAOH-500', name: 'SODIUM HYDROXIDE N/10', categoryId: chem, openingQtyMilli: 0, reorderQtyMilli: 2000, hsn: '2815' });
    mk({ code: 'H2SO4', name: 'SULPHURIC ACID', categoryId: chem, openingQtyMilli: 9000, reorderQtyMilli: 0 });
    return h;
  }

  it('searches name, code, category and HSN, case-insensitively', async () => {
    const h = await seeded();
    const find = (search: string): string[] => h.items.list(h.ownerToken, { search, sortBy: 'code' }).rows.map((r) => r.code);
    expect(find('milk')).toEqual(['MC-40']);
    expect(find('nAoH')).toEqual(['NAOH-500']);
    expect(find('chemicals')).toEqual(['H2SO4', 'NAOH-500']);
    expect(find('7017')).toEqual(['BUT-10']);
    expect(find('nothing here')).toEqual([]);
  });

  it('treats % and _ typed by the user literally', async () => {
    const h = await seeded();
    expect(h.items.list(h.ownerToken, { search: '10%' }).rows.map((r) => r.code)).toEqual(['BUT-10']);
    expect(h.items.list(h.ownerToken, { search: '%' }).total).toBe(1); // only the item whose name has a literal %
    expect(h.items.list(h.ownerToken, { search: '_' }).total).toBe(0);
  });

  it('filters by category and low stock, and flags OUT / LOW / OK', async () => {
    const h = await seeded();
    const chemId = h.items.listCategories(h.ownerToken).find((c) => c.name === 'Chemicals')?.id;
    expect(h.items.list(h.ownerToken, { categoryId: chemId }).total).toBe(2);
    const low = h.items.list(h.ownerToken, { lowStockOnly: true, sortBy: 'qty' }).rows;
    expect(low.map((r) => [r.code, r.stockStatus])).toEqual([['NAOH-500', 'OUT'], ['BUT-10', 'LOW']]);
    const all = Object.fromEntries(h.items.list(h.ownerToken).rows.map((r) => [r.code, r.stockStatus]));
    expect(all).toEqual({ 'MC-40': 'OK', 'BUT-10': 'LOW', 'NAOH-500': 'OUT', H2SO4: 'OK' });
  });

  it('sorts and pages with a total', async () => {
    const h = await seeded();
    const page1 = h.items.list(h.ownerToken, { sortBy: 'code', limit: 3 });
    expect(page1.total).toBe(4);
    expect(page1.rows.map((r) => r.code)).toEqual(['BUT-10', 'H2SO4', 'MC-40']);
    expect(h.items.list(h.ownerToken, { sortBy: 'code', limit: 3, offset: 3 }).rows.map((r) => r.code)).toEqual(['NAOH-500']);
    expect(h.items.list(h.ownerToken, { sortBy: 'qty', descending: true, limit: 1 }).rows[0]?.code).toBe('MC-40');
  });

  it('requires inventory.view', async () => {
    const h = await seeded();
    const nobody = await employee(h, 'nobody', ['sale.create']);
    expect(codeOf(() => h.items.list(nobody.token))).toBe('PERMISSION_DENIED');
    const viewer = await employee(h, 'viewer', ['inventory.view']);
    expect(h.items.list(viewer.token).total).toBe(4);
  });

  it('exports a stock list as safe CSV', async () => {
    const h = await seeded();
    h.items.create(h.ownerToken, { ...milkCan, code: 'EVIL', name: '=1+1' });
    const csv = h.items.exportCsv(h.ownerToken, { sortBy: 'code' });
    expect(csv.startsWith('\uFEFFCode,Item,Category,HSN,Unit,Quantity,Reorder level,Sale rate (Rs),Status')).toBe(true);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain('MC-40,PLASTIC MILK CAN,Dairy equipment,3923,40 - LTR,20,5,925.00,OK');
  });
});

describe('categories', () => {
  it('creates, renames, and refuses duplicates', async () => {
    const h = await setupHarness();
    const id = h.items.createCategory(h.ownerToken, ' Chemicals ');
    expect(codeOf(() => h.items.createCategory(h.ownerToken, 'chemicals'))).toBe('CONFLICT');
    const other = h.items.createCategory(h.ownerToken, 'Glassware');
    expect(codeOf(() => h.items.renameCategory(h.ownerToken, other, 'CHEMICALS'))).toBe('CONFLICT');
    h.items.renameCategory(h.ownerToken, id, 'Lab chemicals');
    expect(h.items.listCategories(h.ownerToken).map((c) => c.name)).toEqual(['Glassware', 'Lab chemicals']);
    expect(codeOf(() => h.items.renameCategory(h.ownerToken, 99, 'x'))).toBe('NOT_FOUND');
    expect(codeOf(() => h.items.createCategory(h.ownerToken, '  '))).toBe('VALIDATION');
  });
});
