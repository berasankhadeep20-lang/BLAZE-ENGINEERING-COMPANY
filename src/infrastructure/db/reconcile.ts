import type { Db } from './connection';

export interface ReconcileIssue {
  kind: 'ITEM_QTY' | 'CUSTOMER_BALANCE' | 'SUPPLIER_BALANCE';
  id: number;
  label: string;
  cached: number;
  ledger: number;
}

/** Compare every cached figure with the sum of its append-only ledger. An empty list means the books agree. */
type Row = Omit<ReconcileIssue, 'kind'>;

export function reconcile(db: Db): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  const push = (kind: ReconcileIssue['kind'], rows: Row[]): void => {
    for (const r of rows) issues.push({ kind, ...r });
  };

  push(
    'ITEM_QTY',
    db
      .prepare(
        `SELECT i.id AS id, i.code AS label, i.qty_milli AS cached, COALESCE(SUM(m.qty_delta_milli), 0) AS ledger
         FROM item i LEFT JOIN stock_movement m ON m.item_id = i.id
         GROUP BY i.id HAVING cached <> ledger`,
      )
      .all() as Row[],
  );
  push(
    'CUSTOMER_BALANCE',
    db
      .prepare(
        `SELECT c.id AS id, c.name AS label, c.balance_paise AS cached, COALESCE(SUM(l.amount_paise), 0) AS ledger
         FROM customer c LEFT JOIN customer_ledger l ON l.customer_id = c.id
         GROUP BY c.id HAVING cached <> ledger`,
      )
      .all() as Row[],
  );
  push(
    'SUPPLIER_BALANCE',
    db
      .prepare(
        `SELECT s.id AS id, s.name AS label, s.balance_paise AS cached, COALESCE(SUM(l.amount_paise), 0) AS ledger
         FROM supplier s LEFT JOIN supplier_ledger l ON l.supplier_id = s.id
         GROUP BY s.id HAVING cached <> ledger`,
      )
      .all() as Row[],
  );
  return issues;
}
