# BLAZE ENGINEERING COMPANY: Billing & Inventory (offline desktop app)

Offline-first desktop application for an Indian milk-testing-equipment and chemical wholesale business:
purchase and sale bills, stock, customer dues, reports, owner/employee accounts, backup/restore, and A4 tax invoice printing.

**Status:** planning complete (SRS, architecture, schema). Application code starts at milestone M0.

## Stack
Electron + TypeScript + React (Vite) + Tailwind + SQLite (better-sqlite3). Windows 10 is the target for the shop PC.

## Documents
- `docs/SRS.md`: requirements
- `docs/ARCHITECTURE.md`: layers, process model, cross-cutting decisions, repo layout
- `docs/DATABASE_SCHEMA.md`: conventions, table map, schema notes
- `docs/API_MODULES_TESTING_ROADMAP.md`: IPC API, module build order, testing strategy, board and roadmap
- `src/infrastructure/db/migrations/001_initial.sql`: first migration

## Run (available once the M0 scaffold is added)
```bash
# install Node.js 20 LTS first
npm install
npm run dev     # launch the app
npm test        # run tests
npm run dist    # build the Windows installer
```

## Data safety
Never commit real business data, `.mdb`/`.sqlite`/`.blazebak` files, bank or GSTIN details, or the real sample bill.
Keep this repository private while it contains anything business-specific.
