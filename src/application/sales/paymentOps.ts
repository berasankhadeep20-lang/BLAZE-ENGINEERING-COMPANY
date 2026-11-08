/**
 * Recording a customer payment inside the caller's transaction. Shared by "money taken at the time of sale" and by later payments,
 * so both follow exactly the same rules: a numbered receipt, a ledger entry, and an allocation to the bills it settles (oldest first).
 */
import { financialYear, seriesPrefix } from '../../domain/billNumber';
import { AppError } from '../../shared/errors';
import { allocateNumber } from '../../infrastructure/db/numberSeries';
import { postCustomerLedger } from '../../infrastructure/db/ledgers';
import { requireActor, type TxContext } from '../../infrastructure/db/unitOfWork';
import type { Db } from '../../infrastructure/db/connection';
import type { AppSettings } from '../settings/settingsService';

export interface PaymentTxInput {
  customerId: number;
  amountPaise: number;
  method: string;
  paidOn: string; // local date, yyyy-mm-dd
  reference?: string | null;
  note?: string | null;
  preferBillId?: number | null; // settle this bill first, then the oldest others
}

export interface PaymentTxResult {
  paymentId: number;
  receiptNo: string;
  balanceAfterPaise: number;
  allocations: { billId: number; billNo: string; amountPaise: number }[];
  unallocatedPaise: number;
}

/** Total of a bill minus the allocations of payments that have not been reversed. */
export const OUTSTANDING_SQL = `b.total_paise - COALESCE((
  SELECT SUM(a.amount_paise) FROM payment_allocation a JOIN customer_payment p ON p.id = a.payment_id
  WHERE a.sale_bill_id = b.id AND p.is_reversed = 0), 0)`;

export function billOutstanding(db: Db, billId: number): number {
  const row = db.prepare(`SELECT ${OUTSTANDING_SQL} AS outstanding FROM sale_bill b WHERE b.id = ?`).get(billId) as { outstanding: number } | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'bill not found');
  return row.outstanding;
}

export function recordPaymentTx(ctx: TxContext, settings: AppSettings, input: PaymentTxInput): PaymentTxResult {
  const actor = requireActor(ctx, 'recordPaymentTx');
  const fy = financialYear(input.paidOn);
  const { number: receiptNo } = allocateNumber(ctx, 'RECEIPT', fy, seriesPrefix(settings.receiptPrefix, fy), settings.invoiceNumberWidth);

  const cust = ctx.db.prepare('SELECT balance_paise FROM customer WHERE id = ?').get(input.customerId) as { balance_paise: number } | undefined;
  if (!cust) throw new AppError('NOT_FOUND', 'customer not found');
  const expectedAfter = cust.balance_paise - input.amountPaise;

  const paymentId = Number(
    ctx.db
      .prepare(
        `INSERT INTO customer_payment (receipt_no, customer_id, sale_bill_id, paid_on, amount_paise, method, reference, note, balance_after_paise, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(receiptNo, input.customerId, input.preferBillId ?? null, input.paidOn, input.amountPaise, input.method, input.reference ?? null, input.note ?? null, expectedAfter, actor.userId, ctx.now)
      .lastInsertRowid,
  );
  const posted = postCustomerLedger(ctx, {
    partyId: input.customerId, entryType: 'PAYMENT', amountPaise: -input.amountPaise,
    refType: 'customer_payment', refId: paymentId, refNo: receiptNo, note: input.note ?? undefined,
  });
  if (posted.balanceAfterPaise !== expectedAfter) throw new AppError('INVARIANT', 'payment balance mismatch');

  const bills = ctx.db
    .prepare(
      `SELECT b.id AS id, b.bill_no AS bill_no, ${OUTSTANDING_SQL} AS outstanding FROM sale_bill b
       WHERE b.customer_id = ? AND b.status = 'CONFIRMED'
       ORDER BY CASE WHEN b.id = ? THEN 0 ELSE 1 END, b.invoice_date, b.id`,
    )
    .all(input.customerId, input.preferBillId ?? -1) as { id: number; bill_no: string; outstanding: number }[];

  let remaining = input.amountPaise;
  const allocations: PaymentTxResult['allocations'] = [];
  const ins = ctx.db.prepare('INSERT INTO payment_allocation (payment_id, sale_bill_id, amount_paise) VALUES (?, ?, ?)');
  for (const b of bills) {
    if (remaining <= 0) break;
    if (b.outstanding <= 0) continue;
    const take = Math.min(remaining, b.outstanding);
    ins.run(paymentId, b.id, take);
    allocations.push({ billId: b.id, billNo: b.bill_no, amountPaise: take });
    remaining -= take;
  }
  return { paymentId, receiptNo, balanceAfterPaise: posted.balanceAfterPaise, allocations, unallocatedPaise: remaining };
}
