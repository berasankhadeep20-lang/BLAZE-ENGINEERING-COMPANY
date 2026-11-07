# System Architecture

## Style
Clean architecture with a transport-agnostic service layer. Dependencies point inward:

    UI (React) -> IPC adapter -> Application services -> Domain <- Repositories (SQLite)

- **Domain:** pure TypeScript (no Electron/SQL/React): Money, GST, bill state machine, number-to-words (Indian numbering), stock rules.
- **Application services:** use cases (ConfirmSaleBill, RecordPayment, CancelBill, AdjustStock, CreateBackup). Each runs in one Unit of Work
  transaction, checks permissions, writes the audit log.
- **Repositories:** the only layer that knows SQL; services depend on interfaces.
- **Transport adapters:** v1 = Electron IPC. A later HTTP adapter calls the same services (LAN/remote seam).

## Process model (Electron)
- Main process owns DB, services, session, file dialogs, backup, PDF.
- Preload exposes a narrow typed `window.api` via contextBridge (contextIsolation on, nodeIntegration off).
- Renderer has no DB/filesystem access. Services re-check permissions; hiding UI is cosmetic.

## Cross-cutting decisions
| Concern | Decision |
|---|---|
| Money | Integer paise in a `Money` value object; half-up per line, visible round-off line on the bill |
| Atomicity | better-sqlite3 `db.transaction()` per use case; any throw rolls back bill, stock, balance, audit |
| Crash safety | WAL, synchronous=FULL, foreign_keys=ON |
| Stock check | Re-read inside the confirm transaction, decrement, assert >= 0; CHECK constraint as last defense |
| Immutability | Confirmed bills never UPDATEd/DELETEd except the controlled CONFIRMED->CANCELLED transition; triggers enforce it |
| Ledgers | Append-only stock_movement / customer_ledger / supplier_ledger; cached qty/balance updated in the same transaction; reconciliation check available |
| Customer snapshot | Name/address/GSTIN copied onto the sale bill at confirm time |
| Auth | argon2id, in-memory session in main, lockout/backoff |
| Demo mode | Separate demo.sqlite with persistent DEMO banner |
| Backup | SQLite online backup API + manifest (schema version, app version, row counts, SHA-256) in a `.blazebak`; verified by reopening before success is reported |
| Migrations | Numbered SQL files + schema_migrations; applied transactionally at startup after an automatic pre-migration backup |
| PDF/print | A4 HTML/CSS template in a hidden window; same template for preview, print, printToPDF; bundled fonts |
| Validation | Zod schemas shared by UI and services |

## Repository layout
    docs/            SRS, architecture, schema, ADRs, user guide
    src/domain/      money, gst, billing rules, state machines, words
    src/application/ use-case services, permissions, UnitOfWork ports
    src/infrastructure/db/ (connection, migrations/, repositories), backup/, pdf/
    src/main/        Electron main, IPC handlers, windows
    src/preload/     typed contextBridge API
    src/renderer/    React app
    src/shared/      zod schemas, DTO types
    tests/           unit (domain), integration (services+SQLite), e2e
    tools/legacy-import/  later: .mdb -> staging -> mapping
    .github/         CI, issue templates

## Why
- Integer paise: binary floats cannot represent 0.1 exactly, so sums drift; invoices must add up to the paisa.
- Append-only ledger + cached balance: double-entry thinking for inventory; history is truth, cache is an optimisation verified by reconciliation.
- ACID per use case: atomicity gives all-or-nothing; WAL + synchronous=FULL gives durability across power loss.
