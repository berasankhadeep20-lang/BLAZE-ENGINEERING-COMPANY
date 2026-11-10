import { financialYear, seriesPrefix } from '../../domain/billNumber';
import { computeBill, type BillTotals, type LineInput, type LineResult } from '../../domain/gst';
import { taxTypeForSupply } from '../../domain/gstin';
import { uomLabel } from '../../domain/inventory';
import { mulDivRound } from '../../domain/money';
import { amountInWords } from '../../domain/words';
import { localDateString, systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postCustomerLedger, postStockMovement } from '../../infrastructure/db/ledgers';
import { allocateNumber } from '../../infrastructure/db/numberSeries';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import { clean, isoDate, priced } from '../common';
import { assertCustomerUsable } from '../parties/customerService';
import { readSettings, requireBillingSettings, type AppSettings } from '../settings/settingsService';
import { OUTSTANDING_SQL, recordPaymentTx } from './paymentOps';

export type BillStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

export interface SaleLineInput {
  itemId: number;
  qtyMilli: number;
  ratePaise?: number; // defaults to the item's sale rate; any other rate needs price.edit
  discountPaise?: number; // any discount needs price.edit
}

export interface SaleDraftInput {
  id?: number; // omit to start a new draft
  customerId: number;
  invoiceDate: string; // local date
  orderNo?: string;
  orderDate?: string;
  transportMode?: string;
  vehicleNo?: string;
  supplyDate?: string;
  placeOfSupply?: string; // defaults to the customer's
  lines: SaleLineInput[];
  delivery?: { amountPaise: number; gstRateBp: number } | null;
  receivedPaise?: number; // money taken at the time of sale
  paymentMethod?: string;
  notes?: string;
}

export interface SaleLineDto {
  lineNo: number;
  itemId: number;
  description: string;
  hsn: string | null;
  qtyMilli: number;
  uomLabel: string;
  ratePaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  belowCost: boolean;
  listRatePaise: number; // the item's standard rate when the bill was priced
  rateChanged: boolean; // true when the rate charged differs from the standard rate
}

export interface SaleBillDto {
  id: number;
  billNo: string | null;
  status: BillStatus;
  fy: string | null;
  invoiceDate: string;
  orderNo: string | null;
  orderDate: string | null;
  transportMode: string | null;
  vehicleNo: string | null;
  supplyDate: string | null;
  placeOfSupply: string | null;
  customer: { id: number; name: string; address: string | null; gstin: string | null; gstinDisplay: string; state: string | null };
  taxType: 'INTRA' | 'INTER';
  lines: SaleLineDto[];
  totals: {
    goodsTaxablePaise: number;
    taxableTotalPaise: number; // "Total Amount before Tax"
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalTaxPaise: number;
    deliveryPaise: number;
    deliveryGstRateBp: number;
    deliveryTaxPaise: number;
    roundOffPaise: number;
    totalPaise: number; // "Total Amount after Tax"
    amountInWords: string;
  };
  receivedAtSalePaise: number;
  paymentMethod: string | null;
  outstandingPaise: number | null; // confirmed bills only
  paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID' | null;
  payments: { receiptNo: string; paidOn: string; method: string; amountPaise: number; reversed: boolean }[];
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface SaleListFilters {
  customerId?: number;
  statuses?: BillStatus[];
  fromDate?: string; // invoice date, inclusive
  toDate?: string;
  search?: string; // bill number or customer name
  unpaidOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface SaleListRow {
  id: number;
  billNo: string | null;
  status: BillStatus;
  invoiceDate: string;
  customerId: number;
  customerName: string;
  totalPaise: number;
  outstandingPaise: number | null;
}

interface BillRow {
  id: number; bill_no: string | null; fy: string | null; status: BillStatus; invoice_date: string; order_no: string | null; order_date: string | null;
  transport_mode: string | null; vehicle_no: string | null; supply_date: string | null; place_of_supply: string | null; customer_id: number;
  cust_name: string; cust_address: string | null; cust_gstin: string | null; cust_state: string | null; tax_type: 'INTRA' | 'INTER';
  taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; delivery_paise: number; delivery_gst_rate_bp: number;
  delivery_tax_paise: number; round_off_paise: number; total_paise: number; received_paise: number; payment_method: string | null; notes: string | null;
  created_at: string; confirmed_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  created_by_name: string | null; confirmed_by_name: string | null; cancelled_by_name: string | null;
}

interface ItemRow {
  id: number; code: string; name: string; hsn: string | null; unit: string; pack_size: string | null;
  purchase_rate_paise: number; sale_rate_paise: number; gst_rate_bp: number; qty_milli: number; is_active: number;
}
const ITEM_SELECT = 'SELECT id, code, name, hsn, unit, pack_size, purchase_rate_paise, sale_rate_paise, gst_rate_bp, qty_milli, is_active FROM item WHERE id = ?';

const BILL_SELECT = `SELECT b.*, uc.display_name AS created_by_name, uf.display_name AS confirmed_by_name, ux.display_name AS cancelled_by_name
  FROM sale_bill b LEFT JOIN user uc ON uc.id = b.created_by LEFT JOIN user uf ON uf.id = b.confirmed_by LEFT JOIN user ux ON ux.id = b.cancelled_by`;

interface ResolvedLine {
  item: ItemRow;
  qtyMilli: number;
  ratePaise: number;
  discountPaise: number;
}

function priceBill(lines: ResolvedLine[], taxType: 'INTRA' | 'INTER', delivery: SaleDraftInput['delivery'], settings: AppSettings): { totals: BillTotals; belowCost: boolean[] } {
  const inputs: LineInput[] = lines.map((l) => ({ qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise, gstRateBp: l.item.gst_rate_bp }));
  const totals = priced(() => computeBill({ lines: inputs, taxType, delivery: delivery ?? null, roundOff: settings.roundOff }));
  // below cost: what the customer pays for the goods (before tax) is less than what the goods cost us (only when a cost is known)
  const belowCost = lines.map((l, i) => {
    const cost = mulDivRound(l.qtyMilli, l.item.purchase_rate_paise, 1000);
    return l.item.purchase_rate_paise > 0 && (totals.lines[i]?.taxablePaise ?? 0) < cost;
  });
  return { totals, belowCost };
}

export interface SaleLineQuote {
  itemId: number;
  code: string;
  description: string;
  hsn: string | null;
  uomLabel: string;
  currentRatePaise: number; // the item's current sale rate per piece: show this first
  gstRateBp: number;
  availableQtyMilli: number;
  isActive: boolean;
  lastRatePaise: number | null; // what this customer was last charged per piece
  lastSoldOn: string | null;
  canEditRate: boolean;
}

export interface SalePreview {
  taxType: 'INTRA' | 'INTER';
  lines: SaleLineDto[];
  totals: SaleBillDto['totals'];
  belowCostLines: { lineNo: number; itemCode: string }[];
  shortages: { itemCode: string; availableMilli: number; requestedMilli: number }[]; // informational: confirming will refuse if these remain
}

interface BuiltDraft {
  resolved: ResolvedLine[];
  totals: BillTotals;
  belowCost: boolean[];
  taxType: 'INTRA' | 'INTER';
  cols: Record<string, string | number | null>;
}

function totalsLine(t: BillTotals, i: number): LineResult {
  const l = t.lines[i];
  if (!l) throw new AppError('INVARIANT', 'line totals missing');
  return l;
}

function totalsDto(t: BillTotals): SaleBillDto['totals'] {
  return {
    goodsTaxablePaise: t.goodsTaxablePaise, taxableTotalPaise: t.taxableTotalPaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise,
    totalTaxPaise: t.totalTaxPaise, deliveryPaise: t.delivery?.taxablePaise ?? 0, deliveryGstRateBp: t.delivery?.gstRateBp ?? 0,
    deliveryTaxPaise: t.delivery ? t.delivery.cgstPaise + t.delivery.sgstPaise + t.delivery.igstPaise : 0, roundOffPaise: t.roundOffPaise,
    totalPaise: t.totalPaise, amountInWords: amountInWords(t.totalPaise),
  };
}

function lineDtoFromComputed(l: ResolvedLine, t: LineResult, belowCost: boolean, lineNo: number): SaleLineDto {
  return {
    lineNo, itemId: l.item.id, description: l.item.name, hsn: l.item.hsn, qtyMilli: l.qtyMilli, uomLabel: uomLabel(l.item.unit, l.item.pack_size),
    ratePaise: l.ratePaise, discountPaise: l.discountPaise, taxablePaise: t.taxablePaise, gstRateBp: t.gstRateBp, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise,
    igstPaise: t.igstPaise, totalPaise: t.totalPaise, belowCost, listRatePaise: l.item.sale_rate_paise,
    rateChanged: l.ratePaise !== l.item.sale_rate_paise || l.discountPaise > 0,
  };
}

export class SaleService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  // ------------------------------------------------------------------ drafts
  /**
   * What the invoice screen shows when a line is added: the item's CURRENT rate per piece (shown first, for the user to edit for this bill),
   * the stock on hand, and what this customer was last charged for it. `canEditRate` tells the screen whether the rate field may be changed.
   */
  quoteLine(token: string, input: { itemId: number; customerId?: number }): SaleLineQuote {
    const user = this.auth.authorize(token, 'sale.create');
    const item = this.db.prepare(ITEM_SELECT).get(input.itemId) as ItemRow | undefined;
    if (!item) throw new AppError('NOT_FOUND', 'item not found');
    const last =
      input.customerId === undefined
        ? undefined
        : (this.db
            .prepare(`SELECT l.rate_paise AS rate, b.invoice_date AS date FROM sale_bill_line l JOIN sale_bill b ON b.id = l.bill_id
                      WHERE b.customer_id = ? AND l.item_id = ? AND b.status = 'CONFIRMED' ORDER BY b.id DESC LIMIT 1`)
            .get(input.customerId, input.itemId) as { rate: number; date: string } | undefined);
    return {
      itemId: item.id, code: item.code, description: item.name, hsn: item.hsn, uomLabel: uomLabel(item.unit, item.pack_size),
      currentRatePaise: item.sale_rate_paise, gstRateBp: item.gst_rate_bp, availableQtyMilli: item.qty_milli, isActive: item.is_active === 1,
      lastRatePaise: last?.rate ?? null, lastSoldOn: last?.date ?? null,
      canEditRate: user.role === 'OWNER' || user.permissions.includes('sale.edit_rate'),
    };
  }

  /** Price a bill exactly as saving would, without saving anything: lets the screen show live totals while the user edits rates and quantities. */
  preview(token: string, input: SaleDraftInput): SalePreview {
    this.auth.authorize(token, 'sale.create');
    const d = this.buildDraft(this.db, token, input, this.clock.now().toISOString());
    const need = new Map<number, number>();
    for (const l of d.resolved) need.set(l.item.id, (need.get(l.item.id) ?? 0) + l.qtyMilli);
    const shortages = [...need.entries()].flatMap(([itemId, requested]) => {
      const row = this.db.prepare('SELECT code, qty_milli FROM item WHERE id = ?').get(itemId) as { code: string; qty_milli: number };
      return row.qty_milli < requested ? [{ itemCode: row.code, availableMilli: row.qty_milli, requestedMilli: requested }] : [];
    });
    return {
      taxType: d.taxType,
      lines: d.resolved.map((l, i) => lineDtoFromComputed(l, totalsLine(d.totals, i), d.belowCost[i] ?? false, i + 1)),
      totals: totalsDto(d.totals),
      belowCostLines: d.resolved.flatMap((l, i) => (d.belowCost[i] ? [{ lineNo: i + 1, itemCode: l.item.code }] : [])),
      shortages,
    };
  }

  /** Create or update a draft. Nothing here touches stock, balances or the invoice number. */
  saveDraft(token: string, input: SaleDraftInput): SaleBillDto {
    const user = this.auth.authorize(token, 'sale.create');
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const d = this.buildDraft(ctx.db, token, input, ctx.now);
      const names = Object.keys(d.cols);
      const values = Object.values(d.cols) as (string | number | null)[];

      let billId: number;
      if (input.id !== undefined) {
        const existing = ctx.db.prepare('SELECT status FROM sale_bill WHERE id = ?').get(input.id) as { status: BillStatus } | undefined;
        if (!existing) throw new AppError('NOT_FOUND', 'bill not found');
        if (existing.status !== 'DRAFT') throw new AppError('CONFLICT', 'only a draft can be edited; an issued bill is never changed (cancel it and issue a new one)');
        ctx.db.prepare(`UPDATE sale_bill SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`).run(...values, input.id);
        ctx.db.prepare('DELETE FROM sale_bill_line WHERE bill_id = ?').run(input.id);
        billId = input.id;
      } else {
        billId = Number(
          ctx.db
            .prepare(`INSERT INTO sale_bill (status, ${names.join(', ')}, created_by, created_at) VALUES ('DRAFT', ${names.map(() => '?').join(', ')}, ?, ?)`)
            .run(...values, user.id, ctx.now).lastInsertRowid,
        );
      }
      this.insertLines(ctx.db, billId, d.resolved, d.totals, d.belowCost);
      recordAudit(ctx, { action: 'SALE_SAVE_DRAFT', entityType: 'sale_bill', entityId: billId, detail: { customerId: input.customerId, lines: d.resolved.length, totalPaise: d.totals.totalPaise } });
      return this.loadBill(ctx.db, billId);
    });
  }

  /** Validate and price a draft (shared by saveDraft and preview). Reads only. */
  private buildDraft(db: Db, token: string, input: SaleDraftInput, nowIso: string): BuiltDraft {
    const settings = readSettings(db);
    const today = localDateString(new Date(nowIso));
    const p = new Problems();
    p.require(isoDate(input.invoiceDate), 'invoice date must be a valid date');
    p.require(!isoDate(input.invoiceDate) || input.invoiceDate <= today, 'invoice date cannot be in the future');
    for (const [label, v] of [['order date', input.orderDate], ['date of supply', input.supplyDate]] as const) p.require(!v || isoDate(v), `${label} must be a valid date`);
    p.require(input.lines.length >= 1, 'add at least one item');
    p.require(input.lines.length <= 100, 'a bill can have at most 100 lines');
    for (const [i, l] of input.lines.entries()) {
      p.require(Number.isSafeInteger(l.qtyMilli) && l.qtyMilli > 0, `line ${String(i + 1)}: quantity must be more than zero`);
      if (l.ratePaise !== undefined) p.require(Number.isSafeInteger(l.ratePaise) && l.ratePaise >= 0, `line ${String(i + 1)}: rate cannot be negative`);
      if (l.discountPaise !== undefined) p.require(Number.isSafeInteger(l.discountPaise) && l.discountPaise >= 0, `line ${String(i + 1)}: discount cannot be negative`);
    }
    const dl = input.delivery;
    if (dl) {
      p.require(Number.isSafeInteger(dl.amountPaise) && dl.amountPaise >= 0, 'delivery charge cannot be negative');
      p.require(Number.isSafeInteger(dl.gstRateBp) && dl.gstRateBp >= 0 && dl.gstRateBp <= 10000, 'delivery GST rate must be between 0% and 100%');
    }
    const received = input.receivedPaise ?? 0;
    p.require(Number.isSafeInteger(received) && received >= 0, 'amount received cannot be negative');
    for (const [label, v, max] of [['order number', input.orderNo, 40], ['transport mode', input.transportMode, 40], ['vehicle number', input.vehicleNo, 20], ['place of supply', input.placeOfSupply, 80], ['notes', input.notes, 500]] as const) {
      p.require((v?.trim().length ?? 0) <= max, `${label} is too long (${String(max)} characters at most)`);
    }
    p.throwIfAny();

    assertCustomerUsable(db, input.customerId, 'DRAFT');
    const customer = db.prepare('SELECT name, address, gstin, state, place_of_supply FROM customer WHERE id = ?').get(input.customerId) as {
      name: string; address: string | null; gstin: string | null; state: string | null; place_of_supply: string | null;
    };

    const resolved: ResolvedLine[] = input.lines.map((l, i) => {
      const item = db.prepare(ITEM_SELECT).get(l.itemId) as ItemRow | undefined;
      if (!item) throw new AppError('NOT_FOUND', `line ${String(i + 1)}: item not found`);
      if (item.is_active !== 1) throw new AppError('VALIDATION', `line ${String(i + 1)}: item ${item.code} is inactive and cannot be sold`);
      // the rate shown first is the item's current rate; typing a different rate (or giving a discount) is a per-bill price decision
      const rate = l.ratePaise ?? item.sale_rate_paise;
      const discount = l.discountPaise ?? 0;
      if (rate !== item.sale_rate_paise || discount > 0) this.auth.authorize(token, 'sale.edit_rate');
      return { item, qtyMilli: l.qtyMilli, ratePaise: rate, discountPaise: discount };
    });

    const taxType = settings.businessState && customer.state ? taxTypeForSupply(settings.businessState, customer.state) : 'INTRA';
    const { totals, belowCost } = priceBill(resolved, taxType, dl, settings);
    if (received > totals.totalPaise) throw new AppError('VALIDATION', 'the amount received is more than the bill total');
    const method = received > 0 ? this.checkMethod(settings, input.paymentMethod) : null;

    const cols = {
      invoice_date: input.invoiceDate, order_no: clean(input.orderNo), order_date: clean(input.orderDate), transport_mode: clean(input.transportMode),
      vehicle_no: clean(input.vehicleNo), supply_date: clean(input.supplyDate), place_of_supply: clean(input.placeOfSupply) ?? customer.place_of_supply ?? customer.state,
      customer_id: input.customerId, cust_name: customer.name, cust_address: customer.address, cust_gstin: customer.gstin, cust_state: customer.state,
      tax_type: taxType, taxable_paise: totals.taxableTotalPaise, cgst_paise: totals.cgstPaise, sgst_paise: totals.sgstPaise, igst_paise: totals.igstPaise,
      delivery_paise: dl?.amountPaise ?? 0, delivery_gst_rate_bp: dl?.gstRateBp ?? 0, delivery_tax_paise: totals.delivery ? totals.delivery.cgstPaise + totals.delivery.sgstPaise + totals.delivery.igstPaise : 0,
      round_off_paise: totals.roundOffPaise, total_paise: totals.totalPaise, received_paise: received,
      payment_method: method, notes: clean(input.notes),
    };
    return { resolved, totals, belowCost, taxType, cols };
  }

  deleteDraft(token: string, billId: number): void {
    const user = this.auth.authorize(token, 'sale.create');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT status, total_paise FROM sale_bill WHERE id = ?').get(billId) as { status: BillStatus; total_paise: number } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'bill not found');
      if (row.status !== 'DRAFT') throw new AppError('CONFLICT', 'only a draft can be deleted; issued bills are cancelled instead');
      ctx.db.prepare('DELETE FROM sale_bill_line WHERE bill_id = ?').run(billId);
      ctx.db.prepare('DELETE FROM sale_bill WHERE id = ?').run(billId);
      recordAudit(ctx, { action: 'SALE_DELETE_DRAFT', entityType: 'sale_bill', entityId: billId, detail: { totalPaise: row.total_paise } });
    });
  }

  // ------------------------------------------------------------------ confirm
  /**
   * Issue the bill. In ONE transaction: re-check everything against today's data, take the next invoice number, freeze the customer's
   * details and the line details on the bill, reduce stock, add the amount to the customer's dues, and record any money taken at the time.
   * If any step fails, none of it is saved and the invoice number is not used up.
   */
  confirm(token: string, billId: number, opts: { acknowledgeBelowCost?: boolean; paymentReference?: string } = {}): SaleBillDto {
    const user = this.auth.authorize(token, 'sale.create');
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const bill = ctx.db.prepare('SELECT * FROM sale_bill WHERE id = ?').get(billId) as BillRow | undefined;
      if (!bill) throw new AppError('NOT_FOUND', 'bill not found');
      if (bill.status !== 'DRAFT') throw new AppError('CONFLICT', bill.status === 'CONFIRMED' ? 'this bill is already confirmed' : 'a cancelled bill cannot be confirmed');

      const settings = readSettings(ctx.db);
      const { businessState, invoicePrefix } = requireBillingSettings(settings);
      assertCustomerUsable(ctx.db, bill.customer_id, 'CONFIRM');
      const customer = ctx.db.prepare('SELECT name, address, gstin, state, place_of_supply FROM customer WHERE id = ?').get(bill.customer_id) as {
        name: string; address: string | null; gstin: string | null; state: string | null; place_of_supply: string | null;
      };
      if (!customer.state) throw new AppError('VALIDATION', "this customer has no state; add it to the customer's details first");
      if (bill.invoice_date > localDateString(new Date(ctx.now))) throw new AppError('VALIDATION', 'invoice date cannot be in the future');

      const lineRows = ctx.db.prepare('SELECT item_id, qty_milli, rate_paise, discount_paise, line_no FROM sale_bill_line WHERE bill_id = ? ORDER BY line_no').all(billId) as {
        item_id: number; qty_milli: number; rate_paise: number; discount_paise: number; line_no: number;
      }[];
      if (lineRows.length === 0) throw new AppError('VALIDATION', 'add at least one item');

      // today's item data (tax rate, HSN, name and unit are taken fresh); the rate and discount are the ones agreed on the draft
      const resolved: ResolvedLine[] = lineRows.map((l) => {
        const item = ctx.db.prepare(ITEM_SELECT).get(l.item_id) as ItemRow | undefined;
        if (!item) throw new AppError('NOT_FOUND', 'an item on this bill no longer exists');
        if (item.is_active !== 1) throw new AppError('VALIDATION', `item ${item.code} is inactive and cannot be sold`);
        return { item, qtyMilli: l.qty_milli, ratePaise: l.rate_paise, discountPaise: l.discount_paise };
      });

      const taxType = taxTypeForSupply(businessState, customer.state);
      const delivery = bill.delivery_paise > 0 ? { amountPaise: bill.delivery_paise, gstRateBp: bill.delivery_gst_rate_bp } : null;
      const { totals, belowCost } = priceBill(resolved, taxType, delivery, settings);

      const received = bill.received_paise;
      if (received > totals.totalPaise) throw new AppError('VALIDATION', 'the amount received is more than the bill total');
      const payMethod = received > 0 ? this.checkMethod(settings, bill.payment_method ?? undefined) : '';

      const belowLines = resolved.flatMap((l, i) => (belowCost[i] ? [{ lineNo: i + 1, itemCode: l.item.code }] : []));
      if (belowLines.length && settings.warnBelowCost && !opts.acknowledgeBelowCost) {
        throw new AppError('ACK_REQUIRED', 'some lines are priced below what the goods cost; confirm again to acknowledge', { kind: 'BELOW_COST', lines: belowLines });
      }

      // stock: checked now, per item across all lines, and every shortage is reported together
      const need = new Map<number, number>();
      for (const l of resolved) need.set(l.item.id, (need.get(l.item.id) ?? 0) + l.qtyMilli);
      const shortages = [...need.entries()].flatMap(([itemId, requested]) => {
        const row = ctx.db.prepare('SELECT code, qty_milli FROM item WHERE id = ?').get(itemId) as { code: string; qty_milli: number };
        return row.qty_milli < requested ? [{ itemCode: row.code, availableMilli: row.qty_milli, requestedMilli: requested }] : [];
      });
      if (shortages.length) throw new AppError('INSUFFICIENT_STOCK', `not enough stock for ${shortages.map((s) => s.itemCode).join(', ')}`, { shortages });

      const fy = financialYear(bill.invoice_date);
      const { number: billNo } = allocateNumber(ctx, 'SALE', fy, seriesPrefix(invoicePrefix, fy), settings.invoiceNumberWidth);

      // lines first (still a draft), then stock, dues, and finally the status change that freezes the bill
      const upd = ctx.db.prepare(
        `UPDATE sale_bill_line SET description = ?, hsn = ?, uom_label = ?, rate_paise = ?, discount_paise = ?, taxable_paise = ?, gst_rate_bp = ?,
           cgst_paise = ?, sgst_paise = ?, igst_paise = ?, total_paise = ?, below_cost = ?, list_rate_paise = ? WHERE bill_id = ? AND line_no = ?`,
      );
      resolved.forEach((l, i) => {
        const t = totals.lines[i];
        if (!t) throw new AppError('INVARIANT', 'line totals missing');
        upd.run(l.item.name, l.item.hsn, uomLabel(l.item.unit, l.item.pack_size), l.ratePaise, l.discountPaise, t.taxablePaise, t.gstRateBp, t.cgstPaise, t.sgstPaise, t.igstPaise, t.totalPaise, belowCost[i] ? 1 : 0, l.item.sale_rate_paise, billId, lineRows[i]?.line_no ?? i + 1);
      });
      for (const l of resolved) {
        postStockMovement(ctx, { itemId: l.item.id, qtyDeltaMilli: -l.qtyMilli, reason: 'SALE', refType: 'sale_bill', refId: billId, refNo: billNo });
      }
      postCustomerLedger(ctx, { partyId: bill.customer_id, entryType: 'SALE', amountPaise: totals.totalPaise, refType: 'sale_bill', refId: billId, refNo: billNo });

      ctx.db
        .prepare(
          `UPDATE sale_bill SET status = 'CONFIRMED', bill_no = ?, fy = ?, cust_name = ?, cust_address = ?, cust_gstin = ?, cust_state = ?,
             place_of_supply = ?, tax_type = ?, taxable_paise = ?, cgst_paise = ?, sgst_paise = ?, igst_paise = ?, delivery_tax_paise = ?,
             round_off_paise = ?, total_paise = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?`,
        )
        .run(billNo, fy, customer.name, customer.address, customer.gstin, customer.state, bill.place_of_supply ?? customer.place_of_supply ?? customer.state, taxType,
          totals.taxableTotalPaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise,
          totals.delivery ? totals.delivery.cgstPaise + totals.delivery.sgstPaise + totals.delivery.igstPaise : 0,
          totals.roundOffPaise, totals.totalPaise, user.id, ctx.now, billId);

      let receipt: string | null = null;
      if (received > 0) {
        const r = recordPaymentTx(ctx, settings, {
          customerId: bill.customer_id, amountPaise: received, method: payMethod, paidOn: localDateString(new Date(ctx.now)),
          reference: clean(opts.paymentReference), note: `Received with bill ${billNo}`, preferBillId: billId,
        });
        receipt = r.receiptNo;
      }

      if (belowLines.length) recordAudit(ctx, { action: 'BELOW_COST_ACK', entityType: 'sale_bill', entityId: billId, detail: { billNo, lines: belowLines, warned: settings.warnBelowCost } });
      recordAudit(ctx, { action: 'SALE_CONFIRM', entityType: 'sale_bill', entityId: billId, detail: { billNo, customerId: bill.customer_id, totalPaise: totals.totalPaise, receivedPaise: received, receiptNo: receipt, linesAtChangedRate: resolved.filter((l) => l.ratePaise !== l.item.sale_rate_paise || l.discountPaise > 0).length } });
      return this.loadBill(ctx.db, billId);
    });
  }

  // ------------------------------------------------------------------ cancel
  /**
   * The only way to correct an issued bill: cancel it (with a reason) and issue a new one. Stock goes back and the dues are removed.
   * If money has been recorded against the bill, those payments must be reversed (refunded) first; this keeps the ledger honest.
   */
  cancel(token: string, billId: number, reason: string): SaleBillDto {
    const user = this.auth.authorize(token, 'bill.cancel');
    const why = reason.trim();
    const p = new Problems();
    p.require(why.length >= 3, 'please give a reason (at least 3 characters)');
    p.require(why.length <= 500, 'the reason is too long (500 characters at most)');
    p.throwIfAny();

    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const bill = ctx.db.prepare('SELECT status, bill_no, customer_id, total_paise FROM sale_bill WHERE id = ?').get(billId) as
        | { status: BillStatus; bill_no: string; customer_id: number; total_paise: number }
        | undefined;
      if (!bill) throw new AppError('NOT_FOUND', 'bill not found');
      if (bill.status !== 'CONFIRMED') throw new AppError('CONFLICT', bill.status === 'DRAFT' ? 'a draft is deleted, not cancelled' : 'this bill is already cancelled');

      const paid = (ctx.db
        .prepare(`SELECT COALESCE(SUM(a.amount_paise), 0) AS paid FROM payment_allocation a JOIN customer_payment p ON p.id = a.payment_id WHERE a.sale_bill_id = ? AND p.is_reversed = 0`)
        .get(billId) as { paid: number }).paid;
      if (paid > 0) {
        throw new AppError('CONFLICT', 'money has been recorded against this bill; reverse those payments (refund the customer) before cancelling it', { paidPaise: paid });
      }

      const lines = ctx.db.prepare('SELECT item_id, qty_milli FROM sale_bill_line WHERE bill_id = ? ORDER BY line_no').all(billId) as { item_id: number; qty_milli: number }[];
      for (const l of lines) {
        postStockMovement(ctx, { itemId: l.item_id, qtyDeltaMilli: l.qty_milli, reason: 'SALE_CANCEL', refType: 'sale_bill', refId: billId, refNo: bill.bill_no, note: why });
      }
      try {
        postCustomerLedger(ctx, { partyId: bill.customer_id, entryType: 'SALE_CANCEL', amountPaise: -bill.total_paise, refType: 'sale_bill', refId: billId, refNo: bill.bill_no, note: why });
      } catch (e) {
        if (e instanceof AppError && e.code === 'OVERPAYMENT') {
          throw new AppError('CONFLICT', 'cancelling would leave this customer with a credit because they have paid more than their remaining dues; reverse the extra payment first', e.details);
        }
        throw e;
      }
      ctx.db.prepare("UPDATE sale_bill SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(user.id, ctx.now, why, billId);
      recordAudit(ctx, { action: 'SALE_CANCEL', entityType: 'sale_bill', entityId: billId, reason: why, detail: { billNo: bill.bill_no, totalPaise: bill.total_paise } });
      return this.loadBill(ctx.db, billId);
    });
  }

  // ------------------------------------------------------------------ reading
  get(token: string, billId: number): SaleBillDto {
    this.auth.authorizeAny(token, ['sale.create', 'customer.view', 'report.view']);
    return this.loadBill(this.db, billId);
  }

  list(token: string, f: SaleListFilters = {}): { rows: SaleListRow[]; total: number; totalBilledPaise: number; totalOutstandingPaise: number } {
    this.auth.authorizeAny(token, ['sale.create', 'customer.view', 'report.view']);
    for (const d of [f.fromDate, f.toDate]) if (d && !isoDate(d)) throw new AppError('VALIDATION', 'dates must be valid (yyyy-mm-dd)');
    if (f.fromDate && f.toDate && f.fromDate > f.toDate) throw new AppError('VALIDATION', 'the start date is after the end date');
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.customerId !== undefined) { where.push('b.customer_id = ?'); params.push(f.customerId); }
    if (f.statuses?.length) { where.push(`b.status IN (${f.statuses.map(() => '?').join(',')})`); params.push(...f.statuses); }
    if (f.fromDate) { where.push('b.invoice_date >= ?'); params.push(f.fromDate); }
    if (f.toDate) { where.push('b.invoice_date <= ?'); params.push(f.toDate); }
    if (f.search?.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(b.bill_no LIKE ? ESCAPE '\\' OR b.cust_name LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (f.unpaidOnly) where.push(`b.status = 'CONFIRMED' AND ${OUTSTANDING_SQL} > 0`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS n,
          COALESCE(SUM(CASE WHEN b.status = 'CONFIRMED' THEN b.total_paise ELSE 0 END), 0) AS billed,
          COALESCE(SUM(CASE WHEN b.status = 'CONFIRMED' THEN ${OUTSTANDING_SQL} ELSE 0 END), 0) AS owed
        FROM sale_bill b ${whereSql}`)
      .get(...params) as { n: number; billed: number; owed: number };
    const rows = this.db
      .prepare(`SELECT b.id, b.bill_no, b.status, b.invoice_date, b.customer_id, b.cust_name, b.total_paise,
          CASE WHEN b.status = 'CONFIRMED' THEN ${OUTSTANDING_SQL} ELSE NULL END AS outstanding
        FROM sale_bill b ${whereSql} ORDER BY b.invoice_date DESC, b.id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as {
        id: number; bill_no: string | null; status: BillStatus; invoice_date: string; customer_id: number; cust_name: string; total_paise: number; outstanding: number | null;
      }[];
    return {
      rows: rows.map((r) => ({ id: r.id, billNo: r.bill_no, status: r.status, invoiceDate: r.invoice_date, customerId: r.customer_id, customerName: r.cust_name, totalPaise: r.total_paise, outstandingPaise: r.outstanding })),
      total: agg.n, totalBilledPaise: agg.billed, totalOutstandingPaise: agg.owed,
    };
  }

  // ------------------------------------------------------------------ internals
  /** The payment method as spelled in Settings (so reports group "cash" and "Cash" together). */
  private checkMethod(settings: AppSettings, method: string | undefined): string {
    if (!method?.trim()) throw new AppError('VALIDATION', 'choose how the payment was received');
    const canonical = settings.paymentMethods.find((m) => m.toLowerCase() === method.trim().toLowerCase());
    if (!canonical) throw new AppError('VALIDATION', `"${method}" is not one of the payment methods in Settings`);
    return canonical;
  }

  private insertLines(db: Db, billId: number, lines: ResolvedLine[], totals: BillTotals, belowCost: boolean[]): void {
    const ins = db.prepare(
      `INSERT INTO sale_bill_line (bill_id, line_no, item_id, description, hsn, qty_milli, uom_label, rate_paise, discount_paise, taxable_paise,
         gst_rate_bp, cgst_paise, sgst_paise, igst_paise, total_paise, below_cost, list_rate_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, i) => {
      const t = totals.lines[i];
      if (!t) throw new AppError('INVARIANT', 'line totals missing');
      ins.run(billId, i + 1, l.item.id, l.item.name, l.item.hsn, l.qtyMilli, uomLabel(l.item.unit, l.item.pack_size), l.ratePaise, l.discountPaise,
        t.taxablePaise, t.gstRateBp, t.cgstPaise, t.sgstPaise, t.igstPaise, t.totalPaise, belowCost[i] ? 1 : 0, l.item.sale_rate_paise);
    });
  }

  private loadBill(db: Db, billId: number): SaleBillDto {
    const b = db.prepare(`${BILL_SELECT} WHERE b.id = ?`).get(billId) as BillRow | undefined;
    if (!b) throw new AppError('NOT_FOUND', 'bill not found');
    const lines = db
      .prepare('SELECT line_no, item_id, description, hsn, qty_milli, uom_label, rate_paise, discount_paise, taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, igst_paise, total_paise, below_cost, list_rate_paise FROM sale_bill_line WHERE bill_id = ? ORDER BY line_no')
      .all(billId) as {
        line_no: number; item_id: number; description: string; hsn: string | null; qty_milli: number; uom_label: string; rate_paise: number; discount_paise: number;
        taxable_paise: number; gst_rate_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; below_cost: number; list_rate_paise: number | null;
      }[];
    const payments = db
      .prepare(`SELECT p.receipt_no, p.paid_on, p.method, a.amount_paise, p.is_reversed FROM payment_allocation a JOIN customer_payment p ON p.id = a.payment_id WHERE a.sale_bill_id = ? ORDER BY p.id`)
      .all(billId) as { receipt_no: string; paid_on: string; method: string; amount_paise: number; is_reversed: number }[];
    const live = payments.filter((x) => x.is_reversed === 0).reduce((s, x) => s + x.amount_paise, 0);
    const outstanding = b.status === 'CONFIRMED' ? b.total_paise - live : null;
    return {
      id: b.id, billNo: b.bill_no, status: b.status, fy: b.fy, invoiceDate: b.invoice_date, orderNo: b.order_no, orderDate: b.order_date,
      transportMode: b.transport_mode, vehicleNo: b.vehicle_no, supplyDate: b.supply_date, placeOfSupply: b.place_of_supply,
      customer: { id: b.customer_id, name: b.cust_name, address: b.cust_address, gstin: b.cust_gstin, gstinDisplay: b.cust_gstin ?? 'UN-REGD', state: b.cust_state },
      taxType: b.tax_type,
      lines: lines.map((l) => ({
        lineNo: l.line_no, itemId: l.item_id, description: l.description, hsn: l.hsn, qtyMilli: l.qty_milli, uomLabel: l.uom_label, ratePaise: l.rate_paise,
        discountPaise: l.discount_paise, taxablePaise: l.taxable_paise, gstRateBp: l.gst_rate_bp, cgstPaise: l.cgst_paise, sgstPaise: l.sgst_paise,
        igstPaise: l.igst_paise, totalPaise: l.total_paise, belowCost: l.below_cost === 1,
        listRatePaise: l.list_rate_paise ?? l.rate_paise, rateChanged: l.list_rate_paise !== null && (l.list_rate_paise !== l.rate_paise || l.discount_paise > 0),
      })),
      totals: {
        goodsTaxablePaise: b.taxable_paise - b.delivery_paise, taxableTotalPaise: b.taxable_paise, cgstPaise: b.cgst_paise, sgstPaise: b.sgst_paise, igstPaise: b.igst_paise,
        totalTaxPaise: b.cgst_paise + b.sgst_paise + b.igst_paise, deliveryPaise: b.delivery_paise, deliveryGstRateBp: b.delivery_gst_rate_bp,
        deliveryTaxPaise: b.delivery_tax_paise, roundOffPaise: b.round_off_paise, totalPaise: b.total_paise, amountInWords: amountInWords(b.total_paise),
      },
      receivedAtSalePaise: b.received_paise, paymentMethod: b.payment_method, outstandingPaise: outstanding,
      paymentStatus: outstanding === null ? null : outstanding <= 0 ? 'PAID' : live > 0 ? 'PARTIAL' : 'UNPAID',
      payments: payments.map((x) => ({ receiptNo: x.receipt_no, paidOn: x.paid_on, method: x.method, amountPaise: x.amount_paise, reversed: x.is_reversed === 1 })),
      notes: b.notes, createdByName: b.created_by_name, createdAt: b.created_at, confirmedByName: b.confirmed_by_name, confirmedAt: b.confirmed_at,
      cancelledByName: b.cancelled_by_name, cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason,
    };
  }
}

