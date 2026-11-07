import { formatBillNo } from '../../domain/billNumber';
import { assertInTransaction, type TxContext } from './unitOfWork';

export type NumberSeriesName = 'SALE' | 'PURCHASE' | 'RECEIPT' | 'SUPPLIER_RECEIPT';

/**
 * Take the next number in a (series, financial year). Must run inside the same transaction as the bill it numbers:
 * if that transaction rolls back, the number is released, so the invoice sequence never has gaps.
 * `prefixIfNew` is only used the first time a series/year is seen; after that the stored prefix wins.
 */
export function allocateNumber(
  ctx: TxContext,
  series: NumberSeriesName,
  fy: string,
  prefixIfNew: string,
  width = 4,
): { number: string; sequence: number } {
  assertInTransaction(ctx, 'allocateNumber');
  ctx.db
    .prepare('INSERT OR IGNORE INTO number_series (series, fy, prefix, next_no) VALUES (?, ?, ?, 1)')
    .run(series, fy, prefixIfNew);
  const row = ctx.db.prepare('SELECT prefix, next_no FROM number_series WHERE series = ? AND fy = ?').get(series, fy) as {
    prefix: string;
    next_no: number;
  };
  ctx.db.prepare('UPDATE number_series SET next_no = next_no + 1 WHERE series = ? AND fy = ?').run(series, fy);
  return { number: formatBillNo(row.prefix, row.next_no, width), sequence: row.next_no };
}
