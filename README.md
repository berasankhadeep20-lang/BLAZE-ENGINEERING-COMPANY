# BLAZE ENGINEERING COMPANY: Billing & Inventory (offline desktop app)

Offline-first desktop application for an Indian milk-testing-equipment and chemical wholesale business:
purchase and sale bills, stock, customer dues, reports, owner/employee accounts, backup/restore, and A4 tax invoice printing.

**Status:** M0 (scaffold, money/GST engine) and M1 (Unit of Work, audit, number series, ledger posting, reconciliation) complete.
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
- `src/shared/`: typed `AppError` codes, injectable clock
- `tests/`: unit tests for the domain, integration tests for migrations, the database-enforced rules, atomicity and ledger invariants
- `docs/adr/`: 0001 money and rounding; 0002 Unit of Work and ledger posting

## Data safety
Never commit real business data, `.mdb`/`.sqlite`/`.blazebak` files, bank or GSTIN details, or the real sample bill.
Keep this repository private while it contains anything business-specific.
