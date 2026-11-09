import { financialYear, seriesPrefix } from '../../domain/billNumber';
import { computeBill, type BillTotals, type LineInput } from '../../domain/gst';
import { taxTypeForSupply } from '../../domain/gstin';
import { uomLabel } from '../../domain/inventory';
import { amountInWords } from '../../domain/words';
import { localDateString, systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postStockMovement, postSupplierLedger } from '../../infrastructure/db/ledgers';
import { allocateNumber } from '../../infrastructure/db/numberSeries';
import { UnitOfWork, requireActor, type TxContext } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import { clean, isoDate, priced } from '../common';
import { assertSupplierUsable } from '../parties/supplierService';
import { readSettings, requireBusinessState, type AppSettings } from '../settings/settingsService';
import { PURCHASE_OUTSTANDING_SQL, recordSupplierPaymentTx } from './supplierPaymentOps';

export type PurchaseStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

export interface PurchaseLineInput {
  itemId: number;
  invoicedQtyMilli: number; // the quantity on the supplier's invoice (this is what is billed)
  receivedQtyMilli?: number; // what actually arrived; defaults to the invoiced quantity. Only this goes into stock.
  ratePaise?: number; // rate per piece the supplier charged; defaults to the item's current purchase rate (shown first, editable)
  discountPaise?: number;
}

export interface PurchaseDraftInput {
  id?: number;
  supplierId: number;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  billDate?: string; // the date it is entered here; defaults to today
  orderNo?: string;
  orderDate?: string;
  transportMode?: string;
  vehicleNo?: string;
  supplyDate?: string;
  placeOfSupply?: string;
  lines: PurchaseLineInput[];
  delivery?: { amountPaise: number; gstRateBp: number } | null;
  paidPaise?: number; // paid to the supplier at the time of entering the bill
  paymentMethod?: string;
  notes?: string;
}

export interface PurchaseLineDto {
  lineNo: number;
  itemId: number;
  description: string;
  hsn: string | null;
  uomLabel: string;
  invoicedQtyMilli: number;
  receivedQtyMilli: number; // drafts: the intended quantity; confirmed bills: what has actually been received so far
  pendingQtyMilli: number; // invoiced but not yet received
  ratePaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface PurchaseBillDto {
  id: number;
  billNo: string | null; // internal number
  status: PurchaseStatus;
  fy: string | null;
  billDate: string;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  orderNo: string | null;
  orderDate: string | null;
  transportMode: string | null;
  vehicleNo: string | null;
  supplyDate: string | null;
  placeOfSupply: string | null;
  supplier: { id: number; name: string; address: string | null; gstin: string | null; gstinDisplay: string; state: string | null };
  taxType: 'INTRA' | 'INTER';
  lines: PurchaseLineDto[];
  totals: {
    goodsTaxablePaise: number;
    taxableTotalPaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalTaxPaise: number;
    deliveryPaise: number;
    deliveryGstRateBp: number;
    deliveryTaxPaise: number;
    roundOffPaise: number;
    totalPaise: number;
    amountInWords: string;
  };
  paidAtEntryPaise: number;
  paidPaise: number | null; // confirmed bills: everything paid against this bill so far
  outstandingPaise: number | null;
  paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID' | null;
  goodsPending: boolean; // confirmed, and some invoiced goods have not arrived yet
  receipts: { lineNo: number; qtyMilli: number; receivedOn: string; note: string | null; userName: string }[];
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

export interface PurchaseLineQuote {
  itemId: number;
  code: string;
  description: string;
  hsn: string | null;
  uomLabel: string;
  currentRatePaise: number; // the item's current purchase rate per piece: shown first, for the user to edit to what the supplier charged
  gstRateBp: number;
  stockQtyMilli: number;
  isActive: boolean;
  lastRatePaise: number | null; // what this supplier last charged per piece
  lastBoughtOn: string | null;
}

export interface PurchasePreview {
  taxType: 'INTRA' | 'INTER';
  lines: PurchaseLineDto[];
  totals: PurchaseBillDto['totals'];
}

export interface PurchaseListFilters {
  supplierId?: number;
  statuses?: PurchaseStatus[];
  fromDate?: string; // internal bill date, inclusive
  toDate?: string;
  search?: string; // internal number, supplier invoice number or supplier name
  unpaidOnly?: boolean;
  pendingGoodsOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface PurchaseListRow {
  id: number;
  billNo: string | null;
  status: PurchaseStatus;
  billDate: string;
  supplierId: number;
  supplierName: string;
  supplierInvoiceNo: string;
  totalPaise: number;
  outstandingPaise: number | null;
  goodsPending: boolean;
}

interface BillRow {
  id: number; bill_no: string | null; fy: string | null; status: PurchaseStatus; bill_date: string; supplier_id: number;
  supplier_inv_no: string; supplier_inv_date: string; sup_name: string; sup_address: string | null; sup_gstin: string | null; sup_state: string | null;
  order_no: string | null; order_date: string | null; transport_mode: string | null; vehicle_no: string | null; supply_date: string | null; place_of_supply: string | null;
  tax_type: 'INTRA' | 'INTER'; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; delivery_paise: number; delivery_gst_rate_bp: number;
  delivery_tax_paise: number; round_off_paise: number; total_paise: number; paid_paise: number; payment_method: string | null; notes: string | null;
  created_at: string; confirmed_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  created_by_name: string | null; confirmed_by_name: string | null; cancelled_by_name: string | null;
}

interface ItemRow {
  id: number; code: string; name: string; hsn: string | null; unit: string; pack_size: string | null;
  purchase_rate_paise: number; gst_rate_bp: number; qty_milli: number; is_active: number;
}
const ITEM_SELECT = 'SELECT id, code, name, hsn, unit, pack_size, purchase_rate_paise, gst_rate_bp, qty_milli, is_active FROM item WHERE id = ?';

const BILL_SELECT = `SELECT b.*, uc.display_name AS created_by_name, uf.display_name AS confirmed_by_name, ux.display_name AS cancelled_by_name
  FROM purchase_bill b LEFT JOIN user uc ON uc.id = b.created_by LEFT JOIN user uf ON uf.id = b.confirmed_by LEFT JOIN user ux ON ux.id = b.cancelled_by`;

const PENDING_EXISTS_SQL = `EXISTS (SELECT 1 FROM purchase_bill_line l WHERE l.bill_id = b.id AND l.ordered_qty_milli >
  COALESCE((SELECT SUM(r.qty_milli) FROM purchase_receipt r WHERE r.bill_id = l.bill_id AND r.line_no = l.line_no), 0))`;

interface ResolvedLine {
  item: ItemRow;
  invoicedQtyMilli: number;
  receivedQtyMilli: number;
  ratePaise: number;
  discountPaise: number;
}

interface BuiltDraft {
  resolved: ResolvedLine[];
  totals: BillTotals;
  taxType: 'INTRA' | 'INTER';
  cols: Record<string, string | number | null>;
}

function priceBill(lines: ResolvedLine[], taxType: 'INTRA' | 'INTER', delivery: PurchaseDraftInput['delivery'], settings: AppSettings): BillTotals {
  const inputs: LineInput[] = lines.map((l) => ({ qtyMilli: l.invoicedQtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise, gstRateBp: l.item.gst_rate_bp }));
  return priced(() => computeBill({ lines: inputs, taxType, delivery: delivery ?? null, roundOff: settings.roundOff }));
}

function totalsDto(t: BillTotals): PurchaseBillDto['totals'] {
  return {
    goodsTaxablePaise: t.goodsTaxablePaise, taxableTotalPaise: t.taxableTotalPaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise,
    totalTaxPaise: t.totalTaxPaise, deliveryPaise: t.delivery?.taxablePaise ?? 0, deliveryGstRateBp: t.delivery?.gstRateBp ?? 0,
    deliveryTaxPaise: t.delivery ? t.delivery.cgstPaise + t.delivery.sgstPaise + t.delivery.igstPaise : 0, roundOffPaise: t.roundOffPaise,
    totalPaise: t.totalPaise, amountInWords: amountInWords(t.totalPaise),
  };
}

export class PurchaseService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  // ------------------------------------------------------------------ drafts
  /** For the purchase screen when a line is added: the item's current purchase rate (to be edited to what the supplier charged), and what this supplier last charged. */
  quoteLine(token: string, input: { itemId: number; supplierId?: number }): PurchaseLineQuote {
    this.auth.authorize(token, 'purchase.create');
    const item = this.db.prepare(ITEM_SELECT).get(input.itemId) as ItemRow | undefined;
    if (!item) throw new AppError('NOT_FOUND', 'item not found');
    const last =
      input.supplierId === undefined
        ? undefined
        : (this.db
            .prepare(`SELECT l.rate_paise AS rate, b.bill_date AS date FROM purchase_bill_line l JOIN purchase_bill b ON b.id = l.bill_id
                      WHERE b.supplier_id = ? AND l.item_id = ? AND b.status = 'CONFIRMED' ORDER BY b.id DESC LIMIT 1`)
            .get(input.supplierId, input.itemId) as { rate: number; date: string } | undefined);
    return {
      itemId: item.id, code: item.code, description: item.name, hsn: item.hsn, uomLabel: uomLabel(item.unit, item.pack_size),
      currentRatePaise: item.purchase_rate_paise, gstRateBp: item.gst_rate_bp, stockQtyMilli: item.qty_milli, isActive: item.is_active === 1,
      lastRatePaise: last?.rate ?? null, lastBoughtOn: last?.date ?? null,
    };
  }

  /** Price a purchase exactly as saving would, without saving anything (live totals while the user types). */
  preview(token: string, input: PurchaseDraftInput): PurchasePreview {
    this.auth.authorize(token, 'purchase.create');
    const d = this.buildDraft(this.db, input, this.clock.now().toISOString());
    return {
      taxType: d.taxType,
      lines: d.resolved.map((l, i) => this.lineDtoFromComputed(l, d.totals, i)),
      totals: totalsDto(d.totals),
    };
  }

  /** Create or update a draft. Nothing here touches stock, the supplier's balance or the internal number. */
  saveDraft(token: string, input: PurchaseDraftInput): PurchaseBillDto {
    const user = this.auth.authorize(token, 'purchase.create');
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const d = this.buildDraft(ctx.db, input, ctx.now);
      const dup = ctx.db
        .prepare("SELECT id FROM purchase_bill WHERE supplier_id = ? AND supplier_inv_no = ? COLLATE NOCASE AND status <> 'CANCELLED' AND id <> ?")
        .get(input.supplierId, d.cols.supplier_inv_no, input.id ?? -1) as { id: number } | undefined;
      if (dup) throw new AppError('CONFLICT', `this supplier's invoice ${String(d.cols.supplier_inv_no)} has already been entered`, { purchaseBillId: dup.id });

      const names = Object.keys(d.cols);
      const values = Object.values(d.cols) as (string | number | null)[];
      let billId: number;
      if (input.id !== undefined) {
        const existing = ctx.db.prepare('SELECT status FROM purchase_bill WHERE id = ?').get(input.id) as { status: PurchaseStatus } | undefined;
        if (!existing) throw new AppError('NOT_FOUND', 'purchase bill not found');
        if (existing.status !== 'DRAFT') throw new AppError('CONFLICT', 'only a draft can be edited; an entered bill is never changed (cancel it and enter it again)');
        ctx.db.prepare(`UPDATE purchase_bill SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`).run(...values, input.id);
        ctx.db.prepare('DELETE FROM purchase_bill_line WHERE bill_id = ?').run(input.id);
        billId = input.id;
      } else {
        billId = Number(
          ctx.db
            .prepare(`INSERT INTO purchase_bill (status, ${names.join(', ')}, created_by, created_at) VALUES ('DRAFT', ${names.map(() => '?').join(', ')}, ?, ?)`)
            .run(...values, user.id, ctx.now).lastInsertRowid,
        );
      }
      this.insertLines(ctx.db, billId, d.resolved, d.totals);
      recordAudit(ctx, { action: 'PURCHASE_SAVE_DRAFT', entityType: 'purchase_bill', entityId: billId, detail: { supplierId: input.supplierId, supplierInvoiceNo: d.cols.supplier_inv_no, lines: d.resolved.length, totalPaise: d.totals.totalPaise } });
      return this.loadBill(ctx.db, billId);
    });
  }

  deleteDraft(token: string, billId: number): void {
    const user = this.auth.authorize(token, 'purchase.create');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT status, total_paise FROM purchase_bill WHERE id = ?').get(billId) as { status: PurchaseStatus; total_paise: number } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'purchase bill not found');
      if (row.status !== 'DRAFT') throw new AppError('CONFLICT', 'only a draft can be deleted; entered bills are cancelled instead');
      ctx.db.prepare('DELETE FROM purchase_bill_line WHERE bill_id = ?').run(billId);
      ctx.db.prepare('DELETE FROM purchase_bill WHERE id = ?').run(billId);
      recordAudit(ctx, { action: 'PURCHASE_DELETE_DRAFT', entityType: 'purchase_bill', entityId: billId, detail: { totalPaise: row.total_paise } });
    });
  }

  // ------------------------------------------------------------------ confirm
  /**
   * Enter the bill for real. In ONE transaction: re-check against today's data, take the next internal number, freeze the supplier's and the lines' details,
   * add what was RECEIVED (not what was merely invoiced) to stock, add the total to what we owe the supplier, and record any payment made at the time.
   * If any step fails, none of it is saved. With `updateItemPurchaseRates` (needs price.edit) the items' purchase rates are brought in line with this bill.
   */
  confirm(token: string, billId: number, opts: { updateItemPurchaseRates?: boolean; paymentReference?: string } = {}): PurchaseBillDto {
    const user = this.auth.authorize(token, 'purchase.create');
    if (opts.updateItemPurchaseRates) this.auth.authorize(token, 'price.edit');
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const bill = ctx.db.prepare('SELECT * FROM purchase_bill WHERE id = ?').get(billId) as BillRow | undefined;
      if (!bill) throw new AppError('NOT_FOUND', 'purchase bill not found');
      if (bill.status !== 'DRAFT') throw new AppError('CONFLICT', bill.status === 'CONFIRMED' ? 'this bill is already entered' : 'a cancelled bill cannot be confirmed');

      const settings = readSettings(ctx.db);
      const businessState = requireBusinessState(settings);
      assertSupplierUsable(ctx.db, bill.supplier_id);
      const supplier = ctx.db.prepare('SELECT name, address, gstin, state FROM supplier WHERE id = ?').get(bill.supplier_id) as { name: string; address: string | null; gstin: string | null; state: string | null };
      if (!supplier.state) throw new AppError('VALIDATION', "this supplier has no state; add it to the supplier's details first");
      const today = localDateString(new Date(ctx.now));
      if (bill.bill_date > today || bill.supplier_inv_date > today) throw new AppError('VALIDATION', 'bill dates cannot be in the future');

      const lineRows = ctx.db.prepare('SELECT line_no, item_id, ordered_qty_milli, received_qty_milli, rate_paise, discount_paise FROM purchase_bill_line WHERE bill_id = ? ORDER BY line_no').all(billId) as {
        line_no: number; item_id: number; ordered_qty_milli: number; received_qty_milli: number; rate_paise: number; discount_paise: number;
      }[];
      if (lineRows.length === 0) throw new AppError('VALIDATION', 'add at least one item');
      const resolved: ResolvedLine[] = lineRows.map((l) => {
        const item = ctx.db.prepare(ITEM_SELECT).get(l.item_id) as ItemRow | undefined;
        if (!item) throw new AppError('NOT_FOUND', 'an item on this bill no longer exists');
        if (item.is_active !== 1) throw new AppError('VALIDATION', `item ${item.code} is inactive and cannot be bought`);
        return { item, invoicedQtyMilli: l.ordered_qty_milli, receivedQtyMilli: l.received_qty_milli, ratePaise: l.rate_paise, discountPaise: l.discount_paise };
      });

      const taxType = taxTypeForSupply(businessState, supplier.state);
      const delivery = bill.delivery_paise > 0 ? { amountPaise: bill.delivery_paise, gstRateBp: bill.delivery_gst_rate_bp } : null;
      const totals = priceBill(resolved, taxType, delivery, settings);
      const paid = bill.paid_paise;
      if (paid > totals.totalPaise) throw new AppError('VALIDATION', 'the amount paid is more than the bill total');
      const payMethod = paid > 0 ? this.checkMethod(settings, bill.payment_method ?? undefined) : '';

      const fy = financialYear(bill.bill_date);
      const { number: billNo } = allocateNumber(ctx, 'PURCHASE', fy, seriesPrefix(settings.purchasePrefix, fy), settings.invoiceNumberWidth);

      const upd = ctx.db.prepare(
        `UPDATE purchase_bill_line SET description = ?, hsn = ?, uom_label = ?, taxable_paise = ?, gst_rate_bp = ?, cgst_paise = ?, sgst_paise = ?, igst_paise = ?, total_paise = ?
         WHERE bill_id = ? AND line_no = ?`,
      );
      const recIns = ctx.db.prepare('INSERT INTO purchase_receipt (bill_id, line_no, qty_milli, received_on, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      resolved.forEach((l, i) => {
        const t = totals.lines[i];
        const lineNo = lineRows[i]?.line_no ?? i + 1;
        if (!t) throw new AppError('INVARIANT', 'line totals missing');
        upd.run(l.item.name, l.item.hsn, uomLabel(l.item.unit, l.item.pack_size), t.taxablePaise, t.gstRateBp, t.cgstPaise, t.sgstPaise, t.igstPaise, t.totalPaise, billId, lineNo);
        if (l.receivedQtyMilli > 0) {
          postStockMovement(ctx, { itemId: l.item.id, qtyDeltaMilli: l.receivedQtyMilli, reason: 'PURCHASE', refType: 'purchase_bill', refId: billId, refNo: billNo });
          recIns.run(billId, lineNo, l.receivedQtyMilli, today, 'Received when the bill was entered', user.id, ctx.now);
        }
      });
      postSupplierLedger(ctx, { partyId: bill.supplier_id, entryType: 'PURCHASE', amountPaise: totals.totalPaise, refType: 'purchase_bill', refId: billId, refNo: billNo, note: `Supplier invoice ${bill.supplier_inv_no}` });

      ctx.db
        .prepare(
          `UPDATE purchase_bill SET status = 'CONFIRMED', bill_no = ?, fy = ?, sup_name = ?, sup_address = ?, sup_gstin = ?, sup_state = ?, tax_type = ?,
             taxable_paise = ?, cgst_paise = ?, sgst_paise = ?, igst_paise = ?, delivery_tax_paise = ?, round_off_paise = ?, total_paise = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?`,
        )
        .run(billNo, fy, supplier.name, supplier.address, supplier.gstin, supplier.state, taxType, totals.taxableTotalPaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise,
          totals.delivery ? totals.delivery.cgstPaise + totals.delivery.sgstPaise + totals.delivery.igstPaise : 0, totals.roundOffPaise, totals.totalPaise, user.id, ctx.now, billId);

      let receipt: string | null = null;
      if (paid > 0) {
        receipt = recordSupplierPaymentTx(ctx, settings, {
          supplierId: bill.supplier_id, amountPaise: paid, method: payMethod, paidOn: today, reference: clean(opts.paymentReference),
          note: `Paid with purchase ${billNo}`, purchaseBillId: billId,
        }).receiptNo;
      }

      if (opts.updateItemPurchaseRates) this.updateItemRates(ctx, resolved, billNo, user.id);
      recordAudit(ctx, {
        action: 'PURCHASE_CONFIRM', entityType: 'purchase_bill', entityId: billId,
        detail: { billNo, supplierId: bill.supplier_id, supplierInvoiceNo: bill.supplier_inv_no, totalPaise: totals.totalPaise, paidPaise: paid, receiptNo: receipt, shortLines: resolved.filter((l) => l.receivedQtyMilli < l.invoicedQtyMilli).length },
      });
      return this.loadBill(ctx.db, billId);
    });
  }

  // ------------------------------------------------------------------ receiving the rest
  /** Goods that were invoiced but had not arrived: record what has arrived now. Stock goes up by exactly that. Needs purchase.create. */
  receive(token: string, billId: number, input: { lines: { lineNo: number; qtyMilli: number }[]; receivedOn?: string; note?: string }): PurchaseBillDto {
    const user = this.auth.authorize(token, 'purchase.create');
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const today = localDateString(new Date(ctx.now));
      const receivedOn = input.receivedOn ?? today;
      const p = new Problems();
      p.require(isoDate(receivedOn), 'the date received must be a valid date');
      p.require(!isoDate(receivedOn) || receivedOn <= today, 'the date received cannot be in the future');
      p.require(input.lines.length >= 1, 'say what was received');
      p.require(new Set(input.lines.map((l) => l.lineNo)).size === input.lines.length, 'each line can appear only once');
      for (const l of input.lines) p.require(Number.isSafeInteger(l.qtyMilli) && l.qtyMilli > 0, `line ${String(l.lineNo)}: quantity must be more than zero`);
      p.require((input.note?.trim().length ?? 0) <= 300, 'note is too long (300 characters at most)');
      p.throwIfAny();

      const bill = ctx.db.prepare('SELECT status, bill_no FROM purchase_bill WHERE id = ?').get(billId) as { status: PurchaseStatus; bill_no: string } | undefined;
      if (!bill) throw new AppError('NOT_FOUND', 'purchase bill not found');
      if (bill.status !== 'CONFIRMED') throw new AppError('CONFLICT', 'goods can only be received against an entered (confirmed) bill');

      const ins = ctx.db.prepare('INSERT INTO purchase_receipt (bill_id, line_no, qty_milli, received_on, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const l of input.lines) {
        const row = ctx.db
          .prepare(`SELECT l.item_id AS item_id, l.ordered_qty_milli AS invoiced, COALESCE((SELECT SUM(r.qty_milli) FROM purchase_receipt r WHERE r.bill_id = l.bill_id AND r.line_no = l.line_no), 0) AS received
                    FROM purchase_bill_line l WHERE l.bill_id = ? AND l.line_no = ?`)
          .get(billId, l.lineNo) as { item_id: number; invoiced: number; received: number } | undefined;
        if (!row) throw new AppError('NOT_FOUND', `line ${String(l.lineNo)} not found on this bill`);
        if (l.qtyMilli > row.invoiced - row.received) {
          throw new AppError('VALIDATION', `line ${String(l.lineNo)}: only ${String(row.invoiced - row.received)} (in thousandths) is still to be received`, { pendingMilli: row.invoiced - row.received });
        }
        postStockMovement(ctx, { itemId: row.item_id, qtyDeltaMilli: l.qtyMilli, reason: 'PURCHASE', refType: 'purchase_bill', refId: billId, refNo: bill.bill_no, note: clean(input.note) ?? undefined });
        ins.run(billId, l.lineNo, l.qtyMilli, receivedOn, clean(input.note), user.id, ctx.now);
      }
      recordAudit(ctx, { action: 'PURCHASE_RECEIVE', entityType: 'purchase_bill', entityId: billId, detail: { billNo: bill.bill_no, lines: input.lines, receivedOn } });
      return this.loadBill(ctx.db, billId);
    });
  }

  // ------------------------------------------------------------------ cancel
  /**
   * Cancel an entered bill (needs bill.cancel and a reason). The goods received are taken back out of stock (refused if they have already been sold or
   * written off), and the amount comes off what we owe the supplier. Payments made against the bill must be reversed first.
   */
  cancel(token: string, billId: number, reason: string): PurchaseBillDto {
    const user = this.auth.authorize(token, 'bill.cancel');
    const why = reason.trim();
    const p = new Problems();
    p.require(why.length >= 3, 'please give a reason (at least 3 characters)');
    p.require(why.length <= 500, 'the reason is too long (500 characters at most)');
    p.throwIfAny();

    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const bill = ctx.db.prepare('SELECT status, bill_no, supplier_id, total_paise FROM purchase_bill WHERE id = ?').get(billId) as
        | { status: PurchaseStatus; bill_no: string; supplier_id: number; total_paise: number }
        | undefined;
      if (!bill) throw new AppError('NOT_FOUND', 'purchase bill not found');
      if (bill.status !== 'CONFIRMED') throw new AppError('CONFLICT', bill.status === 'DRAFT' ? 'a draft is deleted, not cancelled' : 'this bill is already cancelled');

      const paid = (ctx.db.prepare('SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM supplier_payment WHERE purchase_bill_id = ? AND is_reversed = 0').get(billId) as { paid: number }).paid;
      if (paid > 0) throw new AppError('CONFLICT', 'payments to the supplier are recorded against this bill; reverse them first', { paidPaise: paid });

      const received = ctx.db
        .prepare(`SELECT l.item_id AS item_id, COALESCE(SUM(r.qty_milli), 0) AS qty FROM purchase_bill_line l
                  LEFT JOIN purchase_receipt r ON r.bill_id = l.bill_id AND r.line_no = l.line_no WHERE l.bill_id = ? GROUP BY l.line_no ORDER BY l.line_no`)
        .all(billId) as { item_id: number; qty: number }[];
      try {
        for (const r of received) {
          if (r.qty > 0) postStockMovement(ctx, { itemId: r.item_id, qtyDeltaMilli: -r.qty, reason: 'PURCHASE_CANCEL', refType: 'purchase_bill', refId: billId, refNo: bill.bill_no, note: why });
        }
      } catch (e) {
        if (e instanceof AppError && e.code === 'INSUFFICIENT_STOCK') {
          throw new AppError('CONFLICT', 'some of the goods from this bill have already been sold or written off, so it cannot be cancelled; correct the stock instead', e.details);
        }
        throw e;
      }
      try {
        postSupplierLedger(ctx, { partyId: bill.supplier_id, entryType: 'PURCHASE_CANCEL', amountPaise: -bill.total_paise, refType: 'purchase_bill', refId: billId, refNo: bill.bill_no, note: why });
      } catch (e) {
        if (e instanceof AppError && e.code === 'OVERPAYMENT') {
          throw new AppError('CONFLICT', 'cancelling would leave a credit with this supplier because they have been paid more than the rest of what we owe; reverse the extra payment first', e.details);
        }
        throw e;
      }
      ctx.db.prepare("UPDATE purchase_bill SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(user.id, ctx.now, why, billId);
      recordAudit(ctx, { action: 'PURCHASE_CANCEL', entityType: 'purchase_bill', entityId: billId, reason: why, detail: { billNo: bill.bill_no, totalPaise: bill.total_paise } });
      return this.loadBill(ctx.db, billId);
    });
  }

  // ------------------------------------------------------------------ reading
  get(token: string, billId: number): PurchaseBillDto {
    this.auth.authorizeAny(token, ['purchase.create', 'supplier.view', 'report.view']);
    return this.loadBill(this.db, billId);
  }

  list(token: string, f: PurchaseListFilters = {}): { rows: PurchaseListRow[]; total: number; totalBilledPaise: number; totalOutstandingPaise: number } {
    this.auth.authorizeAny(token, ['purchase.create', 'supplier.view', 'report.view']);
    for (const d of [f.fromDate, f.toDate]) if (d && !isoDate(d)) throw new AppError('VALIDATION', 'dates must be valid (yyyy-mm-dd)');
    if (f.fromDate && f.toDate && f.fromDate > f.toDate) throw new AppError('VALIDATION', 'the start date is after the end date');
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.supplierId !== undefined) { where.push('b.supplier_id = ?'); params.push(f.supplierId); }
    if (f.statuses?.length) { where.push(`b.status IN (${f.statuses.map(() => '?').join(',')})`); params.push(...f.statuses); }
    if (f.fromDate) { where.push('b.bill_date >= ?'); params.push(f.fromDate); }
    if (f.toDate) { where.push('b.bill_date <= ?'); params.push(f.toDate); }
    if (f.search?.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(b.bill_no LIKE ? ESCAPE '\\' OR b.supplier_inv_no LIKE ? ESCAPE '\\' OR b.sup_name LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (f.unpaidOnly) where.push(`b.status = 'CONFIRMED' AND ${PURCHASE_OUTSTANDING_SQL} > 0`);
    if (f.pendingGoodsOnly) where.push(`b.status = 'CONFIRMED' AND ${PENDING_EXISTS_SQL}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS n,
          COALESCE(SUM(CASE WHEN b.status = 'CONFIRMED' THEN b.total_paise ELSE 0 END), 0) AS billed,
          COALESCE(SUM(CASE WHEN b.status = 'CONFIRMED' THEN ${PURCHASE_OUTSTANDING_SQL} ELSE 0 END), 0) AS owed
        FROM purchase_bill b ${whereSql}`)
      .get(...params) as { n: number; billed: number; owed: number };
    const rows = this.db
      .prepare(`SELECT b.id, b.bill_no, b.status, b.bill_date, b.supplier_id, b.sup_name, b.supplier_inv_no, b.total_paise,
          CASE WHEN b.status = 'CONFIRMED' THEN ${PURCHASE_OUTSTANDING_SQL} ELSE NULL END AS outstanding,
          CASE WHEN b.status = 'CONFIRMED' AND ${PENDING_EXISTS_SQL} THEN 1 ELSE 0 END AS pending
        FROM purchase_bill b ${whereSql} ORDER BY b.bill_date DESC, b.id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as {
        id: number; bill_no: string | null; status: PurchaseStatus; bill_date: string; supplier_id: number; sup_name: string; supplier_inv_no: string;
        total_paise: number; outstanding: number | null; pending: number;
      }[];
    return {
      rows: rows.map((r) => ({ id: r.id, billNo: r.bill_no, status: r.status, billDate: r.bill_date, supplierId: r.supplier_id, supplierName: r.sup_name, supplierInvoiceNo: r.supplier_inv_no, totalPaise: r.total_paise, outstandingPaise: r.outstanding, goodsPending: r.pending === 1 })),
      total: agg.n, totalBilledPaise: agg.billed, totalOutstandingPaise: agg.owed,
    };
  }

  // ------------------------------------------------------------------ internals
  private buildDraft(db: Db, input: PurchaseDraftInput, nowIso: string): BuiltDraft {
    const settings = readSettings(db);
    const today = localDateString(new Date(nowIso));
    const billDate = input.billDate ?? today;
    const invNo = input.supplierInvoiceNo.trim();
    const p = new Problems();
    p.require(invNo.length >= 1 && invNo.length <= 40, "the supplier's invoice number is required (40 characters at most)");
    p.require(isoDate(input.supplierInvoiceDate), "the supplier's invoice date must be a valid date");
    p.require(!isoDate(input.supplierInvoiceDate) || input.supplierInvoiceDate <= today, "the supplier's invoice date cannot be in the future");
    p.require(isoDate(billDate), 'the bill date must be a valid date');
    p.require(!isoDate(billDate) || billDate <= today, 'the bill date cannot be in the future');
    for (const [label, v] of [['order date', input.orderDate], ['date of supply', input.supplyDate]] as const) p.require(!v || isoDate(v), `${label} must be a valid date`);
    p.require(input.lines.length >= 1, 'add at least one item');
    p.require(input.lines.length <= 100, 'a bill can have at most 100 lines');
    for (const [i, l] of input.lines.entries()) {
      const n = String(i + 1);
      p.require(Number.isSafeInteger(l.invoicedQtyMilli) && l.invoicedQtyMilli > 0, `line ${n}: the invoiced quantity must be more than zero`);
      if (l.receivedQtyMilli !== undefined) {
        p.require(Number.isSafeInteger(l.receivedQtyMilli) && l.receivedQtyMilli >= 0, `line ${n}: the received quantity cannot be negative`);
        p.require(l.receivedQtyMilli <= l.invoicedQtyMilli, `line ${n}: more was received than was invoiced`);
      }
      if (l.ratePaise !== undefined) p.require(Number.isSafeInteger(l.ratePaise) && l.ratePaise >= 0, `line ${n}: rate cannot be negative`);
      if (l.discountPaise !== undefined) p.require(Number.isSafeInteger(l.discountPaise) && l.discountPaise >= 0, `line ${n}: discount cannot be negative`);
    }
    const dl = input.delivery;
    if (dl) {
      p.require(Number.isSafeInteger(dl.amountPaise) && dl.amountPaise >= 0, 'delivery charge cannot be negative');
      p.require(Number.isSafeInteger(dl.gstRateBp) && dl.gstRateBp >= 0 && dl.gstRateBp <= 10000, 'delivery GST rate must be between 0% and 100%');
    }
    const paid = input.paidPaise ?? 0;
    p.require(Number.isSafeInteger(paid) && paid >= 0, 'amount paid cannot be negative');
    for (const [label, v, max] of [['order number', input.orderNo, 40], ['transport mode', input.transportMode, 40], ['vehicle number', input.vehicleNo, 20], ['place of supply', input.placeOfSupply, 80], ['notes', input.notes, 500]] as const) {
      p.require((v?.trim().length ?? 0) <= max, `${label} is too long (${String(max)} characters at most)`);
    }
    p.throwIfAny();

    assertSupplierUsable(db, input.supplierId);
    const supplier = db.prepare('SELECT name, address, gstin, state FROM supplier WHERE id = ?').get(input.supplierId) as { name: string; address: string | null; gstin: string | null; state: string | null };
    const resolved: ResolvedLine[] = input.lines.map((l, i) => {
      const item = db.prepare(ITEM_SELECT).get(l.itemId) as ItemRow | undefined;
      if (!item) throw new AppError('NOT_FOUND', `line ${String(i + 1)}: item not found`);
      if (item.is_active !== 1) throw new AppError('VALIDATION', `line ${String(i + 1)}: item ${item.code} is inactive and cannot be bought`);
      return {
        item, invoicedQtyMilli: l.invoicedQtyMilli, receivedQtyMilli: l.receivedQtyMilli ?? l.invoicedQtyMilli,
        ratePaise: l.ratePaise ?? item.purchase_rate_paise, discountPaise: l.discountPaise ?? 0,
      };
    });
    const taxType = settings.businessState && supplier.state ? taxTypeForSupply(settings.businessState, supplier.state) : 'INTRA';
    const totals = priceBill(resolved, taxType, dl, settings);
    if (paid > totals.totalPaise) throw new AppError('VALIDATION', 'the amount paid is more than the bill total');
    const method = paid > 0 ? this.checkMethod(settings, input.paymentMethod) : null;

    const cols = {
      bill_date: billDate, supplier_id: input.supplierId, supplier_inv_no: invNo, supplier_inv_date: input.supplierInvoiceDate,
      sup_name: supplier.name, sup_address: supplier.address, sup_gstin: supplier.gstin, sup_state: supplier.state,
      order_no: clean(input.orderNo), order_date: clean(input.orderDate), transport_mode: clean(input.transportMode), vehicle_no: clean(input.vehicleNo),
      supply_date: clean(input.supplyDate), place_of_supply: clean(input.placeOfSupply), tax_type: taxType,
      taxable_paise: totals.taxableTotalPaise, cgst_paise: totals.cgstPaise, sgst_paise: totals.sgstPaise, igst_paise: totals.igstPaise,
      delivery_paise: dl?.amountPaise ?? 0, delivery_gst_rate_bp: dl?.gstRateBp ?? 0, delivery_tax_paise: totals.delivery ? totals.delivery.cgstPaise + totals.delivery.sgstPaise + totals.delivery.igstPaise : 0,
      round_off_paise: totals.roundOffPaise, total_paise: totals.totalPaise, paid_paise: paid, payment_method: method, notes: clean(input.notes),
    };
    return { resolved, totals, taxType, cols };
  }

  private checkMethod(settings: AppSettings, method: string | undefined): string {
    if (!method?.trim()) throw new AppError('VALIDATION', 'choose how the payment was made');
    const canonical = settings.paymentMethods.find((m) => m.toLowerCase() === method.trim().toLowerCase());
    if (!canonical) throw new AppError('VALIDATION', `"${method}" is not one of the payment methods in Settings`);
    return canonical;
  }

  private insertLines(db: Db, billId: number, lines: ResolvedLine[], totals: BillTotals): void {
    const ins = db.prepare(
      `INSERT INTO purchase_bill_line (bill_id, line_no, item_id, description, hsn, ordered_qty_milli, received_qty_milli, uom_label, rate_paise, discount_paise,
         taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, igst_paise, total_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, i) => {
      const t = totals.lines[i];
      if (!t) throw new AppError('INVARIANT', 'line totals missing');
      ins.run(billId, i + 1, l.item.id, l.item.name, l.item.hsn, l.invoicedQtyMilli, l.receivedQtyMilli, uomLabel(l.item.unit, l.item.pack_size), l.ratePaise, l.discountPaise,
        t.taxablePaise, t.gstRateBp, t.cgstPaise, t.sgstPaise, t.igstPaise, t.totalPaise);
    });
  }

  /** Bring each item's purchase rate in line with this bill (last line for an item wins). Audited as a price change. */
  private updateItemRates(ctx: TxContext, lines: ResolvedLine[], billNo: string, userId: number): void {
    requireActor(ctx, 'updateItemRates');
    const done = new Set<number>();
    for (const l of [...lines].reverse()) {
      if (done.has(l.item.id)) continue;
      done.add(l.item.id);
      if (l.ratePaise === l.item.purchase_rate_paise) continue;
      ctx.db.prepare('UPDATE item SET purchase_rate_paise = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(l.ratePaise, userId, ctx.now, l.item.id);
      recordAudit(ctx, {
        action: 'PRICE_CHANGE', entityType: 'item', entityId: l.item.id,
        detail: { code: l.item.code, via: `purchase ${billNo}`, changes: { purchaseRatePaise: { from: l.item.purchase_rate_paise, to: l.ratePaise } } },
      });
    }
  }

  private lineDtoFromComputed(l: ResolvedLine, totals: BillTotals, i: number): PurchaseLineDto {
    const t = totals.lines[i];
    if (!t) throw new AppError('INVARIANT', 'line totals missing');
    return {
      lineNo: i + 1, itemId: l.item.id, description: l.item.name, hsn: l.item.hsn, uomLabel: uomLabel(l.item.unit, l.item.pack_size),
      invoicedQtyMilli: l.invoicedQtyMilli, receivedQtyMilli: l.receivedQtyMilli, pendingQtyMilli: l.invoicedQtyMilli - l.receivedQtyMilli,
      ratePaise: l.ratePaise, discountPaise: l.discountPaise, taxablePaise: t.taxablePaise, gstRateBp: t.gstRateBp, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise,
      igstPaise: t.igstPaise, totalPaise: t.totalPaise,
    };
  }

  private loadBill(db: Db, billId: number): PurchaseBillDto {
    const b = db.prepare(`${BILL_SELECT} WHERE b.id = ?`).get(billId) as BillRow | undefined;
    if (!b) throw new AppError('NOT_FOUND', 'purchase bill not found');
    const lines = db
      .prepare('SELECT line_no, item_id, description, hsn, uom_label, ordered_qty_milli, received_qty_milli, rate_paise, discount_paise, taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, igst_paise, total_paise FROM purchase_bill_line WHERE bill_id = ? ORDER BY line_no')
      .all(billId) as {
        line_no: number; item_id: number; description: string; hsn: string | null; uom_label: string; ordered_qty_milli: number; received_qty_milli: number; rate_paise: number;
        discount_paise: number; taxable_paise: number; gst_rate_bp: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number;
      }[];
    const receipts = db
      .prepare('SELECT r.line_no, r.qty_milli, r.received_on, r.note, u.display_name AS user_name FROM purchase_receipt r JOIN user u ON u.id = r.user_id WHERE r.bill_id = ? ORDER BY r.id')
      .all(billId) as { line_no: number; qty_milli: number; received_on: string; note: string | null; user_name: string }[];
    const receivedByLine = new Map<number, number>();
    for (const r of receipts) receivedByLine.set(r.line_no, (receivedByLine.get(r.line_no) ?? 0) + r.qty_milli);
    const payments = db
      .prepare('SELECT receipt_no, paid_on, method, amount_paise, is_reversed FROM supplier_payment WHERE purchase_bill_id = ? ORDER BY id')
      .all(billId) as { receipt_no: string; paid_on: string; method: string; amount_paise: number; is_reversed: number }[];
    const live = payments.filter((x) => x.is_reversed === 0).reduce((s, x) => s + x.amount_paise, 0);
    const confirmed = b.status === 'CONFIRMED';
    const lineDtos: PurchaseLineDto[] = lines.map((l) => {
      const received = b.status === 'DRAFT' ? l.received_qty_milli : (receivedByLine.get(l.line_no) ?? 0);
      return {
        lineNo: l.line_no, itemId: l.item_id, description: l.description, hsn: l.hsn, uomLabel: l.uom_label, invoicedQtyMilli: l.ordered_qty_milli,
        receivedQtyMilli: received, pendingQtyMilli: b.status === 'CANCELLED' ? 0 : l.ordered_qty_milli - received, ratePaise: l.rate_paise, discountPaise: l.discount_paise,
        taxablePaise: l.taxable_paise, gstRateBp: l.gst_rate_bp, cgstPaise: l.cgst_paise, sgstPaise: l.sgst_paise, igstPaise: l.igst_paise, totalPaise: l.total_paise,
      };
    });
    const outstanding = confirmed ? b.total_paise - live : null;
    return {
      id: b.id, billNo: b.bill_no, status: b.status, fy: b.fy, billDate: b.bill_date, supplierInvoiceNo: b.supplier_inv_no, supplierInvoiceDate: b.supplier_inv_date,
      orderNo: b.order_no, orderDate: b.order_date, transportMode: b.transport_mode, vehicleNo: b.vehicle_no, supplyDate: b.supply_date, placeOfSupply: b.place_of_supply,
      supplier: { id: b.supplier_id, name: b.sup_name, address: b.sup_address, gstin: b.sup_gstin, gstinDisplay: b.sup_gstin ?? 'UN-REGD', state: b.sup_state },
      taxType: b.tax_type, lines: lineDtos,
      totals: {
        goodsTaxablePaise: b.taxable_paise - b.delivery_paise, taxableTotalPaise: b.taxable_paise, cgstPaise: b.cgst_paise, sgstPaise: b.sgst_paise, igstPaise: b.igst_paise,
        totalTaxPaise: b.cgst_paise + b.sgst_paise + b.igst_paise, deliveryPaise: b.delivery_paise, deliveryGstRateBp: b.delivery_gst_rate_bp,
        deliveryTaxPaise: b.delivery_tax_paise, roundOffPaise: b.round_off_paise, totalPaise: b.total_paise, amountInWords: amountInWords(b.total_paise),
      },
      paidAtEntryPaise: b.paid_paise, paidPaise: confirmed ? live : null, outstandingPaise: outstanding,
      paymentStatus: outstanding === null ? null : outstanding <= 0 ? 'PAID' : live > 0 ? 'PARTIAL' : 'UNPAID',
      goodsPending: confirmed && lineDtos.some((l) => l.pendingQtyMilli > 0),
      receipts: receipts.map((r) => ({ lineNo: r.line_no, qtyMilli: r.qty_milli, receivedOn: r.received_on, note: r.note, userName: r.user_name })),
      payments: payments.map((x) => ({ receiptNo: x.receipt_no, paidOn: x.paid_on, method: x.method, amountPaise: x.amount_paise, reversed: x.is_reversed === 1 })),
      notes: b.notes, createdByName: b.created_by_name, createdAt: b.created_at, confirmedByName: b.confirmed_by_name, confirmedAt: b.confirmed_at,
      cancelledByName: b.cancelled_by_name, cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason,
    };
  }
}
