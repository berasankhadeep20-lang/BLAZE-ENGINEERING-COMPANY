# ADR 0005: Customers, suppliers, approval, dues and statements

**Status:** accepted (M4)

## Decisions
- **State is mandatory** for every customer and supplier (it decides CGST+SGST versus IGST). It may be taken from the GSTIN. If both are given they must agree.
  `taxTypeForSupply(sellerState, buyerState)` is the single rule billing will use.
- **GSTIN** is validated for format, a known state code and the base-36 check digit (the rule was verified against real GSTINs), stored upper-case, and
  must be unique per customer and per supplier (service check plus a unique index in migration 002). Blank means unregistered and prints as `UN-REGD`, as on the sample bill.
  The app cannot tell whether a number is actually registered or belongs to that party; that stays the owner's responsibility. The state list follows the GST state codes;
  confirm it against the GST portal if a code ever looks wrong.
- **Approval.** Owner-created customers are approved immediately. Employee-created customers are PENDING: they can be used on a draft bill but a bill cannot be confirmed
  until the owner approves (`assertCustomerUsable(db, id, 'CONFIRM')`, called by billing). Rejection needs a reason; a rejected customer is hidden by default and unusable,
  but the owner can approve it later. Approving and rejecting are owner-only (`customer.approve`) and audited.
- **Who may edit.** Needs `customer.edit`, except that the creator of a still-PENDING customer may correct it before review. Only changed fields are written and audited (old and new values).
- **Issued bills never change.** A bill stores its own copy of the customer's name, address, GSTIN and state at confirmation (ADR 0002 / schema). Editing a customer touches only the customer
  row; this is tested against an already-confirmed bill.
- **Opening balances** (dues or amounts owed from before this software) are owner-only, must be zero or more, and are posted as `OPENING` ledger entries so the books keep agreeing.
  Advances (negative customer balances) and the `advance_allowed` workflow are left to the payments milestone.
- **A party with a balance cannot be made inactive**, so nobody drops out of the dues list while still owing money. Inactive parties cannot be billed.
- **Dues** list who owes money (largest first) with the total outstanding, last sale and last payment dates, and can be rebuilt as at the end of any past local day from the ledger.
  Advances are listed only on request and never reduce the total outstanding.
- **Statements** (customer and supplier) cover an inclusive range of local dates: opening balance, every entry, closing balance; opening + increases - reductions always equals closing.
  They are exported as CSV with real numbers. Printable/PDF statements arrive with the print milestone.
- **Search** covers name, GSTIN, email, address, place of supply and phone (digits-only matching ignores spaces, dashes and brackets); `%` and `_` match literally.
- **Supplier payments** are tracked on the separate supplier ledger, never mixed with customer receivables. Purchase history by bill arrives with the purchase milestone; until then
  the supplier statement is the history.

## Permissions used
`customer.view`, `customer.create`, `customer.edit`, `customer.approve` (owner only), `supplier.view`, `supplier.edit`.
