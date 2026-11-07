# ADR 0002: Unit of Work and ledger posting

**Status:** accepted (M1)

## Decision
- Every use case runs inside `UnitOfWork.run(actor, fn)`: one SQLite transaction, one fixed timestamp, one acting user. If `fn` throws,
  every write (bill, stock, balances, audit, number) rolls back together. `fn` must be synchronous; an async body is refused and rolled back.
- `item.qty_milli`, `customer.balance_paise` and `supplier.balance_paise` may only be changed through `postStockMovement`,
  `postCustomerLedger` and `postSupplierLedger`. Each updates the cached figure and appends the ledger row in the same transaction.
  User and time come from the transaction context, so callers cannot attribute a row to someone else or back-date it.
- Stock is checked inside `postStockMovement` at the moment of the write (not when the form opened). Insufficient stock raises
  `INSUFFICIENT_STOCK` and writes nothing. The `CHECK (qty_milli >= 0)` constraint is the second line of defence.
- Direction rules: PURCHASE/SALE_CANCEL/OPENING add stock; SALE/PURCHASE_CANCEL/DAMAGED/MISSING remove it; RETURN and COUNT_ADJUST may go either way.
  DAMAGED, MISSING and COUNT_ADJUST require a written note.
- Customer ledger: a sale posts `SALE +total`; money received at the time of sale posts a separate `PAYMENT -received`, so statements show both.
  A payment that would push the balance below zero raises `OVERPAYMENT` unless the customer has `advance_allowed`. Supplier balances never go below zero.
- Bill and receipt numbers come from `allocateNumber` inside the same transaction as the document, so a rolled-back confirm releases its number (no gaps).
- `recordAudit` appends inside the same transaction and redacts any key that looks like a secret (password, hash, secret, token).
- `reconcile(db)` compares each cached figure with its ledger sum and reports any difference. Opening balances imported later must be posted as `OPENING` ledger entries so this keeps holding.

## Consequences
- Services never write to the cached columns directly. A reviewer can grep for `UPDATE item SET qty_milli` and expect hits only in `ledgers.ts`.
- There is no negative-stock override in v1: the database constraint forbids it. If the owner later needs one, it means dropping the CHECK and enforcing the rule
  in the service with an audited, owner-only setting. Recommended: do not add it.
- The SQLite layer is used directly (better-sqlite3 is synchronous). Services import only these modules, so swapping the storage engine later stays contained.
