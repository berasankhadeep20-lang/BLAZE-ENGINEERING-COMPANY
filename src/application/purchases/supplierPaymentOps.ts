/**
 * Recording a payment MADE TO a supplier, inside the caller's transaction. Shared by "paid at the time of entering the purchase" and by later
 * payments. Kept entirely separate from customer receivables: its own ledger, its own numbers (default prefix SP).
 */
import { financialYear, seriesPrefix } from '../../domain/billNumber';
import { AppError } from '../../shared/errors';
import { allocateNumber } from '../../infrastructure/db/numberSeries';
import { postSupplierLedger } from '../../infrastructure/db/ledgers';
import { requireActor, type TxContext } from '../../infrastructure/db/unitOfWork';
import type { Db } from '../../infrastructure/db/connection';
import type { AppSettings } from '../settings/settingsService';

export interface SupplierPaymentTxInput {
  supplierId: number;
  amountPaise: number;
  method: string;
  paidOn: string; // local date
  reference?: string | null;
  note?: string | null;
  purchaseBillId?: number | null; // the bill this payment is for, if named
}

export interface SupplierPaymentTxResult {
  paymentId: number;
  receiptNo: string;
  balanceAfterPaise: number; // what we still owe the supplier after this payment
}

/** A purchase bill's total minus the payments made against it that have not been reversed. */
export const PURCHASE_OUTSTANDING_SQL = `b.total_paise - COALESCE((
  SELECT SUM(p.amount_paise) FROM supplier_payment p WHERE p.purchase_bill_id = b.id AND p.is_reversed = 0), 0)`;

export function purchaseOutstanding(db: Db, billId: number): number {
  const row = db.prepare(`SELECT ${PURCHASE_OUTSTANDING_SQL} AS outstanding FROM purchase_bill b WHERE b.id = ?`).get(billId) as { outstanding: number } | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'purchase bill not found');
  return row.outstanding;
}

export function recordSupplierPaymentTx(ctx: TxContext, settings: AppSettings, input: SupplierPaymentTxInput): SupplierPaymentTxResult {
  const actor = requireActor(ctx, 'recordSupplierPaymentTx');
  const fy = financialYear(input.paidOn);
  const { number: receiptNo } = allocateNumber(ctx, 'SUPPLIER_RECEIPT', fy, seriesPrefix(settings.supplierReceiptPrefix, fy), settings.invoiceNumberWidth);

  const sup = ctx.db.prepare('SELECT balance_paise FROM supplier WHERE id = ?').get(input.supplierId) as { balance_paise: number } | undefined;
  if (!sup) throw new AppError('NOT_FOUND', 'supplier not found');
  const expectedAfter = sup.balance_paise - input.amountPaise;

  const paymentId = Number(
    ctx.db
      .prepare(
        `INSERT INTO supplier_payment (receipt_no, supplier_id, purchase_bill_id, paid_on, amount_paise, method, reference, note, balance_after_paise, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(receiptNo, input.supplierId, input.purchaseBillId ?? null, input.paidOn, input.amountPaise, input.method, input.reference ?? null, input.note ?? null, expectedAfter, actor.userId, ctx.now)
      .lastInsertRowid,
  );
  const posted = postSupplierLedger(ctx, {
    partyId: input.supplierId, entryType: 'PAYMENT', amountPaise: -input.amountPaise,
    refType: 'supplier_payment', refId: paymentId, refNo: receiptNo, note: input.note ?? undefined,
  });
  if (posted.balanceAfterPaise !== expectedAfter) throw new AppError('INVARIANT', 'supplier payment balance mismatch');
  return { paymentId, receiptNo, balanceAfterPaise: posted.balanceAfterPaise };
}
