# API, Modules, Testing, Board and Roadmap

## IPC API (`api.<module>.<action>(input) -> Result<T, AppError>`)
Services re-check permissions; hiding UI is never the security.
| Module | Calls |
|---|---|
| auth | login, logout, currentUser, changePassword |
| users (owner) | list, create, setActive, resetPassword, setPermissions |
| items | list(filters), get, create, update, setActive |
| stock | movements(filters), adjust(itemId, delta, reason), lowStock, reconcile |
| customers | list, get, create, update, approve, reject, statement(id, range) |
| suppliers | list, get, create, update, ledger |
| sales | saveDraft, confirm, cancel(id, reason), get, list, preview(id), exportPdf(id) |
| purchases | saveDraft, confirm, cancel, get, list |
| payments | recordCustomer, reverseCustomer, recordSupplier, list |
| reports | bestSellers, customerHistory, salesTotals, dues, lowMovement, purchasesBySupplier |
| backup | createNow, verify, restore(path, confirmToken), lastBackup |
| settings | get, update, uploadLogo |
| demo | enter, exit, reset |

Typed errors: INSUFFICIENT_STOCK, PERMISSION_DENIED, VALIDATION, OVERPAYMENT, CUSTOMER_NOT_APPROVED.

## Module build order
1. Core: Money, GST engine (intra/inter, delivery GST, round-off), amount in words (lakh/crore), number series
2. DB infrastructure: connection, migrations runner, Unit of Work, audit helper
3. Auth and permissions
4. Items and stock ledger
5. Customers/suppliers (with approval)
6. Sale bills + payments + dues
7. Purchase bills
8. Invoice template/PDF
9. Reports
10. Backup/restore + demo mode
11. Settings, dashboard, polish, installer

## Testing strategy
- Unit (domain): GST splits, rounding, paise arithmetic, amount in words. **Golden test from the sample bill:** the engine must reproduce
  line totals 2183.00 / 129.80 / 578.20 (goods 2891.00), before-tax 2542.37, CGST 228.81, SGST 228.81, total tax 457.62, total 3000.00
  (delivery 92.37 + 18% GST -> 2999.99, plus round-off +0.01). Use a sanitized fake customer in fixtures, never real data.
- Integration (services + in-memory SQLite), one file per rule: purchase adds stock; sale subtracts stock; insufficient stock blocks;
  partial payment reduces due; forced failure mid-confirm rolls back bill+stock+balance together; backup -> restore preserves every table.
- Property tests: random bill sequences keep `item.qty_milli` == sum of movements and `customer.balance` == ledger sum.
- Trigger tests: the immutability rules in DATABASE_SCHEMA.md.
- E2E (Playwright for Electron): login, create bill, print preview smoke.
- CI (GitHub Actions): lint, typecheck, tests on every push.

## GitHub board
Columns: Backlog -> In progress -> Review -> Done. One milestone per module (M0 scaffold ... M11 release), with issues such as
"GST engine + golden test", "Confirm sale transaction", "Restore with pre-restore backup".

## Roadmap
- M0 scaffold + CI + migration runner + Money/GST + golden test
- M1-M9 modules in the build order above
- M10 backup/restore, demo mode
- M11 settings, dashboard, Windows installer (GitHub Actions Windows runner builds the .exe)

## Run
    npm install
    npm run dev     # app with hot reload
    npm test
    npm run dist    # Windows installer
(Commands become available when the M0 scaffold is added. The shop PC needs only the installer, no internet.)
