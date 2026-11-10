# ADR 0008: Printing, PDF export and the business details on invoices

**Status:** accepted (M7)

## One HTML document is the preview, the printout and the PDF
`renderInvoiceHtml(bill, business, copyLabels)` is a pure function that returns one self-contained HTML document for the A4 "Tax Invoice cum Challan"; `PrintService.invoice` wraps it
(permission check, settings, logo, warnings, suggested file name). The on-screen preview shows that HTML; printing and PDF export use the same HTML, so they cannot differ.
- The Electron shell (a later milestone) loads the HTML into a hidden window with JavaScript off and calls `webContents.print()` or `printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })`.
  Nothing in the page depends on Electron.
- The page needs nothing from the internet: fonts are the computer's own (Arial, then DejaVu Sans), the logo is embedded, there are no scripts, and a content-security policy
  (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) forbids everything else. Every typed value is HTML-escaped (names, addresses, notes, terms, order numbers).
- During development the layout was checked by rendering the HTML to PDF with WeasyPrint and looking at the pages. Chromium (inside Electron) is the real renderer; it should be re-checked
  once, on the shop's printer, when the shell exists.

## Layout (follows the supplied sample)
Business heading and contact/GST line; copy label; title; Bill To (the customer details frozen on the bill) with invoice no./date, order no./date, transport mode, vehicle no., date and place of supply;
the item table (description, HSN, qty, UOM, rate, amount, discount, taxable value, CGST rate/amount, SGST rate/amount, total) with a totals row that repeats its header across pages;
amount in words and the delivery-charge note; the totals box (before tax, CGST, SGST, total tax, round off, after tax); bank details, terms, declaration, authorized signatory, common seal, buyer's signature.
- Inter-state bills show IGST columns instead of CGST/SGST.
- The **round-off is shown as its own line** when it is not zero. (The sample omits it, so its printed figures do not quite add up: 2,542.37 + 457.62 = 2,999.99, printed total 3,000.00.)
- Place of supply falls back to the customer's state when no town was entered.
- Drafts print once, with a "DRAFT - NOT A TAX INVOICE" watermark, "DRAFT" in place of a number and no copy label. Cancelled bills carry a "CANCELLED" watermark.
- **Copies:** one page set per label in Settings (default Original for Recipient / Duplicate for Transporter / Triplicate for Supplier, as listed on the sample; editable; empty = one page with no label).

## Business details are settings, never code
Name, address, phone, email, GSTIN (format and check digit, and it must agree with the business state), bank name/branch/account/IFSC (account number masked in the audit trail), terms and conditions,
declaration sentence (default: the sample's "Certified that the particulars given above are true and correct", editable), invoice title, copy labels, and an optional logo (PNG or JPEG, up to 300 KB,
checked by the file's own bytes; SVG is refused because it can carry scripts; the picture is never copied into the audit trail).
Nothing from the sample's real customer, bank or tax details is in the program. If something is missing the invoice leaves that block out, and the preview lists what to fill in (`warnings`).

## Other printouts
Customer statement (opening balance, every entry, closing balance), customers with balance due (today or as at a past day), stock list, and stock movements share one table renderer (`renderReportHtml`),
with dd/mm/yyyy dates in shop-local time and safe file names. Reports in the reports milestone will use the same renderer.

## Audit
After a real print or PDF save the shell calls `recordPrint`, which writes `INVOICE_PRINT` (who, which bill, print or PDF, which copies). Reprints are therefore visible.
