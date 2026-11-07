-- 001_initial.sql: BLAZE ENGINEERING COMPANY
-- Conventions: money = integer paise (*_paise); GST rate = basis points (900 = 9%);
-- quantity = integer thousandths (*_milli); dates ISO text; timestamps UTC.
-- NOTE: schema_migrations is created/maintained by the migration runner.
-- foreign_keys / WAL / synchronous are set per connection by the app, not here.

CREATE TABLE app_setting (
  key TEXT PRIMARY KEY, value TEXT NOT NULL,
  updated_by INTEGER, updated_at TEXT NOT NULL
);

CREATE TABLE number_series (
  series TEXT NOT NULL CHECK (series IN ('SALE','PURCHASE','RECEIPT','SUPPLIER_RECEIPT')),
  fy TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_no INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (series, fy)
);

CREATE TABLE user (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER','EMPLOYEE')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_by INTEGER REFERENCES user(id), created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id), updated_at TEXT
);

CREATE TABLE user_permission (
  user_id INTEGER NOT NULL REFERENCES user(id),
  permission TEXT NOT NULL,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES user(id),
  action TEXT NOT NULL,
  entity_type TEXT, entity_id INTEGER,
  reason TEXT, detail_json TEXT
);

CREATE TABLE category (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);

CREATE TABLE supplier (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT,
  address TEXT, state TEXT, gstin TEXT, notes TEXT,
  balance_paise INTEGER NOT NULL DEFAULT 0,          -- amount we owe the supplier
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES user(id), created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id), updated_at TEXT
);

CREATE TABLE customer (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT,
  address TEXT, state TEXT, place_of_supply TEXT,
  gstin TEXT,                                        -- NULL = unregistered
  notes TEXT,
  advance_allowed INTEGER NOT NULL DEFAULT 0 CHECK (advance_allowed IN (0,1)),
  balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (balance_paise >= 0 OR advance_allowed = 1),
  approval_status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (approval_status IN ('APPROVED','PENDING','REJECTED')),
  approved_by INTEGER REFERENCES user(id), approved_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES user(id), created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id), updated_at TEXT
);
CREATE INDEX idx_customer_name ON customer(name);

CREATE TABLE item (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, description TEXT,
  hsn TEXT, category_id INTEGER REFERENCES category(id),
  unit TEXT NOT NULL,
  pack_size TEXT,
  purchase_rate_paise INTEGER NOT NULL DEFAULT 0 CHECK (purchase_rate_paise >= 0),
  sale_rate_paise INTEGER NOT NULL DEFAULT 0 CHECK (sale_rate_paise >= 0),
  gst_rate_bp INTEGER NOT NULL DEFAULT 1800 CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (qty_milli >= 0),
  reorder_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_qty_milli >= 0),
  supplier_id INTEGER REFERENCES supplier(id), location TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES user(id), created_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES user(id), updated_at TEXT
);
CREATE INDEX idx_item_name ON item(name);

-- ================= SALES =================
CREATE TABLE sale_bill (
  id INTEGER PRIMARY KEY,
  bill_no TEXT UNIQUE,                               -- assigned on confirm; NULL for drafts
  fy TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
  invoice_date TEXT NOT NULL,
  order_no TEXT, order_date TEXT,
  transport_mode TEXT, vehicle_no TEXT, supply_date TEXT, place_of_supply TEXT,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  cust_name TEXT NOT NULL, cust_address TEXT, cust_gstin TEXT, cust_state TEXT,   -- frozen snapshot
  tax_type TEXT NOT NULL CHECK (tax_type IN ('INTRA','INTER')),
  taxable_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise INTEGER NOT NULL DEFAULT 0, sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0,
  delivery_paise INTEGER NOT NULL DEFAULT 0,
  delivery_gst_rate_bp INTEGER NOT NULL DEFAULT 0,
  delivery_tax_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  received_paise INTEGER NOT NULL DEFAULT 0 CHECK (received_paise >= 0),   -- paid at time of sale
  payment_method TEXT, notes TEXT,
  created_by INTEGER NOT NULL REFERENCES user(id), created_at TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES user(id), confirmed_at TEXT,
  cancelled_by INTEGER REFERENCES user(id), cancelled_at TEXT, cancel_reason TEXT
);
CREATE INDEX idx_sale_cust_date ON sale_bill(customer_id, invoice_date);
CREATE INDEX idx_sale_date ON sale_bill(invoice_date);

CREATE TABLE sale_bill_line (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES sale_bill(id),
  line_no INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES item(id),
  description TEXT NOT NULL, hsn TEXT,               -- frozen copies
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  uom_label TEXT NOT NULL,                           -- e.g. '40 - LTR'
  rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise INTEGER NOT NULL,
  gst_rate_bp INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0, sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  below_cost INTEGER NOT NULL DEFAULT 0 CHECK (below_cost IN (0,1)),   -- warned, acknowledged, audited; never blocked
  UNIQUE (bill_id, line_no)
);
CREATE INDEX idx_sale_line_item ON sale_bill_line(item_id);

-- ================= PURCHASES =================
CREATE TABLE purchase_bill (
  id INTEGER PRIMARY KEY,
  bill_no TEXT UNIQUE,                               -- internal number, assigned on confirm
  fy TEXT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
  bill_date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES supplier(id),
  supplier_inv_no TEXT NOT NULL, supplier_inv_date TEXT NOT NULL,
  sup_name TEXT NOT NULL, sup_address TEXT, sup_gstin TEXT, sup_state TEXT,        -- snapshot
  order_no TEXT, order_date TEXT,
  transport_mode TEXT, vehicle_no TEXT, supply_date TEXT, place_of_supply TEXT,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('INTRA','INTER')),
  taxable_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise INTEGER NOT NULL DEFAULT 0, sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0,
  delivery_paise INTEGER NOT NULL DEFAULT 0,
  delivery_gst_rate_bp INTEGER NOT NULL DEFAULT 0,
  delivery_tax_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  paid_paise INTEGER NOT NULL DEFAULT 0 CHECK (paid_paise >= 0),
  payment_method TEXT, notes TEXT, attachment_path TEXT,
  created_by INTEGER NOT NULL REFERENCES user(id), created_at TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES user(id), confirmed_at TEXT,
  cancelled_by INTEGER REFERENCES user(id), cancelled_at TEXT, cancel_reason TEXT
);
CREATE INDEX idx_purchase_sup_date ON purchase_bill(supplier_id, bill_date);

CREATE TABLE purchase_bill_line (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES purchase_bill(id),
  line_no INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES item(id),
  description TEXT NOT NULL, hsn TEXT,
  ordered_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (ordered_qty_milli >= 0),
  received_qty_milli INTEGER NOT NULL CHECK (received_qty_milli >= 0),   -- only this affects stock
  uom_label TEXT NOT NULL,
  rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise INTEGER NOT NULL,
  gst_rate_bp INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0, sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  UNIQUE (bill_id, line_no)
);
CREATE INDEX idx_purchase_line_item ON purchase_bill_line(item_id);

-- ================= PAYMENTS =================
CREATE TABLE customer_payment (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  sale_bill_id INTEGER REFERENCES sale_bill(id),
  paid_on TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL, reference TEXT, note TEXT,
  balance_after_paise INTEGER NOT NULL,
  is_reversed INTEGER NOT NULL DEFAULT 0 CHECK (is_reversed IN (0,1)),
  reversal_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES user(id), created_at TEXT NOT NULL
);
CREATE INDEX idx_cpay_cust ON customer_payment(customer_id, paid_on);

CREATE TABLE supplier_payment (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES supplier(id),
  purchase_bill_id INTEGER REFERENCES purchase_bill(id),
  paid_on TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL, reference TEXT, note TEXT,
  balance_after_paise INTEGER NOT NULL,
  is_reversed INTEGER NOT NULL DEFAULT 0 CHECK (is_reversed IN (0,1)),
  reversal_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES user(id), created_at TEXT NOT NULL
);

-- ================= LEDGERS (append-only) =================
CREATE TABLE stock_movement (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES item(id),
  qty_delta_milli INTEGER NOT NULL CHECK (qty_delta_milli <> 0),
  reason TEXT NOT NULL CHECK (reason IN
    ('PURCHASE','SALE','SALE_CANCEL','PURCHASE_CANCEL','RETURN','DAMAGED','MISSING','COUNT_ADJUST','OPENING')),
  ref_type TEXT, ref_id INTEGER, ref_no TEXT, note TEXT,
  qty_after_milli INTEGER NOT NULL CHECK (qty_after_milli >= 0),
  user_id INTEGER NOT NULL REFERENCES user(id)
);
CREATE INDEX idx_move_item_at ON stock_movement(item_id, at);

CREATE TABLE customer_ledger (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN
    ('SALE','PAYMENT','SALE_CANCEL','PAYMENT_REVERSAL','ADJUSTMENT','OPENING')),
  amount_paise INTEGER NOT NULL,                     -- +ve increases dues, -ve reduces
  balance_after_paise INTEGER NOT NULL,
  ref_type TEXT, ref_id INTEGER, ref_no TEXT, note TEXT,
  user_id INTEGER NOT NULL REFERENCES user(id)
);
CREATE INDEX idx_cledger_cust ON customer_ledger(customer_id, at);

CREATE TABLE supplier_ledger (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES supplier(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN
    ('PURCHASE','PAYMENT','PURCHASE_CANCEL','PAYMENT_REVERSAL','ADJUSTMENT','OPENING')),
  amount_paise INTEGER NOT NULL,                     -- +ve increases what we owe
  balance_after_paise INTEGER NOT NULL,
  ref_type TEXT, ref_id INTEGER, ref_no TEXT, note TEXT,
  user_id INTEGER NOT NULL REFERENCES user(id)
);

CREATE TABLE backup_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('MANUAL','PRE_RESTORE','PRE_MIGRATION')),
  path TEXT NOT NULL, sha256 TEXT, size_bytes INTEGER,
  verified INTEGER NOT NULL DEFAULT 0, user_id INTEGER REFERENCES user(id)
);

-- ================= IMMUTABILITY TRIGGERS =================
-- Append-only tables
CREATE TRIGGER trg_stock_movement_no_update BEFORE UPDATE ON stock_movement
BEGIN SELECT RAISE(ABORT,'stock_movement is append-only'); END;
CREATE TRIGGER trg_stock_movement_no_delete BEFORE DELETE ON stock_movement
BEGIN SELECT RAISE(ABORT,'stock_movement is append-only'); END;
CREATE TRIGGER trg_customer_ledger_no_update BEFORE UPDATE ON customer_ledger
BEGIN SELECT RAISE(ABORT,'customer_ledger is append-only'); END;
CREATE TRIGGER trg_customer_ledger_no_delete BEFORE DELETE ON customer_ledger
BEGIN SELECT RAISE(ABORT,'customer_ledger is append-only'); END;
CREATE TRIGGER trg_supplier_ledger_no_update BEFORE UPDATE ON supplier_ledger
BEGIN SELECT RAISE(ABORT,'supplier_ledger is append-only'); END;
CREATE TRIGGER trg_supplier_ledger_no_delete BEFORE DELETE ON supplier_ledger
BEGIN SELECT RAISE(ABORT,'supplier_ledger is append-only'); END;
CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;

-- Payments: never deleted; only the reversal flag may change (0 -> 1, with a reason)
CREATE TRIGGER trg_cpay_no_delete BEFORE DELETE ON customer_payment
BEGIN SELECT RAISE(ABORT,'payments cannot be deleted; reverse them instead'); END;
CREATE TRIGGER trg_cpay_update_guard BEFORE UPDATE ON customer_payment
WHEN NOT (OLD.is_reversed = 0 AND NEW.is_reversed = 1
          AND NEW.reversal_reason IS NOT NULL AND length(trim(NEW.reversal_reason)) > 0
          AND NEW.amount_paise = OLD.amount_paise AND NEW.customer_id = OLD.customer_id
          AND NEW.receipt_no = OLD.receipt_no AND NEW.paid_on = OLD.paid_on)
BEGIN SELECT RAISE(ABORT,'payments are immutable except for a reasoned reversal'); END;
CREATE TRIGGER trg_spay_no_delete BEFORE DELETE ON supplier_payment
BEGIN SELECT RAISE(ABORT,'payments cannot be deleted; reverse them instead'); END;
CREATE TRIGGER trg_spay_update_guard BEFORE UPDATE ON supplier_payment
WHEN NOT (OLD.is_reversed = 0 AND NEW.is_reversed = 1
          AND NEW.reversal_reason IS NOT NULL AND length(trim(NEW.reversal_reason)) > 0
          AND NEW.amount_paise = OLD.amount_paise AND NEW.supplier_id = OLD.supplier_id
          AND NEW.receipt_no = OLD.receipt_no AND NEW.paid_on = OLD.paid_on)
BEGIN SELECT RAISE(ABORT,'payments are immutable except for a reasoned reversal'); END;

-- Sale bills: DRAFT is editable and may become CONFIRMED.
-- CONFIRMED may only become CANCELLED (with a reason) with all financial/identity columns unchanged.
CREATE TRIGGER trg_sale_bill_guard BEFORE UPDATE ON sale_bill
WHEN OLD.status <> 'DRAFT' AND NOT (
      OLD.status = 'CONFIRMED' AND NEW.status = 'CANCELLED'
  AND NEW.cancel_reason IS NOT NULL AND length(trim(NEW.cancel_reason)) > 0
  AND NEW.bill_no IS OLD.bill_no AND NEW.invoice_date = OLD.invoice_date
  AND NEW.customer_id = OLD.customer_id
  AND NEW.cust_name IS OLD.cust_name AND NEW.cust_address IS OLD.cust_address
  AND NEW.cust_gstin IS OLD.cust_gstin AND NEW.cust_state IS OLD.cust_state
  AND NEW.taxable_paise = OLD.taxable_paise AND NEW.cgst_paise = OLD.cgst_paise
  AND NEW.sgst_paise = OLD.sgst_paise AND NEW.igst_paise = OLD.igst_paise
  AND NEW.delivery_paise = OLD.delivery_paise AND NEW.delivery_tax_paise = OLD.delivery_tax_paise
  AND NEW.round_off_paise = OLD.round_off_paise AND NEW.total_paise = OLD.total_paise
  AND NEW.received_paise = OLD.received_paise)
BEGIN SELECT RAISE(ABORT,'confirmed/cancelled sale bills cannot be edited'); END;
CREATE TRIGGER trg_sale_bill_no_delete BEFORE DELETE ON sale_bill
WHEN OLD.status <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'only draft bills can be deleted'); END;

CREATE TRIGGER trg_sale_line_no_insert BEFORE INSERT ON sale_bill_line
WHEN (SELECT status FROM sale_bill WHERE id = NEW.bill_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'lines of issued bills are frozen'); END;
CREATE TRIGGER trg_sale_line_no_update BEFORE UPDATE ON sale_bill_line
WHEN (SELECT status FROM sale_bill WHERE id = OLD.bill_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'lines of issued bills are frozen'); END;
CREATE TRIGGER trg_sale_line_no_delete BEFORE DELETE ON sale_bill_line
WHEN (SELECT status FROM sale_bill WHERE id = OLD.bill_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'lines of issued bills are frozen'); END;

-- Purchase bills: same rules
CREATE TRIGGER trg_purchase_bill_guard BEFORE UPDATE ON purchase_bill
WHEN OLD.status <> 'DRAFT' AND NOT (
      OLD.status = 'CONFIRMED' AND NEW.status = 'CANCELLED'
  AND NEW.cancel_reason IS NOT NULL AND length(trim(NEW.cancel_reason)) > 0
  AND NEW.bill_no IS OLD.bill_no AND NEW.bill_date = OLD.bill_date
  AND NEW.supplier_id = OLD.supplier_id
  AND NEW.sup_name IS OLD.sup_name AND NEW.sup_address IS OLD.sup_address
  AND NEW.sup_gstin IS OLD.sup_gstin AND NEW.sup_state IS OLD.sup_state
  AND NEW.supplier_inv_no = OLD.supplier_inv_no AND NEW.supplier_inv_date = OLD.supplier_inv_date
  AND NEW.taxable_paise = OLD.taxable_paise AND NEW.cgst_paise = OLD.cgst_paise
  AND NEW.sgst_paise = OLD.sgst_paise AND NEW.igst_paise = OLD.igst_paise
  AND NEW.delivery_paise = OLD.delivery_paise AND NEW.delivery_tax_paise = OLD.delivery_tax_paise
  AND NEW.round_off_paise = OLD.round_off_paise AND NEW.total_paise = OLD.total_paise
  AND NEW.paid_paise = OLD.paid_paise)
BEGIN SELECT RAISE(ABORT,'confirmed/cancelled purchase bills cannot be edited'); END;
CREATE TRIGGER trg_purchase_bill_no_delete BEFORE DELETE ON purchase_bill
WHEN OLD.status <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'only draft bills can be deleted'); END;

CREATE TRIGGER trg_purchase_line_no_insert BEFORE INSERT ON purchase_bill_line
WHEN (SELECT status FROM purchase_bill WHERE id = NEW.bill_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'lines of issued bills are frozen'); END;
CREATE TRIGGER trg_purchase_line_no_update BEFORE UPDATE ON purchase_bill_line
WHEN (SELECT status FROM purchase_bill WHERE id = OLD.bill_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'lines of issued bills are frozen'); END;
CREATE TRIGGER trg_purchase_line_no_delete BEFORE DELETE ON purchase_bill_line
WHEN (SELECT status FROM purchase_bill WHERE id = OLD.bill_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT,'lines of issued bills are frozen'); END;
