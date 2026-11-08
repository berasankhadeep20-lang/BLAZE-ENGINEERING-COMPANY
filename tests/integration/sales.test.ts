import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { makeEmployee, quickBill, sampleLines, shopHarness, type Shop } from '../helpers/shop';

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
const balance = (h: Shop, id = h.ids.farm): number => h.customers.get(h.ownerToken, id).balancePaise;
const count = (h: Shop, sql: string): number => (h.db.prepare(sql).get() as { n: number }).n;

// the shop is in India; "today" below is a local date in UTC+5:30
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('the sample bill, end to end', () => {
  it('issues the sample bill with exactly the sample figures', async () => {
    const h = await shopHarness();
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-10-31', lines: sampleLines(h.ids), delivery: { amountPaise: 9237, gstRateBp: 1800 } });
    expect(draft).toMatchObject({ status: 'DRAFT', billNo: null, taxType: 'INTRA' });
    expect(draft.totals.totalPaise).toBe(300000);
    // saving a draft touches nothing else
    expect([qty(h, h.ids.can), qty(h, h.ids.buty), qty(h, h.ids.naoh)]).toEqual([10000, 100000, 50000]);
    expect(balance(h)).toBe(0);

    const bill = h.sales.confirm(h.ownerToken, draft.id);
    expect(bill).toMatchObject({ status: 'CONFIRMED', billNo: 'BZ260001', fy: '2026-27', taxType: 'INTRA', confirmedByName: 'Shop Owner', paymentStatus: 'UNPAID', outstandingPaise: 300000 });
    expect(bill.lines.map((l) => [l.description, l.hsn, l.uomLabel, l.qtyMilli, l.ratePaise, l.taxablePaise, l.cgstPaise, l.sgstPaise, l.totalPaise])).toEqual([
      ['PLASTIC MILK CAN', '3923', '40 - LTR', 2000, 92500, 185000, 16650, 16650, 218300],
      ['BUTYROMETER FOR MILK 0-10% ISI', '7017', 'PCS - PCS', 2000, 5500, 11000, 990, 990, 12980],
      ['SODIUM HYDROXIDE N/10 SOLUTION', '2815', '500 - ML', 2000, 24500, 49000, 4410, 4410, 57820],
    ]);
    expect(bill.totals).toMatchObject({
      goodsTaxablePaise: 245000, taxableTotalPaise: 254237, cgstPaise: 22881, sgstPaise: 22881, igstPaise: 0, totalTaxPaise: 45762,
      deliveryPaise: 9237, deliveryGstRateBp: 1800, deliveryTaxPaise: 1662, roundOffPaise: 1, totalPaise: 300000, amountInWords: 'Three Thousand only',
    });
    expect(bill.customer).toMatchObject({ name: 'TEST DAIRY FARM', gstinDisplay: 'UN-REGD', state: 'West Bengal' });
    expect(bill.placeOfSupply).toBe('EXAMPLEPUR');
    expect([qty(h, h.ids.can), qty(h, h.ids.buty), qty(h, h.ids.naoh)]).toEqual([8000, 98000, 48000]); // sale bill decreases stock
    expect(balance(h)).toBe(300000); // and adds the unpaid amount to the customer's dues
    expect(h.db.prepare("SELECT entry_type, amount_paise, ref_no FROM customer_ledger WHERE entry_type = 'SALE'").all()).toEqual([{ entry_type: 'SALE', amount_paise: 300000, ref_no: 'BZ260001' }]);
    expect(count(h, "SELECT COUNT(*) AS n FROM stock_movement WHERE reason = 'SALE' AND ref_no = 'BZ260001'")).toBe(3);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('numbers bills in sequence and restarts the sequence in a new financial year', async () => {
    const h = await shopHarness();
    expect(quickBill(h, { date: '2026-11-01' }).billNo).toBe('BZ260001');
    expect(quickBill(h, { date: '2026-11-02' }).billNo).toBe('BZ260002');
    h.clock.advanceMinutes(60 * 24 * 200); // about 26 May 2027
    expect(quickBill(h, { date: '2027-05-20' }).billNo).toBe('BZ270001');
  });

  it('uses IGST when the customer is in another state', async () => {
    const h = await shopHarness();
    const other = h.customers.create(h.ownerToken, { name: 'PATNA DAIRY', state: 'Bihar' });
    const bill = h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: other, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 2000 }] }).id);
    expect(bill.taxType).toBe('INTER');
    expect(bill.totals).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 33300, totalPaise: 218300 });
    expect(bill.lines[0]).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 33300 });
  });
});

describe('drafts', () => {
  it('can be edited and deleted; none of it changes stock, dues or numbers', async () => {
    const h = await shopHarness();
    const d1 = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    const d2 = h.sales.saveDraft(h.ownerToken, { id: d1.id, customerId: h.ids.farm, invoiceDate: '2026-11-02', notes: 'second look', lines: [{ itemId: h.ids.buty, qtyMilli: 3000 }, { itemId: h.ids.naoh, qtyMilli: 1000 }] });
    expect(d2.id).toBe(d1.id);
    expect(d2.lines.map((l) => l.description)).toEqual(['BUTYROMETER FOR MILK 0-10% ISI', 'SODIUM HYDROXIDE N/10 SOLUTION']);
    expect(d2).toMatchObject({ invoiceDate: '2026-11-02', notes: 'second look', billNo: null });
    expect(qty(h, h.ids.can)).toBe(10000);
    h.sales.deleteDraft(h.ownerToken, d1.id);
    expect(count(h, 'SELECT COUNT(*) AS n FROM sale_bill')).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM sale_bill_line')).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SALE_DELETE_DRAFT'")).toBe(1);
  });

  it('lists every validation problem and refuses unusable items, customers and dates', async () => {
    const h = await shopHarness();
    const base = { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] };
    let err: AppError | undefined;
    try {
      h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: 'yesterday', lines: [] });
    } catch (e) {
      err = e as AppError;
    }
    expect((err?.details?.problems as string[]).length).toBeGreaterThanOrEqual(2);
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, { ...base, lines: [{ itemId: h.ids.can, qtyMilli: 0 }] }))).toBe('VALIDATION');
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, { ...base, lines: [{ itemId: 999, qtyMilli: 1000 }] }))).toBe('NOT_FOUND');
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, { ...base, customerId: 999 }))).toBe('NOT_FOUND');
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, { ...base, lines: [{ itemId: h.ids.can, qtyMilli: 1000, discountPaise: 999999 }] }))).toBe('VALIDATION'); // discount above the amount
    h.items.setActive(h.ownerToken, h.ids.can, false);
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, base))).toBe('VALIDATION'); // inactive item
    h.items.setActive(h.ownerToken, h.ids.can, true);
    h.customers.setActive(h.ownerToken, h.ids.farm, false);
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, base))).toBe('CONFLICT'); // inactive customer
  });

  it('rejects a future invoice date but allows today and earlier', async () => {
    const h = await shopHarness(); // the test clock says 2026-11-07 10:00 UTC = 15:30 IST
    const mk = (date: string): unknown => h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: date, lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    expect(codeOf(() => mk('2026-11-08'))).toBe('VALIDATION');
    expect(codeOf(() => mk('2026-11-07'))).toBe('NO_ERROR');
    expect(codeOf(() => mk('2026-10-01'))).toBe('NO_ERROR');
  });

  it('an employee sells at the item rate; any other rate or any discount needs price.edit', async () => {
    const h = await shopHarness();
    const clerk = await makeEmployee(h, 'clerk', ['sale.create']);
    const mk = (line: { ratePaise?: number; discountPaise?: number }): unknown =>
      h.sales.saveDraft(clerk, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000, ...line }] });
    expect(codeOf(() => mk({}))).toBe('NO_ERROR');
    expect(codeOf(() => mk({ ratePaise: 92500 }))).toBe('NO_ERROR'); // same as the item rate
    expect(codeOf(() => mk({ ratePaise: 90000 }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => mk({ discountPaise: 100 }))).toBe('PERMISSION_DENIED');
    const trusted = await makeEmployee(h, 'trusted', ['sale.create', 'price.edit']);
    expect(codeOf(() => h.sales.saveDraft(trusted, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000, discountPaise: 100 }] }))).toBe('NO_ERROR');
  });

  it('needs sale.create to save or confirm, and one of sale.create / customer.view / report.view to look', async () => {
    const h = await shopHarness();
    const viewer = await makeEmployee(h, 'viewer', ['customer.view']);
    const nobody = await makeEmployee(h, 'nobody', ['inventory.view']);
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    expect(codeOf(() => h.sales.saveDraft(viewer, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.sales.confirm(viewer, draft.id))).toBe('PERMISSION_DENIED');
    expect(h.sales.get(viewer, draft.id).id).toBe(draft.id);
    expect(codeOf(() => h.sales.get(nobody, draft.id))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.sales.list(nobody))).toBe('PERMISSION_DENIED');
  });
});

describe('confirming', () => {
  it('needs the business state and invoice prefix to be set first', async () => {
    const h = await shopHarness({ configure: false });
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    let err: AppError | undefined;
    try {
      h.sales.confirm(h.ownerToken, draft.id);
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('VALIDATION');
    expect(err?.details?.missing).toEqual(['your business state', 'the invoice number prefix']);
    expect(qty(h, h.ids.can)).toBe(10000);
  });

  it('blocks a sale that exceeds stock, reports every shortage, and changes nothing', async () => {
    const h = await shopHarness();
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 11000 }, { itemId: h.ids.buty, qtyMilli: 1000 }, { itemId: h.ids.naoh, qtyMilli: 60000 }] });
    let err: AppError | undefined;
    try {
      h.sales.confirm(h.ownerToken, draft.id);
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('INSUFFICIENT_STOCK');
    expect(err?.details?.shortages).toEqual([
      { itemCode: 'MC-40', availableMilli: 10000, requestedMilli: 11000 },
      { itemCode: 'NAOH-500', availableMilli: 50000, requestedMilli: 60000 },
    ]);
    expect([qty(h, h.ids.can), qty(h, h.ids.buty), qty(h, h.ids.naoh)]).toEqual([10000, 100000, 50000]);
    expect(balance(h)).toBe(0);
    expect(h.sales.get(h.ownerToken, draft.id)).toMatchObject({ status: 'DRAFT', billNo: null });
    // the invoice number was not used up
    h.sales.saveDraft(h.ownerToken, { id: draft.id, customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    expect(h.sales.confirm(h.ownerToken, draft.id).billNo).toBe('BZ260001');
  });

  it('adds up the same item across lines when checking stock, and checks at confirm time, not at draft time', async () => {
    const h = await shopHarness();
    const both = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 6000 }, { itemId: h.ids.can, qtyMilli: 6000 }] });
    expect(codeOf(() => h.sales.confirm(h.ownerToken, both.id))).toBe('INSUFFICIENT_STOCK'); // each line alone would fit
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 8000 }] });
    h.stock.recordLoss(h.ownerToken, { itemId: h.ids.can, kind: 'DAMAGED', qtyMilli: 5000, note: 'water damage' }); // stock drops while the draft sits there
    expect(codeOf(() => h.sales.confirm(h.ownerToken, draft.id))).toBe('INSUFFICIENT_STOCK');
    expect(qty(h, h.ids.can)).toBe(5000);
  });

  it('can sell exactly all remaining stock', async () => {
    const h = await shopHarness();
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 10000 }] });
    h.sales.confirm(h.ownerToken, draft.id);
    expect(qty(h, h.ids.can)).toBe(0);
  });

  it('rolls back the bill, stock, dues, receipt and number together if saving fails part-way', async () => {
    const h = await shopHarness();
    const draft = h.sales.saveDraft(h.ownerToken, {
      customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: sampleLines(h.ids), receivedPaise: 100000, paymentMethod: 'Cash',
    });
    // simulate a failure at the very last step (recording the payment), after stock, dues and the number have already been written
    h.db.exec("CREATE TRIGGER boom BEFORE INSERT ON customer_ledger WHEN NEW.entry_type = 'PAYMENT' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => h.sales.confirm(h.ownerToken, draft.id)).toThrow(/disk full/);

    expect([qty(h, h.ids.can), qty(h, h.ids.buty), qty(h, h.ids.naoh)]).toEqual([10000, 100000, 50000]);
    expect(balance(h)).toBe(0);
    expect(h.sales.get(h.ownerToken, draft.id)).toMatchObject({ status: 'DRAFT', billNo: null });
    expect(count(h, "SELECT COUNT(*) AS n FROM stock_movement WHERE reason = 'SALE'")).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM customer_ledger')).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM customer_payment')).toBe(0);
    expect(count(h, 'SELECT COUNT(*) AS n FROM payment_allocation')).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SALE_CONFIRM'")).toBe(0);
    expect(count(h, "SELECT COUNT(*) AS n FROM number_series WHERE series IN ('SALE', 'RECEIPT')")).toBe(0);

    h.db.exec('DROP TRIGGER boom');
    const bill = h.sales.confirm(h.ownerToken, draft.id);
    expect(bill.billNo).toBe('BZ260001'); // the first number, not the second
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('refuses a pending customer until the owner approves, but allows the draft', async () => {
    const h = await shopHarness();
    const clerk = await makeEmployee(h, 'clerk', ['sale.create', 'customer.create', 'customer.view']);
    const newCustomer = h.customers.create(clerk, { name: 'CLERK ADDED FARM', state: 'West Bengal' });
    const draft = h.sales.saveDraft(clerk, { customerId: newCustomer, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    expect(codeOf(() => h.sales.confirm(clerk, draft.id))).toBe('CUSTOMER_NOT_APPROVED');
    h.customers.approve(h.ownerToken, newCustomer);
    expect(h.sales.confirm(clerk, draft.id).status).toBe('CONFIRMED');
  });

  it('takes the current tax rate at confirmation, keeps the agreed price, and freezes the customer details', async () => {
    const h = await shopHarness();
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    h.items.update(h.ownerToken, h.ids.can, { gstRateBp: 500, saleRatePaise: 99999 }); // changed after the draft was saved
    const bill = h.sales.confirm(h.ownerToken, draft.id);
    expect(bill.lines[0]).toMatchObject({ ratePaise: 92500, gstRateBp: 500, cgstPaise: 2313, sgstPaise: 2313 }); // old agreed price, new tax rate
    h.customers.update(h.ownerToken, h.ids.farm, { name: 'RENAMED FARM', address: 'A new address' });
    expect(h.sales.get(h.ownerToken, bill.id).customer).toMatchObject({ name: 'TEST DAIRY FARM', address: 'Vill Example, Hooghly 712000' });
  });

  it('never allows an issued bill to be edited or deleted', async () => {
    const h = await shopHarness();
    const q = quickBill(h);
    expect(codeOf(() => h.sales.saveDraft(h.ownerToken, { id: q.id, customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.buty, qtyMilli: 1000 }] }))).toBe('CONFLICT');
    expect(codeOf(() => h.sales.deleteDraft(h.ownerToken, q.id))).toBe('CONFLICT');
    expect(codeOf(() => h.sales.confirm(h.ownerToken, q.id))).toBe('CONFLICT');
    expect(() => h.db.prepare('UPDATE sale_bill SET total_paise = 1 WHERE id = ?').run(q.id)).toThrow(/cannot be edited/);
  });
});

describe('selling below cost', () => {
  const cheap = (h: Shop): number => h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 2000, ratePaise: 70000 }] }).id; // cost is 80000 each

  it('warns, needs an explicit acknowledgement, then goes through and is recorded', async () => {
    const h = await shopHarness();
    const id = cheap(h);
    let err: AppError | undefined;
    try {
      h.sales.confirm(h.ownerToken, id);
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('ACK_REQUIRED');
    expect(err?.details).toEqual({ kind: 'BELOW_COST', lines: [{ lineNo: 1, itemCode: 'MC-40' }] });
    expect(qty(h, h.ids.can)).toBe(10000);
    const bill = h.sales.confirm(h.ownerToken, id, { acknowledgeBelowCost: true });
    expect(bill.lines[0]?.belowCost).toBe(true);
    expect(count(h, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BELOW_COST_ACK'")).toBe(1);
  });

  it('is never a hard block: the warning can be switched off in settings', async () => {
    const h = await shopHarness();
    h.settings.update(h.ownerToken, { warnBelowCost: false });
    expect(codeOf(() => h.sales.confirm(h.ownerToken, cheap(h)))).toBe('NO_ERROR');
  });

  it('does not flag a sale at or above cost', async () => {
    const h = await shopHarness();
    const bill = h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000, ratePaise: 80000 }] }).id);
    expect(bill.lines[0]?.belowCost).toBe(false);
  });
});

describe('money taken at the time of sale', () => {
  const draftWith = (h: Shop, over: object): number =>
    h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: sampleLines(h.ids), delivery: { amountPaise: 9237, gstRateBp: 1800 }, ...over }).id;

  it('records a numbered receipt, and only the unpaid part becomes dues', async () => {
    const h = await shopHarness();
    const bill = h.sales.confirm(h.ownerToken, draftWith(h, { receivedPaise: 100000, paymentMethod: 'cash' }), { paymentReference: 'CASH-1' });
    expect(balance(h)).toBe(200000);
    expect(bill).toMatchObject({ receivedAtSalePaise: 100000, outstandingPaise: 200000, paymentStatus: 'PARTIAL', paymentMethod: 'Cash' }); // typed as "cash", stored as spelled in Settings
    expect(bill.payments).toEqual([{ receiptNo: 'RC260001', paidOn: '2026-11-07', method: 'Cash', amountPaise: 100000, reversed: false }]);
    expect(h.db.prepare('SELECT reference, note, balance_after_paise FROM customer_payment').get()).toEqual({ reference: 'CASH-1', note: `Received with bill ${bill.billNo}`, balance_after_paise: 200000 });
    expect(h.db.prepare('SELECT entry_type, amount_paise FROM customer_ledger ORDER BY id').all()).toEqual([{ entry_type: 'SALE', amount_paise: 300000 }, { entry_type: 'PAYMENT', amount_paise: -100000 }]);
  });

  it('a fully paid bill leaves no dues', async () => {
    const h = await shopHarness();
    const bill = h.sales.confirm(h.ownerToken, draftWith(h, { receivedPaise: 300000, paymentMethod: 'UPI' }));
    expect(balance(h)).toBe(0);
    expect(bill).toMatchObject({ outstandingPaise: 0, paymentStatus: 'PAID' });
  });

  it('refuses more than the total, an unknown method, and a missing method', async () => {
    const h = await shopHarness();
    expect(codeOf(() => draftWith(h, { receivedPaise: 300001, paymentMethod: 'Cash' }))).toBe('VALIDATION');
    expect(codeOf(() => draftWith(h, { receivedPaise: 100, paymentMethod: 'Barter' }))).toBe('VALIDATION');
    expect(codeOf(() => draftWith(h, { receivedPaise: 100 }))).toBe('VALIDATION');
    expect(codeOf(() => draftWith(h, { receivedPaise: 0 }))).toBe('NO_ERROR');
  });
});

describe('cancelling', () => {
  it('needs bill.cancel and a reason; stock and dues come back; the number stays used', async () => {
    const h = await shopHarness();
    const first = quickBill(h, { qtyMilli: 10000 });
    expect(qty(h, h.ids.buty)).toBe(90000);
    const clerk = await makeEmployee(h, 'clerk', ['sale.create']);
    expect(codeOf(() => h.sales.cancel(clerk, first.id, 'wrong customer'))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.sales.cancel(h.ownerToken, first.id, ' '))).toBe('VALIDATION');

    const cancelled = h.sales.cancel(h.ownerToken, first.id, 'wrong customer');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'wrong customer', cancelledByName: 'Shop Owner', billNo: first.billNo, outstandingPaise: null });
    expect(qty(h, h.ids.buty)).toBe(100000);
    expect(balance(h)).toBe(0);
    expect(h.db.prepare("SELECT entry_type, amount_paise FROM customer_ledger ORDER BY id").all()).toEqual([{ entry_type: 'SALE', amount_paise: first.totalPaise }, { entry_type: 'SALE_CANCEL', amount_paise: -first.totalPaise }]);
    expect(h.db.prepare("SELECT reason, note FROM stock_movement WHERE reason = 'SALE_CANCEL'").get()).toEqual({ reason: 'SALE_CANCEL', note: 'wrong customer' });
    expect(h.db.prepare("SELECT reason, user_id FROM audit_log WHERE action = 'SALE_CANCEL'").get()).toEqual({ reason: 'wrong customer', user_id: 1 });
    expect(quickBill(h).billNo).toBe('BZ260002'); // BZ260001 is never reused
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });

  it('cannot cancel twice, cannot cancel a draft, and a cancelled bill stays cancelled', async () => {
    const h = await shopHarness();
    const q = quickBill(h);
    h.sales.cancel(h.ownerToken, q.id, 'duplicate entry');
    expect(codeOf(() => h.sales.cancel(h.ownerToken, q.id, 'again please'))).toBe('CONFLICT');
    expect(codeOf(() => h.sales.confirm(h.ownerToken, q.id))).toBe('CONFLICT');
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    expect(codeOf(() => h.sales.cancel(h.ownerToken, draft.id, 'not issued'))).toBe('CONFLICT');
    expect(codeOf(() => h.sales.cancel(h.ownerToken, 999, 'no such bill'))).toBe('NOT_FOUND');
  });

  it('a bill with money recorded against it can be cancelled only after those payments are reversed', async () => {
    const h = await shopHarness();
    const draft = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 2000 }], receivedPaise: 100000, paymentMethod: 'Cash' });
    const bill = h.sales.confirm(h.ownerToken, draft.id);
    expect(codeOf(() => h.sales.cancel(h.ownerToken, bill.id, 'customer returned all'))).toBe('CONFLICT');
    expect(balance(h)).toBe(bill.totals.totalPaise - 100000);

    const payment = h.payments.list(h.ownerToken).rows[0];
    h.payments.reverse(h.ownerToken, payment?.id ?? 0, 'refunded in cash');
    h.sales.cancel(h.ownerToken, bill.id, 'customer returned all');
    expect(balance(h)).toBe(0);
    expect(qty(h, h.ids.can)).toBe(10000);
    expect(h.stock.checkIntegrity(h.ownerToken)).toEqual([]);
  });
});

describe('finding bills', () => {
  it('lists with filters and totals', async () => {
    const h = await shopHarness();
    const other = h.customers.create(h.ownerToken, { name: 'OTHER FARM', state: 'West Bengal' });
    const a = quickBill(h, { date: '2026-11-01' });
    const b = quickBill(h, { date: '2026-11-03', customerId: other });
    const c = quickBill(h, { date: '2026-11-05' });
    h.sales.cancel(h.ownerToken, c.id, 'entered twice');
    h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: a.totalPaise, method: 'Cash' });
    h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-06', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });

    const all = h.sales.list(h.ownerToken);
    expect(all.total).toBe(4);
    expect(all.rows.map((r) => [r.billNo, r.status])).toEqual([[null, 'DRAFT'], [c.billNo, 'CANCELLED'], [b.billNo, 'CONFIRMED'], [a.billNo, 'CONFIRMED']]); // newest first
    expect(all.totalBilledPaise).toBe(a.totalPaise + b.totalPaise); // cancelled bills and drafts are not billed
    expect(all.totalOutstandingPaise).toBe(b.totalPaise);
    expect(h.sales.list(h.ownerToken, { customerId: other }).rows.map((r) => r.billNo)).toEqual([b.billNo]);
    expect(h.sales.list(h.ownerToken, { statuses: ['CONFIRMED'], fromDate: '2026-11-02', toDate: '2026-11-04' }).rows.map((r) => r.billNo)).toEqual([b.billNo]);
    expect(h.sales.list(h.ownerToken, { unpaidOnly: true }).rows.map((r) => r.billNo)).toEqual([b.billNo]);
    expect(h.sales.list(h.ownerToken, { search: 'other' }).total).toBe(1);
    expect(h.sales.list(h.ownerToken, { search: 'BZ260001' }).rows[0]?.outstandingPaise).toBe(0);
    expect(h.sales.list(h.ownerToken, { limit: 2, offset: 1 }).rows).toHaveLength(2);
    expect(codeOf(() => h.sales.list(h.ownerToken, { fromDate: '2026-11-05', toDate: '2026-11-01' }))).toBe('VALIDATION');
  });
});
