import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/infrastructure/db/connection';
import { recordAudit } from '../../src/infrastructure/db/audit';
import { postCustomerLedger, postStockMovement } from '../../src/infrastructure/db/ledgers';
import { assertInTransaction } from '../../src/infrastructure/db/unitOfWork';
import { AppError } from '../../src/shared/errors';
import { owner, testDb, uowFor } from '../helpers/db';

let db: Db;
beforeEach(() => {
  db = testDb();
});
afterEach(() => db.close());

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe('UnitOfWork', () => {
  it('commits everything when the function returns', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => {
      postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 5000, reason: 'PURCHASE' });
      postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: 10000 });
      recordAudit(ctx, { action: 'SALE_CONFIRM' });
    });
    expect(count('stock_movement')).toBe(1);
    expect(count('customer_ledger')).toBe(1);
    expect(count('audit_log')).toBe(1);
  });

  it('rolls back bill-style writes together when something fails midway', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 3000, reason: 'PURCHASE' }));

    expect(() =>
      uow.run(owner, (ctx) => {
        postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -2000, reason: 'SALE' }); // line 1 fits
        postCustomerLedger(ctx, { partyId: 1, entryType: 'SALE', amountPaise: 50000 });
        recordAudit(ctx, { action: 'SALE_CONFIRM' });
        postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: -2000, reason: 'SALE' }); // line 2 does not (1000 left)
      }),
    ).toThrow(AppError);

    expect(db.prepare('SELECT qty_milli FROM item WHERE id = 1').get()).toEqual({ qty_milli: 3000 });
    expect(db.prepare('SELECT balance_paise FROM customer WHERE id = 1').get()).toEqual({ balance_paise: 0 });
    expect(count('stock_movement')).toBe(1); // only the original purchase
    expect(count('customer_ledger')).toBe(0);
    expect(count('audit_log')).toBe(0);
  });

  it('makes nested runs savepoints: an inner failure caught by the outer keeps the outer work', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => {
      postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 1000, reason: 'PURCHASE' });
      try {
        uow.run(owner, (inner) => {
          postStockMovement(inner, { itemId: 2, qtyDeltaMilli: 1000, reason: 'PURCHASE' });
          throw new Error('inner failed');
        });
      } catch {
        /* outer carries on */
      }
    });
    expect(db.prepare('SELECT qty_milli FROM item WHERE id = 1').get()).toEqual({ qty_milli: 1000 });
    expect(db.prepare('SELECT qty_milli FROM item WHERE id = 2').get()).toEqual({ qty_milli: 0 });
  });

  it('refuses an async body and rolls back', () => {
    const uow = uowFor(db);
    expect(() =>
      uow.run(owner, (ctx) => {
        postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 1000, reason: 'PURCHASE' });
        return Promise.resolve(1);
      }),
    ).toThrow(/synchronous/);
    expect(count('stock_movement')).toBe(0);
  });

  it('uses one timestamp and the acting user for every row in the transaction', () => {
    const uow = uowFor(db, '2026-11-07T10:00:00.000Z');
    uow.run(owner, (ctx) => {
      postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 1000, reason: 'PURCHASE' });
      recordAudit(ctx, { action: 'STOCK_ADJUST' });
    });
    expect(db.prepare('SELECT at, user_id FROM stock_movement').get()).toEqual({ at: '2026-11-07T10:00:00.000Z', user_id: 1 });
    expect(db.prepare('SELECT at, user_id FROM audit_log').get()).toEqual({ at: '2026-11-07T10:00:00.000Z', user_id: 1 });
  });

  it('writes need a transaction and (for ledgers) a signed-in user', () => {
    const uow = uowFor(db);
    let captured: Parameters<Parameters<typeof uow.run>[1]>[0] | undefined;
    uow.run(owner, (ctx) => {
      captured = ctx;
    });
    if (!captured) throw new Error('ctx not captured');
    expect(() => assertInTransaction(captured as never, 'x')).toThrow(/inside UnitOfWork/);
    expect(() => uow.run(null, (ctx) => postStockMovement(ctx, { itemId: 1, qtyDeltaMilli: 1000, reason: 'PURCHASE' }))).toThrow(/signed-in/);
    expect(() => uow.run(null, (ctx) => recordAudit(ctx, { action: 'LOGIN_FAILED' }))).not.toThrow();
    expect(db.prepare("SELECT user_id FROM audit_log WHERE action='LOGIN_FAILED'").get()).toEqual({ user_id: null });
  });
});
