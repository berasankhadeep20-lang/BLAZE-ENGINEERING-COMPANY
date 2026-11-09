import { localDateString, systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postSupplierLedger } from '../../infrastructure/db/ledgers';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import { isoDate } from '../common';
import { assertSupplierUsable } from '../parties/supplierService';
import { readSettings } from '../settings/settingsService';
import { PURCHASE_OUTSTANDING_SQL, recordSupplierPaymentTx, type SupplierPaymentTxResult } from './supplierPaymentOps';

export interface SupplierPaymentInput {
  supplierId: number;
  amountPaise: number;
  method: string;
  paidOn?: string; // local date; defaults to today
  reference?: string;
  note?: string;
  purchaseBillId?: number; // the purchase bill this payment is for (it may not exceed that bill's unpaid amount)
}

export interface SupplierPaymentDto {
  id: number;
  receiptNo: string;
  supplierId: number;
  supplierName: string;
  purchaseBillNo: string | null;
  paidOn: string;
  amountPaise: number;
  method: string;
  reference: string | null;
  note: string | null;
  balanceAfterPaise: number; // what we owed the supplier right after this payment
  reversed: boolean;
  reversalReason: string | null;
  createdByName: string;
  createdAt: string;
}

export interface SupplierPaymentFilters {
  supplierId?: number;
  fromDate?: string;
  toDate?: string;
  includeReversed?: boolean; // default true
  search?: string; // number or reference
  limit?: number;
  offset?: number;
}

export class SupplierPaymentService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  /** Record money paid to a supplier. Paying more than we owe is refused. Needs supplier.pay. */
  record(token: string, input: SupplierPaymentInput): SupplierPaymentTxResult {
    const user = this.auth.authorize(token, 'supplier.pay');
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const settings = readSettings(ctx.db);
      const today = localDateString(new Date(ctx.now));
      const paidOn = input.paidOn ?? today;
      const p = new Problems();
      p.require(Number.isSafeInteger(input.amountPaise) && input.amountPaise > 0, 'the amount must be more than zero');
      p.require(isoDate(paidOn), 'payment date must be a valid date');
      p.require(!isoDate(paidOn) || paidOn <= today, 'payment date cannot be in the future');
      p.require((input.reference?.trim().length ?? 0) <= 60, 'reference is too long (60 characters at most)');
      p.require((input.note?.trim().length ?? 0) <= 300, 'note is too long (300 characters at most)');
      const method = settings.paymentMethods.find((m) => m.toLowerCase() === input.method.trim().toLowerCase());
      p.require(!!method, `"${input.method}" is not one of the payment methods in Settings`);
      p.throwIfAny();

      assertSupplierUsable(ctx.db, input.supplierId);
      if (input.purchaseBillId !== undefined) {
        const b = ctx.db.prepare(`SELECT b.supplier_id AS supplier_id, b.status AS status, ${PURCHASE_OUTSTANDING_SQL} AS outstanding FROM purchase_bill b WHERE b.id = ?`).get(input.purchaseBillId) as
          | { supplier_id: number; status: string; outstanding: number }
          | undefined;
        if (!b || b.supplier_id !== input.supplierId) throw new AppError('NOT_FOUND', 'that purchase bill was not found for this supplier');
        if (b.status !== 'CONFIRMED') throw new AppError('VALIDATION', 'only a confirmed purchase bill can be paid');
        if (input.amountPaise > b.outstanding) throw new AppError('VALIDATION', 'the amount is more than the unpaid amount of that bill', { outstandingPaise: b.outstanding });
      }
      const result = recordSupplierPaymentTx(ctx, settings, {
        supplierId: input.supplierId, amountPaise: input.amountPaise, method: method ?? input.method, paidOn,
        reference: input.reference?.trim() || null, note: input.note?.trim() || null, purchaseBillId: input.purchaseBillId ?? null,
      });
      recordAudit(ctx, {
        action: 'SUPPLIER_PAYMENT_ADD', entityType: 'supplier_payment', entityId: result.paymentId,
        detail: { receiptNo: result.receiptNo, supplierId: input.supplierId, amountPaise: input.amountPaise, method, balanceAfterPaise: result.balanceAfterPaise, purchaseBillId: input.purchaseBillId ?? null },
      });
      return result;
    });
  }

  /** Undo a payment to a supplier (needs payment.reverse and a reason). The record stays, marked reversed, and the amount owed comes back. */
  reverse(token: string, paymentId: number, reason: string): void {
    const user = this.auth.authorize(token, 'payment.reverse');
    const why = reason.trim();
    const p = new Problems();
    p.require(why.length >= 3, 'please give a reason (at least 3 characters)');
    p.require(why.length <= 300, 'the reason is too long (300 characters at most)');
    p.throwIfAny();
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const pay = ctx.db.prepare('SELECT receipt_no, supplier_id, amount_paise, is_reversed FROM supplier_payment WHERE id = ?').get(paymentId) as
        | { receipt_no: string; supplier_id: number; amount_paise: number; is_reversed: number }
        | undefined;
      if (!pay) throw new AppError('NOT_FOUND', 'payment not found');
      if (pay.is_reversed === 1) throw new AppError('CONFLICT', 'this payment is already reversed');
      ctx.db.prepare('UPDATE supplier_payment SET is_reversed = 1, reversal_reason = ? WHERE id = ?').run(why, paymentId);
      postSupplierLedger(ctx, { partyId: pay.supplier_id, entryType: 'PAYMENT_REVERSAL', amountPaise: pay.amount_paise, refType: 'supplier_payment', refId: paymentId, refNo: pay.receipt_no, note: why });
      recordAudit(ctx, { action: 'SUPPLIER_PAYMENT_REVERSE', entityType: 'supplier_payment', entityId: paymentId, reason: why, detail: { receiptNo: pay.receipt_no, amountPaise: pay.amount_paise } });
    });
  }

  list(token: string, f: SupplierPaymentFilters = {}): { rows: SupplierPaymentDto[]; total: number } {
    this.auth.authorizeAny(token, ['supplier.pay', 'supplier.view', 'report.view']);
    for (const d of [f.fromDate, f.toDate]) if (d && !isoDate(d)) throw new AppError('VALIDATION', 'dates must be valid (yyyy-mm-dd)');
    if (f.fromDate && f.toDate && f.fromDate > f.toDate) throw new AppError('VALIDATION', 'the start date is after the end date');
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.supplierId !== undefined) { where.push('p.supplier_id = ?'); params.push(f.supplierId); }
    if (f.fromDate) { where.push('p.paid_on >= ?'); params.push(f.fromDate); }
    if (f.toDate) { where.push('p.paid_on <= ?'); params.push(f.toDate); }
    if (f.includeReversed === false) where.push('p.is_reversed = 0');
    if (f.search?.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(p.receipt_no LIKE ? ESCAPE '\\' OR p.reference LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM supplier_payment p ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT p.id, p.receipt_no, p.supplier_id, s.name AS supplier_name, b.bill_no AS bill_no, p.paid_on, p.amount_paise, p.method, p.reference, p.note,
          p.balance_after_paise, p.is_reversed, p.reversal_reason, u.display_name AS user_name, p.created_at
        FROM supplier_payment p JOIN supplier s ON s.id = p.supplier_id JOIN user u ON u.id = p.created_by LEFT JOIN purchase_bill b ON b.id = p.purchase_bill_id
        ${whereSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as {
        id: number; receipt_no: string; supplier_id: number; supplier_name: string; bill_no: string | null; paid_on: string; amount_paise: number; method: string;
        reference: string | null; note: string | null; balance_after_paise: number; is_reversed: number; reversal_reason: string | null; user_name: string; created_at: string;
      }[];
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id, receiptNo: r.receipt_no, supplierId: r.supplier_id, supplierName: r.supplier_name, purchaseBillNo: r.bill_no, paidOn: r.paid_on, amountPaise: r.amount_paise,
        method: r.method, reference: r.reference, note: r.note, balanceAfterPaise: r.balance_after_paise, reversed: r.is_reversed === 1, reversalReason: r.reversal_reason,
        createdByName: r.user_name, createdAt: r.created_at,
      })),
    };
  }
}
