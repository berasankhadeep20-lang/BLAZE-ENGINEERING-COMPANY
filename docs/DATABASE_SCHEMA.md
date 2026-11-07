# Database Schema (migration 001)

Full DDL: `src/infrastructure/db/migrations/001_initial.sql` (19 tables, 22 triggers; trigger behaviour verified in SQLite).

## Conventions
- Money: integer paise (`*_paise`). GST rates: basis points (`900` = 9%). Quantities: integer thousandths (`*_milli`).
- Dates ISO text (`2026-10-31`); timestamps UTC.
- Ledgers (`stock_movement`, `customer_ledger`, `supplier_ledger`, `audit_log`) are append-only (triggers).
- Cached balances (`item.qty_milli`, `customer.balance_paise`, `supplier.balance_paise`) are updated in the same transaction as their ledger row;
  a reconciliation check verifies cache == ledger sum.

## Table map
| Area | Tables |
|---|---|
| System | `app_setting`, `number_series`, `backup_log` (`schema_migrations` is created by the migration runner) |
| Access | `user`, `user_permission`, `audit_log` |
| Masters | `category`, `item`, `customer`, `supplier` |
| Sales | `sale_bill`, `sale_bill_line`, `customer_payment` |
| Purchases | `purchase_bill`, `purchase_bill_line`, `supplier_payment` |
| Ledgers | `stock_movement`, `customer_ledger`, `supplier_ledger` |

## Rules enforced by the database
- `item.qty_milli >= 0` and `stock_movement.qty_after_milli >= 0` (negative stock refused even if a service bug slips through).
- Confirmed sale/purchase bills: only `CONFIRMED -> CANCELLED` is allowed, requires a non-empty reason, and every financial and
  identity column must be unchanged. Cancelled bills are fully frozen. Only drafts can be deleted.
- Lines of non-draft bills cannot be inserted, updated, or deleted.
- Payments cannot be deleted; the only permitted update is a reversal (`is_reversed 0 -> 1` with a reason).
- `customer.balance_paise < 0` is only possible when `advance_allowed = 1` (explicit credit/advance workflow).

## Design notes
- `bill_no` is NULL for drafts and assigned from `number_series` inside the confirm transaction, so abandoned drafts leave no gaps.
- Sale bills freeze customer name/address/GSTIN/state; purchase bills freeze supplier details; lines freeze description/HSN/UOM.
- `purchase_bill_line` has `ordered_qty_milli` and `received_qty_milli`; only received quantity moves stock.
- `sale_bill_line.below_cost` records an acknowledged below-purchase-rate sale (warning only, never a block).
- `customer.approval_status`: employee-created customers start PENDING; a bill can't be confirmed until APPROVED (enforced in the service).
- GST computation and balance arithmetic live in the domain/service layers (unit-tested), not in SQL.
- Legacy import will use separate `legacy_*` staging tables created by a later migration.

- `item.gst_rate_bp` accepts 0 to 10000 (0% to 100%); the app never hard-codes legal tax slabs.

## Known follow-ups
- Negative-stock override: not possible in v1 (CHECK constraint); see ADR 0002.
- Legacy opening balances/stock must be imported as OPENING ledger entries so `reconcile()` stays clean.
- Whether payments may be allocated to specific bills (`sale_bill_id`) or only to the account balance: decide in M5.
- Settings keys (business name, address, GSTIN, bank, terms, tax display rules, `warn_below_cost`, `allow_negative_stock_override`) to be listed in M10.
