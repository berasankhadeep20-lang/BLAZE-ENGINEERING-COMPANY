import { localDateString, systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postCustomerLedger } from '../../infrastructure/db/ledgers';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import { assertCustomerUsable } from '../parties/customerService';
import { readSettings } from '../settings/settingsService';
import { OUTSTANDING_SQL, recordPaymentTx, type PaymentTxResult } from './paymentOps';

export interface PaymentInput {
  customerId: number;
  amountPaise: number;
  method: string;
  paidOn?: string; // local date; defaults to today
  reference?: string; // cheque number, UPI reference...
  note?: string;
  saleBillId?: number; // settle this bill first; the rest goes to the oldest unpaid bills
}

export interface PaymentDto {
  id: number;
  receiptNo: string;
  customerId: number;
  customerName: string;
  paidOn: string;
  amountPaise: number;
  method: string;
  reference: string | null;
  note: string | null;
  balanceAfterPaise: number; // the customer's balance right after this payment
  reversed: boolean;
  reversalReason: string | null;
  createdByName: string;
  createdAt: string;
  allocations: { billNo: string; amountPaise: number }[];
}

export interface PaymentFilters {
  customerId?: number;
  fromDate?: string;
  toDate?: string;
  includeReversed?: boolean; // default true
  search?: string; // receipt number or reference
  limit?: number;
  offset?: number;
}

const isoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export class PaymentService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  /**
   * Record money received from a customer (full or partial). Gives a numbered receipt, reduces the customer's balance, and settles their
   * oldest unpaid bills first (or the bill named). A payment that is more than the customer owes is refused unless the owner has allowed
   * advances for that customer.
   */
  record(token: string, input: PaymentInput): PaymentTxResult {
    const user = this.auth.authorize(token, 'payment.record');
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

      assertCustomerUsable(ctx.db, input.customerId, 'DRAFT');
      if (input.saleBillId !== undefined) {
        const b = ctx.db.prepare(`SELECT b.customer_id AS customer_id, b.status AS status, ${OUTSTANDING_SQL} AS outstanding FROM sale_bill b WHERE b.id = ?`).get(input.saleBillId) as
          | { customer_id: number; status: string; outstanding: number }
          | undefined;
        if (!b || b.customer_id !== input.customerId) throw new AppError('NOT_FOUND', "that bill was not found for this customer");
        if (b.status !== 'CONFIRMED') throw new AppError('VALIDATION', 'only a confirmed bill can be settled');
        if (b.outstanding <= 0) throw new AppError('VALIDATION', 'that bill is already fully paid');
      }
      const result = recordPaymentTx(ctx, settings, {
        customerId: input.customerId, amountPaise: input.amountPaise, method: method ?? input.method, paidOn,
        reference: input.reference?.trim() || null, note: input.note?.trim() || null, preferBillId: input.saleBillId ?? null,
      });
      recordAudit(ctx, {
        action: 'PAYMENT_ADD', entityType: 'customer_payment', entityId: result.paymentId,
        detail: { receiptNo: result.receiptNo, customerId: input.customerId, amountPaise: input.amountPaise, method, balanceAfterPaise: result.balanceAfterPaise, allocations: result.allocations },
      });
      return result;
    });
  }

  /** Undo a payment (a bounced cheque, a refund). The reason is mandatory; the payment stays on record, marked reversed, and the dues come back. */
  reverse(token: string, paymentId: number, reason: string): void {
    const user = this.auth.authorize(token, 'payment.reverse');
    const why = reason.trim();
    const p = new Problems();
    p.require(why.length >= 3, 'please give a reason (at least 3 characters)');
    p.require(why.length <= 300, 'the reason is too long (300 characters at most)');
    p.throwIfAny();
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const pay = ctx.db.prepare('SELECT receipt_no, customer_id, amount_paise, is_reversed FROM customer_payment WHERE id = ?').get(paymentId) as
        | { receipt_no: string; customer_id: number; amount_paise: number; is_reversed: number }
        | undefined;
      if (!pay) throw new AppError('NOT_FOUND', 'payment not found');
      if (pay.is_reversed === 1) throw new AppError('CONFLICT', 'this payment is already reversed');
      ctx.db.prepare('UPDATE customer_payment SET is_reversed = 1, reversal_reason = ? WHERE id = ?').run(why, paymentId);
      postCustomerLedger(ctx, { partyId: pay.customer_id, entryType: 'PAYMENT_REVERSAL', amountPaise: pay.amount_paise, refType: 'customer_payment', refId: paymentId, refNo: pay.receipt_no, note: why });
      recordAudit(ctx, { action: 'PAYMENT_REVERSE', entityType: 'customer_payment', entityId: paymentId, reason: why, detail: { receiptNo: pay.receipt_no, amountPaise: pay.amount_paise } });
    });
  }

  /**
   * Owner-only switch that lets a customer pay more than they owe (an advance, shown as a negative balance). Without it, an overpayment is refused.
   * It cannot be switched off while the customer holds a credit.
   */
  setAdvanceAllowed(token: string, customerId: number, allowed: boolean): void {
    const user = this.auth.authorize(token, 'customer.approve'); // owner only
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const c = ctx.db.prepare('SELECT name, balance_paise, advance_allowed FROM customer WHERE id = ?').get(customerId) as { name: string; balance_paise: number; advance_allowed: number } | undefined;
      if (!c) throw new AppError('NOT_FOUND', 'customer not found');
      if ((c.advance_allowed === 1) === allowed) return;
      if (!allowed && c.balance_paise < 0) throw new AppError('CONFLICT', 'this customer holds an advance; settle it before switching advances off');
      ctx.db.prepare('UPDATE customer SET advance_allowed = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(allowed ? 1 : 0, user.id, ctx.now, customerId);
      recordAudit(ctx, { action: 'CUSTOMER_UPDATE', entityType: 'customer', entityId: customerId, detail: { name: c.name, changes: { advanceAllowed: { from: c.advance_allowed === 1, to: allowed } } } });
    });
  }

  list(token: string, f: PaymentFilters = {}): { rows: PaymentDto[]; total: number } {
    this.auth.authorizeAny(token, ['payment.record', 'customer.view', 'report.view']);
    for (const d of [f.fromDate, f.toDate]) if (d && !isoDate(d)) throw new AppError('VALIDATION', 'dates must be valid (yyyy-mm-dd)');
    if (f.fromDate && f.toDate && f.fromDate > f.toDate) throw new AppError('VALIDATION', 'the start date is after the end date');
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.customerId !== undefined) { where.push('p.customer_id = ?'); params.push(f.customerId); }
    if (f.fromDate) { where.push('p.paid_on >= ?'); params.push(f.fromDate); }
    if (f.toDate) { where.push('p.paid_on <= ?'); params.push(f.toDate); }
    if (f.includeReversed === false) where.push('p.is_reversed = 0');
    if (f.search?.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push("(p.receipt_no LIKE ? ESCAPE '\\' OR p.reference LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM customer_payment p ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT p.id, p.receipt_no, p.customer_id, c.name AS customer_name, p.paid_on, p.amount_paise, p.method, p.reference, p.note, p.balance_after_paise,
          p.is_reversed, p.reversal_reason, u.display_name AS user_name, p.created_at
        FROM customer_payment p JOIN customer c ON c.id = p.customer_id JOIN user u ON u.id = p.created_by ${whereSql} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as {
        id: number; receipt_no: string; customer_id: number; customer_name: string; paid_on: string; amount_paise: number; method: string; reference: string | null;
        note: string | null; balance_after_paise: number; is_reversed: number; reversal_reason: string | null; user_name: string; created_at: string;
      }[];
    const allocStmt = this.db.prepare('SELECT b.bill_no AS bill_no, a.amount_paise AS amount FROM payment_allocation a JOIN sale_bill b ON b.id = a.sale_bill_id WHERE a.payment_id = ? ORDER BY a.id');
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id, receiptNo: r.receipt_no, customerId: r.customer_id, customerName: r.customer_name, paidOn: r.paid_on, amountPaise: r.amount_paise, method: r.method,
        reference: r.reference, note: r.note, balanceAfterPaise: r.balance_after_paise, reversed: r.is_reversed === 1, reversalReason: r.reversal_reason,
        createdByName: r.user_name, createdAt: r.created_at,
        allocations: (allocStmt.all(r.id) as { bill_no: string; amount: number }[]).map((a) => ({ billNo: a.bill_no, amountPaise: a.amount })),
      })),
    };
  }
}

