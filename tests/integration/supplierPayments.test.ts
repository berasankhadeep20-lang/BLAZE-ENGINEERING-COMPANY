import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { makeEmployee, shopHarness, type Shop } from '../helpers/shop';

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const owed = (h: Shop, id = h.ids.supplier): number => h.suppliers.get(h.ownerToken, id).balancePaise;

let n = 0;
/** Enter a purchase of `qty` butyrometers (rate 40.00 each, 18% GST) and return its id and total. */
function purchase(h: Shop, opts: { supplierId?: number; qtyMilli?: number; date?: string } = {}): { id: number; total: number } {
  n += 1;
  const d = h.purchases.saveDraft(h.ownerToken, {
    supplierId: opts.supplierId ?? h.ids.supplier, supplierInvoiceNo: `SP-INV-${String(n)}`, supplierInvoiceDate: '2026-11-01', billDate: opts.date ?? '2026-11-02',
    lines: [{ itemId: h.ids.buty, invoicedQtyMilli: opts.qtyMilli ?? 10000 }],
  });
  const b = h.purchases.confirm(h.ownerToken, d.id);
  return { id: b.id, total: b.totals.totalPaise };
}

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('paying a supplier', () => {
  it('each payment gets a number, reduces what we owe, and records the balance right after it', async () => {
    const h = await shopHarness();
    const bill = purchase(h);
    const p1 = h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 1000, method: 'cash', reference: 'V-1', note: 'advance against the bill' });
    expect(p1).toMatchObject({ receiptNo: 'SP260001', balanceAfterPaise: bill.total - 1000 });
    const p2 = h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 2000, method: 'Bank transfer', paidOn: '2026-11-04' });
    expect(p2).toMatchObject({ receiptNo: 'SP260002', balanceAfterPaise: bill.total - 3000 });
    expect(owed(h)).toBe(bill.total - 3000);
    const list = h.supplierPayments.list(h.ownerToken, { supplierId: h.ids.supplier });
    expect(list.rows.map((r) => [r.receiptNo, r.amountPaise, r.balanceAfterPaise, r.method])).toEqual([['SP260002', 2000, bill.total - 3000, 'Bank transfer'], ['SP260001', 1000, bill.total - 1000, 'Cash']]);
    expect(list.rows[1]).toMatchObject({ reference: 'V-1', note: 'advance against the bill', paidOn: '2026-11-07', purchaseBillNo: null });
    h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: bill.total - 3000, method: 'Cash' });
    expect(owed(h)).toBe(0);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('a payment named for a bill shows against that bill, and cannot exceed what is unpaid on it', async () => {
    const h = await shopHarness();
    const a = purchase(h);
    const b = purchase(h);
    h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 1000, method: 'Cash', purchaseBillId: b.id });
    const view = h.purchases.get(h.ownerToken, b.id);
    expect(view).toMatchObject({ paidPaise: 1000, outstandingPaise: b.total - 1000, paymentStatus: 'PARTIAL' });
    expect(h.purchases.get(h.ownerToken, a.id)).toMatchObject({ paidPaise: 0, paymentStatus: 'UNPAID' });
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: b.total, method: 'Cash', purchaseBillId: b.id }))).toBe('VALIDATION'); // more than is unpaid
    h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: b.total - 1000, method: 'Cash', purchaseBillId: b.id });
    expect(h.purchases.get(h.ownerToken, b.id)).toMatchObject({ outstandingPaise: 0, paymentStatus: 'PAID' });
    expect(owed(h)).toBe(a.total);
  });

  it('can never pay more than we owe, and a refused payment leaves no trace (not even a number)', async () => {
    const h = await shopHarness();
    const bill = purchase(h);
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: bill.total + 1, method: 'Cash' }))).toBe('OVERPAYMENT');
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM supplier_payment').get() as { n: number }).n).toBe(0);
    expect(h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: bill.total, method: 'Cash' }).receiptNo).toBe('SP260001');
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 1, method: 'Cash' }))).toBe('OVERPAYMENT');
  });

  it('is validated: amount, method, date, supplier and bill', async () => {
    const h = await shopHarness();
    const other = h.suppliers.create(h.ownerToken, { name: 'OTHER SUPPLIER', state: 'West Bengal' });
    purchase(h);
    const theirs = purchase(h, { supplierId: other });
    const base = { supplierId: h.ids.supplier, amountPaise: 100, method: 'Cash' };
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { ...base, amountPaise: 0 }))).toBe('VALIDATION');
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { ...base, method: 'Barter' }))).toBe('VALIDATION');
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { ...base, paidOn: '2026-11-08' }))).toBe('VALIDATION');
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { ...base, supplierId: 999 }))).toBe('NOT_FOUND');
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { ...base, purchaseBillId: theirs.id }))).toBe('NOT_FOUND'); // another supplier's bill
    const draft = h.purchases.saveDraft(h.ownerToken, { supplierId: h.ids.supplier, supplierInvoiceNo: 'DRAFT-1', supplierInvoiceDate: '2026-11-01', lines: [{ itemId: h.ids.buty, invoicedQtyMilli: 1000 }] });
    expect(codeOf(() => h.supplierPayments.record(h.ownerToken, { ...base, purchaseBillId: draft.id }))).toBe('VALIDATION'); // not confirmed
  });

  it('opening-balance debts can be paid down', async () => {
    const h = await shopHarness();
    const old = h.suppliers.create(h.ownerToken, { name: 'OLD ACCOUNT SUPPLIER', state: 'West Bengal', openingBalancePaise: 50000 });
    expect(h.supplierPayments.record(h.ownerToken, { supplierId: old, amountPaise: 20000, method: 'Cash' }).balanceAfterPaise).toBe(30000);
  });

  it('needs supplier.pay; reversing needs payment.reverse and a reason', async () => {
    const h = await shopHarness();
    purchase(h);
    const viewer = await makeEmployee(h, 'viewer', ['supplier.view']);
    const payer = await makeEmployee(h, 'payer', ['supplier.pay']);
    const reverser = await makeEmployee(h, 'reverser', ['payment.reverse', 'supplier.view']);
    expect(codeOf(() => h.supplierPayments.record(viewer, { supplierId: h.ids.supplier, amountPaise: 100, method: 'Cash' }))).toBe('PERMISSION_DENIED');
    const r = h.supplierPayments.record(payer, { supplierId: h.ids.supplier, amountPaise: 100, method: 'Cash' });
    expect(codeOf(() => h.supplierPayments.reverse(payer, r.paymentId, 'entered wrongly'))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.supplierPayments.reverse(reverser, r.paymentId, ' '))).toBe('VALIDATION');
    expect(codeOf(() => h.supplierPayments.reverse(reverser, r.paymentId, 'entered wrongly'))).toBe('NO_ERROR');
    expect(h.db.prepare('SELECT created_by FROM supplier_payment').get()).not.toEqual({ created_by: 1 }); // recorded as the payer
  });
});

describe('reversing a payment to a supplier', () => {
  it('brings the amount owed back, keeps the record, and cannot be done twice', async () => {
    const h = await shopHarness();
    const bill = purchase(h);
    const r = h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: bill.total, method: 'Cheque', reference: 'CHQ 77', purchaseBillId: bill.id });
    expect(owed(h)).toBe(0);
    h.supplierPayments.reverse(h.ownerToken, r.paymentId, 'cheque returned unpaid');
    expect(owed(h)).toBe(bill.total);
    expect(h.purchases.get(h.ownerToken, bill.id)).toMatchObject({ outstandingPaise: bill.total, paymentStatus: 'UNPAID' });
    expect(h.purchases.get(h.ownerToken, bill.id).payments[0]).toMatchObject({ receiptNo: 'SP260001', reversed: true });
    expect(h.supplierPayments.list(h.ownerToken).rows[0]).toMatchObject({ reversed: true, reversalReason: 'cheque returned unpaid', amountPaise: bill.total });
    expect(h.db.prepare("SELECT reason FROM audit_log WHERE action = 'SUPPLIER_PAYMENT_REVERSE'").get()).toEqual({ reason: 'cheque returned unpaid' });
    expect(codeOf(() => h.supplierPayments.reverse(h.ownerToken, r.paymentId, 'again'))).toBe('CONFLICT');
    expect(codeOf(() => h.supplierPayments.reverse(h.ownerToken, 999, 'no such payment'))).toBe('NOT_FOUND');
    expect(h.supplierPayments.list(h.ownerToken, { includeReversed: false }).total).toBe(0);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });
});

describe('the supplier statement', () => {
  it('shows purchases and payments in order with the running balance', async () => {
    const h = await shopHarness();
    const bill = purchase(h);
    h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 5000, method: 'Cash' });
    const s = h.suppliers.statement(h.ownerToken, h.ids.supplier);
    expect(s.entries.map((e) => [e.label, e.amountPaise, e.balanceAfterPaise])).toEqual([['Purchase', bill.total, bill.total], ['Payment', -5000, bill.total - 5000]]);
    expect(s.entries[0]?.refNo).toMatch(/^PB26/);
    expect(s.entries[1]?.refNo).toBe('SP260001');
    expect(s).toMatchObject({ openingPaise: 0, closingPaise: bill.total - 5000, increasesPaise: bill.total, reducesPaise: 5000 });
  });
});

describe('searching supplier payments', () => {
  it('filters by supplier, date, number and reference', async () => {
    const h = await shopHarness();
    const other = h.suppliers.create(h.ownerToken, { name: 'OTHER SUPPLIER', state: 'West Bengal' });
    purchase(h);
    purchase(h, { supplierId: other });
    h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 100, method: 'Cash', paidOn: '2026-11-02', reference: 'ABC-1' });
    h.supplierPayments.record(h.ownerToken, { supplierId: other, amountPaise: 200, method: 'UPI', paidOn: '2026-11-04', reference: 'XYZ-9' });
    expect(h.supplierPayments.list(h.ownerToken).total).toBe(2);
    expect(h.supplierPayments.list(h.ownerToken, { supplierId: other }).rows.map((r) => r.amountPaise)).toEqual([200]);
    expect(h.supplierPayments.list(h.ownerToken, { fromDate: '2026-11-03' }).rows.map((r) => r.amountPaise)).toEqual([200]);
    expect(h.supplierPayments.list(h.ownerToken, { search: 'abc' }).rows.map((r) => r.amountPaise)).toEqual([100]);
    expect(h.supplierPayments.list(h.ownerToken, { search: 'SP260002' }).rows.map((r) => r.amountPaise)).toEqual([200]);
    expect(codeOf(() => h.supplierPayments.list(h.ownerToken, { toDate: 'never' }))).toBe('VALIDATION');
  });
});

describe('stress: purchases and sales together', () => {
  it('the books always agree and stock never goes negative, whatever the order of events', async () => {
    const h = await shopHarness();
    const suppliers = [h.ids.supplier, h.suppliers.create(h.ownerToken, { name: 'SECOND SUPPLIER', state: 'West Bengal' }), h.suppliers.create(h.ownerToken, { name: 'FAR SUPPLIER', state: 'Maharashtra' })];
    // mulberry32: a small generator with well-mixed bits (a plain linear congruential generator repeats itself in its low bits)
    let state = 20261109;
    const rnd = (k: number): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * k);
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
    let invoice = 0;

    for (let i = 0; i < 180; i++) {
      switch (rnd(8)) {
        case 0:
        case 1:
          attempt(() => {
            invoice += 1;
            const lines = Array.from({ length: 1 + rnd(2) }, () => {
              const invoiced = (1 + rnd(6)) * 1000;
              return { itemId: itemIds[rnd(3)] ?? h.ids.can, invoicedQtyMilli: invoiced, receivedQtyMilli: rnd(3) === 0 ? rnd(invoiced + 1) : invoiced };
            });
            const d = h.purchases.saveDraft(h.ownerToken, { supplierId: suppliers[rnd(3)] ?? h.ids.supplier, supplierInvoiceNo: `RND-${String(invoice)}`, supplierInvoiceDate: '2026-11-01', lines, delivery: rnd(2) ? { amountPaise: rnd(20000), gstRateBp: 1800 } : null });
            h.purchases.confirm(h.ownerToken, d.id);
          });
          break;
        case 2: {
          const open = h.db.prepare("SELECT b.id AS id FROM purchase_bill b WHERE b.status = 'CONFIRMED'").all() as { id: number }[];
          const pick = open[rnd(Math.max(1, open.length))];
          if (pick) {
            const bill = h.purchases.get(h.ownerToken, pick.id);
            const pending = bill.lines.find((l) => l.pendingQtyMilli > 0);
            if (pending) attempt(() => h.purchases.receive(h.ownerToken, pick.id, { lines: [{ lineNo: pending.lineNo, qtyMilli: 1 + rnd(pending.pendingQtyMilli) }] }));
          }
          break;
        }
        case 3:
          attempt(() => h.supplierPayments.record(h.ownerToken, { supplierId: suppliers[rnd(3)] ?? h.ids.supplier, amountPaise: 1 + rnd(40000), method: 'Cash' }));
          break;
        case 4: {
          const live = h.db.prepare('SELECT id FROM supplier_payment WHERE is_reversed = 0').all() as { id: number }[];
          const pick = live[rnd(Math.max(1, live.length))];
          if (pick) attempt(() => h.supplierPayments.reverse(h.ownerToken, pick.id, 'random reversal'));
          break;
        }
        case 5: {
          const bills = h.db.prepare("SELECT id FROM purchase_bill WHERE status = 'CONFIRMED'").all() as { id: number }[];
          const pick = bills[rnd(Math.max(1, bills.length))];
          if (pick) attempt(() => h.purchases.cancel(h.ownerToken, pick.id, 'random cancellation'));
          break;
        }
        default:
          attempt(() => {
            const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: itemIds[rnd(3)] ?? h.ids.can, qtyMilli: (1 + rnd(4)) * 1000 }] });
            h.sales.confirm(h.ownerToken, draft.id);
          });
      }
      expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
    }

    expect((h.db.prepare("SELECT COUNT(*) AS n FROM purchase_bill WHERE status = 'CONFIRMED'").get() as { n: number }).n).toBeGreaterThan(5); // the run did real work
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM supplier_payment').get() as { n: number }).n).toBeGreaterThan(3);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM item WHERE qty_milli < 0').get() as { n: number }).n).toBe(0);
    const unpaid = h.db.prepare(`SELECT b.id AS id FROM purchase_bill b WHERE b.status = 'CONFIRMED' AND b.total_paise - COALESCE((SELECT SUM(p.amount_paise) FROM supplier_payment p WHERE p.purchase_bill_id = b.id AND p.is_reversed = 0), 0) < 0`).all();
    expect(unpaid).toEqual([]); // no bill is ever paid beyond its total
  });
});
