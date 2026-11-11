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
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

interface World extends Shop {
  second: number;
  far: number;
  supplier2: number;
}

/**
 * A small shop history (today is 2026-11-07), worked out by hand:
 *   sales:   B1 farm 1 Nov: 2 cans + 10 butyrometers (283,200.00? no: Rs 2,832.00)   B2 farm 1 Nov: 10 butyrometers (Rs 649.00)
 *            B6 farm 2 Nov: 5 butyrometers (CANCELLED)   B3 second farm 3 Nov: 1 can (Rs 1,092.00)
 *            B4 Patna (Bihar, IGST) 5 Nov: 4 NaOH (Rs 1,156.00)   B5 farm 7 Nov: 1 can (Rs 1,092.00)
 *   purchases: P1 supplier 2 Nov: 5 cans (Rs 4,720.00)  P2 supplier 4 Nov: 10 butyrometers (Rs 472.00)  P3 supplier 2, 6 Nov: 1 NaOH (Rs 236.00)
 *   money: farm paid Rs 500.00 on 3 Nov; Rs 1,000.00 paid to supplier 1 on 4 Nov.
 */
async function world(): Promise<World> {
  const h = await shopHarness();
  const second = h.customers.create(h.ownerToken, { name: 'SECOND FARM', state: 'West Bengal' });
  const far = h.customers.create(h.ownerToken, { name: 'PATNA DAIRY', state: 'Bihar' });
  const supplier2 = h.suppliers.create(h.ownerToken, { name: 'SECOND SUPPLIER', state: 'West Bengal' });
  const sale = (customerId: number, date: string, lines: { itemId: number; qtyMilli: number }[]): number =>
    h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId, invoiceDate: date, lines }).id).id;
  const buy = (supplierId: number, date: string, no: string, itemId: number, qtyMilli: number, ratePaise?: number): void => {
    h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, { supplierId, supplierInvoiceNo: no, supplierInvoiceDate: date, billDate: date, lines: [{ itemId, invoicedQtyMilli: qtyMilli, ratePaise }] }).id);
  };
  sale(h.ids.farm, '2026-11-01', [{ itemId: h.ids.can, qtyMilli: 2000 }, { itemId: h.ids.buty, qtyMilli: 10000 }]); // B1
  sale(h.ids.farm, '2026-11-01', [{ itemId: h.ids.buty, qtyMilli: 10000 }]); // B2
  h.sales.cancel(h.ownerToken, sale(h.ids.farm, '2026-11-02', [{ itemId: h.ids.buty, qtyMilli: 5000 }]), 'entered by mistake'); // B6
  sale(second, '2026-11-03', [{ itemId: h.ids.can, qtyMilli: 1000 }]); // B3
  sale(far, '2026-11-05', [{ itemId: h.ids.naoh, qtyMilli: 4000 }]); // B4
  sale(h.ids.farm, '2026-11-07', [{ itemId: h.ids.can, qtyMilli: 1000 }]); // B5
  buy(h.ids.supplier, '2026-11-02', 'P-1', h.ids.can, 5000, 80000);
  buy(h.ids.supplier, '2026-11-04', 'P-2', h.ids.buty, 10000);
  buy(supplier2, '2026-11-06', 'P-3', h.ids.naoh, 1000, 20000);
  h.payments.record(h.ownerToken, { customerId: h.ids.farm, amountPaise: 50000, method: 'Cash', paidOn: '2026-11-03' });
  h.supplierPayments.record(h.ownerToken, { supplierId: h.ids.supplier, amountPaise: 100000, method: 'Cash', paidOn: '2026-11-04' });
  return { ...h, second, far, supplier2 };
}

describe('best-selling items', () => {
  it('ranks by quantity, bills or value; units and separate bills are different columns; cancelled bills do not count', async () => {
    const h = await world();
    const byQty = h.reports.bestSellers(h.ownerToken);
    expect(byQty.map((r) => r.code)).toEqual(['BUT-10', 'MC-40', 'NAOH-500']);
    expect(byQty[0]).toEqual({ itemId: h.ids.buty, code: 'BUT-10', name: 'BUTYROMETER FOR MILK 0-10% ISI', unit: 'PCS', totalQtyMilli: 20000, billCount: 2, salesValuePaise: 110000, salesValueInclTaxPaise: 129800, averageRatePaise: 5500 });
    expect(byQty[1]).toMatchObject({ totalQtyMilli: 4000, billCount: 3, salesValuePaise: 370000, salesValueInclTaxPaise: 436600, averageRatePaise: 92500 });
    expect(byQty[2]).toMatchObject({ totalQtyMilli: 4000, billCount: 1, salesValuePaise: 98000, salesValueInclTaxPaise: 115640 });
    expect(h.reports.bestSellers(h.ownerToken, { sortBy: 'bills' }).map((r) => [r.code, r.billCount])).toEqual([['MC-40', 3], ['BUT-10', 2], ['NAOH-500', 1]]);
    expect(h.reports.bestSellers(h.ownerToken, { sortBy: 'value' }).map((r) => [r.code, r.salesValuePaise])).toEqual([['MC-40', 370000], ['BUT-10', 110000], ['NAOH-500', 98000]]);
    expect(h.reports.bestSellers(h.ownerToken, { limit: 1 })).toHaveLength(1);
  });

  it('respects the date range (inclusive, on the invoice date)', async () => {
    const h = await world();
    const mid = h.reports.bestSellers(h.ownerToken, { fromDate: '2026-11-02', toDate: '2026-11-06' });
    expect(mid.map((r) => [r.code, r.totalQtyMilli, r.billCount])).toEqual([['NAOH-500', 4000, 1], ['MC-40', 1000, 1]]);
    expect(h.reports.bestSellers(h.ownerToken, { fromDate: '2026-11-07', toDate: '2026-11-07' }).map((r) => r.code)).toEqual(['MC-40']);
    expect(h.reports.bestSellers(h.ownerToken, { fromDate: '2027-01-01' })).toEqual([]);
    expect(codeOf(() => h.reports.bestSellers(h.ownerToken, { fromDate: '2026-11-05', toDate: '2026-11-01' }))).toBe('VALIDATION');
    expect(codeOf(() => h.reports.bestSellers(h.ownerToken, { fromDate: 'last week' }))).toBe('VALIDATION');
  });
});

describe('customer purchase history', () => {
  it('shows each item with its total quantity, the number of separate bills containing it, its dates and its value', async () => {
    const h = await world();
    const r = h.reports.customerPurchaseHistory(h.ownerToken, { customerId: h.ids.farm });
    expect(r.customer).toEqual({ id: h.ids.farm, name: 'TEST DAIRY FARM' });
    expect(r).toMatchObject({ billCount: 3, billsTotalPaise: 457300 });
    expect(r.items.map((i) => i.code)).toEqual(['BUT-10', 'MC-40']);
    expect(r.items[0]).toMatchObject({ totalQtyMilli: 20000, billCount: 2, firstDate: '2026-11-01', lastDate: '2026-11-01', salesValuePaise: 110000, salesValueInclTaxPaise: 129800 });
    expect(r.items[0]?.purchases.map((p) => [p.invoiceDate, p.qtyMilli, p.ratePaise])).toEqual([['2026-11-01', 10000, 5500], ['2026-11-01', 10000, 5500]]);
    expect(r.items[1]).toMatchObject({ totalQtyMilli: 3000, billCount: 2, firstDate: '2026-11-01', lastDate: '2026-11-07', salesValuePaise: 277500, salesValueInclTaxPaise: 327450 });
    expect(r.items[1]?.purchases.map((p) => [p.invoiceDate, p.qtyMilli])).toEqual([['2026-11-01', 2000], ['2026-11-07', 1000]]);
    const late = h.reports.customerPurchaseHistory(h.ownerToken, { customerId: h.ids.farm, fromDate: '2026-11-02' });
    expect(late.items.map((i) => [i.code, i.totalQtyMilli, i.billCount])).toEqual([['MC-40', 1000, 1]]); // the cancelled bill is not there
    expect(late.billCount).toBe(1);
  });

  it('10 units bought in one bill is 10 units and one bill; a second bill makes it 20 units and two', async () => {
    const h = await shopHarness();
    const c = h.customers.create(h.ownerToken, { name: 'THIRD FARM', state: 'West Bengal' });
    const buy = (date: string): void => {
      h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: c, invoiceDate: date, lines: [{ itemId: h.ids.buty, qtyMilli: 10000 }] }).id);
    };
    buy('2026-11-01');
    const one = h.reports.customerPurchaseHistory(h.ownerToken, { customerId: c });
    expect(one.items[0]).toMatchObject({ totalQtyMilli: 10000, billCount: 1 });
    buy('2026-11-03');
    const two = h.reports.customerPurchaseHistory(h.ownerToken, { customerId: c });
    expect(two.items[0]).toMatchObject({ totalQtyMilli: 20000, billCount: 2, firstDate: '2026-11-01', lastDate: '2026-11-03' });
  });

  it('counts a bill once even if the item is on two of its lines; customers with no purchases give an empty history', async () => {
    const h = await shopHarness();
    h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }, { itemId: h.ids.can, qtyMilli: 2000 }] }).id);
    expect(h.reports.customerPurchaseHistory(h.ownerToken, { customerId: h.ids.farm }).items[0]).toMatchObject({ totalQtyMilli: 3000, billCount: 1 });
    const empty = h.customers.create(h.ownerToken, { name: 'NEVER BOUGHT', state: 'West Bengal' });
    expect(h.reports.customerPurchaseHistory(h.ownerToken, { customerId: empty })).toMatchObject({ items: [], billCount: 0, billsTotalPaise: 0 });
    expect(codeOf(() => h.reports.customerPurchaseHistory(h.ownerToken, { customerId: 999 }))).toBe('NOT_FOUND');
  });

  it('can be seen with customer.view or report.view', async () => {
    const h = await world();
    const viewer = await makeEmployee(h, 'viewer', ['customer.view']);
    const nobody = await makeEmployee(h, 'nobody', ['sale.create']);
    expect(codeOf(() => h.reports.customerPurchaseHistory(viewer, { customerId: h.ids.farm }))).toBe('NO_ERROR');
    expect(codeOf(() => h.reports.customerPurchaseHistory(nobody, { customerId: h.ids.farm }))).toBe('PERMISSION_DENIED');
  });
});

describe('sales and purchase totals', () => {
  it('by day: each day with its sales, tax, purchases, collections and payments; cancelled bills listed apart', async () => {
    const h = await world();
    const r = h.reports.salesAndPurchases(h.ownerToken, { groupBy: 'day' });
    expect(r.periods.map((p) => p.period)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    const day = (d: string): (typeof r.periods)[number] => r.periods.find((p) => p.period === d) as (typeof r.periods)[number];
    expect(day('2026-11-01')).toMatchObject({ salesBills: 2, salesTaxablePaise: 295000, salesCgstPaise: 26550, salesSgstPaise: 26550, salesIgstPaise: 0, salesTotalPaise: 348100, purchaseBills: 0 });
    expect(day('2026-11-02')).toMatchObject({ salesBills: 0, salesTotalPaise: 0, purchaseBills: 1, purchaseTaxablePaise: 400000, purchaseTaxPaise: 72000, purchaseTotalPaise: 472000 }); // the cancelled sale of this day is not here
    expect(day('2026-11-03')).toMatchObject({ salesBills: 1, salesTaxablePaise: 92500, salesTotalPaise: 109200, collectedPaise: 50000 });
    expect(day('2026-11-04')).toMatchObject({ purchaseBills: 1, purchaseTotalPaise: 47200, paidToSuppliersPaise: 100000 });
    expect(day('2026-11-05')).toMatchObject({ salesBills: 1, salesTaxablePaise: 98000, salesCgstPaise: 0, salesSgstPaise: 0, salesIgstPaise: 17640, salesTotalPaise: 115600 });
    expect(day('2026-11-06')).toMatchObject({ purchaseBills: 1, purchaseTotalPaise: 23600 });
    expect(day('2026-11-07')).toMatchObject({ salesBills: 1, salesTotalPaise: 109200 });
    expect(r.cancelledSales).toEqual({ count: 1, totalPaise: 32500 });
    expect(r.cancelledPurchases).toEqual({ count: 0, totalPaise: 0 });
  });

  it('by month and for the whole period, the totals agree with the days', async () => {
    const h = await world();
    const month = h.reports.salesAndPurchases(h.ownerToken, { groupBy: 'month' });
    expect(month.periods).toHaveLength(1);
    expect(month.periods[0]).toMatchObject({
      period: '2026-11', salesBills: 5, salesTaxablePaise: 578000, salesTotalPaise: 682100, purchaseBills: 3, purchaseTaxablePaise: 460000, purchaseTaxPaise: 82800, purchaseTotalPaise: 542800,
      collectedPaise: 50000, paidToSuppliersPaise: 100000,
    });
    const total = h.reports.salesAndPurchases(h.ownerToken);
    expect(total.groupBy).toBe('total');
    expect(total.periods).toHaveLength(1);
    expect(total.totals).toEqual({ ...month.periods[0], period: 'ALL' });
    const days = h.reports.salesAndPurchases(h.ownerToken, { groupBy: 'day' });
    expect(days.totals).toEqual(total.totals); // the day-by-day rows add up to the same figures
  });

  it('a custom date range only counts what falls inside it', async () => {
    const h = await world();
    const r = h.reports.salesAndPurchases(h.ownerToken, { fromDate: '2026-11-02', toDate: '2026-11-04' });
    expect(r.totals).toMatchObject({ salesBills: 1, salesTotalPaise: 109200, purchaseBills: 2, purchaseTotalPaise: 519200, collectedPaise: 50000, paidToSuppliersPaise: 100000 });
    expect(r.cancelledSales).toEqual({ count: 1, totalPaise: 32500 }); // the cancelled bill dated 2 Nov falls inside this range
    expect(h.reports.salesAndPurchases(h.ownerToken, { fromDate: '2026-11-03', toDate: '2026-11-03' }).cancelledSales.count).toBe(0);
    expect(h.reports.salesAndPurchases(h.ownerToken, { fromDate: '2027-01-01' }).periods).toEqual([]);
  });

  it('a payment that was reversed is not counted as collected', async () => {
    const h = await world();
    const p = h.payments.list(h.ownerToken).rows[0];
    h.payments.reverse(h.ownerToken, p?.id ?? 0, 'cheque bounced');
    expect(h.reports.salesAndPurchases(h.ownerToken).totals.collectedPaise).toBe(0);
  });
});

describe('items with low or no movement', () => {
  async function stockyShop(): Promise<Shop> {
    const h = await shopHarness();
    const mk = (code: string, name: string, stock: number, cost: number, active = true): number => {
      const id = h.items.create(h.ownerToken, { code, name, unit: 'pcs', purchaseRatePaise: cost, saleRatePaise: cost * 2, gstRateBp: 1800, openingQtyMilli: stock });
      if (!active) h.items.setActive(h.ownerToken, id, false);
      return id;
    };
    const slow = mk('SLOW-1', 'SLOW ITEM', 20000, 2000);
    mk('DEAD-1', 'OLD STOCK ITEM', 5000, 10000);
    mk('OUT-1', 'SOLD OUT ITEM', 0, 500);
    mk('GONE-1', 'DISCONTINUED ITEM', 8000, 500, false);
    const sell = (date: string, itemId: number, qty: number): void => {
      h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: date, lines: [{ itemId, qtyMilli: qty }] }).id);
    };
    sell('2026-11-04', slow, 1000);
    sell('2026-11-02', h.ids.can, 2000);
    h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, { supplierId: h.ids.supplier, supplierInvoiceNo: 'LM-1', supplierInvoiceDate: '2026-11-03', billDate: '2026-11-03', lines: [{ itemId: h.ids.naoh, invoicedQtyMilli: 1000, ratePaise: 20000 }] }).id);
    return h;
  }

  it('lists what sold nothing in the period (default: the last 90 days), dead stock with the most money tied up first', async () => {
    const h = await stockyShop();
    const r = h.reports.lowMovement(h.ownerToken);
    expect([r.fromDate, r.toDate]).toEqual(['2026-08-10', '2026-11-07']);
    expect(r.rows.map((x) => [x.code, x.soldMilli, x.stockValueAtCostPaise])).toEqual([['NAOH-500', 0, 1020000], ['BUT-10', 0, 400000], ['DEAD-1', 0, 50000]]);
    expect(r.rows[0]).toMatchObject({ stockQtyMilli: 51000, purchasedMilli: 1000, lastSoldOn: null, daysSinceLastSale: null, billCount: 0 });
    // out-of-stock and discontinued items are left out
    expect(r.rows.map((x) => x.code)).not.toContain('OUT-1');
    expect(r.rows.map((x) => x.code)).not.toContain('GONE-1');
  });

  it('low movement: a limit on units sold brings in slow sellers, with days since the last sale', async () => {
    const h = await stockyShop();
    const r = h.reports.lowMovement(h.ownerToken, { maxSoldMilli: 1000 });
    expect(r.rows.map((x) => x.code)).toEqual(['NAOH-500', 'BUT-10', 'DEAD-1', 'SLOW-1']);
    expect(r.rows[3]).toMatchObject({ soldMilli: 1000, billCount: 1, lastSoldOn: '2026-11-04', daysSinceLastSale: 3, stockQtyMilli: 19000, stockValueAtCostPaise: 38000 }); // 20 opening, 1 sold
    expect(r.rows.map((x) => x.code)).not.toContain('MC-40'); // sold 2 units: more than the limit
    expect(h.reports.lowMovement(h.ownerToken, { maxSoldMilli: 1000, onlyInStock: false }).rows.map((x) => x.code)).toContain('OUT-1');
  });

  it('uses the period given: something sold before the period counts as no movement in it', async () => {
    const h = await stockyShop();
    const r = h.reports.lowMovement(h.ownerToken, { fromDate: '2026-11-05', toDate: '2026-11-07' });
    const slow = r.rows.find((x) => x.code === 'SLOW-1');
    const can = r.rows.find((x) => x.code === 'MC-40');
    expect(slow).toMatchObject({ soldMilli: 0, lastSoldOn: '2026-11-04', daysSinceLastSale: 3 });
    expect(can).toMatchObject({ soldMilli: 0, lastSoldOn: '2026-11-02', daysSinceLastSale: 5 });
    expect(r.rows.find((x) => x.code === 'NAOH-500')?.purchasedMilli).toBe(1000); // received 7 Nov, the day the bill was entered
    expect(h.reports.lowMovement(h.ownerToken, { fromDate: '2026-11-01', toDate: '2026-11-06' }).rows.find((x) => x.code === 'NAOH-500')?.purchasedMilli).toBe(0);
    expect(codeOf(() => h.reports.lowMovement(h.ownerToken, { fromDate: '2026-11-07', toDate: '2026-11-01' }))).toBe('VALIDATION');
    expect(codeOf(() => h.reports.lowMovement(h.ownerToken, { maxSoldMilli: -1 }))).toBe('VALIDATION');
  });
});

describe('purchases by supplier', () => {
  it('totals each supplier, largest first, with what was paid in the period and what is owed now', async () => {
    const h = await world();
    const r = h.reports.purchasesBySupplier(h.ownerToken);
    expect(r.map((x) => x.name)).toEqual(['SAMPLE DAIRY EQUIPMENT CO', 'SECOND SUPPLIER']);
    expect(r[0]).toEqual({ supplierId: h.ids.supplier, name: 'SAMPLE DAIRY EQUIPMENT CO', billCount: 2, taxablePaise: 440000, taxPaise: 79200, totalPaise: 519200, paidInPeriodPaise: 100000, owedNowPaise: 419200 });
    expect(r[1]).toMatchObject({ billCount: 1, taxablePaise: 20000, taxPaise: 3600, totalPaise: 23600, paidInPeriodPaise: 0, owedNowPaise: 23600 });
    expect(h.reports.purchasesBySupplier(h.ownerToken, { fromDate: '2026-11-05' }).map((x) => x.name)).toEqual(['SECOND SUPPLIER']);
    expect(h.reports.purchasesBySupplier(h.ownerToken, { fromDate: '2026-11-02', toDate: '2026-11-03' })[0]).toMatchObject({ billCount: 1, totalPaise: 472000, paidInPeriodPaise: 0 }); // the payment was on 4 Nov
  });

  it('leaves out cancelled purchases', async () => {
    const h = await world();
    const p3 = h.purchases.list(h.ownerToken, { supplierId: h.supplier2 }).rows[0];
    h.purchases.cancel(h.ownerToken, p3?.id ?? 0, 'wrong supplier');
    expect(h.reports.purchasesBySupplier(h.ownerToken).map((x) => x.name)).toEqual(['SAMPLE DAIRY EQUIPMENT CO']);
  });
});

describe('who may run reports', () => {
  it('needs report.view (customer history also accepts customer.view)', async () => {
    const h = await world();
    const clerk = await makeEmployee(h, 'clerk', ['sale.create', 'customer.view', 'inventory.view']);
    const analyst = await makeEmployee(h, 'analyst', ['report.view']);
    expect(codeOf(() => h.reports.bestSellers(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.reports.salesAndPurchases(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.reports.lowMovement(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.reports.purchasesBySupplier(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.reports.exportCsv(clerk, { report: 'BEST_SELLERS' }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.print.report(clerk, { report: 'BEST_SELLERS' }))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.reports.bestSellers(analyst))).toBe('NO_ERROR');
    expect(codeOf(() => h.reports.exportCsv(analyst, { report: 'PURCHASES_BY_SUPPLIER' }))).toBe('NO_ERROR');
  });
});

describe('the same table on screen, in a spreadsheet and on paper', () => {
  it('exports best sellers as CSV with real numbers', async () => {
    const h = await world();
    const csv = h.reports.exportCsv(h.ownerToken, { report: 'BEST_SELLERS' });
    expect(csv.startsWith('\uFEFFCode,Item,Unit,Total quantity sold,Number of bills,Sales value before tax (Rs.),Sales value incl. tax (Rs.),Average rate (Rs.)\r\n')).toBe(true);
    expect(csv).toContain('BUT-10,BUTYROMETER FOR MILK 0-10% ISI,PCS,20,2,1100,1298,55\r\n');
    expect(csv).toContain('MC-40,PLASTIC MILK CAN,PCS,4,3,3700,4366,925\r\n'.replace('PCS', 'LTR'));
  });

  it('customer history and the other reports have headers, totals and filters in their tables', async () => {
    const h = await world();
    const hist = h.reports.table(h.ownerToken, { report: 'CUSTOMER_HISTORY', customerId: h.ids.farm });
    expect(hist.title).toBe('Purchase history - TEST DAIRY FARM');
    expect(hist.columns.map((c) => c.header)).toEqual(expect.arrayContaining(['Total quantity', 'Number of bills containing it', 'First bought', 'Last bought', 'Dates']));
    expect(hist.rows[1]?.[6]).toBe('01/11/2026, 07/11/2026');
    const csv = h.reports.exportCsv(h.ownerToken, { report: 'CUSTOMER_HISTORY', customerId: h.ids.farm });
    expect(csv).toContain('PLASTIC MILK CAN,LTR,3,2,2026-11-01,2026-11-07,"01/11/2026, 07/11/2026",2775,3274.5\r\n');

    const sp = h.reports.table(h.ownerToken, { report: 'SALES_AND_PURCHASES', groupBy: 'day' });
    expect(sp.totalsRow?.[0]).toBe('Total');
    expect(sp.subtitle.join(' ')).toContain('1 cancelled sale bill(s) (Rs. 325.00)');
    expect(h.reports.table(h.ownerToken, { report: 'SALES_AND_PURCHASES' }).totalsRow).toBeNull(); // a single total row needs no extra total
    const sup = h.reports.table(h.ownerToken, { report: 'PURCHASES_BY_SUPPLIER' });
    expect(sup.totalsRow).toEqual(['Total', 3, 460000, 82800, 542800, 100000, 442800]);
    const lm = h.reports.table(h.ownerToken, { report: 'LOW_MOVEMENT' });
    expect(lm.title).toBe('Items with low or no movement');
  });

  it('prints any report with Indian digit grouping and dd/mm/yyyy dates, escaping what was typed', async () => {
    const h = await world();
    h.items.update(h.ownerToken, h.ids.can, { name: 'CAN <b>40</b> & "LID"' });
    const r = h.print.report(h.ownerToken, { report: 'BEST_SELLERS' });
    expect(r.title).toBe('Best-selling items');
    expect(r.fileName).toBe('Best-selling-items.pdf');
    expect(r.html).toContain('@page { size: A4 landscape'); // wide tables print landscape
    expect(r.html).toContain('1,298.00');
    expect(r.html).toContain('CAN &lt;b&gt;40&lt;/b&gt; &amp; &quot;LID&quot;');
    expect(r.html).not.toContain('<b>40</b>');
    expect(r.html).toContain('TEST ENGINEERING CO');
    const hist = h.print.report(h.ownerToken, { report: 'CUSTOMER_HISTORY', customerId: h.ids.farm });
    expect(hist.html).toContain('01/11/2026, 07/11/2026');
    expect(hist.html).toContain('Purchase history - TEST DAIRY FARM');
    const days = h.print.report(h.ownerToken, { report: 'SALES_AND_PURCHASES', groupBy: 'day' });
    expect(days.html).toContain('<tr class="em"><td style="text-align:left;">Total</td>'); // the totals row is emphasised and labelled, even though its column holds dates
    expect(days.html).toContain('01/11/2026');
    expect(h.print.report(h.ownerToken, { report: 'LOW_MOVEMENT' }).html).toContain('Nothing to show for these filters.'); // every item sold, so nothing is slow
    h.items.create(h.ownerToken, { code: 'DEAD-1', name: 'OLD STOCK ITEM', unit: 'pcs', purchaseRatePaise: 10000, saleRatePaise: 15000, gstRateBp: 1800, openingQtyMilli: 5000 });
    const lm = h.print.report(h.ownerToken, { report: 'LOW_MOVEMENT' });
    expect(lm.html).toContain('>never<'); // an item that never sold says so, instead of a blank
    expect(lm.html).not.toContain('Nothing to show');
  });
});

describe('the dashboard', () => {
  it('gives the owner every section, with figures that agree with the books', async () => {
    const h = await world();
    h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-07', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] }); // an open draft
    const clerk = await makeEmployee(h, 'clerk', ['customer.create', 'customer.view']);
    h.customers.create(clerk, { name: 'WAITING FOR APPROVAL', state: 'West Bengal' });
    h.purchases.confirm(h.ownerToken, h.purchases.saveDraft(h.ownerToken, { supplierId: h.ids.supplier, supplierInvoiceNo: 'P-4', supplierInvoiceDate: '2026-11-07', lines: [{ itemId: h.ids.can, invoicedQtyMilli: 4000, receivedQtyMilli: 1000, ratePaise: 80000 }] }).id);

    const d = h.reports.dashboard(h.ownerToken);
    expect(d.asOf).toBe('2026-11-07');
    expect(d.sales).toEqual({ today: { bills: 1, totalPaise: 109200 }, monthToDate: { bills: 5, totalPaise: 682100 } });
    expect(d.dues).toEqual({ totalOutstandingPaise: 632100, customersWithDues: 3 }); // farm 4,073.00 + second 1,092.00 + Patna 1,156.00
    const items = h.items.list(h.ownerToken).rows;
    expect(d.stock).toEqual({
      activeItems: 3, outOfStock: 0, lowStock: 0,
      stockValueAtCostPaise: items.reduce((s, i) => s + Math.round((i.qtyMilli * i.purchaseRatePaise) / 1000), 0),
      stockValueAtSalePaise: items.reduce((s, i) => s + Math.round((i.qtyMilli * i.saleRatePaise) / 1000), 0),
    });
    expect(d.recentBills).toHaveLength(6);
    expect(d.recentBills?.[0]).toMatchObject({ customerName: 'TEST DAIRY FARM', invoiceDate: '2026-11-07', totalPaise: 109200, outstandingPaise: 109200, status: 'CONFIRMED' });
    expect(d.recentBills?.map((b) => b.status)).toContain('CANCELLED');
    expect(d.openDrafts).toBe(1);
    expect(d.pendingApprovals).toBe(1);
    expect(d.goodsAwaited).toBe(1);
    expect((h.db.prepare('SELECT SUM(balance_paise) AS t FROM supplier WHERE balance_paise > 0').get() as { t: number }).t).toBe(d.owedToSuppliersPaise);
    expect(d.lowStockItems).toEqual([]);
  });

  it('flags out-of-stock and low-stock items', async () => {
    const h = await shopHarness();
    h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 8500 }, { itemId: h.ids.buty, qtyMilli: 100000 }] }).id);
    const d = h.reports.dashboard(h.ownerToken);
    expect(d.stock).toMatchObject({ outOfStock: 1, lowStock: 1 }); // butyrometers sold out; cans at 1.5 against a reorder level of 2
    expect(d.lowStockItems?.map((i) => [i.code, i.qtyMilli])).toEqual([['BUT-10', 0], ['MC-40', 1500]]);
  });

  it('shows each person only what they may see, and keeps the cost of stock from people who may not see costs', async () => {
    const h = await world();
    const counter = await makeEmployee(h, 'counter', ['sale.create']);
    const c = h.reports.dashboard(counter);
    expect(c).toMatchObject({ sales: null, dues: null, stock: null, lowStockItems: null, pendingApprovals: null, goodsAwaited: null, owedToSuppliersPaise: null });
    expect(c.recentBills).toHaveLength(6);
    expect(c.openDrafts).toBe(0);

    const stockman = await makeEmployee(h, 'stockman', ['inventory.view']);
    const s = h.reports.dashboard(stockman);
    expect(s.stock?.stockValueAtCostPaise).toBeNull();
    expect(s.stock?.stockValueAtSalePaise).toBeGreaterThan(0);
    expect(s.recentBills).toBeNull();

    const accountant = await makeEmployee(h, 'accountant', ['report.view', 'customer.view', 'supplier.view', 'inventory.view']);
    const a = h.reports.dashboard(accountant);
    expect(a.sales?.monthToDate.totalPaise).toBe(682100);
    expect(a.dues?.totalOutstandingPaise).toBe(632100);
    expect(a.stock?.stockValueAtCostPaise).toBeGreaterThan(0);
    expect(a.owedToSuppliersPaise).toBeGreaterThan(0);
    expect(a.pendingApprovals).toBeNull(); // approving customers is the owner's

    expect(codeOf(() => h.reports.dashboard('not-a-token'))).toBe('AUTH_FAILED');
  });
});
