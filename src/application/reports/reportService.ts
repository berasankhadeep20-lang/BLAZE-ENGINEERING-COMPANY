import { formatINR, mulDivRound, type Paise } from '../../domain/money';
import { localDateString, systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { displayDate } from '../../shared/format';
import type { Cell } from '../../shared/csv';
import type { Db } from '../../infrastructure/db/connection';
import type { AuthService, SessionUser } from '../auth/authService';
import { isoDate } from '../common';
import { PENDING_EXISTS_SQL } from '../purchases/purchaseService';
import { OUTSTANDING_SQL } from '../sales/paymentOps';
import type { Permission } from '../../domain/permissions';
import { tableToCsv, type ReportTable } from './reportTable';

export interface DateRange {
  fromDate?: string; // local date, inclusive
  toDate?: string;
}

export type ReportRequest =
  | ({ report: 'BEST_SELLERS'; sortBy?: 'qty' | 'bills' | 'value'; limit?: number } & DateRange)
  | ({ report: 'CUSTOMER_HISTORY'; customerId: number } & DateRange)
  | ({ report: 'SALES_AND_PURCHASES'; groupBy?: 'day' | 'month' | 'total' } & DateRange)
  | ({ report: 'LOW_MOVEMENT'; maxSoldMilli?: number; onlyInStock?: boolean } & DateRange)
  | ({ report: 'PURCHASES_BY_SUPPLIER' } & DateRange);

// ---------------------------------------------------------------- result types
export interface BestSellerRow {
  itemId: number;
  code: string;
  name: string;
  unit: string;
  totalQtyMilli: number; // units sold
  billCount: number; // separate bills containing the item (10 units in one bill = 10 units, 1 bill)
  salesValuePaise: number; // before tax
  salesValueInclTaxPaise: number;
  averageRatePaise: number; // per unit, before tax
}

export interface CustomerHistoryItem {
  itemId: number;
  code: string;
  name: string;
  unit: string;
  totalQtyMilli: number;
  billCount: number;
  firstDate: string;
  lastDate: string;
  salesValuePaise: number;
  salesValueInclTaxPaise: number;
  purchases: { billNo: string; invoiceDate: string; qtyMilli: number; ratePaise: number; salesValuePaise: number }[];
}

export interface CustomerHistory {
  customer: { id: number; name: string };
  items: CustomerHistoryItem[];
  billCount: number; // separate confirmed bills in the range
  billsTotalPaise: number; // what those bills came to, including delivery, tax and round-off
}

export interface PeriodTotals {
  period: string; // yyyy-mm-dd, yyyy-mm, or "ALL"
  salesBills: number;
  salesTaxablePaise: number; // before tax, including delivery
  salesCgstPaise: number;
  salesSgstPaise: number;
  salesIgstPaise: number;
  salesTotalPaise: number;
  purchaseBills: number;
  purchaseTaxablePaise: number;
  purchaseTaxPaise: number;
  purchaseTotalPaise: number;
  collectedPaise: number; // customer payments received (not reversed)
  paidToSuppliersPaise: number; // payments made to suppliers (not reversed)
}

export interface SalesAndPurchases {
  groupBy: 'day' | 'month' | 'total';
  periods: PeriodTotals[];
  totals: PeriodTotals;
  cancelledSales: { count: number; totalPaise: number }; // shown for transparency; not included above
  cancelledPurchases: { count: number; totalPaise: number };
}

export interface LowMovementRow {
  itemId: number;
  code: string;
  name: string;
  unit: string;
  stockQtyMilli: number;
  soldMilli: number; // in the period
  billCount: number;
  purchasedMilli: number; // goods received in the period
  lastSoldOn: string | null; // most recent sale up to the end of the period (null = never)
  daysSinceLastSale: number | null;
  stockValueAtCostPaise: number;
}

export interface SupplierPurchaseRow {
  supplierId: number;
  name: string;
  billCount: number;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  paidInPeriodPaise: number;
  owedNowPaise: number;
}

export interface Dashboard {
  asOf: string;
  sales: { today: { bills: number; totalPaise: number }; monthToDate: { bills: number; totalPaise: number } } | null;
  dues: { totalOutstandingPaise: number; customersWithDues: number } | null;
  stock: { activeItems: number; outOfStock: number; lowStock: number; stockValueAtCostPaise: number | null; stockValueAtSalePaise: number } | null;
  lowStockItems: { id: number; code: string; name: string; qtyMilli: number; reorderQtyMilli: number }[] | null;
  recentBills: { id: number; billNo: string | null; invoiceDate: string; customerName: string; totalPaise: number; outstandingPaise: number | null; status: string }[] | null;
  openDrafts: number | null;
  pendingApprovals: number | null;
  goodsAwaited: number | null; // purchase bills with invoiced goods not yet received
  owedToSuppliersPaise: number | null;
}

// ---------------------------------------------------------------- helpers
const can = (u: SessionUser, p: Permission): boolean => u.role === 'OWNER' || u.permissions.includes(p);

function checkRange(r: DateRange): void {
  for (const d of [r.fromDate, r.toDate]) if (d && !isoDate(d)) throw new AppError('VALIDATION', 'dates must be valid (yyyy-mm-dd)');
  if (r.fromDate && r.toDate && r.fromDate > r.toDate) throw new AppError('VALIDATION', 'the start date is after the end date');
}

/** SQL for an inclusive local-date range on a date column, plus its parameters. */
function rangeSql(col: string, r: DateRange): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (r.fromDate) { parts.push(`${col} >= ?`); params.push(r.fromDate); }
  if (r.toDate) { parts.push(`${col} <= ?`); params.push(r.toDate); }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

const rangeText = (r: DateRange): string => (r.fromDate || r.toDate ? `${r.fromDate ? displayDate(r.fromDate) : 'the beginning'} to ${r.toDate ? displayDate(r.toDate) : 'today'}` : 'All dates');

const daysBetween = (a: string, b: string): number => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);

const emptyPeriod = (period: string): PeriodTotals => ({
  period, salesBills: 0, salesTaxablePaise: 0, salesCgstPaise: 0, salesSgstPaise: 0, salesIgstPaise: 0, salesTotalPaise: 0,
  purchaseBills: 0, purchaseTaxablePaise: 0, purchaseTaxPaise: 0, purchaseTotalPaise: 0, collectedPaise: 0, paidToSuppliersPaise: 0,
});

export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Items ranked by units sold, number of separate bills, or sales value. Only confirmed bills count. Quantities are per item (different units are never added together). */
  bestSellers(token: string, f: DateRange & { sortBy?: 'qty' | 'bills' | 'value'; limit?: number } = {}): BestSellerRow[] {
    this.auth.authorize(token, 'report.view');
    checkRange(f);
    const r = rangeSql('b.invoice_date', f);
    const order = f.sortBy === 'bills' ? 'bills DESC, qty DESC' : f.sortBy === 'value' ? 'taxable DESC, qty DESC' : 'qty DESC, bills DESC';
    const rows = this.db
      .prepare(`SELECT l.item_id AS id, i.code AS code, i.name AS name, i.unit AS unit, SUM(l.qty_milli) AS qty, COUNT(DISTINCT l.bill_id) AS bills,
          SUM(l.taxable_paise) AS taxable, SUM(l.total_paise) AS total
        FROM sale_bill_line l JOIN sale_bill b ON b.id = l.bill_id JOIN item i ON i.id = l.item_id
        WHERE b.status = 'CONFIRMED'${r.sql} GROUP BY l.item_id ORDER BY ${order}, i.name COLLATE NOCASE LIMIT ?`)
      .all(...r.params, Math.max(1, f.limit ?? 1000)) as { id: number; code: string; name: string; unit: string; qty: number; bills: number; taxable: number; total: number }[];
    return rows.map((x) => ({
      itemId: x.id, code: x.code, name: x.name, unit: x.unit, totalQtyMilli: x.qty, billCount: x.bills, salesValuePaise: x.taxable, salesValueInclTaxPaise: x.total,
      averageRatePaise: x.qty > 0 ? mulDivRound(x.taxable, 1000, x.qty) : 0,
    }));
  }

  /** What one customer bought: per item the total quantity, the number of separate bills containing it, the dates, and the sales value. */
  customerPurchaseHistory(token: string, f: DateRange & { customerId: number }): CustomerHistory {
    this.auth.authorizeAny(token, ['report.view', 'customer.view']);
    checkRange(f);
    const cust = this.db.prepare('SELECT id, name FROM customer WHERE id = ?').get(f.customerId) as { id: number; name: string } | undefined;
    if (!cust) throw new AppError('NOT_FOUND', 'customer not found');
    const r = rangeSql('b.invoice_date', f);
    const lines = this.db
      .prepare(`SELECT l.item_id AS item_id, i.code AS code, i.name AS name, i.unit AS unit, b.bill_no AS bill_no, b.invoice_date AS date, l.qty_milli AS qty,
          l.rate_paise AS rate, l.taxable_paise AS taxable, l.total_paise AS total, b.id AS bill_id
        FROM sale_bill_line l JOIN sale_bill b ON b.id = l.bill_id JOIN item i ON i.id = l.item_id
        WHERE b.status = 'CONFIRMED' AND b.customer_id = ?${r.sql} ORDER BY i.name COLLATE NOCASE, b.invoice_date, b.id, l.line_no`)
      .all(f.customerId, ...r.params) as { item_id: number; code: string; name: string; unit: string; bill_no: string; date: string; qty: number; rate: number; taxable: number; total: number; bill_id: number }[];

    const byItem = new Map<number, CustomerHistoryItem & { bills: Set<number> }>();
    for (const l of lines) {
      let it = byItem.get(l.item_id);
      if (!it) {
        it = { itemId: l.item_id, code: l.code, name: l.name, unit: l.unit, totalQtyMilli: 0, billCount: 0, firstDate: l.date, lastDate: l.date, salesValuePaise: 0, salesValueInclTaxPaise: 0, purchases: [], bills: new Set() };
        byItem.set(l.item_id, it);
      }
      it.totalQtyMilli += l.qty;
      it.salesValuePaise += l.taxable;
      it.salesValueInclTaxPaise += l.total;
      it.bills.add(l.bill_id);
      it.firstDate = l.date < it.firstDate ? l.date : it.firstDate;
      it.lastDate = l.date > it.lastDate ? l.date : it.lastDate;
      it.purchases.push({ billNo: l.bill_no, invoiceDate: l.date, qtyMilli: l.qty, ratePaise: l.rate, salesValuePaise: l.taxable });
    }
    const items = [...byItem.values()].map(({ bills, ...rest }) => ({ ...rest, billCount: bills.size }));
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(b.total_paise), 0) AS total FROM sale_bill b WHERE b.status = 'CONFIRMED' AND b.customer_id = ?${r.sql}`)
      .get(f.customerId, ...r.params) as { n: number; total: number };
    return { customer: cust, items, billCount: agg.n, billsTotalPaise: agg.total };
  }

  /** Sales and purchase totals by day, by month, or for the whole range, with the money collected and paid out. Only confirmed bills count; cancelled ones are listed apart. */
  salesAndPurchases(token: string, f: DateRange & { groupBy?: 'day' | 'month' | 'total' } = {}): SalesAndPurchases {
    this.auth.authorize(token, 'report.view');
    checkRange(f);
    const groupBy = f.groupBy ?? 'total';
    const key = (col: string): string => (groupBy === 'day' ? col : groupBy === 'month' ? `substr(${col}, 1, 7)` : "'ALL'");
    const map = new Map<string, PeriodTotals>();
    const at = (p: string): PeriodTotals => {
      let x = map.get(p);
      if (!x) {
        x = emptyPeriod(p);
        map.set(p, x);
      }
      return x;
    };

    const sr = rangeSql('invoice_date', f);
    for (const x of this.db
      .prepare(`SELECT ${key('invoice_date')} AS p, COUNT(*) AS n, SUM(taxable_paise) AS taxable, SUM(cgst_paise) AS cgst, SUM(sgst_paise) AS sgst, SUM(igst_paise) AS igst, SUM(total_paise) AS total
        FROM sale_bill WHERE status = 'CONFIRMED'${sr.sql} GROUP BY p`)
      .all(...sr.params) as { p: string; n: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }[]) {
      Object.assign(at(x.p), { salesBills: x.n, salesTaxablePaise: x.taxable, salesCgstPaise: x.cgst, salesSgstPaise: x.sgst, salesIgstPaise: x.igst, salesTotalPaise: x.total });
    }
    const pr = rangeSql('bill_date', f);
    for (const x of this.db
      .prepare(`SELECT ${key('bill_date')} AS p, COUNT(*) AS n, SUM(taxable_paise) AS taxable, SUM(cgst_paise + sgst_paise + igst_paise) AS tax, SUM(total_paise) AS total
        FROM purchase_bill WHERE status = 'CONFIRMED'${pr.sql} GROUP BY p`)
      .all(...pr.params) as { p: string; n: number; taxable: number; tax: number; total: number }[]) {
      Object.assign(at(x.p), { purchaseBills: x.n, purchaseTaxablePaise: x.taxable, purchaseTaxPaise: x.tax, purchaseTotalPaise: x.total });
    }
    const cr = rangeSql('paid_on', f);
    for (const x of this.db.prepare(`SELECT ${key('paid_on')} AS p, SUM(amount_paise) AS total FROM customer_payment WHERE is_reversed = 0${cr.sql} GROUP BY p`).all(...cr.params) as { p: string; total: number }[]) {
      at(x.p).collectedPaise = x.total;
    }
    for (const x of this.db.prepare(`SELECT ${key('paid_on')} AS p, SUM(amount_paise) AS total FROM supplier_payment WHERE is_reversed = 0${cr.sql} GROUP BY p`).all(...cr.params) as { p: string; total: number }[]) {
      at(x.p).paidToSuppliersPaise = x.total;
    }

    const periods = [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
    const totals = emptyPeriod('ALL');
    for (const p of periods) {
      for (const k of Object.keys(totals) as (keyof PeriodTotals)[]) if (k !== 'period') (totals[k] as number) += p[k] as number;
    }
    const cancelled = (table: string, dateCol: string): { count: number; totalPaise: number } => {
      const c = rangeSql(dateCol, f);
      const row = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS total FROM ${table} WHERE status = 'CANCELLED'${c.sql}`).get(...c.params) as { n: number; total: number };
      return { count: row.n, totalPaise: row.total };
    };
    return { groupBy, periods, totals, cancelledSales: cancelled('sale_bill', 'invoice_date'), cancelledPurchases: cancelled('purchase_bill', 'bill_date') };
  }

  /**
   * Items that sold little or nothing in the period (default: the last 90 days), with stock on hand and what it cost. `maxSoldMilli` 0 = no sales at all.
   * Items already out of stock are left out unless `onlyInStock` is false. Dead stock (most money tied up) comes first.
   */
  lowMovement(token: string, f: DateRange & { maxSoldMilli?: number; onlyInStock?: boolean } = {}): { fromDate: string; toDate: string; rows: LowMovementRow[] } {
    this.auth.authorize(token, 'report.view');
    checkRange(f);
    const today = localDateString(this.clock.now());
    const toDate = f.toDate ?? today;
    const fromDate = f.fromDate ?? ((): string => { const d = new Date(`${toDate}T00:00:00`); d.setDate(d.getDate() - 89); return localDateString(d); })();
    if (fromDate > toDate) throw new AppError('VALIDATION', 'the start date is after the end date');
    const maxSold = f.maxSoldMilli ?? 0;
    if (!Number.isSafeInteger(maxSold) || maxSold < 0) throw new AppError('VALIDATION', 'the sales limit must be zero or more');

    const rows = this.db
      .prepare(`SELECT * FROM (
          SELECT i.id AS id, i.code AS code, i.name AS name, i.unit AS unit, i.qty_milli AS stock, i.purchase_rate_paise AS cost,
            COALESCE((SELECT SUM(l.qty_milli) FROM sale_bill_line l JOIN sale_bill b ON b.id = l.bill_id
                      WHERE l.item_id = i.id AND b.status = 'CONFIRMED' AND b.invoice_date >= ? AND b.invoice_date <= ?), 0) AS sold,
            (SELECT COUNT(DISTINCT l.bill_id) FROM sale_bill_line l JOIN sale_bill b ON b.id = l.bill_id
                      WHERE l.item_id = i.id AND b.status = 'CONFIRMED' AND b.invoice_date >= ? AND b.invoice_date <= ?) AS bills,
            COALESCE((SELECT SUM(r.qty_milli) FROM purchase_receipt r JOIN purchase_bill pb ON pb.id = r.bill_id JOIN purchase_bill_line pl ON pl.bill_id = r.bill_id AND pl.line_no = r.line_no
                      WHERE pl.item_id = i.id AND pb.status = 'CONFIRMED' AND r.received_on >= ? AND r.received_on <= ?), 0) AS purchased,
            (SELECT MAX(b.invoice_date) FROM sale_bill_line l JOIN sale_bill b ON b.id = l.bill_id
                      WHERE l.item_id = i.id AND b.status = 'CONFIRMED' AND b.invoice_date <= ?) AS last_sold
          FROM item i WHERE i.is_active = 1${f.onlyInStock === false ? '' : ' AND i.qty_milli > 0'}
        ) WHERE sold <= ?`)
      .all(fromDate, toDate, fromDate, toDate, fromDate, toDate, toDate, maxSold) as {
        id: number; code: string; name: string; unit: string; stock: number; cost: number; sold: number; bills: number; purchased: number; last_sold: string | null;
      }[];
    const out: LowMovementRow[] = rows.map((x) => ({
      itemId: x.id, code: x.code, name: x.name, unit: x.unit, stockQtyMilli: x.stock, soldMilli: x.sold, billCount: x.bills, purchasedMilli: x.purchased,
      lastSoldOn: x.last_sold, daysSinceLastSale: x.last_sold ? daysBetween(x.last_sold, toDate) : null, stockValueAtCostPaise: mulDivRound(x.stock, x.cost, 1000),
    }));
    out.sort((a, b) => a.soldMilli - b.soldMilli || b.stockValueAtCostPaise - a.stockValueAtCostPaise || a.name.localeCompare(b.name));
    return { fromDate, toDate, rows: out };
  }

  /** Purchase totals by supplier (confirmed bills), with what was paid to each in the period and what is still owed now. */
  purchasesBySupplier(token: string, f: DateRange = {}): SupplierPurchaseRow[] {
    this.auth.authorize(token, 'report.view');
    checkRange(f);
    const r = rangeSql('b.bill_date', f);
    const p = rangeSql('p.paid_on', f);
    const rows = this.db
      .prepare(`SELECT b.supplier_id AS id, s.name AS name, COUNT(*) AS bills, SUM(b.taxable_paise) AS taxable, SUM(b.cgst_paise + b.sgst_paise + b.igst_paise) AS tax, SUM(b.total_paise) AS total,
          COALESCE((SELECT SUM(p.amount_paise) FROM supplier_payment p WHERE p.supplier_id = b.supplier_id AND p.is_reversed = 0${p.sql}), 0) AS paid, s.balance_paise AS owed
        FROM purchase_bill b JOIN supplier s ON s.id = b.supplier_id WHERE b.status = 'CONFIRMED'${r.sql} GROUP BY b.supplier_id ORDER BY total DESC, s.name COLLATE NOCASE`)
      .all(...p.params, ...r.params) as { id: number; name: string; bills: number; taxable: number; tax: number; total: number; paid: number; owed: number }[];
    return rows.map((x) => ({ supplierId: x.id, name: x.name, billCount: x.bills, taxablePaise: x.taxable, taxPaise: x.tax, totalPaise: x.total, paidInPeriodPaise: x.paid, owedNowPaise: x.owed }));
  }

  /** The numbers for the dashboard. Each section is filled only for a user allowed to see it; the rest are null. */
  dashboard(token: string): Dashboard {
    const user = this.auth.requireSignedIn(token);
    const today = localDateString(this.clock.now());
    const monthStart = `${today.slice(0, 7)}-01`;
    const one = <T>(sql: string, ...params: (string | number)[]): T => this.db.prepare(sql).get(...params) as T;
    const salesIn = (from: string, to: string): { bills: number; totalPaise: number } => {
      const x = one<{ n: number; t: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS t FROM sale_bill WHERE status = 'CONFIRMED' AND invoice_date >= ? AND invoice_date <= ?", from, to);
      return { bills: x.n, totalPaise: x.t };
    };

    const seesBills = can(user, 'sale.create') || can(user, 'customer.view') || can(user, 'report.view');
    const seesStock = can(user, 'inventory.view');
    let stock: Dashboard['stock'] = null;
    if (seesStock) {
      const items = this.db.prepare('SELECT qty_milli AS q, reorder_qty_milli AS r, purchase_rate_paise AS c, sale_rate_paise AS s FROM item WHERE is_active = 1').all() as { q: number; r: number; c: number; s: number }[];
      let cost: Paise = 0;
      let sale: Paise = 0;
      for (const i of items) {
        cost += mulDivRound(i.q, i.c, 1000);
        sale += mulDivRound(i.q, i.s, 1000);
      }
      stock = {
        activeItems: items.length, outOfStock: items.filter((i) => i.q <= 0).length, lowStock: items.filter((i) => i.q > 0 && i.r > 0 && i.q <= i.r).length,
        stockValueAtCostPaise: can(user, 'report.view') ? cost : null, // what the stock cost us is business-sensitive
        stockValueAtSalePaise: sale,
      };
    }
    return {
      asOf: today,
      sales: can(user, 'report.view') ? { today: salesIn(today, today), monthToDate: salesIn(monthStart, today) } : null,
      dues: can(user, 'customer.view')
        ? ((x) => ({ totalOutstandingPaise: x.t, customersWithDues: x.n }))(one<{ t: number; n: number }>("SELECT COALESCE(SUM(balance_paise), 0) AS t, COUNT(*) AS n FROM customer WHERE balance_paise > 0 AND approval_status <> 'REJECTED'"))
        : null,
      stock,
      lowStockItems: seesStock
        ? (this.db.prepare('SELECT id, code, name, qty_milli AS q, reorder_qty_milli AS r FROM item WHERE is_active = 1 AND (qty_milli <= 0 OR (reorder_qty_milli > 0 AND qty_milli <= reorder_qty_milli)) ORDER BY qty_milli, name COLLATE NOCASE LIMIT 5').all() as { id: number; code: string; name: string; q: number; r: number }[]).map((x) => ({ id: x.id, code: x.code, name: x.name, qtyMilli: x.q, reorderQtyMilli: x.r }))
        : null,
      recentBills: seesBills
        ? (this.db
            .prepare(`SELECT b.id, b.bill_no, b.invoice_date, b.cust_name, b.total_paise, b.status, CASE WHEN b.status = 'CONFIRMED' THEN ${OUTSTANDING_SQL} ELSE NULL END AS outstanding
                      FROM sale_bill b WHERE b.status IN ('CONFIRMED', 'CANCELLED') ORDER BY b.id DESC LIMIT 8`)
            .all() as { id: number; bill_no: string | null; invoice_date: string; cust_name: string; total_paise: number; status: string; outstanding: number | null }[]).map((x) => ({
            id: x.id, billNo: x.bill_no, invoiceDate: x.invoice_date, customerName: x.cust_name, totalPaise: x.total_paise, outstandingPaise: x.outstanding, status: x.status,
          }))
        : null,
      openDrafts: can(user, 'sale.create') ? one<{ n: number }>("SELECT COUNT(*) AS n FROM sale_bill WHERE status = 'DRAFT'").n : null,
      pendingApprovals: can(user, 'customer.approve') ? one<{ n: number }>("SELECT COUNT(*) AS n FROM customer WHERE approval_status = 'PENDING'").n : null,
      goodsAwaited:
        can(user, 'purchase.create') || can(user, 'supplier.view') || can(user, 'report.view')
          ? one<{ n: number }>(`SELECT COUNT(*) AS n FROM purchase_bill b WHERE b.status = 'CONFIRMED' AND ${PENDING_EXISTS_SQL}`).n
          : null,
      owedToSuppliersPaise: can(user, 'supplier.view') ? one<{ t: number }>('SELECT COALESCE(SUM(balance_paise), 0) AS t FROM supplier WHERE balance_paise > 0').t : null,
    };
  }

  // ---------------------------------------------------------------- one table for screen, CSV and print
  table(token: string, req: ReportRequest): ReportTable {
    const range = rangeText(req);
    switch (req.report) {
      case 'BEST_SELLERS': {
        const rows = this.bestSellers(token, req);
        const sort = req.sortBy === 'bills' ? 'number of bills' : req.sortBy === 'value' ? 'sales value' : 'quantity sold';
        return {
          title: 'Best-selling items', subtitle: [`Period: ${range}`, `Ranked by ${sort}. Only confirmed bills are counted. Sales value is before tax.`],
          columns: [{ header: 'Code', kind: 'text' }, { header: 'Item', kind: 'text' }, { header: 'Unit', kind: 'text' }, { header: 'Total quantity sold', kind: 'qty' }, { header: 'Number of bills', kind: 'int' },
            { header: 'Sales value before tax (Rs.)', kind: 'money' }, { header: 'Sales value incl. tax (Rs.)', kind: 'money' }, { header: 'Average rate (Rs.)', kind: 'money' }],
          rows: rows.map((x) => [x.code, x.name, x.unit, x.totalQtyMilli, x.billCount, x.salesValuePaise, x.salesValueInclTaxPaise, x.averageRatePaise]), totalsRow: null,
        };
      }
      case 'CUSTOMER_HISTORY': {
        const h = this.customerPurchaseHistory(token, req);
        const dates = (i: CustomerHistoryItem): string => {
          const d = [...new Set(i.purchases.map((p) => displayDate(p.invoiceDate)))];
          return d.length > 8 ? `${d.slice(0, 8).join(', ')} and ${String(d.length - 8)} more` : d.join(', ');
        };
        return {
          title: `Purchase history - ${h.customer.name}`, subtitle: [`Period: ${range}`, `${String(h.billCount)} separate bill(s), Rs. ${formatINR(h.billsTotalPaise)} in all. Quantity and number of bills are shown separately.`],
          columns: [{ header: 'Item', kind: 'text' }, { header: 'Unit', kind: 'text' }, { header: 'Total quantity', kind: 'qty' }, { header: 'Number of bills containing it', kind: 'int' }, { header: 'First bought', kind: 'date' },
            { header: 'Last bought', kind: 'date' }, { header: 'Dates', kind: 'text' }, { header: 'Sales value before tax (Rs.)', kind: 'money' }, { header: 'Sales value incl. tax (Rs.)', kind: 'money' }],
          rows: h.items.map((i) => [i.name, i.unit, i.totalQtyMilli, i.billCount, i.firstDate, i.lastDate, dates(i), i.salesValuePaise, i.salesValueInclTaxPaise]), totalsRow: null,
        };
      }
      case 'SALES_AND_PURCHASES': {
        const r = this.salesAndPurchases(token, req);
        const row = (p: PeriodTotals): Cell[] => [p.period, p.salesBills, p.salesTaxablePaise, p.salesCgstPaise + p.salesSgstPaise + p.salesIgstPaise, p.salesTotalPaise, p.purchaseBills, p.purchaseTaxablePaise, p.purchaseTotalPaise, p.collectedPaise, p.paidToSuppliersPaise];
        return {
          title: `Sales and purchases by ${r.groupBy === 'total' ? 'the whole period' : r.groupBy}`,
          subtitle: [`Period: ${range}`, `Confirmed bills only. Not included: ${String(r.cancelledSales.count)} cancelled sale bill(s) (Rs. ${formatINR(r.cancelledSales.totalPaise)}) and ${String(r.cancelledPurchases.count)} cancelled purchase bill(s) (Rs. ${formatINR(r.cancelledPurchases.totalPaise)}).`],
          columns: [{ header: r.groupBy === 'day' ? 'Date' : r.groupBy === 'month' ? 'Month' : 'Period', kind: r.groupBy === 'day' ? 'date' : 'text' }, { header: 'Sale bills', kind: 'int' }, { header: 'Sales before tax (Rs.)', kind: 'money' },
            { header: 'Sales tax (Rs.)', kind: 'money' }, { header: 'Sales total (Rs.)', kind: 'money' }, { header: 'Purchase bills', kind: 'int' }, { header: 'Purchases before tax (Rs.)', kind: 'money' },
            { header: 'Purchases total (Rs.)', kind: 'money' }, { header: 'Collected from customers (Rs.)', kind: 'money' }, { header: 'Paid to suppliers (Rs.)', kind: 'money' }],
          rows: r.periods.map(row), totalsRow: r.groupBy === 'total' ? null : ['Total', ...row(r.totals).slice(1)],
        };
      }
      case 'LOW_MOVEMENT': {
        const r = this.lowMovement(token, req);
        return {
          title: 'Items with low or no movement', subtitle: [`Period: ${displayDate(r.fromDate)} to ${displayDate(r.toDate)}`, `Items that sold ${req.maxSoldMilli ? `${String(req.maxSoldMilli / 1000)} or less` : 'nothing'} in the period${req.onlyInStock === false ? '' : ', still in stock'}. Most money tied up first.`],
          columns: [{ header: 'Code', kind: 'text' }, { header: 'Item', kind: 'text' }, { header: 'Unit', kind: 'text' }, { header: 'In stock', kind: 'qty' }, { header: 'Sold in period', kind: 'qty' }, { header: 'Bills', kind: 'int' },
            { header: 'Received in period', kind: 'qty' }, { header: 'Last sold', kind: 'date' }, { header: 'Days since last sale', kind: 'int' }, { header: 'Stock at cost (Rs.)', kind: 'money' }],
          rows: r.rows.map((x) => [x.code, x.name, x.unit, x.stockQtyMilli, x.soldMilli, x.billCount, x.purchasedMilli, x.lastSoldOn ?? 'never', x.daysSinceLastSale, x.stockValueAtCostPaise]),
          totalsRow: ['Total', '', '', null, null, null, null, '', null, r.rows.reduce((s, x) => s + x.stockValueAtCostPaise, 0)],
        };
      }
      case 'PURCHASES_BY_SUPPLIER': {
        const rows = this.purchasesBySupplier(token, req);
        const sum = (f: (x: SupplierPurchaseRow) => number): number => rows.reduce((s, x) => s + f(x), 0);
        return {
          title: 'Purchases by supplier', subtitle: [`Period: ${range}`, 'Confirmed purchase bills only. "Owed now" is today\'s balance.'],
          columns: [{ header: 'Supplier', kind: 'text' }, { header: 'Bills', kind: 'int' }, { header: 'Before tax (Rs.)', kind: 'money' }, { header: 'Tax (Rs.)', kind: 'money' }, { header: 'Total (Rs.)', kind: 'money' },
            { header: 'Paid in period (Rs.)', kind: 'money' }, { header: 'Owed now (Rs.)', kind: 'money' }],
          rows: rows.map((x) => [x.name, x.billCount, x.taxablePaise, x.taxPaise, x.totalPaise, x.paidInPeriodPaise, x.owedNowPaise]),
          totalsRow: ['Total', sum((x) => x.billCount), sum((x) => x.taxablePaise), sum((x) => x.taxPaise), sum((x) => x.totalPaise), sum((x) => x.paidInPeriodPaise), sum((x) => x.owedNowPaise)],
        };
      }
    }
  }

  /** The same report as a spreadsheet file (UTF-8 with BOM; amounts and quantities as real numbers). */
  exportCsv(token: string, req: ReportRequest): string {
    return tableToCsv(this.table(token, req));
  }
}
