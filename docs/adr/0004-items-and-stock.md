# ADR 0004: Items, stock corrections and movement history

**Status:** accepted (M3)

## Decisions
- **Quantity is never edited directly.** An item's quantity changes only through the ledger (ADR 0002). `ItemService.update` has no quantity field.
  Opening stock for a new item is posted as an `OPENING` movement and needs `stock.adjust`.
- **Permissions.** Creating an item needs `item.create` AND `price.edit` (a new item carries rates and tax). Editing details needs `item.edit`; changing
  purchase rate, sale rate or GST rate needs `price.edit`. Only fields that actually change are checked, so a form that re-sends an unchanged price is fine.
- **Audit.** Price/GST changes are audited as `PRICE_CHANGE` (old and new values, user, time), other edits as `ITEM_UPDATE`. A no-op edit writes nothing.
- **GST rate is always supplied explicitly** and may be 0% to 100%. The app does not hard-code legal tax slabs; the owner verifies rates. (The earlier database
  limit of 28% was removed from migration 001 before any database existed.)
- **HSN** is format-checked only (2 to 8 digits). The app cannot know whether a code is right for the goods; the owner must verify it.
- **Unit** cannot change once an item has stock history (quantities would change meaning); create a new item instead. Code can change (bills keep their own copy).
- **Inactive items** disappear from lists by default and later from new bills, but remain in history and reports.
- **Corrections** are two workflows: *loss* (DAMAGED or MISSING, a positive quantity removed) and *physical count* (the counted figure is entered and the difference
  is computed inside the transaction from the quantity at that moment). Both need `stock.adjust` and a written reason of at least 3 characters, record the user,
  and write a `STOCK_ADJUST` audit entry with before/after figures.
- **Stock status:** OUT (nothing left), LOW (at or below a non-zero reorder level), OK. A reorder level of 0 means "never LOW".
- **Search** matches name, code, category and HSN, case-insensitively; `%` and `_` typed by the user match literally.
- **Local days.** Timestamps are stored in UTC; date filters take the shop's local calendar days and are converted to UTC bounds, so a movement at 00:30 IST on 1 Nov
  appears under 1 Nov (tested with the process time zone set to Asia/Kolkata).
- **CSV export** (stock list, movement history): UTF-8 with BOM for Excel; quantities are written as real numbers; any text starting with `=`, `+`, `-` or `@` is
  prefixed with an apostrophe so a spreadsheet can never execute it as a formula. Printable/PDF versions arrive with the print milestone.
- **Integrity check** (`checkIntegrity`, needs `audit.view`) compares cached stock and balances with their ledgers.
