-- 004: purchases and the standard rate on sale lines.
--  * purchase_receipt: every quantity of goods actually received against a purchase bill line (at entry, and any later partial receipts). Append-only.
--    Stock only ever increases by what was received, never by what was merely invoiced.
--  * one live purchase bill per (supplier, supplier invoice number), compared without regard to capitals; a cancelled bill frees the number.
--  * sale_bill_line.list_rate_paise: the item's standard rate when the bill was issued, kept next to the rate actually charged.
CREATE TABLE purchase_receipt (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES purchase_bill(id),
  line_no INTEGER NOT NULL,
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  received_on TEXT NOT NULL,
  note TEXT,
  user_id INTEGER NOT NULL REFERENCES user(id),
  at TEXT NOT NULL,
  FOREIGN KEY (bill_id, line_no) REFERENCES purchase_bill_line(bill_id, line_no)
);
CREATE INDEX idx_receipt_bill ON purchase_receipt(bill_id, line_no);

CREATE TRIGGER trg_receipt_no_update BEFORE UPDATE ON purchase_receipt
BEGIN SELECT RAISE(ABORT,'purchase_receipt is append-only'); END;
CREATE TRIGGER trg_receipt_no_delete BEFORE DELETE ON purchase_receipt
BEGIN SELECT RAISE(ABORT,'purchase_receipt is append-only'); END;

CREATE UNIQUE INDEX idx_purchase_supplier_invoice ON purchase_bill(supplier_id, supplier_inv_no COLLATE NOCASE) WHERE status <> 'CANCELLED';
CREATE INDEX idx_spay_supplier ON supplier_payment(supplier_id, paid_on);
CREATE INDEX idx_spay_bill ON supplier_payment(purchase_bill_id);

ALTER TABLE sale_bill_line ADD COLUMN list_rate_paise INTEGER;
