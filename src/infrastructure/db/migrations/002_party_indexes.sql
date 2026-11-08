-- 002: one customer / one supplier per GSTIN, and indexes for the lookups the party screens use.
-- GSTINs are stored upper-case by the service, so plain equality is enough.
CREATE UNIQUE INDEX idx_customer_gstin ON customer(gstin) WHERE gstin IS NOT NULL;
CREATE UNIQUE INDEX idx_supplier_gstin ON supplier(gstin) WHERE gstin IS NOT NULL;
CREATE INDEX idx_customer_approval ON customer(approval_status);
CREATE INDEX idx_customer_phone ON customer(phone);
CREATE INDEX idx_supplier_name ON supplier(name);
