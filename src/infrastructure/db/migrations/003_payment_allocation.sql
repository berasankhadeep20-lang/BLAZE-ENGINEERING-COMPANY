-- 003: which bill(s) each customer payment settles.
-- A payment (including money taken at the time of sale) is split across confirmed bills, oldest first; any remainder
-- (for example dues carried in as an opening balance) stays unallocated. A bill's outstanding amount is its total minus the
-- allocations of payments that have not been reversed. Allocation rows are append-only; reversing a payment frees its allocations.
CREATE TABLE payment_allocation (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES customer_payment(id),
  sale_bill_id INTEGER NOT NULL REFERENCES sale_bill(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  UNIQUE (payment_id, sale_bill_id)
);
CREATE INDEX idx_alloc_bill ON payment_allocation(sale_bill_id);

CREATE TRIGGER trg_alloc_no_update BEFORE UPDATE ON payment_allocation
BEGIN SELECT RAISE(ABORT,'payment_allocation is append-only'); END;
CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON payment_allocation
BEGIN SELECT RAISE(ABORT,'payment_allocation is append-only'); END;
