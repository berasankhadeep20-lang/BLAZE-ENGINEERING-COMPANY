# Software Requirements Specification v0.1 (approved)

## 1. Scope
Single-user, offline Windows-first desktop app for BLAZE ENGINEERING CO.: purchase and sale billing, inventory, customer dues,
suppliers, reports, roles, backup/restore, A4 invoice printing.
Out of scope for v1: networking/sync, legacy data import (later phase).

## 2. Roles
- **Owner/Admin:** full access.
- **Employee:** per-user permission flags set by the owner, e.g. `price.edit`, `bill.edit_confirmed`, `bill.cancel`,
  `stock.adjust`, `user.manage`, `backup.restore`, `customer.edit`, `customer.approve` (owner only by default).

## 3. Functional requirements
- **FR-AUTH:** sign-in on every launch; individual accounts; argon2id hashes; no seeded demo passwords; first-run wizard creates the owner.
- **FR-INV:** item master, stock ledger, low-stock alerts, stock corrections with mandatory reason.
- **FR-PUR:** draft -> confirmed purchase bills with explicit ordered vs received quantity. Stock changes only on confirm, only by received quantity.
- **FR-SAL:** draft -> confirmed sale bills. Stock re-checked inside the confirm transaction. Customer details frozen as a snapshot on the bill.
- **FR-PAY:** partial payments; no overpayment unless via explicit advance/credit workflow; balance shown after each payment.
- **FR-CANCEL:** confirmed records are never edited or deleted; cancellation/return/adjustment creates reversing entries with a reason.
- **FR-CUST-APPROVAL:** customers created by employees start PENDING. They may be used on draft bills but a bill cannot be confirmed until the owner approves the customer.
- **FR-PRICE-WARN:** selling below purchase rate shows a warning and requires acknowledgement; it is recorded in the audit log and never hard-blocked (setting `warn_below_cost`, default on).
- **FR-PRINT:** A4 invoice/challan with print preview and PDF export (Original / Duplicate / Triplicate labels configurable).
- **FR-REPORT:** best sellers; customer purchase history (units vs number of bills shown separately); day/month/custom totals; dues; low/no-movement items; purchases by supplier.
- **FR-BACKUP:** versioned, validated backup; pre-restore auto-backup; success reported only after the file is written and verified.
- **FR-DEMO:** separate demo database file; real and demo data never mix; reset affects demo only.
- **FR-AUDIT:** append-only audit log of who did what and when.

## 4. Non-functional requirements
- Fully offline: no CDN fonts, no remote calls, bundled fonts.
- Money as integer paise, never floats. GST rates in basis points. Quantities in thousandths.
- Every multi-table write is one transaction; WAL + synchronous=FULL; versioned migrations.
- Keyboard-friendly forms; usable from 1366x768 upward.

## 5. Observations from the sample bill (design inputs)
1. Delivery charge was back-solved to reach a round total: goods Rs 2,891.00; delivery Rs 92.37 + 18% GST (Rs 8.31 CGST + Rs 8.31 SGST)
   gives Rs 2,999.99; an explicit round-off of +Rs 0.01 makes the final total exactly Rs 3,000.00.
   Support pre-tax delivery entry, a "solve delivery for target total" helper, and an explicit round-off line.
2. UOM carries pack size: "40 - LTR", "PCS - PCS", "500 - ML" -> model as `pack_size` + `unit`.
3. CGST+SGST applies for intra-state supply; inter-state needs **IGST** (added beyond the original spec).
4. Invoice number `BZ260150` = prefix + 2-digit year + 4-digit sequence; make format configurable, reset per financial year.
5. HSN codes are stored as entered and never invented or validated; the owner must verify them (e.g. with a CA).
6. Bank, GSTIN, address come from settings, never hard-coded.

## 6. Decisions
- Reports count only confirmed bills, show quantity and number of bills as separate columns, use shop-local calendar dates, and come out as one table for screen, CSV and print. `report.view` is not an employee default because reports reveal costs.
- The printed invoice follows the sample's layout; its business, bank, tax and terms details come from Settings only. The round-off is printed as its own line. Inter-state bills print IGST. Drafts and cancelled bills are watermarked.
- On a sale invoice the current rate per piece is shown first and the user may type the desired rate for that bill (permission `sale.edit_rate`, on by default for employees; `price.edit` is only for the item master). The standard rate is stored beside the rate charged.
- Purchase bills keep `ordered_qty` and `received_qty`; only received affects stock.
- Supplier payments are tracked separately from customer receivables.
- Negative-stock override is off by default; owner-only with mandatory reason if enabled.
- No weighted-average costing in v1.
- Legacy data (.mdb, MS Access) will be read with mdbtools into `legacy_*` staging tables, reviewed, then mapped.
