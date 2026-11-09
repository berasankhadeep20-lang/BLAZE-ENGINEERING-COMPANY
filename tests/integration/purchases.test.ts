import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PurchaseDraftInput } from '../../src/application/purchases/purchaseService';
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
const qty = (h: Shop, id: number): number => h.items.get(h.ownerToken, id).qtyMilli;
const owed = (h: Shop, id = h.ids.supplier): number => h.suppliers.get(h.ownerToken, id).balancePaise;
const count = (h: Shop, sql: string): number => (h.db.prepare(sql).get() as { n: number }).n;

let invoiceSeq = 0;
/** A draft purchase of 5 milk cans at the supplier's rate 800.00 (taxable 4,000.00; tax 720.00; total 4,720.00) unless overridden. */
function draftInput(h: Shop, over: Partial<PurchaseDraftInput> = {}): PurchaseDraftInput {
  invoiceSeq += 1;
  return {
    supplierId: h.ids.supplier, supplierInvoiceNo: `INV-${String(invoiceSeq).padStart(3, '0')}`, supplierInvoiceDate: '2026-11-01', billDate: '2026-11-02',
    lines: [{ itemId: h.ids.can, invoicedQtyMilli: 5000, ratePaise: 80000 }], ...over,
  };
}
const enter = (h: Shop, over: Partial<PurchaseDraftInput> = {}): { id: number; billNo: string; total: number } => {
  const b = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, over)).id);
  return { id: b.id, billNo: b.billNo ?? '', total: b.totals.totalPaise };
};

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('entering a purchase bill', () => {
  it('adds the received quantity to stock, and the total to what we owe the supplier', async () => {
    const h = await shopHarness();
    const draft = h.purchases.saveDraft(h.ownerToken, draftInput(h, { supplierInvoiceNo: 'SUP/2026/118', orderNo: 'PO-7', transportMode: 'Road', vehicleNo: 'WB 01 AB 1234' }));
    expect(draft).toMatchObject({ status: 'DRAFT', billNo: null });
    expect(qty(h, h.ids.can)).toBe(10000); // a draft adds no stock
    expect(owed(h)).toBe(0);

    const bill = h.purchases.confirm(h.ownerToken, draft.id);
    expect(bill).toMatchObject({ status: 'CONFIRMED', billNo: 'PB260001', fy: '2026-27', taxType: 'INTRA', supplierInvoiceNo: 'SUP/2026/118', orderNo: 'PO-7', vehicleNo: 'WB 01 AB 1234', paymentStatus: 'UNPAID', outstandingPaise: 472000, goodsPending: false });
    expect(bill.lines[0]).toMatchObject({ description: 'PLASTIC MILK CAN', hsn: '3923', uomLabel: '40 - LTR', invoicedQtyMilli: 5000, receivedQtyMilli: 5000, pendingQtyMilli: 0, ratePaise: 80000, taxablePaise: 400000, cgstPaise: 36000, sgstPaise: 36000, totalPaise: 472000 });
    expect(bill.totals).toMatchObject({ taxableTotalPaise: 400000, cgstPaise: 36000, sgstPaise: 36000, totalTaxPaise: 72000, totalPaise: 472000, amountInWords: 'Four Thousand Seven Hundred Twenty only' });
    expect(bill.supplier).toMatchObject({ name: 'SAMPLE DAIRY EQUIPMENT CO', gstinDisplay: 'UN-REGD', state: 'West Bengal' });
    expect(qty(h, h.ids.can)).toBe(15000);
    expect(owed(h)).toBe(472000);
    expect(h.db.prepare("SELECT reason, qty_delta_milli, ref_no FROM stock_movement WHERE reason = 'PURCHASE' AND ref_no = 'PB260001'").all()).toEqual([{ reason: 'PURCHASE', qty_delta_milli: 5000, ref_no: 'PB260001' }]);
    expect(h.db.prepare("SELECT entry_type, amount_paise, ref_no, note FROM supplier_ledger WHERE entry_type = 'PURCHASE'").get()).toEqual({ entry_type: 'PURCHASE', amount_paise: 472000, ref_no: 'PB260001', note: 'Supplier invoice SUP/2026/118' });
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('uses IGST for a supplier in another state, and taxes delivery charges', async () => {
    const h = await shopHarness();
    const far = h.suppliers.create(h.ownerToken, { name: 'PUNE GLASSWORKS', state: 'Maharashtra' });
    const inter = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { supplierId: far })).id);
    expect(inter.taxType).toBe('INTER');
    expect(inter.totals).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 72000, totalPaise: 472000 });
    const withDelivery = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { delivery: { amountPaise: 10000, gstRateBp: 1800 } })).id);
    expect(withDelivery.totals).toMatchObject({ deliveryPaise: 10000, deliveryTaxPaise: 1800, taxableTotalPaise: 410000, totalPaise: 483800 });
  });

  it('numbers bills in sequence with the internal prefix (default PB), restarting each financial year', async () => {
    const h = await shopHarness();
    expect(enter(h).billNo).toBe('PB260001');
    expect(enter(h).billNo).toBe('PB260002');
    h.clock.advanceMinutes(60 * 24 * 200);
    expect(enter(h, { billDate: '2027-05-20', supplierInvoiceDate: '2027-05-19' }).billNo).toBe('PB270001');
  });

  it('drafts can be edited and deleted, and change nothing', async () => {
    const h = await shopHarness();
    const d = h.purchases.saveDraft(h.ownerToken, draftInput(h));
    const edited = h.purchases.saveDraft(h.ownerToken, { ...draftInput(h), id: d.id, supplierInvoiceNo: d.supplierInvoiceNo, lines: [{ itemId: h.ids.buty, invoicedQtyMilli: 20000 }, { itemId: h.ids.naoh, invoicedQtyMilli: 4000 }] });
    expect(edited.id).toBe(d.id);
    expect(edited.lines.map((l) => l.description)).toEqual(['BUTYROMETER FOR MILK 0-10% ISI', 'SODIUM HYDROXIDE N/10 SOLUTION']);
    expect(edited.lines[0]?.ratePaise).toBe(4000); // defaults to the item's current purchase rate
    h.purchases.deleteDraft(h.ownerToken, d.id);
    expect(count(h, 'SELECT COUNT(*) AS n FROM purchase_bill')).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM purchase_bill_line')).toBe(0);
    expect(qty(h, h.ids.buty)).toBe(100000);
  });

  it('refuses what cannot be entered: bad dates, blank supplier invoice number, inactive supplier or item, missing business state', async () => {
    const h = await shopHarness();
    const save = (over: Partial<PurchaseDraftInput>): unknown => h.purchases.saveDraft(h.ownerToken, draftInput(h, over));
    expect(codeOf(() => save({ supplierInvoiceNo: '  ' }))).toBe('VALIDATION');
    expect(codeOf(() => save({ supplierInvoiceDate: '2026-11-08' }))).toBe('VALIDATION'); // tomorrow
    expect(codeOf(() => save({ billDate: '2026-11-08' }))).toBe('VALIDATION');
    expect(codeOf(() => save({ lines: [] }))).toBe('VALIDATION');
    expect(codeOf(() => save({ lines: [{ itemId: h.ids.can, invoicedQtyMilli: 0 }] }))).toBe('VALIDATION');
    expect(codeOf(() => save({ lines: [{ itemId: h.ids.can, invoicedQtyMilli: 1000, receivedQtyMilli: 2000 }] }))).toBe('VALIDATION'); // more received than invoiced
    expect(codeOf(() => save({ lines: [{ itemId: 999, invoicedQtyMilli: 1000 }] }))).toBe('NOT_FOUND');
    expect(codeOf(() => save({ supplierId: 999 }))).toBe('NOT_FOUND');
    expect(codeOf(() => save({ lines: [{ itemId: h.ids.can, invoicedQtyMilli: 1000, discountPaise: 99999999 }] }))).toBe('VALIDATION');
    h.items.setActive(h.ownerToken, h.ids.can, false);
    expect(codeOf(() => save({}))).toBe('VALIDATION');
    h.items.setActive(h.ownerToken, h.ids.can, true);
    const other = h.suppliers.create(h.ownerToken, { name: 'GONE SUPPLIER', state: 'West Bengal' });
    h.suppliers.setActive(h.ownerToken, other, false);
    expect(codeOf(() => save({ supplierId: other }))).toBe('CONFLICT');

    const bare = await shopHarness({ configure: false });
    const d = bare.purchases.saveDraft(bare.ownerToken, draftInput(bare));
    expect(codeOf(() => bare.purchases.confirm(bare.ownerToken, d.id))).toBe('VALIDATION'); // business state not set
    expect(qty(bare, bare.ids.can)).toBe(10000);
  });

  it('never allows an entered bill to be edited or deleted, or confirmed twice', async () => {
    const h = await shopHarness();
    const b = enter(h);
    expect(codeOf(() => h.purchases.saveDraft(h.ownerToken, { ...draftInput(h), id: b.id }))).toBe('CONFLICT');
    expect(codeOf(() => h.purchases.deleteDraft(h.ownerToken, b.id))).toBe('CONFLICT');
    expect(codeOf(() => h.purchases.confirm(h.ownerToken, b.id))).toBe('CONFLICT');
    expect(() => h.db.prepare('UPDATE purchase_bill SET total_paise = 1 WHERE id = ?').run(b.id)).toThrow(/cannot be edited/);
  });

  it('rolls back the bill, stock, supplier balance, payment and number together if saving fails part-way', async () => {
    const h = await shopHarness();
    const d = h.purchases.saveDraft(h.ownerToken, draftInput(h, { paidPaise: 100000, paymentMethod: 'Cash' }));
    h.db.exec("CREATE TRIGGER boom BEFORE INSERT ON supplier_ledger WHEN NEW.entry_type = 'PAYMENT' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => h.purchases.confirm(h.ownerToken, d.id)).toThrow(/disk full/);
    expect(qty(h, h.ids.can)).toBe(10000);
    expect(owed(h)).toBe(0);
    expect(h.purchases.get(h.ownerToken, d.id)).toMatchObject({ status: 'DRAFT', billNo: null });
    expect(count(h, 'SELECT COUNT(*) AS n FROM purchase_receipt')).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM supplier_ledger')).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM supplier_payment')).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM stock_movement WHERE reason = 'PURCHASE'")).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM number_series WHERE series IN ('PURCHASE', 'SUPPLIER_RECEIPT')")).toBe(0);
    h.db.exec('DROP TRIGGER boom');
    expect(h.purchases.confirm(h.ownerToken, d.id).billNo).toBe('PB260001');
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });
});

describe('the supplier invoice number', () => {
  it('can be used once per supplier (capitals ignored) until that bill is cancelled', async () => {
    const h = await shopHarness();
    const other = h.suppliers.create(h.ownerToken, { name: 'OTHER SUPPLIER', state: 'West Bengal' });
    const first = h.purchases.saveDraft(h.ownerToken, draftInput(h, { supplierInvoiceNo: 'A-100' }));
    expect(codeOf(() => h.purchases.saveDraft(h.ownerToken, draftInput(h, { supplierInvoiceNo: 'a-100' })))).toBe('CONFLICT');
    expect(codeOf(() => h.purchases.saveDraft(h.ownerToken, draftInput(h, { supplierInvoiceNo: 'A-100', supplierId: other })))).toBe('NO_ERROR'); // another supplier
    expect(codeOf(() => h.purchases.saveDraft(h.ownerToken, { ...draftInput(h, { supplierInvoiceNo: 'A-100' }), id: first.id }))).toBe('NO_ERROR'); // editing the same draft
    expect(() => h.db.prepare(`INSERT INTO purchase_bill (status, bill_date, supplier_id, supplier_inv_no, supplier_inv_date, sup_name, tax_type, created_by, created_at)
      VALUES ('DRAFT', '2026-11-01', ?, 'a-100', '2026-11-01', 'X', 'INTRA', 1, 't')`).run(h.ids.supplier)).toThrow(/UNIQUE/); // and the database agrees

    const bill = h.purchases.confirm(h.ownerToken, first.id);
    h.purchases.cancel(h.ownerToken, bill.id, 'entered by mistake');
    expect(codeOf(() => h.purchases.saveDraft(h.ownerToken, draftInput(h, { supplierInvoiceNo: 'A-100' })))).toBe('NO_ERROR'); // free again
  });
});

describe('partial receipt', () => {
  it('bills what was invoiced but stocks only what arrived, then takes the rest when it comes', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { lines: [{ itemId: h.ids.can, invoicedQtyMilli: 10000, receivedQtyMilli: 6000, ratePaise: 80000 }] })).id);
    expect(bill.totals.totalPaise).toBe(944000); // billed on the 10 invoiced
    expect(owed(h)).toBe(944000);
    expect(qty(h, h.ids.can)).toBe(16000); // only 6 added
    expect(bill.lines[0]).toMatchObject({ invoicedQtyMilli: 10000, receivedQtyMilli: 6000, pendingQtyMilli: 4000 });
    expect(bill.goodsPending).toBe(true);
    expect(h.purchases.list(h.ownerToken, { pendingGoodsOnly: true }).rows.map((r) => r.id)).toEqual([bill.id]);

    const after = h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 3000 }], receivedOn: '2026-11-05', note: 'second lorry' });
    expect(qty(h, h.ids.can)).toBe(19000);
    expect(after.lines[0]).toMatchObject({ receivedQtyMilli: 9000, pendingQtyMilli: 1000 });
    expect(after.receipts.map((r) => [r.qtyMilli, r.receivedOn, r.userName])).toEqual([[6000, '2026-11-07', 'Shop Owner'], [3000, '2026-11-05', 'Shop Owner']]);
    expect(owed(h)).toBe(944000); // receiving more does not change what is billed

    const done = h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 1000 }] });
    expect(done.goodsPending).toBe(false);
    expect(qty(h, h.ids.can)).toBe(20000);
    expect(h.purchases.list(h.ownerToken, { pendingGoodsOnly: true }).total).toBe(0);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('cannot receive more than is still pending, twice on one line, nothing, or against a draft or cancelled bill', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { lines: [{ itemId: h.ids.can, invoicedQtyMilli: 4000, receivedQtyMilli: 3000 }] })).id);
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 1001 }] }))).toBe('VALIDATION');
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 500 }, { lineNo: 1, qtyMilli: 500 }] }))).toBe('VALIDATION');
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [] }))).toBe('VALIDATION');
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 0 }] }))).toBe('VALIDATION');
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 9, qtyMilli: 100 }] }))).toBe('NOT_FOUND');
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 100 }], receivedOn: '2026-12-25' }))).toBe('VALIDATION');
    expect(qty(h, h.ids.can)).toBe(13000);
    const draft = h.purchases.saveDraft(h.ownerToken, draftInput(h));
    expect(codeOf(() => h.purchases.receive(h.ownerToken, draft.id, { lines: [{ lineNo: 1, qtyMilli: 100 }] }))).toBe('CONFLICT');
    h.purchases.cancel(h.ownerToken, bill.id, 'supplier cancelled the order');
    expect(codeOf(() => h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 100 }] }))).toBe('CONFLICT');
  });

  it('nothing received yet is allowed: the bill is entered, stock is untouched, and everything is pending', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { lines: [{ itemId: h.ids.can, invoicedQtyMilli: 4000, receivedQtyMilli: 0 }] })).id);
    expect(qty(h, h.ids.can)).toBe(10000);
    expect(bill).toMatchObject({ goodsPending: true });
    expect(bill.lines[0]).toMatchObject({ receivedQtyMilli: 0, pendingQtyMilli: 4000 });
    expect(count(h, 'SELECT COUNT(*) AS n FROM purchase_receipt')).toBe(0);
    h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 4000 }] });
    expect(qty(h, h.ids.can)).toBe(14000);
  });
});

describe('paying the supplier when the bill is entered', () => {
  it('records a numbered payment and leaves only the rest owing', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { paidPaise: 100000, paymentMethod: 'cash' })).id, { paymentReference: 'CASH-9' });
    expect(owed(h)).toBe(372000);
    expect(bill).toMatchObject({ paidAtEntryPaise: 100000, paidPaise: 100000, outstandingPaise: 372000, paymentStatus: 'PARTIAL' });
    expect(bill.payments).toEqual([{ receiptNo: 'SP260001', paidOn: '2026-11-07', method: 'Cash', amountPaise: 100000, reversed: false }]);
    const row = h.supplierPayments.list(h.ownerToken).rows[0];
    expect(row).toMatchObject({ receiptNo: 'SP260001', purchaseBillNo: 'PB260001', reference: 'CASH-9', balanceAfterPaise: 372000, createdByName: 'Shop Owner' });
    expect(h.db.prepare('SELECT entry_type, amount_paise FROM supplier_ledger ORDER BY id').all()).toEqual([{ entry_type: 'PURCHASE', amount_paise: 472000 }, { entry_type: 'PAYMENT', amount_paise: -100000 }]);
  });

  it('refuses more than the total, an unknown method, and a missing method', async () => {
    const h = await shopHarness();
    const save = (over: Partial<PurchaseDraftInput>): unknown => h.purchases.saveDraft(h.ownerToken, draftInput(h, over));
    expect(codeOf(() => save({ paidPaise: 472001, paymentMethod: 'Cash' }))).toBe('VALIDATION');
    expect(codeOf(() => save({ paidPaise: 100, paymentMethod: 'Barter' }))).toBe('VALIDATION');
    expect(codeOf(() => save({ paidPaise: 100 }))).toBe('VALIDATION');
    expect(codeOf(() => save({ paidPaise: 0 }))).toBe('NO_ERROR');
  });
});

describe('the rate per piece, as on the sales invoice', () => {
  it('shows the item\'s current purchase rate first and what this supplier last charged; the user types what they charge now', async () => {
    const h = await shopHarness();
    const q1 = h.purchases.quoteLine(h.ownerToken, { itemId: h.ids.can, supplierId: h.ids.supplier });
    expect(q1).toMatchObject({ code: 'MC-40', currentRatePaise: 80000, stockQtyMilli: 10000, lastRatePaise: null });
    enter(h, { lines: [{ itemId: h.ids.can, invoicedQtyMilli: 1000, ratePaise: 78000 }], billDate: '2026-11-03' });
    expect(h.purchases.quoteLine(h.ownerToken, { itemId: h.ids.can, supplierId: h.ids.supplier })).toMatchObject({ currentRatePaise: 80000, lastRatePaise: 78000, lastBoughtOn: '2026-11-03' });
    expect(h.items.get(h.ownerToken, h.ids.can).purchaseRatePaise).toBe(80000); // typing a rate does not change the item
    expect(codeOf(() => h.purchases.quoteLine(h.ownerToken, { itemId: 999 }))).toBe('NOT_FOUND');
  });

  it('previews the totals without saving, and agrees with what saving computes', async () => {
    const h = await shopHarness();
    const input = draftInput(h, { delivery: { amountPaise: 5000, gstRateBp: 1800 }, lines: [{ itemId: h.ids.can, invoicedQtyMilli: 3000, ratePaise: 79000 }] });
    const pre = h.purchases.preview(h.ownerToken, input);
    expect(count(h, 'SELECT COUNT(*) AS n FROM purchase_bill')).toBe(0);
    const saved = h.purchases.saveDraft(h.ownerToken, input);
    expect(pre.totals).toEqual(saved.totals);
    expect(pre.lines).toEqual(saved.lines);
  });

  it('can bring the items\' purchase rates in line with the bill, but only with price.edit', async () => {
    const h = await shopHarness();
    const clerk = await makeEmployee(h, 'clerk', ['purchase.create']);
    const d = h.purchases.saveDraft(clerk, draftInput(h, { lines: [{ itemId: h.ids.can, invoicedQtyMilli: 1000, ratePaise: 82000 }, { itemId: h.ids.buty, invoicedQtyMilli: 1000 }] }));
    expect(codeOf(() => h.purchases.confirm(clerk, d.id, { updateItemPurchaseRates: true }))).toBe('PERMISSION_DENIED');
    expect(h.purchases.get(h.ownerToken, d.id).status).toBe('DRAFT'); // nothing happened
    h.purchases.confirm(h.ownerToken, d.id, { updateItemPurchaseRates: true });
    expect(h.items.get(h.ownerToken, h.ids.can).purchaseRatePaise).toBe(82000);
    expect(h.items.get(h.ownerToken, h.ids.buty).purchaseRatePaise).toBe(4000); // same rate: left alone
    const a = h.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'PRICE_CHANGE'").all() as { detail_json: string }[];
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0]?.detail_json ?? '{}')).toMatchObject({ code: 'MC-40', via: 'purchase PB260001', changes: { purchaseRatePaise: { from: 80000, to: 82000 } } });
  });
});

describe('cancelling a purchase', () => {
  it('needs bill.cancel and a reason, takes the received goods back out of stock, and removes what we owed', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { lines: [{ itemId: h.ids.can, invoicedQtyMilli: 5000, receivedQtyMilli: 3000 }] })).id);
    h.purchases.receive(h.ownerToken, bill.id, { lines: [{ lineNo: 1, qtyMilli: 1000 }] });
    expect(qty(h, h.ids.can)).toBe(14000);
    const clerk = await makeEmployee(h, 'clerk', ['purchase.create']);
    expect(codeOf(() => h.purchases.cancel(clerk, bill.id, 'wrong supplier'))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.purchases.cancel(h.ownerToken, bill.id, ' '))).toBe('VALIDATION');
    const cancelled = h.purchases.cancel(h.ownerToken, bill.id, 'wrong supplier');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'wrong supplier', billNo: bill.billNo, outstandingPaise: null, goodsPending: false });
    expect(qty(h, h.ids.can)).toBe(10000); // exactly what was received (4) went back out
    expect(owed(h)).toBe(0);
    expect(h.db.prepare("SELECT entry_type, amount_paise FROM supplier_ledger ORDER BY id").all()).toEqual([{ entry_type: 'PURCHASE', amount_paise: 472000 }, { entry_type: 'PURCHASE_CANCEL', amount_paise: -472000 }]);
    expect(codeOf(() => h.purchases.cancel(h.ownerToken, bill.id, 'again please'))).toBe('CONFLICT');
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('is refused if the goods have already been sold, and then nothing changes', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { lines: [{ itemId: h.ids.buty, invoicedQtyMilli: 10000 }] })).id);
    expect(qty(h, h.ids.buty)).toBe(110000);
    h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-03', lines: [{ itemId: h.ids.buty, qtyMilli: 105000 }] }).id);
    expect(qty(h, h.ids.buty)).toBe(5000);
    let err: AppError | undefined;
    try {
      h.purchases.cancel(h.ownerToken, bill.id, 'duplicate bill');
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('CONFLICT');
    expect(qty(h, h.ids.buty)).toBe(5000);
    expect(h.purchases.get(h.ownerToken, bill.id).status).toBe('CONFIRMED');
    expect(owed(h)).toBe(bill.totals.totalPaise);
  });

  it('is refused while payments to the supplier are recorded against the bill, until they are reversed', async () => {
    const h = await shopHarness();
    const bill = h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, draftInput(h, { paidPaise: 100000, paymentMethod: 'Cash' })).id);
    expect(codeOf(() => h.purchases.cancel(h.ownerToken, bill.id, 'returned all goods'))).toBe('CONFLICT');
    const pay = h.supplierPayments.list(h.ownerToken).rows[0];
    h.supplierPayments.reverse(h.ownerToken, pay?.id ?? 0, 'supplier refunded us');
    h.purchases.cancel(h.ownerToken, bill.id, 'returned all goods');
    expect(owed(h)).toBe(0);
    expect(qty(h, h.ids.can)).toBe(10000);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });
});

describe('finding purchase bills', () => {
  it('lists with filters and totals', async () => {
    const h = await shopHarness();
    const other = h.suppliers.create(h.ownerToken, { name: 'OTHER SUPPLIER', state: 'West Bengal' });
    const a = enter(h, { billDate: '2026-11-01', supplierInvoiceNo: 'ALPHA-1' });
    const b = enter(h, { billDate: '2026-11-03', supplierId: other, supplierInvoiceNo: 'BETA-1' });
    const c = enter(h, { billDate: '2026-11-05', supplierInvoiceNo: 'GAMMA-1' });
    h.purchases.cancel(h.ownerToken, c.id, 'entered twice');
    h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: a.total, method: 'Cash', purchaseBillId: a.id });
    h.purchases.saveDraft(h.ownerToken, draftInput(h, { billDate: '2026-11-06' }));

    const all = h.purchases.list(h.ownerToken);
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => r.status)).toEqual(['DRAFT', 'CANCELLED', 'CONFIRMED', 'CONFIRMED']);
    expect(all.totalBilledPaise).toBe(a.total + b.total);
    expect(all.totalOutstandingPaise).toBe(b.total);
    expect(h.purchases.list(h.ownerToken, { supplierId: other }).rows.map((r) => r.billNo)).toEqual([b.billNo]);
    expect(h.purchases.list(h.ownerToken, { statuses: ['CONFIRMED'], fromDate: '2026-11-02', toDate: '2026-11-04' }).rows.map((r) => r.billNo)).toEqual([b.billNo]);
    expect(h.purchases.list(h.ownerToken, { unpaidOnly: true }).rows.map((r) => r.billNo)).toEqual([b.billNo]);
    expect(h.purchases.list(h.ownerToken, { search: 'beta' }).total).toBe(1);
    expect(h.purchases.list(h.ownerToken, { search: 'OTHER SUP' }).total).toBe(1);
    expect(codeOf(() => h.purchases.list(h.ownerToken, { fromDate: '2026-11-05', toDate: '2026-11-01' }))).toBe('VALIDATION');
  });

  it('needs purchase.create to enter bills, and one of purchase.create / supplier.view / report.view to look', async () => {
    const h = await shopHarness();
    const viewer = await makeEmployee(h, 'viewer', ['supplier.view']);
    const nobody = await makeEmployee(h, 'nobody', ['inventory.view']);
    const d = h.purchases.saveDraft(h.ownerToken, draftInput(h));
    expect(codeOf(() => h.purchases.saveDraft(viewer, draftInput(h)))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.purchases.confirm(viewer, d.id))).toBe('PERMISSION_DENIED');
    expect(h.purchases.get(viewer, d.id).id).toBe(d.id);
    expect(codeOf(() => h.purchases.get(nobody, d.id))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.purchases.list(nobody))).toBe('PERMISSION_DENIED');
  });

  it('the integrity check flags goods received beyond what was invoiced', async () => {
    const h = await shopHarness();
    const b = enter(h);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
    h.db.prepare("INSERT INTO purchase_receipt (bill_id, line_no, qty_milli, received_on, user_id, at) VALUES (?, 1, 500, '2026-11-07', 1, 't')").run(b.id);
    expect(h.stock.checkIntegrity(h.ownerToken).map((i) => i.kind)).toEqual(expect.arrayContaining(['PURCHASE_OVER_RECEIVED']));
    expect(() => h.db.prepare('DELETE FROM purchase_receipt').run()).toThrow(/append-only/);
  });
});
