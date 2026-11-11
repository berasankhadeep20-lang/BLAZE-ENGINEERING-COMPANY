# ADR 0009: Reports and the dashboard numbers

**Status:** accepted (M8)

## One table for screen, spreadsheet and paper
Every report produces a `ReportTable` (title, subtitle, typed columns, rows, optional totals row). The screen, the CSV export and the printout are all made from that one table, so they cannot disagree.
Money cells hold paise and quantity cells hold thousandths; CSV writes them as real numbers (rupees and units), dates stay `yyyy-mm-dd` so they sort, and the printout uses Indian digit grouping and `dd/mm/yyyy`.
Wide tables (more than 6 columns) print landscape. An empty report says "Nothing to show for these filters." instead of printing a row of zeros.

## What counts
- **Only CONFIRMED bills.** Drafts and cancelled bills never inflate a figure. Cancelled bills are listed apart (count and value) on the sales and purchases report, for transparency.
- **Dates are local calendar dates**, inclusive, matched against the invoice date (sales), bill date (purchases), payment date, or the date goods were received. Nothing in the reports depends on the UTC clock.
- **Quantity is never mixed across items** (different units cannot be added). Every quantity is per item.
- **Sales value** is shown both before tax (the taxable value of the lines) and including tax. Delivery charges and round-off belong to the bill, not to an item, so they appear only in bill totals.

## The reports (spec -> where)
| Spec item | Report |
|---|---|
| Best-selling items by quantity, bill count and sales value | `BEST_SELLERS` (rank by quantity, bills or value; units and bills are separate columns) |
| Customer purchase history: each item, total quantity, number of separate bills containing it, dates, sales value | `CUSTOMER_HISTORY` (10 units in one bill = 10 units, 1 bill; a bill counts once even if the item is on two lines) |
| Sales and purchase totals by day, month, custom range | `SALES_AND_PURCHASES` (group by day, month or the whole range; also shows money collected from customers and paid to suppliers; payments that were reversed are not counted) |
| Customer balances and payment history | `CustomerService.dues` / `statement` (M4) and `PaymentService.list` (M5), printable via `PrintService` (M7) |
| Low-stock and inventory movement reports | `StockService.lowStock` / `movements` (M3), printable (M7) |
| Items with low or no movement | `LOW_MOVEMENT` (default: last 90 days; sold nothing, or at most a chosen number of units; in stock only unless asked; dead stock with the most money tied up first; shows stock at cost, last sale and days since) |
| Purchase totals by supplier | `PURCHASES_BY_SUPPLIER` (bills, before tax, tax, total, paid in the period, owed now) |

## Permissions
All reports need `report.view`. The customer purchase history is also open to `customer.view` (it is the customer's own record). Reports reveal costs and margins, so `report.view` is not an employee default.

## Dashboard
`ReportService.dashboard` returns the numbers for the dashboard screen; each section is filled only for a user allowed to see it (otherwise `null`):
sales today and month to date (`report.view`); customer dues (`customer.view`); stock counts, out-of-stock and low-stock items (`inventory.view`; the **cost** of stock only with `report.view`);
the last 8 issued or cancelled bills and the number of open drafts (`sale.create`, `customer.view` or `report.view`); customers waiting for approval (`customer.approve`);
purchases with goods still to arrive; and what we owe suppliers (`supplier.view`).
