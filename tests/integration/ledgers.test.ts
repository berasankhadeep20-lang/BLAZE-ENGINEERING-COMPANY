import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/infrastructure/db/connection';
import { postCustomerLedger, postStockMovement, postSupplierLedger } from '../../src/infrastructure/db/ledgers';
import { reconcile } from '../../src/infrastructure/db/reconcile';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { owner, testDb, uowFor } from '../helpers/db';

let db: Db;
beforeEach(() => {
  db = testDb();
});
afterEach(() => db.close());

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const qty = (id: number): number => (db.prepare('SELECT qty_milli AS q FROM item WHERE id = ?').get(id) as { q: number }).q;
const bal = (id: number): number => (db.prepare('SELECT balance_paise AS b FROM customer WHERE id = ?').get(id) as { b: number }).b;

describe('stock ledger', () => {
  it('purchase increases stock and records the movement', () => {
    const r = uowFor(db).run(owner, (ctx) =>
      postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 10000, reason: 'PURCHASE', refType: 'purchase_bill', refId: 1, refNo: 'PB260001' }),
    );
    expect(r.qtyAfterMilli).toBe(10000);
    expect(qty(1)).toBe(10000);
    expect(db.prepare('SELECT reason, ref_no, qty_after_milli FROM stock_movement').get()).toEqual({
      reason: 'PURCHASE',
      ref_no: 'PB260001',
      qty_after_milli: 10000,
    });
  });

  it('sale decreases stock', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 10000, reason: 'PURCHASE' }));
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -4000, reason: 'SALE' }));
    expect(qty(1)).toBe(6000);
  });

  it('blocks a sale that exceeds stock, checked at confirm time, with nothing written', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 2000, reason: 'PURCHASE' }));
    let err: unknown;
    try {
      uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -3000, reason: 'SALE' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('INSUFFICIENT_STOCK');
    expect((err as AppError).details).toEqual({ itemCode: 'I1', availableMilli: 2000, requestedMilli: 3000 });
    expect(qty(1)).toBe(2000);
    expect((db.prepare('SELECT COUNT(*) AS c FROM stock_movement').get() as { c: number }).c).toBe(1);
  });

  it('allows selling exactly all remaining stock', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 2500, reason: 'PURCHASE' }));
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -2500, reason: 'SALE' }));
    expect(qty(1)).toBe(0);
  });

  it('requires a note for corrections and enforces the direction of each reason', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 5000, reason: 'PURCHASE' }));
    expect(codeOf(() => uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -1000, reason: 'DAMAGED' })))).toBe('VALIDATION');
    expect(codeOf(() => uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -1000, reason: 'DAMAGED', note: '  ' })))).toBe('VALIDATION');
    expect(codeOf(() => uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -1000, reason: 'DAMAGED', note: 'dropped, leaked' })))).toBe('NO_ERROR');
    expect(codeOf(() => uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 1000, reason: 'SALE' })))).toBe('VALIDATION');
    expect(codeOf(() => uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 0, reason: 'COUNT_ADJUST', note: 'x' })))).toBe('VALIDATION');
    expect(codeOf(() => uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 99, qtyDeltaMilli: 1000, reason: 'PURCHASE' })))).toBe('NOT_FOUND');
  });
});

describe('customer dues', () => {
  it('a sale creates dues and a partial payment reduces them', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: 300000, refNo: 'BZ260001' }));
    const r = uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: -100000, refNo: 'RC260001' }));
    expect(r.balanceAfterPaise).toBe(200000);
    expect(bal(1)).toBe(200000);
    expect(bal(2)).toBe(0);
    const rows = db.prepare('SELECT entry_type, amount_paise, balance_after_paise FROM customer_ledger ORDER BY id').all();
    expect(rows).toEqual([
      { entry_type: 'SALE', amount_paise: 300000, balance_after_paise: 300000 },
      { entry_type: 'PAYMENT', amount_paise: -100000, balance_after_paise: 200000 },
    ]);
  });

  it('refuses a payment above the balance unless advances are allowed', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: 50000 }));
    expect(codeOf(() => uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: -50001 })))).toBe('OVERPAYMENT');
    expect(bal(1)).toBe(50000);
    db.prepare('UPDATE customer SET advance_allowed = 1 WHERE id = 1').run();
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: -60000 }));
    expect(bal(1)).toBe(-10000);
  });

  it('cancelling a sale reverses its dues; a payment reversal restores them', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: 100000 }));
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: -40000 }));
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'PAYMENT_REVERSAL', amountPaise: 40000, note: 'cheque bounced' }));
    expect(bal(1)).toBe(100000);
    uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE_CANCEL', amountPaise: -100000 }));
    expect(bal(1)).toBe(0);
  });

  it('rejects wrong-signed entries and unknown customers', () => {
    const uow = uowFor(db);
    expect(codeOf(() => uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: -1 })))).toBe('VALIDATION');
    expect(codeOf(() => uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: 1 })))).toBe('VALIDATION');
    expect(codeOf(() => uow.run(owner, (ctx) => postCustomerLedger(ctx, { partyId: 77, entryType: 'SALE', amountPaise: 1 })))).toBe('NOT_FOUND');
  });
});

describe('supplier dues', () => {
  it('tracks what we owe, separately from customer receivables', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postSupplierLedger(ctx, { partyId: 1, entryType: 'PURCHASE', amountPaise: 250000 }));
    uow.run(owner, (ctx) => postSupplierLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: -100000 }));
    expect((db.prepare('SELECT balance_paise AS b FROM supplier WHERE id = 1').get() as { b: number }).b).toBe(150000);
    expect(bal(1)).toBe(0);
    expect(codeOf(() => uow.run(owner, (ctx) => postSupplierLedger(ctx, { partyId: 1, entryType: 'PAYMENT', amountPaise: -150001 })))).toBe('OVERPAYMENT');
  });
});

describe('reconcile', () => {
  it('is empty after normal activity', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => {
      postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 9000, reason: 'PURCHASE' });
      postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -2000, reason: 'SALE' });
      postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: 12345 });
      postSupplierLedger(ctx, { partyId: 1, entryType: 'PURCHASE', amountPaise: 999 });
    });
    expect(reconcile(db)).toEqual([]);
  });

  it('detects a cached figure that was changed behind the ledger', () => {
    uowFor(db).run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 9000, reason: 'PURCHASE' }));
    db.prepare('UPDATE item SET qty_milli = 8000 WHERE id = 1').run();
    db.prepare('UPDATE customer SET balance_paise = 500 WHERE id = 2').run();
    db.prepare('UPDATE supplier SET balance_paise = 700 WHERE id = 1').run();
    expect(reconcile(db)).toEqual([
      { kind: 'ITEM_QTY', id: 1, label: 'I1', cached: 8000, ledger: 9000 },
      { kind: 'CUSTOMER_BALANCE', id: 2, label: 'TEST CUSTOMER B', cached: 500, ledger: 0 },
      { kind: 'SUPPLIER_BALANCE', id: 1, label: 'TEST SUPPLIER', cached: 700, ledger: 0 },
    ]);
  });

  it('property: after many random operations (some failing) cache always equals ledger and stock is never negative', () => {
    let seed = 2026;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const uow = uowFor(db);
    for (let i = 0; i < 400; i++) {
      const item = 1 + rnd(2);
      const cust = 1 + rnd(2);
      try {
        uow.run(owner, (ctx) => {
          switch (rnd(5)) {
            case 0: postStockMovement(ctx, { itemId: item, qtyDeltaMilli: 1 + rnd(5000), reason: 'PURCHASE' }); break;
            case 1: postStockMovement(ctx, { itemId: item, qtyDeltaMilli: -(1 + rnd(5000)), reason: 'SALE' }); break;
            case 2: postCustomerLedger(ctx, { partyId: cust, entryType: 'SALE', amountPaise: 1 + rnd(100000) }); break;
            case 3: postCustomerLedger(ctx, { partyId: cust, entryType: 'PAYMENT', amountPaise: -(1 + rnd(100000)) }); break;
            default: { // a "bill": stock out + dues up, then fail half the time to force a rollback
              postStockMovement(ctx, { itemId: item, qtyDeltaMilli: -(1 + rnd(3000)), reason: 'SALE' });
              postCustomerLedger(ctx, { partyId: cust, entryType: 'SALE', amountPaise: 1 + rnd(50000) });
              if (rnd(2) === 0) throw new Error('simulated failure');
            }
          }
        });
      } catch (e) {
        if (!(e instanceof AppError) && !(e instanceof Error && e.message === 'simulated failure')) throw e;
      }
    }
    expect(reconcile(db)).toEqual([]);
    const negatives = db.prepare('SELECT COUNT(*) AS c FROM item WHERE qty_milli < 0').get() as { c: number };
    expect(negatives.c).toBe(0);
  });
});
