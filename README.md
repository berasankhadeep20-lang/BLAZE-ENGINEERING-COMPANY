# BLAZE ENGINEERING COMPANY: Billing & Inventory (offline desktop app)

Offline-first desktop application for an Indian milk-testing-equipment and chemical wholesale business:
purchase and sale bills, stock, customer dues, reports, owner/employee accounts, backup/restore, and A4 tax invoice printing.

**Status:** M0 (scaffold, money/GST engine), M1 (Unit of Work, audit, number series, ledgers, reconciliation) and M2 (accounts, sessions, permissions) and M3 (items, stock corrections, movement history) M4 (customers, suppliers, approval, dues, statements) M5 (sale bills, customer payments, settings) M6 (purchase bills, supplier payments, editable rate per piece) M7 (A4 invoice, statements and report printouts, business details in Settings) and M8 (reports and dashboard numbers) complete.
There is no application window yet; the first window (login) arrives with the auth milestone.

## Stack
Electron + TypeScript + React (Vite) + Tailwind + SQLite (better-sqlite3). Windows 10 is the target for the shop PC.

## Documents
- `docs/SRS.md`: requirements
- `docs/ARCHITECTURE.md`: layers, process model, cross-cutting decisions, repo layout
- `docs/DATABASE_SCHEMA.md`: conventions, table map, schema notes
- `docs/API_MODULES_TESTING_ROADMAP.md`: IPC API, module build order, testing strategy, board and roadmap
- `src/infrastructure/db/migrations/001_initial.sql`: first migration

## Run (developer)
Requires Node.js 22 LTS or newer.
```bash
npm install
npm run check   # typecheck + lint + tests
npm test        # tests only
```
`npm run dev` and `npm run dist` (Windows installer) arrive with the Electron shell in a later milestone.

## What exists so far
- `src/domain/`: `money` (paise/quantity primitives), `gst` (line, delivery and bill totals, round-off, delivery back-solve), `words` (Indian-numbering amount in words), `billNumber` (financial year, invoice numbers)
- `src/infrastructure/db/`: `connection` (WAL, synchronous=FULL, foreign keys), `migrate` (checksummed, transactional migrations), `migrations/001_initial.sql`
  - `unitOfWork` (one transaction per use case), `audit` (append-only, secret-redacting), `numberSeries` (gap-free numbers),
    `ledgers` (the only way to change stock and balances), `reconcile` (cache vs ledger check)
- `src/domain/`: also `permissions` (catalogue, owner-only list, employee defaults) and `password` (input rules)
- `src/application/auth/`: `AuthService` (first-run setup, sign-in with lockout, sessions, change password, owner recovery code, `authorize`), `UserService` (create/disable/reset employees, set permissions), `SessionStore`
- `src/application/inventory/`: `ItemService` (create/edit with split permissions, search and filters, categories, CSV export), `StockService` (loss and physical-count corrections, movement history, low-stock list, integrity check)
- `src/application/parties/`: `CustomerService` (create/edit, owner approval queue, search, dues as of any day, statements, CSV), `SupplierService`, shared validation and statement builder
- `src/application/sales/`: `SaleService` (draft, confirm, cancel, list), `PaymentService` (receipts, oldest-first allocation, reversals, advances), shared payment mechanics
- `src/application/purchases/`: `PurchaseService` (draft, confirm, partial receipt, cancel, list, rate quote and live preview), `SupplierPaymentService`, shared supplier-payment mechanics
- `src/application/print/`: `renderInvoiceHtml` (the A4 Tax Invoice cum Challan), `renderReportHtml` (statements, stock lists, dues, movements), `PrintService` (preview/print/PDF source, copy labels, warnings, print audit)
- `src/application/reports/`: `ReportService` (best sellers, customer purchase history, sales and purchases by day or month, low or no movement, purchases by supplier, dashboard numbers) and `ReportTable` (one table feeds the screen, the CSV and the printout)
- `src/application/settings/`: `SettingsService` and `readSettings` (business state, invoice prefix, rounding, payment methods, below-cost warning)
- `src/domain/gstin.ts`: GSTIN check digit, Indian state codes, intra/inter-state rule
- `src/infrastructure/security/`: argon2id password hasher
- `src/shared/`: typed `AppError` codes, injectable clock
- `tests/`: unit tests for the domain, integration tests for migrations, the database-enforced rules, atomicity and ledger invariants
- `docs/adr/`: 0001 money and rounding; 0002 Unit of Work and ledger posting; 0003 accounts, sessions and permissions; 0004 items and stock; 0005 customers and suppliers; 0006 sale bills and payments; 0007 purchases and the editable rate per piece; 0008 printing; 0009 reports and dashboard

## Data safety
Never commit real business data, `.mdb`/`.sqlite`/`.blazebak` files, bank or GSTIN details, or the real sample bill.
Keep this repository private while it contains anything business-specific.
