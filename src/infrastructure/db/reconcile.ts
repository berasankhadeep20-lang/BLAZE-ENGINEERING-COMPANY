import type { Db } from './connection';

export interface ReconcileIssue {
  kind: 'ITEM_QTY' | 'CUSTOMER_BALANCE' | 'SUPPLIER_BALANCE' | 'PAYMENT_OVER_ALLOCATED' | 'BILL_OVER_PAID' | 'PURCHASE_OVER_RECEIVED';
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
  // a payment cannot settle more than it is worth, and a bill cannot be settled for more than its total
  push(
    'PAYMENT_OVER_ALLOCATED',
    db
      .prepare(
        `SELECT p.id AS id, p.receipt_no AS label, p.amount_paise AS cached, COALESCE(SUM(a.amount_paise), 0) AS ledger
         FROM customer_payment p JOIN payment_allocation a ON a.payment_id = p.id
         GROUP BY p.id HAVING ledger > cached`,
      )
      .all() as Row[],
  );
  push(
    'BILL_OVER_PAID',
    db
      .prepare(
        `SELECT b.id AS id, COALESCE(b.bill_no, '') AS label, b.total_paise AS cached, COALESCE(SUM(a.amount_paise), 0) AS ledger
         FROM sale_bill b JOIN payment_allocation a ON a.sale_bill_id = b.id JOIN customer_payment p ON p.id = a.payment_id AND p.is_reversed = 0
         GROUP BY b.id HAVING ledger > cached`,
      )
      .all() as Row[],
  );
  // goods cannot be received for more than was invoiced
  push(
    'PURCHASE_OVER_RECEIVED',
    db
      .prepare(
        `SELECT l.id AS id, COALESCE(b.bill_no, '') || ' line ' || l.line_no AS label, l.ordered_qty_milli AS cached, COALESCE(SUM(r.qty_milli), 0) AS ledger
         FROM purchase_bill_line l JOIN purchase_bill b ON b.id = l.bill_id JOIN purchase_receipt r ON r.bill_id = l.bill_id AND r.line_no = l.line_no
         WHERE b.status = 'CONFIRMED' GROUP BY l.id HAVING ledger > cached`,
      )
      .all() as Row[],
  );
  return issues;
}
