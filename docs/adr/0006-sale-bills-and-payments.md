# ADR 0006: Sale bills, customer payments and settings

**Status:** accepted (M5)

## Lifecycle
DRAFT (editable, deletable, touches nothing else) -> CONFIRMED (frozen) -> CANCELLED (frozen, number stays used). Corrections to an issued bill are always cancel + re-issue.

## Confirming a bill is one transaction
Re-check everything against today's data; take the next invoice number; freeze the customer's name, address, GSTIN and state and each line's description, HSN and unit on the bill;
reduce stock (checked per item across all lines, every shortage reported together); add the total to the customer's dues; record any money taken at the time (numbered receipt + ledger +
allocation); audit. If any step fails, nothing is saved and the invoice number is not used (tested by forcing a failure at the last step).
- The **tax rate, HSN, name and unit** are taken fresh at confirmation; the **rate and discount** are the ones agreed on the draft.
- Business state and invoice prefix must be set in Settings first (no defaults are invented). Customer state decides INTRA (CGST+SGST) or INTER (IGST).
- Invoice date may be today or earlier, never in the future. Numbers are `prefix + 2-digit FY start + sequence`, restarting each financial year (April to March).
- A customer waiting for approval can be drafted against but not confirmed. Inactive items and customers cannot be sold to or from.

## Prices and permissions
- Selling at the item's rate needs only `sale.create`. Any other rate, or any discount, needs `price.edit`.
- Selling below cost (after discount, before tax, when a purchase rate is known) is never blocked: confirmation asks for an explicit acknowledgement (`ACK_REQUIRED`), which is audited
  (`BELOW_COST_ACK`). The owner can switch the warning off in Settings (`warnBelowCost`).
- Viewing bills needs `sale.create`, `customer.view` or `report.view`. Cancelling needs `bill.cancel` and a reason.

## Payments
- Every payment (including money taken at the time of sale) gets a numbered receipt (own series), a ledger entry, and the customer's balance right after it is stored on the payment.
- **Allocation:** a payment settles the customer's confirmed bills oldest first, or the named bill first. A bill's outstanding amount = total - allocations of payments that are not reversed
  (migration 003, append-only). Whatever cannot be allocated (dues carried in as an opening balance, or an advance) stays unallocated.
- A payment above what the customer owes is refused (`OVERPAYMENT`) unless the owner has allowed advances for that customer (`setAdvanceAllowed`, owner only; cannot be switched off while a credit exists).
  Advances reduce the account balance but are not applied to later bills automatically.
- **Reversal** (bounced cheque, refund) needs `payment.reverse` and a reason; the payment stays on record, marked reversed, the dues come back and the bill's allocation is freed.
- **Cancelling a bill that has money recorded against it** is refused until those payments are reversed (refunded). This keeps the ledger honest and avoids hidden credits.
  A payment that covered several bills must be reversed as a whole and re-recorded.
- Payment methods are the list in Settings (default Cash, UPI, Cheque, Bank transfer, Card); whatever is typed is stored in the Settings spelling.

## Not in this milestone
Partial returns / credit notes (cancel and re-issue instead), printing and PDF (M7), purchase bills (done in M6, ADR 0007), and the full settings screen (M10: address, bank details, terms, logo, copy labels).

## Integrity
`checkIntegrity` now also flags a payment allocated for more than its amount and a bill allocated for more than its total.
