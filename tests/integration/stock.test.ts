import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postStockMovement } from '../../src/infrastructure/db/ledgers';
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
const base = { name: 'ITEM', unit: 'pcs', purchaseRatePaise: 100, saleRatePaise: 200, gstRateBp: 1800 };

async function employee(h: Harness, username: string, permissions: string[]): Promise<string> {
  await h.users.createEmployee(h.ownerToken, { username, displayName: `Clerk ${username}`, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await h.auth.login(username, 'temp-pass-123');
  await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return token;
}
const qty = (h: Harness, id: number): number => h.items.get(h.ownerToken, id).qtyMilli;

describe('stock corrections', () => {
  it('records damaged stock with the reason, the user and an audit entry', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 10000 });
    const r = h.stock.recordLoss(h.ownerToken, { itemId: id, kind: 'DAMAGED', qtyMilli: 2500, note: '  leaked in transit ' });
    expect(r.qtyAfterMilli).toBe(7500);
    expect(h.db.prepare("SELECT qty_delta_milli, reason, note, qty_after_milli, user_id FROM stock_movement WHERE reason = 'DAMAGED'").get()).toEqual({
      qty_delta_milli: -2500, reason: 'DAMAGED', note: 'leaked in transit', qty_after_milli: 7500, user_id: 1,
    });
    const a = h.db.prepare("SELECT reason, detail_json FROM audit_log WHERE action = 'STOCK_ADJUST'").get() as { reason: string; detail_json: string };
    expect(a.reason).toBe('leaked in transit');
    expect(JSON.parse(a.detail_json)).toMatchObject({ kind: 'DAMAGED', beforeMilli: 10000, afterMilli: 7500, itemCode: 'A1' });
  });

  it('refuses a reason that is blank or too short, a zero quantity, and more than is in stock', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 1000 });
    expect(codeOf(() => h.stock.recordLoss(h.ownerToken, { itemId: id, kind: 'MISSING', qtyMilli: 100, note: '  ' }))).toBe('VALIDATION');
    expect(codeOf(() => h.stock.recordLoss(h.ownerToken, { itemId: id, kind: 'MISSING', qtyMilli: 100, note: 'ab' }))).toBe('VALIDATION');
    expect(codeOf(() => h.stock.recordLoss(h.ownerToken, { itemId: id, kind: 'MISSING', qtyMilli: 0, note: 'lost box' }))).toBe('VALIDATION');
    expect(codeOf(() => h.stock.recordLoss(h.ownerToken, { itemId: id, kind: 'MISSING', qtyMilli: 1001, note: 'lost box' }))).toBe('INSUFFICIENT_STOCK');
    expect(qty(h, id)).toBe(1000);
    expect(codeOf(() => h.stock.recordLoss(h.ownerToken, { itemId: 999, kind: 'MISSING', qtyMilli: 1, note: 'lost box' }))).toBe('NOT_FOUND');
  });

  it('a physical count sets the stock, working out the difference at that moment', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 10000 });
    expect(h.stock.recordCount(h.ownerToken, { itemId: id, countedQtyMilli: 9000, note: 'monthly count' })).toEqual({ qtyBeforeMilli: 10000, qtyAfterMilli: 9000, deltaMilli: -1000 });
    expect(h.stock.recordCount(h.ownerToken, { itemId: id, countedQtyMilli: 9500, note: 'found a carton' })).toMatchObject({ deltaMilli: 500 });
    expect(codeOf(() => h.stock.recordCount(h.ownerToken, { itemId: id, countedQtyMilli: 9500, note: 'again' }))).toBe('VALIDATION'); // no change
    expect(codeOf(() => h.stock.recordCount(h.ownerToken, { itemId: id, countedQtyMilli: -1, note: 'bad count' }))).toBe('VALIDATION');
    expect(h.stock.recordCount(h.ownerToken, { itemId: id, countedQtyMilli: 0, note: 'shelf empty' }).qtyAfterMilli).toBe(0);
    expect(qty(h, id)).toBe(0);
  });

  it('needs stock.adjust', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 1000 });
    const clerk = await employee(h, 'clerk', ['inventory.view', 'sale.create']);
    expect(codeOf(() => h.stock.recordLoss(clerk, { itemId: id, kind: 'DAMAGED', qtyMilli: 100, note: 'broken' }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.stock.recordCount(clerk, { itemId: id, countedQtyMilli: 5, note: 'count' }))).toBe('PERMISSION_DENIED');
    h.users.setPermissions(h.ownerToken, h.users.list(h.ownerToken).find((u) => u.username === 'clerk')?.id ?? 0, ['stock.adjust']);
    expect(codeOf(() => h.stock.recordLoss(clerk, { itemId: id, kind: 'DAMAGED', qtyMilli: 100, note: 'broken' }))).toBe('NO_ERROR');
    expect(h.db.prepare("SELECT user_id FROM stock_movement WHERE reason = 'DAMAGED'").get()).not.toEqual({ user_id: 1 }); // the clerk, not the owner
  });
});

describe('movement history', () => {
  it('lists newest first with item, reason, reference and user, and filters by item and reason', async () => {
    const h = await setupHarness();
    const a = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 10000 });
    const b = h.items.create(h.ownerToken, { ...base, code: 'B1', openingQtyMilli: 5000 });
    h.clock.advanceMinutes(1);
    new UnitOfWork(h.db, h.clock).run({ userId: 1, role: 'OWNER' }, (ctx) =>
      postStockMovement(ctx, { itemId: a, qtyDeltaMilli: -3000, reason: 'SALE', refType: 'sale_bill', refId: 1, refNo: 'BZ260001' }),
    );
    h.clock.advanceMinutes(1);
    h.stock.recordLoss(h.ownerToken, { itemId: b, kind: 'DAMAGED', qtyMilli: 500, note: 'cracked' });

    const all = h.stock.movements(h.ownerToken);
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => [r.itemCode, r.reason])).toEqual([['B1', 'DAMAGED'], ['A1', 'SALE'], ['B1', 'OPENING'], ['A1', 'OPENING']]);
    expect(all.rows[1]).toMatchObject({ qtyDeltaMilli: -3000, qtyAfterMilli: 7000, refNo: 'BZ260001', userName: 'Shop Owner' });
    expect(h.stock.movements(h.ownerToken, { itemId: a }).rows).toHaveLength(2);
    expect(h.stock.movements(h.ownerToken, { reasons: ['SALE', 'DAMAGED'] }).rows).toHaveLength(2);
    expect(h.stock.movements(h.ownerToken, { limit: 1, offset: 1 }).rows[0]?.reason).toBe('SALE');
    expect(codeOf(() => h.stock.movements(h.ownerToken, { reasons: ['BOGUS' as never] }))).toBe('VALIDATION');
  });

  it('requires inventory.view', async () => {
    const h = await setupHarness();
    const nobody = await employee(h, 'nobody', ['sale.create']);
    expect(codeOf(() => h.stock.movements(nobody))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.stock.exportMovementsCsv(nobody))).toBe('PERMISSION_DENIED');
  });

  it('exports movements as CSV with local times and signed changes', async () => {
    const h = await setupHarness();
    const a = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 2500 });
    h.stock.recordLoss(h.ownerToken, { itemId: a, kind: 'DAMAGED', qtyMilli: 500, note: '=cmd|calc' });
    const csv = h.stock.exportMovementsCsv(h.ownerToken, { itemId: a });
    expect(csv.startsWith('\uFEFFDate and time,Item code,Item,Change,Reason,Reference,Note,Balance after,User')).toBe(true);
    expect(csv).toContain(',A1,ITEM,2.5,OPENING,,Opening stock,2.5,Shop Owner'); // a plain number: no apostrophe
    expect(csv).toContain(",A1,ITEM,-0.5,DAMAGED,,'=cmd|calc,2,Shop Owner");
  });

  describe('date filters use the shop\'s local day (India, UTC+5:30)', () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'Asia/Kolkata';
    });
    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it('puts a movement at 00:30 IST on 1 Nov into 1 Nov, not 31 Oct', async () => {
      const h = await setupHarness();
      const id = h.items.create(h.ownerToken, { ...base, code: 'A1' });
      const uow = new UnitOfWork(h.db, { now: () => new Date('2026-10-31T17:30:00.000Z') }); // 23:00 IST on 31 Oct
      uow.run({ userId: 1, role: 'OWNER' }, (ctx) => postStockMovement(ctx, { itemId: id, qtyDeltaMilli: 1000, reason: 'PURCHASE' }));
      const uow2 = new UnitOfWork(h.db, { now: () => new Date('2026-10-31T19:00:00.000Z') }); // 00:30 IST on 1 Nov
      uow2.run({ userId: 1, role: 'OWNER' }, (ctx) => postStockMovement(ctx, { itemId: id, qtyDeltaMilli: 2000, reason: 'PURCHASE' }));

      const day = (d: string): number[] => h.stock.movements(h.ownerToken, { fromDate: d, toDate: d }).rows.map((r) => r.qtyDeltaMilli);
      expect(day('2026-10-31')).toEqual([1000]);
      expect(day('2026-11-01')).toEqual([2000]);
      expect(h.stock.movements(h.ownerToken, { fromDate: '2026-10-31', toDate: '2026-11-01' }).total).toBe(2);
      expect(codeOf(() => h.stock.movements(h.ownerToken, { fromDate: '2026-11-02', toDate: '2026-11-01' }))).toBe('VALIDATION');
      expect(codeOf(() => h.stock.movements(h.ownerToken, { fromDate: 'yesterday' }))).toBe('VALIDATION');
    });
  });
});

describe('alerts and integrity', () => {
  it('lists active out-of-stock and low-stock items, lowest first', async () => {
    const h = await setupHarness();
    h.items.create(h.ownerToken, { ...base, code: 'OK1', openingQtyMilli: 9000, reorderQtyMilli: 1000 });
    h.items.create(h.ownerToken, { ...base, code: 'LOW1', openingQtyMilli: 800, reorderQtyMilli: 1000 });
    h.items.create(h.ownerToken, { ...base, code: 'OUT1', reorderQtyMilli: 1000 });
    const gone = h.items.create(h.ownerToken, { ...base, code: 'GONE', reorderQtyMilli: 1000 });
    h.items.setActive(h.ownerToken, gone, false);
    expect(h.stock.lowStock(h.ownerToken).map((r) => [r.code, r.stockStatus])).toEqual([['OUT1', 'OUT'], ['LOW1', 'LOW']]);
  });

  it('integrity check is clean after normal use, and catches tampering; it needs audit.view', async () => {
    const h = await setupHarness();
    const id = h.items.create(h.ownerToken, { ...base, code: 'A1', openingQtyMilli: 5000 });
    h.stock.recordLoss(h.ownerToken, { itemId: id, kind: 'MISSING', qtyMilli: 1000, note: 'not found' });
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
    h.db.prepare('UPDATE item SET qty_milli = 9999 WHERE id = ?').run(id);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([{ kind: 'ITEM_QTY', id, label: 'A1', cached: 9999, ledger: 4000 }]);
    const clerk = await employee(h, 'clerk', ['inventory.view']);
    expect(codeOf(() => h.stock.checkIntegrity(clerk))).toBe('PERMISSION_DENIED');
  });
});
