/**
 * Ledger posting primitives. These are the ONLY code that may change item.qty_milli, customer.balance_paise
 * or supplier.balance_paise: each call updates the cached figure and appends the ledger row in the caller's
 * transaction, so cache == ledger sum always holds (verified by reconcile()).
 * User and timestamp come from the transaction context, never from the caller.
 */
import { AppError } from '../../shared/errors';
import { assertInTransaction, requireActor, type TxContext } from './unitOfWork';

type SignRule = '+' | '-' | 'any';

function checkSign(rule: SignRule, amount: number, label: string): void {
  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw new AppError('VALIDATION', `${label} must be a non-zero whole number`);
  }
  if (rule === '+' && amount < 0) throw new AppError('VALIDATION', `${label} must be positive`);
  if (rule === '-' && amount > 0) throw new AppError('VALIDATION', `${label} must be negative`);
}

// ---------------- stock ----------------
const STOCK_RULES = {
  PURCHASE: '+',
  SALE: '-',
  SALE_CANCEL: '+',
  PURCHASE_CANCEL: '-',
  RETURN: 'any',
  DAMAGED: '-',
  MISSING: '-',
  COUNT_ADJUST: 'any',
  OPENING: '+',
} as const satisfies Record<string, SignRule>;

export type StockReason = keyof typeof STOCK_RULES;
const NOTE_REQUIRED = new Set<StockReason>(['DAMAGED', 'MISSING', 'COUNT_ADJUST']);

export interface StockMovementInput {
  itemId: number;
  qtyDeltaMilli: number;
  reason: StockReason;
  refType?: string;
  refId?: number;
  refNo?: string;
  note?: string;
}

/** Change an item's stock. Throws INSUFFICIENT_STOCK (and writes nothing) if the result would be below zero. */
export function postStockMovement(ctx: TxContext, m: StockMovementInput): { qtyAfterMilli: number } {
  assertInTransaction(ctx, 'postStockMovement');
  const actor = requireActor(ctx, 'postStockMovement');
  checkSign(STOCK_RULES[m.reason], m.qtyDeltaMilli, 'stock change');
  if (NOTE_REQUIRED.has(m.reason) && !m.note?.trim()) {
    throw new AppError('VALIDATION', 'a reason note is required for stock corrections');
  }

  const item = ctx.db.prepare('SELECT code, qty_milli FROM item WHERE id = ?').get(m.itemId) as
    | { code: string; qty_milli: number }
    | undefined;
  if (!item) throw new AppError('NOT_FOUND', `item ${String(m.itemId)} not found`);

  const after = item.qty_milli + m.qtyDeltaMilli;
  if (after < 0) {
    throw new AppError('INSUFFICIENT_STOCK', `not enough stock for item ${item.code}`, {
      itemCode: item.code,
      availableMilli: item.qty_milli,
      requestedMilli: -m.qtyDeltaMilli,
    });
  }

  ctx.db.prepare('UPDATE item SET qty_milli = ? WHERE id = ?').run(after, m.itemId);
  ctx.db
    .prepare(
      `INSERT INTO stock_movement (at, item_id, qty_delta_milli, reason, ref_type, ref_id, ref_no, note, qty_after_milli, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.now, m.itemId, m.qtyDeltaMilli, m.reason, m.refType ?? null, m.refId ?? null, m.refNo ?? null, m.note ?? null, after, actor.userId);
  return { qtyAfterMilli: after };
}

// ---------------- customer dues ----------------
const CUSTOMER_RULES = {
  SALE: '+', // dues increase by the bill total
  PAYMENT: '-',
  SALE_CANCEL: '-',
  PAYMENT_REVERSAL: '+',
  ADJUSTMENT: 'any',
  OPENING: 'any',
} as const satisfies Record<string, SignRule>;

export type CustomerEntryType = keyof typeof CUSTOMER_RULES;

export interface PartyLedgerInput<T extends string> {
  partyId: number;
  entryType: T;
  amountPaise: number; // + increases what is owed, - reduces it
  refType?: string;
  refId?: number;
  refNo?: string;
  note?: string;
}

/** Post to a customer's account. Throws OVERPAYMENT if the balance would go below zero and advances are not allowed. */
export function postCustomerLedger(ctx: TxContext, e: PartyLedgerInput<CustomerEntryType>): { balanceAfterPaise: number } {
  assertInTransaction(ctx, 'postCustomerLedger');
  const actor = requireActor(ctx, 'postCustomerLedger');
  checkSign(CUSTOMER_RULES[e.entryType], e.amountPaise, 'ledger amount');

  const c = ctx.db.prepare('SELECT name, balance_paise, advance_allowed FROM customer WHERE id = ?').get(e.partyId) as
    | { name: string; balance_paise: number; advance_allowed: number }
    | undefined;
  if (!c) throw new AppError('NOT_FOUND', `customer ${String(e.partyId)} not found`);

  const after = c.balance_paise + e.amountPaise;
  if (after < 0 && c.advance_allowed !== 1) {
    throw new AppError('OVERPAYMENT', 'payment is more than the amount due', {
      balancePaise: c.balance_paise,
      attemptedPaise: -e.amountPaise,
    });
  }

  ctx.db.prepare('UPDATE customer SET balance_paise = ? WHERE id = ?').run(after, e.partyId);
  ctx.db
    .prepare(
      `INSERT INTO customer_ledger (at, customer_id, entry_type, amount_paise, balance_after_paise, ref_type, ref_id, ref_no, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.now, e.partyId, e.entryType, e.amountPaise, after, e.refType ?? null, e.refId ?? null, e.refNo ?? null, e.note ?? null, actor.userId);
  return { balanceAfterPaise: after };
}

// ---------------- supplier dues (kept separate from customer receivables) ----------------
const SUPPLIER_RULES = {
  PURCHASE: '+', // what we owe increases
  PAYMENT: '-',
  PURCHASE_CANCEL: '-',
  PAYMENT_REVERSAL: '+',
  ADJUSTMENT: 'any',
  OPENING: 'any',
} as const satisfies Record<string, SignRule>;

export type SupplierEntryType = keyof typeof SUPPLIER_RULES;

/** Post to a supplier's account. Paying a supplier more than we owe is refused (OVERPAYMENT). */
export function postSupplierLedger(ctx: TxContext, e: PartyLedgerInput<SupplierEntryType>): { balanceAfterPaise: number } {
  assertInTransaction(ctx, 'postSupplierLedger');
  const actor = requireActor(ctx, 'postSupplierLedger');
  checkSign(SUPPLIER_RULES[e.entryType], e.amountPaise, 'ledger amount');

  const s = ctx.db.prepare('SELECT balance_paise FROM supplier WHERE id = ?').get(e.partyId) as { balance_paise: number } | undefined;
  if (!s) throw new AppError('NOT_FOUND', `supplier ${String(e.partyId)} not found`);

  const after = s.balance_paise + e.amountPaise;
  if (after < 0) {
    throw new AppError('OVERPAYMENT', 'payment is more than we owe this supplier', {
      balancePaise: s.balance_paise,
      attemptedPaise: -e.amountPaise,
    });
  }

  ctx.db.prepare('UPDATE supplier SET balance_paise = ? WHERE id = ?').run(after, e.partyId);
  ctx.db
    .prepare(
      `INSERT INTO supplier_ledger (at, supplier_id, entry_type, amount_paise, balance_after_paise, ref_type, ref_id, ref_no, note, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.now, e.partyId, e.entryType, e.amountPaise, after, e.refType ?? null, e.refId ?? null, e.refNo ?? null, e.note ?? null, actor.userId);
  return { balanceAfterPaise: after };
}
