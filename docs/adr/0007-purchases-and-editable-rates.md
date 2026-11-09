# ADR 0007: Purchase bills, supplier payments, and the editable rate per piece

**Status:** accepted (M6)

## The rate per piece on an invoice (sales)
- When a line is added, `SaleService.quoteLine` returns the item's **current sale rate per piece** (shown first), the stock on hand, and what this customer was last charged for the item.
  The user then types the rate they want for this bill; `preview` prices the whole bill live (totals, tax, below-cost flags, stock shortages) without saving anything and agrees to the paisa with saving.
- Typing a different rate, or giving a discount, needs the new permission **`sale.edit_rate`** ("change the rate on a bill; affects that bill only"). It is **on by default for new employees**; the owner can switch it
  off per employee. It is separate from **`price.edit`**, which still controls the item's own price in the master list. Typing the standard rate again is not a change.
- Every line stores the **standard rate in force when the bill was issued** (`list_rate_paise`) beside the **rate charged**, so any difference is visible afterwards (`rateChanged`), and the confirm audit entry
  counts the lines sold at a changed rate. The cost price is never shown on the invoice screen; below-cost is shown only as a flag.
- Selling below cost is still never blocked (acknowledgement required, audited), as decided in M5.

## Purchase bills
- A purchase is a **supplier's invoice** entered here: supplier invoice number and date, an internal number (default prefix `PB`, per financial year), order and transport details, lines, delivery charges, notes.
  The same supplier invoice number can be used once per supplier (capitals ignored) while that bill is not cancelled; the database enforces it as well as the service.
- Drafts add no stock. **Confirming** (one transaction) numbers the bill, freezes the supplier's and the lines' details, adds the **received** quantity to stock, adds the total to what we owe the supplier,
  records any payment made at the time, and audits.
- **Billed on the invoiced quantity, stocked on the received quantity.** Each line has an invoiced quantity (what the supplier billed) and a received quantity (default: the same; may be less; may be zero).
  Amounts and tax follow the invoice; stock follows what actually arrived. Goods that arrive later are recorded with `receive` (append-only `purchase_receipt` rows, never more than is pending).
- The rate per piece defaults to the item's current purchase rate and is edited to what the supplier charged (`quoteLine` also shows what this supplier last charged). Typing a rate does not change the item.
  Optionally `updateItemPurchaseRates` (needs `price.edit`) brings the items' purchase rates in line with the bill and is audited as a price change, so below-cost warnings stay meaningful.
- Supplier state vs business state decides CGST+SGST or IGST. Only the business state setting is required (no invoice prefix: the internal number has a harmless default).
- **Cancelling** needs `bill.cancel` and a reason: the received goods go back out of stock (refused if they have already been sold or written off), the amount comes off what we owe, and payments made against
  the bill must be reversed first. A cancelled bill frees its supplier invoice number.
- Not done in this milestone: attachments (the column exists), partial returns / debit notes (cancel and re-enter), and printing.

## Supplier payments
- Entirely separate from customer receivables: own ledger, own numbers (default prefix `SP`), own permission **`supplier.pay`** (not given to employees by default). Reversal reuses `payment.reverse`, with a reason.
- A payment may name a purchase bill (it may not exceed that bill's unpaid amount); unnamed payments reduce the account only. Paying more than is owed is refused. A bill's paid and outstanding amounts count
  only payments named for it that have not been reversed. (Unlike customers there is no oldest-first allocation; supplier payments are account-level unless a bill is named.)

## Integrity
`checkIntegrity` also flags goods received beyond what was invoiced.
