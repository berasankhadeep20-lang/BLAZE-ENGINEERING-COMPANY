import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { makeEmployee, quickBill, shopHarness, type Shop } from '../helpers/shop';

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const balance = (h: Shop, id = h.ids.farm): number => h.customers.get(h.ownerToken, id).balancePaise;
const outstanding = (h: Shop, billId: number): number | null => h.sales.get(h.ownerToken, billId).outstandingPaise;

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('partial payments', () => {
  it('each payment gets a receipt, reduces the due, and records the balance right after it', async () => {
    const h = await shopHarness();
    const bill = quickBill(h); // total T
    const T = bill.totalPaise;
    const p1 = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 1000, method: 'cash', reference: 'R-1', note: 'first instalment' });
    expect(p1).toMatchObject({ receiptNo: 'RC260001', balanceAfterPaise: T - 1000, unallocatedPaise: 0 });
    expect(p1.allocations).toEqual([{ billId: bill.id, billNo: bill.billNo, amountPaise: 1000 }]);
    const p2 = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 2500, method: 'UPI', paidOn: '2026-11-05' });
    expect(p2).toMatchObject({ receiptNo: 'RC260002', balanceAfterPaise: T - 3500 });
    expect(balance(h)).toBe(T - 3500);
    expect(h.sales.get(h.ownerToken, bill.id)).toMatchObject({ outstandingPaise: T - 3500, paymentStatus: 'PARTIAL' });

    const list = h.payments.list(h.ownerToken, { customerId: h.ids.farm });
    expect(list.rows.map((r) => [r.receiptNo, r.amountPaise, r.balanceAfterPaise, r.method, r.createdByName])).toEqual([
      ['RC260002', 2500, T - 3500, 'UPI', 'Shop Owner'], ['RC260001', 1000, T - 1000, 'Cash', 'Shop Owner'], // typed "cash", stored as spelled in Settings
    ]);
    expect(list.rows[1]).toMatchObject({ reference: 'R-1', note: 'first instalment', paidOn: '2026-11-07', allocations: [{ billNo: bill.billNo, amountPaise: 1000 }] });

    h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: T - 3500, method: 'Cash' });
    expect(balance(h)).toBe(0);
    expect(h.sales.get(h.ownerToken, bill.id)).toMatchObject({ outstandingPaise: 0, paymentStatus: 'PAID' });
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('settles the oldest bills first, or the bill you name first', async () => {
    const h = await shopHarness();
    const a = quickBill(h, { date: '2026-11-01' });
    const b = quickBill(h, { date: '2026-11-02' });
    const c = quickBill(h, { date: '2026-11-03' });
    const r1 = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: a.totalPaise + 500, method: 'Cash' });
    expect(r1.allocations).toEqual([{ billId: a.id, billNo: a.billNo, amountPaise: a.totalPaise }, { billId: b.id, billNo: b.billNo, amountPaise: 500 }]);
    expect([outstanding(h, a.id), outstanding(h, b.id), outstanding(h, c.id)]).toEqual([0, b.totalPaise - 500, c.totalPaise]);

    const r2 = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: c.totalPaise + 100, method: 'Cash', saleBillId: c.id }); // name the newest bill
    expect(r2.allocations).toEqual([{ billId: c.id, billNo: c.billNo, amountPaise: c.totalPaise }, { billId: b.id, billNo: b.billNo, amountPaise: 100 }]);
    expect(outstanding(h, b.id)).toBe(b.totalPaise - 600);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('dues that are not on any bill (an opening balance) are paid down without allocation', async () => {
    const h = await shopHarness();
    const old = h.customers.create(h.ownerToken, { name: 'OLD ACCOUNT', state: 'West Bengal', openingBalancePaise: 50000 });
    const r = h.payments.record(h.ownerToken, { customerId: old, amountPaise: 20000, method: 'Cash' });
    expect(r).toMatchObject({ balanceAfterPaise: 30000, allocations: [], unallocatedPaise: 20000 });
    expect(balance(h, old)).toBe(30000);
  });
});

describe('what a payment may not do', () => {
  it('can never take the balance below zero, and a refused payment leaves no trace (not even a receipt number)', async () => {
    const h = await shopHarness();
    const bill = quickBill(h);
    expect(codeOf(() => h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: bill.totalPaise + 1, method: 'Cash' }))).toBe('OVERPAYMENT');
    expect(balance(h)).toBe(bill.totalPaise);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM customer_payment').get() as { n: number }).n).toBe(0);
    expect(h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: bill.totalPaise, method: 'Cash' }).receiptNo).toBe('RC260001');
    expect(codeOf(() => h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 1, method: 'Cash' }))).toBe('OVERPAYMENT'); // nothing left to pay
  });

  it('an advance needs the owner to allow it for that customer first', async () => {
    const h = await shopHarness();
    const clerk = await makeEmployee(h, 'clerk', ['payment.record', 'customer.view']);
    expect(codeOf(() => h.payments.setAdvanceAllowed(clerk, h.ids.farm, true))).toBe('PERMISSION_DENIED');
    h.payments.setAdvanceAllowed(h.ownerToken, h.ids.farm, true);
    const r = h.payments.record(clerk, { customerId: h.ids.farm, amountPaise: 25000, method: 'Cash' });
    expect(r).toMatchObject({ balanceAfterPaise: -25000, allocations: [], unallocatedPaise: 25000 });
    expect(codeOf(() => h.payments.setAdvanceAllowed(h.ownerToken, h.ids.farm, false))).toBe('CONFLICT'); // holds a credit
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('is validated: amount, method, date, customer and bill', async () => {
    const h = await shopHarness();
    const other = h.customers.create(h.ownerToken, { name: 'OTHER FARM', state: 'West Bengal' });
    const mine = quickBill(h);
    const theirs = quickBill(h, { customerId: other });
    const base = { customerId: h.ids.farm, amountPaise: 100, method: 'Cash' };
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, amountPaise: 0 }))).toBe('VALIDATION');
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, amountPaise: -5 }))).toBe('VALIDATION');
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, method: 'Barter' }))).toBe('VALIDATION');
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, paidOn: '2026-11-08' }))).toBe('VALIDATION'); // tomorrow
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, paidOn: 'soon' }))).toBe('VALIDATION');
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, customerId: 999 }))).toBe('NOT_FOUND');
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, saleBillId: theirs.id }))).toBe('NOT_FOUND'); // another customer's bill
    h.payments.record(h.ownerToken, { ...base, amountPaise: mine.totalPaise });
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, saleBillId: mine.id }))).toBe('VALIDATION'); // already paid
    expect(codeOf(() => h.payments.record(h.ownerToken, { ...base, paidOn: '2026-10-01', amountPaise: 1, saleBillId: theirs.id }))).toBe('NOT_FOUND');
  });

  it('needs payment.record, and reversing needs payment.reverse', async () => {
    const h = await shopHarness();
    quickBill(h);
    const nobody = await makeEmployee(h, 'nobody', ['customer.view']);
    const cashier = await makeEmployee(h, 'cashier', ['payment.record']);
    expect(codeOf(() => h.payments.record(nobody, { customerId: h.ids.farm, amountPaise: 100, method: 'Cash' }))).toBe('PERMISSION_DENIED');
    const r = h.payments.record(cashier, { customerId: h.ids.farm, amountPaise: 100, method: 'Cash' });
    expect(codeOf(() => h.payments.reverse(cashier, r.paymentId, 'cheque bounced'))).toBe('PERMISSION_DENIED');
    expect(h.db.prepare('SELECT created_by FROM customer_payment').get()).not.toEqual({ created_by: 1 }); // recorded as the cashier
  });
});

describe('reversing a payment', () => {
  it('brings the dues back, frees the bill, keeps the record, and needs a reason', async () => {
    const h = await shopHarness();
    const bill = quickBill(h);
    const r = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: bill.totalPaise, method: 'Cheque', reference: 'CHQ 0042' });
    expect(balance(h)).toBe(0);
    expect(codeOf(() => h.payments.reverse(h.ownerToken, r.paymentId, ' '))).toBe('VALIDATION');
    h.payments.reverse(h.ownerToken, r.paymentId, 'cheque bounced');
    expect(balance(h)).toBe(bill.totalPaise);
    expect(h.sales.get(h.ownerToken, bill.id)).toMatchObject({ outstandingPaise: bill.totalPaise, paymentStatus: 'UNPAID' });
    expect(h.sales.get(h.ownerToken, bill.id).payments[0]).toMatchObject({ receiptNo: 'RC260001', reversed: true });
    const row = h.payments.list(h.ownerToken).rows[0];
    expect(row).toMatchObject({ reversed: true, reversalReason: 'cheque bounced', amountPaise: bill.totalPaise });
    expect(h.db.prepare("SELECT entry_type, amount_paise, note FROM customer_ledger WHERE entry_type = 'PAYMENT_REVERSAL'").get()).toEqual({ entry_type: 'PAYMENT_REVERSAL', amount_paise: bill.totalPaise, note: 'cheque bounced' });
    expect(h.db.prepare("SELECT reason FROM audit_log WHERE action = 'PAYMENT_REVERSE'").get()).toEqual({ reason: 'cheque bounced' });
    expect(codeOf(() => h.payments.reverse(h.ownerToken, r.paymentId, 'again'))).toBe('CONFLICT');
    expect(codeOf(() => h.payments.reverse(h.ownerToken, 999, 'no such payment'))).toBe('NOT_FOUND');
    expect(h.payments.list(h.ownerToken, { includeReversed: false }).total).toBe(0);
    // the customer can pay again
    h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: bill.totalPaise, method: 'Cash' });
    expect(balance(h)).toBe(0);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('a payment that covered two bills frees both', async () => {
    const h = await shopHarness();
    const a = quickBill(h, { date: '2026-11-01' });
    const b = quickBill(h, { date: '2026-11-02' });
    const r = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: a.totalPaise + 700, method: 'Cash' });
    h.payments.reverse(h.ownerToken, r.paymentId, 'entered on the wrong customer');
    expect([outstanding(h, a.id), outstanding(h, b.id)]).toEqual([a.totalPaise, b.totalPaise]);
  });
});

describe('searching payments', () => {
  it('filters by customer, date, receipt and reference', async () => {
    const h = await shopHarness();
    const other = h.customers.create(h.ownerToken, { name: 'OTHER FARM', state: 'West Bengal' });
    quickBill(h);
    quickBill(h, { customerId: other });
    h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 100, method: 'Cash', paidOn: '2026-11-02', reference: 'ABC-1' });
    h.payments.record(h.ownerToken, { customerId: other, amountPaise: 200, method: 'UPI', paidOn: '2026-11-04', reference: 'XYZ-9' });
    expect(h.payments.list(h.ownerToken).total).toBe(2);
    expect(h.payments.list(h.ownerToken, { customerId: other }).rows.map((r) => r.amountPaise)).toEqual([200]);
    expect(h.payments.list(h.ownerToken, { fromDate: '2026-11-03' }).rows.map((r) => r.amountPaise)).toEqual([200]);
    expect(h.payments.list(h.ownerToken, { search: 'abc' }).rows.map((r) => r.amountPaise)).toEqual([100]);
    expect(h.payments.list(h.ownerToken, { search: 'RC260002' }).rows.map((r) => r.amountPaise)).toEqual([200]);
    expect(codeOf(() => h.payments.list(h.ownerToken, { toDate: 'never' }))).toBe('VALIDATION');
  });
});

describe('stress: random sales, payments, reversals and cancellations', () => {
  it('the books always agree, no bill is ever over-paid, and stock never goes negative', async () => {
    const h = await shopHarness();
    const customers = [h.ids.farm, h.customers.create(h.ownerToken, { name: 'SECOND FARM', state: 'West Bengal' }), h.customers.create(h.ownerToken, { name: 'THIRD FARM', state: 'Bihar' })];
    let seed = 20261108;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const tolerated = new Set<ErrorCode>(['INSUFFICIENT_STOCK', 'OVERPAYMENT', 'CONFLICT', 'VALIDATION']);
    const attempt = (fn: () => unknown): void => {
      try {
        fn();
      } catch (e) {
        if (!(e instanceof AppError) || !tolerated.has(e.code)) throw e;
      }
    };
    const itemIds = [h.ids.can, h.ids.buty, h.ids.naoh];

    for (let i = 0; i < 160; i++) {
      const customerId = customers[rnd(customers.length)] ?? h.ids.farm;
      switch (rnd(6)) {
        case 0:
        case 1:
          attempt(() => {
            const lines = Array.from({ length: 1 + rnd(2) }, () => ({ itemId: itemIds[rnd(3)] ?? h.ids.can, qtyMilli: (1 + rnd(4)) * 1000 }));
            const draft = h.sales.saveDraft(h.ownerToken, { customerId, invoiceDate: '2026-11-01', lines, delivery: rnd(2) ? { amountPaise: rnd(20000), gstRateBp: 1800 } : null });
            h.sales.confirm(h.ownerToken, draft.id);
          });
          break;
        case 2:
        case 3:
          attempt(() => h.payments.record(h.ownerToken, { customerId, amountPaise: 1 + rnd(30000), method: 'Cash' }));
          break;
        case 4: {
          const live = h.db.prepare('SELECT id FROM customer_payment WHERE is_reversed = 0').all() as { id: number }[];
          const pick = live[rnd(Math.max(1, live.length))];
          if (pick) attempt(() => h.payments.reverse(h.ownerToken, pick.id, 'random reversal'));
          break;
        }
        default: {
          const bills = h.db.prepare("SELECT id FROM sale_bill WHERE status = 'CONFIRMED'").all() as { id: number }[];
          const pick = bills[rnd(Math.max(1, bills.length))];
          if (pick) attempt(() => h.sales.cancel(h.ownerToken, pick.id, 'random cancellation'));
          if (rnd(3) === 0) {
            const id = itemIds[rnd(3)] ?? h.ids.can;
            h.stock.recordCount(h.ownerToken, { itemId: id, countedQtyMilli: h.items.get(h.ownerToken, id).qtyMilli + 5000, note: 'restock count' });
          }
        }
      }
      expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
    }

    const bills = h.db.prepare("SELECT id FROM sale_bill WHERE status = 'CONFIRMED'").all() as { id: number }[];
    expect(bills.length).toBeGreaterThan(5); // the run did real work
    for (const b of bills) expect(outstanding(h, b.id)).toBeGreaterThanOrEqual(0);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM item WHERE qty_milli < 0').get() as { n: number }).n).toBe(0);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM customer_payment').get() as { n: number }).n).toBeGreaterThan(5);
  });
});

describe('integrity check covers allocations', () => {
  it('flags a payment that settles more than it is worth, and a bill settled for more than its total', async () => {
    const h = await shopHarness();
    const bill = quickBill(h);
    const r = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 1000, method: 'Cash' });
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
    // tamper behind the services' back: a second allocation of this payment to the same bill is blocked by the unique key,
    // so allocate it to a second bill instead
    const second = quickBill(h, { date: '2026-11-02' });
    h.db.prepare('INSERT INTO payment_allocation (payment_id, sale_bill_id, amount_paise) VALUES (?, ?, ?)').run(r.paymentId, second.id, 500);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([{ kind: 'PAYMENT_OVER_ALLOCATED', id: r.paymentId, label: 'RC260001', cached: 1000, ledger: 1500 }]);
    expect(() => h.db.prepare('DELETE FROM payment_allocation').run()).toThrow(/append-only/);
    // a second payment, pushed onto the second bill as well, over-pays that bill (500 from the first payment + its whole total)
    const r2 = h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 100, method: 'Cash' });
    h.db.prepare('INSERT INTO payment_allocation (payment_id, sale_bill_id, amount_paise) VALUES (?, ?, ?)').run(r2.paymentId, second.id, second.totalPaise);
    const kinds = h.stock.checkIntegrity(h.ownerToken).map((i) => `${i.kind}:${i.id}`).sort();
    expect(kinds).toEqual([`BILL_OVER_PAID:${second.id}`, `PAYMENT_OVER_ALLOCATED:${r.paymentId}`, `PAYMENT_OVER_ALLOCATED:${r2.paymentId}`].sort());
    expect(bill.id).not.toBe(second.id);
  });
});
