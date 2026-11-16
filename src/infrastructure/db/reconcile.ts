import type { Db } from './connection';

export interface ReconcileIssue {
  kind: 'ITEM_QTY' | 'CUSTOMER_BALANCE' | 'SUPPLIER_BALANCE' | 'PAYMENT_OVER_ALLOCATED' | 'BILL_OVER_PAID' | 'PURCHASE_OVER_RECEIVED';
  id: number;
  label: string;
  cached: number;
  ledger: number;
}

type Row = Omit<ReconcileIssue, 'kind'>;

/**
 * Compare every cached figure with the sum of its append-only ledger, and check that nothing was settled or received beyond what it was worth.
 * An empty list means the books agree. A backup made by an older version of the program has fewer tables, so each check runs only where the
 * tables it needs exist (checking an old backup must not fail merely because it predates a feature).
 */
export function reconcile(db: Db): ReconcileIssue[] {
  const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  const issues: ReconcileIssue[] = [];
  const check = (kind: ReconcileIssue['kind'], tables: string[], sql: string): void => {
    if (!tables.every((t) => have.has(t))) return;
    for (const r of db.prepare(sql).all() as Row[]) issues.push({ kind, ...r });
  };

  check('ITEM_QTY', ['item', 'stock_movement'], `
    SELECT i.id AS id, i.code AS label, i.qty_milli AS cached, COALESCE(SUM(m.qty_delta_milli), 0) AS ledger
    FROM item i LEFT JOIN stock_movement m ON m.item_id = i.id
    GROUP BY i.id HAVING cached <> ledger`);
  check('CUSTOMER_BALANCE', ['customer', 'customer_ledger'], `
    SELECT c.id AS id, c.name AS label, c.balance_paise AS cached, COALESCE(SUM(l.amount_paise), 0) AS ledger
    FROM customer c LEFT JOIN customer_ledger l ON l.customer_id = c.id
    GROUP BY c.id HAVING cached <> ledger`);
  check('SUPPLIER_BALANCE', ['supplier', 'supplier_ledger'], `
    SELECT s.id AS id, s.name AS label, s.balance_paise AS cached, COALESCE(SUM(l.amount_paise), 0) AS ledger
    FROM supplier s LEFT JOIN supplier_ledger l ON l.supplier_id = s.id
    GROUP BY s.id HAVING cached <> ledger`);
  // a payment cannot settle more than it is worth, and a bill cannot be settled for more than its total
  check('PAYMENT_OVER_ALLOCATED', ['customer_payment', 'payment_allocation'], `
    SELECT p.id AS id, p.receipt_no AS label, p.amount_paise AS cached, COALESCE(SUM(a.amount_paise), 0) AS ledger
    FROM customer_payment p JOIN payment_allocation a ON a.payment_id = p.id
    GROUP BY p.id HAVING ledger > cached`);
  check('BILL_OVER_PAID', ['sale_bill', 'payment_allocation', 'customer_payment'], `
    SELECT b.id AS id, COALESCE(b.bill_no, '') AS label, b.total_paise AS cached, COALESCE(SUM(a.amount_paise), 0) AS ledger
    FROM sale_bill b JOIN payment_allocation a ON a.sale_bill_id = b.id JOIN customer_payment p ON p.id = a.payment_id AND p.is_reversed = 0
    GROUP BY b.id HAVING ledger > cached`);
  // goods cannot be received for more than was invoiced
  check('PURCHASE_OVER_RECEIVED', ['purchase_bill', 'purchase_bill_line', 'purchase_receipt'], `
    SELECT l.id AS id, COALESCE(b.bill_no, '') || ' line ' || l.line_no AS label, l.ordered_qty_milli AS cached, COALESCE(SUM(r.qty_milli), 0) AS ledger
    FROM purchase_bill_line l JOIN purchase_bill b ON b.id = l.bill_id JOIN purchase_receipt r ON r.bill_id = l.bill_id AND r.line_no = l.line_no
    WHERE b.status = 'CONFIRMED' GROUP BY l.id HAVING ledger > cached`);
  return issues;
}
