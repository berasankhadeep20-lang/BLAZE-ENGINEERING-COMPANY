import { localDayRangeToUtc } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import type { Db } from '../../infrastructure/db/connection';

export interface StatementEntry {
  id: number;
  at: string; // UTC ISO
  entryType: string;
  label: string;
  refNo: string | null;
  note: string | null;
  amountPaise: number; // + increases the balance, - reduces it
  balanceAfterPaise: number;
  userName: string;
}

export interface Statement {
  openingPaise: number;
  entries: StatementEntry[];
  closingPaise: number;
  increasesPaise: number; // sum of positive entries in the range
  reducesPaise: number; // sum of negative entries, as a positive number
}

const LABELS: Record<string, string> = {
  SALE: 'Sale', PURCHASE: 'Purchase', PAYMENT: 'Payment', SALE_CANCEL: 'Sale cancelled', PURCHASE_CANCEL: 'Purchase cancelled',
  PAYMENT_REVERSAL: 'Payment reversed', ADJUSTMENT: 'Adjustment', OPENING: 'Opening balance',
};

export type LedgerKind = 'customer' | 'supplier';

// Table and column names come from this fixed map, never from user input.
const LEDGERS: Record<LedgerKind, { table: string; col: string }> = {
  customer: { table: 'customer_ledger', col: 'customer_id' },
  supplier: { table: 'supplier_ledger', col: 'supplier_id' },
};

/**
 * Ledger statement for one party over an inclusive range of local dates. The chain is read in ledger order (id), so the
 * opening balance plus the entries always adds up to the closing balance.
 */
export function buildStatement(db: Db, kind: LedgerKind, partyId: number, fromDate?: string, toDate?: string): Statement {
  const { table, col } = LEDGERS[kind];
  let range: { fromUtc?: string; toUtcExclusive?: string };
  try {
    range = localDayRangeToUtc(fromDate, toDate);
  } catch (e) {
    throw new AppError('VALIDATION', (e as Error).message);
  }

  let openingPaise = 0;
  if (range.fromUtc) {
    const prev = db.prepare(`SELECT balance_after_paise AS b FROM ${table} WHERE ${col} = ? AND at < ? ORDER BY id DESC LIMIT 1`).get(partyId, range.fromUtc) as
      | { b: number }
      | undefined;
    openingPaise = prev?.b ?? 0;
  }

  const where = [`l.${col} = ?`];
  const params: (string | number)[] = [partyId];
  if (range.fromUtc) {
    where.push('l.at >= ?');
    params.push(range.fromUtc);
  }
  if (range.toUtcExclusive) {
    where.push('l.at < ?');
    params.push(range.toUtcExclusive);
  }
  const rows = db
    .prepare(
      `SELECT l.id, l.at, l.entry_type, l.ref_no, l.note, l.amount_paise, l.balance_after_paise, u.display_name AS user_name
       FROM ${table} l JOIN user u ON u.id = l.user_id WHERE ${where.join(' AND ')} ORDER BY l.id`,
    )
    .all(...params) as { id: number; at: string; entry_type: string; ref_no: string | null; note: string | null; amount_paise: number; balance_after_paise: number; user_name: string }[];

  const entries: StatementEntry[] = rows.map((r) => ({
    id: r.id, at: r.at, entryType: r.entry_type, label: LABELS[r.entry_type] ?? r.entry_type, refNo: r.ref_no, note: r.note,
    amountPaise: r.amount_paise, balanceAfterPaise: r.balance_after_paise, userName: r.user_name,
  }));
  const last = entries[entries.length - 1];
  return {
    openingPaise,
    entries,
    closingPaise: last ? last.balanceAfterPaise : openingPaise,
    increasesPaise: entries.reduce((s, e) => s + Math.max(e.amountPaise, 0), 0),
    reducesPaise: entries.reduce((s, e) => s + Math.max(-e.amountPaise, 0), 0),
  };
}
