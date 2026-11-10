/**
 * The printed A4 "Tax Invoice cum Challan", laid out like the supplied sample: business heading and contact/GST line, the title, invoice and order details,
 * Bill To, the item table (description, HSN, quantity, UOM, rate, amount, discount, taxable value, CGST and SGST rate and amount, total), the totals box,
 * amount in words, delivery note, terms, declaration, bank details, seal and signatures. Inter-state bills show IGST instead of CGST and SGST.
 *
 * This is a pure function: bill + business details in, one self-contained HTML document out (one page set per copy label). The same HTML is used for the
 * on-screen preview, for printing and for PDF export, so they can never differ. No scripts and no external files: fonts are the computer's own,
 * the logo is embedded, and a content-security policy forbids everything else.
 */
import { formatINR, formatQty } from '../../domain/money';
import { bpToPercent, displayDate, escapeHtml } from '../../shared/format';
import type { SaleBillDto } from '../sales/saleService';

export interface InvoiceBusiness {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  title: string;
  terms: string | null;
  declaration: string;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  logoDataUri: string | null; // data:image/png or data:image/jpeg only
}

export interface InvoiceRenderInput {
  bill: SaleBillDto;
  business: InvoiceBusiness;
  copyLabels: string[]; // one page set per label; empty = one page set with no label
}

const esc = escapeHtml;
const multiline = (s: string): string => esc(s).replace(/\r?\n/g, '<br>');
const money = (paise: number): string => formatINR(paise);

const CSS = `
@page { size: A4; margin: 7mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, "DejaVu Sans", sans-serif; font-size: 8pt; color: #000; }
.copy { page-break-after: always; position: relative; }
.copy:last-child { page-break-after: auto; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 0.6pt solid #000; padding: 1.4mm 1.6mm; vertical-align: top; }
.head td { text-align: center; padding: 2mm; }
.biz-name { font-size: 15pt; font-weight: bold; letter-spacing: 0.3pt; }
.biz-line { font-size: 8pt; margin-top: 0.8mm; }
.logo { max-height: 17mm; max-width: 38mm; }
.copy-label { font-size: 7.5pt; font-weight: bold; text-align: center; vertical-align: middle; width: 32mm; }
.title td { text-align: center; font-size: 11pt; font-weight: bold; padding: 1.2mm; }
.meta td { padding: 1mm 1.6mm; }
.meta .k { font-weight: bold; white-space: nowrap; width: 27mm; border-right: 0; }
.meta .v { border-left: 0; }
.billto .t { font-weight: bold; font-size: 7.5pt; text-decoration: underline; }
.billto .n { font-weight: bold; font-size: 9pt; }
table.items { table-layout: fixed; }
table.items thead { display: table-header-group; }
table.items tr { page-break-inside: avoid; }
table.items th { text-align: center; font-size: 7pt; background: #eeeeee; vertical-align: middle; padding: 1mm 0.8mm; }
table.items td { font-size: 7.6pt; padding: 1.2mm 1mm; }
.r { text-align: right; white-space: nowrap; }
.c { text-align: center; }
.desc { word-wrap: break-word; }
.total-row td { font-weight: bold; background: #f6f6f6; }
.sum td { padding: 1.2mm 2mm; }
.sum .lbl { font-weight: bold; }
.sum .amt { text-align: right; white-space: nowrap; width: 28mm; }
.sum .strong td { font-weight: bold; font-size: 9pt; }
.words { font-weight: bold; }
.foot { page-break-inside: avoid; }
.foot td { padding: 2mm; }
.sign { height: 20mm; }
.small { font-size: 7.4pt; }
.wm { position: fixed; top: 38%; left: 0; right: 0; text-align: center; font-size: 54pt; font-weight: bold; color: #cc0000; opacity: 0.16; transform: rotate(-22deg); }
`;

function businessHeader(b: InvoiceBusiness, copyLabel: string | null): string {
  const contact = [b.gstin ? `GSTIN : ${esc(b.gstin)}` : '', b.email ? `Email : ${esc(b.email)}` : '', b.phone ? `Phone : ${esc(b.phone)}` : ''].filter(Boolean).join('&nbsp;&nbsp;&nbsp;');
  const logo = b.logoDataUri && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(b.logoDataUri) ? `<img class="logo" src="${b.logoDataUri}" alt="">` : '';
  return `<table class="head"><tr>
    <td style="width:${logo ? '40mm' : '0'};${logo ? '' : 'display:none;'}">${logo}</td>
    <td><div class="biz-name">${esc(b.name)}</div>
      ${b.address ? `<div class="biz-line">${multiline(b.address)}</div>` : ''}
      ${contact ? `<div class="biz-line">${contact}</div>` : ''}</td>
    ${copyLabel ? `<td class="copy-label">${esc(copyLabel)}</td>` : ''}
  </tr></table>`;
}

function itemTable(bill: SaleBillDto): string {
  const inter = bill.taxType === 'INTER';
  const cols = inter
    ? ['24%', '6.5%', '4%', '9%', '8%', '9%', '6.5%', '10%', '5%', '8%', '10%']
    : ['21%', '6.5%', '3.5%', '9%', '7.5%', '8.5%', '5.5%', '8.5%', '4%', '6.5%', '4%', '6.5%', '9%'];
  const head = inter
    ? `<tr><th rowspan="2">Product Description</th><th rowspan="2">HSN Code</th><th rowspan="2">Qty</th><th rowspan="2">UOM</th><th rowspan="2">Rate<br>Rs.</th><th rowspan="2">Amount<br>Rs.</th><th rowspan="2">Discount<br>Rs.</th><th rowspan="2">Taxable<br>Value Rs.</th><th colspan="2">IGST</th><th rowspan="2">Total<br>Rs.</th></tr>
       <tr><th>Rate %</th><th>Amt (Rs.)</th></tr>`
    : `<tr><th rowspan="2">Product Description</th><th rowspan="2">HSN Code</th><th rowspan="2">Qty</th><th rowspan="2">UOM</th><th rowspan="2">Rate<br>Rs.</th><th rowspan="2">Amount<br>Rs.</th><th rowspan="2">Discount<br>Rs.</th><th rowspan="2">Taxable<br>Value Rs.</th><th colspan="2">CGST</th><th colspan="2">SGST</th><th rowspan="2">Total<br>Rs.</th></tr>
       <tr><th>Rate %</th><th>Amt (Rs.)</th><th>Rate %</th><th>Amt (Rs.)</th></tr>`;
  const rows = bill.lines
    .map((l) => {
      const amount = l.taxablePaise + l.discountPaise;
      const tax = inter
        ? `<td class="c">${bpToPercent(l.gstRateBp)}</td><td class="r">${money(l.igstPaise)}</td>`
        : `<td class="c">${bpToPercent(l.gstRateBp / 2)}</td><td class="r">${money(l.cgstPaise)}</td><td class="c">${bpToPercent(l.gstRateBp / 2)}</td><td class="r">${money(l.sgstPaise)}</td>`;
      return `<tr><td class="desc">${esc(l.description)}</td><td class="c">${esc(l.hsn ?? '')}</td><td class="c">${formatQty(l.qtyMilli)}</td><td class="c">${esc(l.uomLabel)}</td>
        <td class="r">${money(l.ratePaise)}</td><td class="r">${money(amount)}</td><td class="r">${money(l.discountPaise)}</td><td class="r">${money(l.taxablePaise)}</td>${tax}<td class="r">${money(l.totalPaise)}</td></tr>`;
    })
    .join('');
  const sum = (f: (l: SaleBillDto['lines'][number]) => number): number => bill.lines.reduce((s, l) => s + f(l), 0);
  const totalTax = inter ? `<td></td><td class="r">${money(sum((l) => l.igstPaise))}</td>` : `<td></td><td class="r">${money(sum((l) => l.cgstPaise))}</td><td></td><td class="r">${money(sum((l) => l.sgstPaise))}</td>`;
  const totalRow = `<tr class="total-row"><td colspan="5" class="r">Total</td><td class="r">${money(sum((l) => l.taxablePaise + l.discountPaise))}</td><td class="r">${money(sum((l) => l.discountPaise))}</td><td class="r">${money(sum((l) => l.taxablePaise))}</td>${totalTax}<td class="r">${money(sum((l) => l.totalPaise))}</td></tr>`;
  return `<table class="items"><colgroup>${cols.map((w) => `<col style="width:${w}">`).join('')}</colgroup><thead>${head}</thead><tbody>${rows}${totalRow}</tbody></table>`;
}

function summary(bill: SaleBillDto): string {
  const t = bill.totals;
  const inter = bill.taxType === 'INTER';
  const roundOff = t.roundOffPaise === 0 ? '' : `<tr><td class="lbl">Round off</td><td class="amt">${t.roundOffPaise > 0 ? '+' : '-'}${money(Math.abs(t.roundOffPaise))}</td></tr>`;
  const deliveryNote = t.deliveryPaise > 0 ? `<div style="margin-top:2mm;">Delivery charges Rs.${money(t.deliveryPaise)} added in Bill with ${bpToPercent(t.deliveryGstRateBp)}% GST</div>` : '';
  const taxRows = inter
    ? `<tr><td class="lbl">Add : IGST</td><td class="amt">Rs. ${money(t.igstPaise)}</td></tr>`
    : `<tr><td class="lbl">Add : CGST</td><td class="amt">Rs. ${money(t.cgstPaise)}</td></tr><tr><td class="lbl">Add : SGST</td><td class="amt">Rs. ${money(t.sgstPaise)}</td></tr>`;
  return `<table class="sum"><tr>
    <td style="width:52%"><div>Invoice Amount in Words :</div><div class="words" style="margin-top:1mm;">${esc(t.amountInWords)}</div>${deliveryNote}</td>
    <td style="padding:0;"><table style="border:0;">
      <tr><td class="lbl">Total Amount before Tax</td><td class="amt">Rs. ${money(t.taxableTotalPaise)}</td></tr>
      ${taxRows}
      <tr><td class="lbl">Total Tax Amount</td><td class="amt">Rs. ${money(t.totalTaxPaise)}</td></tr>
      ${roundOff}
      <tr class="strong"><td class="lbl">Total Amount after Tax</td><td class="amt">Rs. ${money(t.totalPaise)}</td></tr>
    </table></td></tr></table>`;
}

function footer(b: InvoiceBusiness): string {
  const bank = [b.bankName ? esc(b.bankName) : '', b.bankBranch ? esc(b.bankBranch) : ''].filter(Boolean).join(', ');
  const bankBlock =
    bank || b.bankAccountNo || b.bankIfsc
      ? `<div><b>Bank Details:</b></div>${bank ? `<div>Bank A/c: ${bank}</div>` : ''}<div>${b.bankAccountNo ? `A/c No.: ${esc(b.bankAccountNo)}` : ''}${b.bankAccountNo && b.bankIfsc ? '&nbsp;&nbsp;&nbsp;' : ''}${b.bankIfsc ? `Bank IFSC: ${esc(b.bankIfsc)}` : ''}</div>`
      : '';
  const terms = b.terms ? `<div style="margin-top:2mm;"><b>Terms and Conditions</b></div><div>${multiline(b.terms)}</div>` : '';
  return `<table class="foot small"><tr>
      <td style="width:55%">${bankBlock}${terms}</td>
      <td class="c">${esc(b.declaration)}<div class="sign"></div><div style="text-align:right;"><b>For ${esc(b.name)}</b></div><div style="text-align:right;margin-top:8mm;">Authorized Signatory</div></td>
    </tr><tr>
      <td style="height:24mm;">Common Seal</td>
      <td>Buyer's Signature</td>
    </tr></table>`;
}

function onePage(input: InvoiceRenderInput, copyLabel: string | null): string {
  const { bill, business: b } = input;
  const c = bill.customer;
  const draft = bill.status === 'DRAFT';
  const watermark = draft ? 'DRAFT - NOT A TAX INVOICE' : bill.status === 'CANCELLED' ? 'CANCELLED' : '';
  const kv = (k: string, v: string): string => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
  return `<section class="copy">
    ${watermark ? `<div class="wm">${esc(watermark)}</div>` : ''}
    ${businessHeader(b, copyLabel)}
    <table class="title"><tr><td>${esc(b.title)}</td></tr></table>
    <table class="meta"><tr>
      <td class="billto" style="width:52%"><div class="t">Bill To</div><div class="n">${esc(c.name)}</div>${c.address ? `<div>${multiline(c.address)}</div>` : ''}<div>GSTIN: ${esc(c.gstinDisplay)}</div></td>
      <td style="padding:0;"><table style="border:0;">
        ${kv('Invoice No :', esc(bill.billNo ?? 'DRAFT'))}${kv('Invoice Date :', displayDate(bill.invoiceDate))}
        ${kv('Order No :', esc(bill.orderNo ?? ''))}${kv('Order Date :', displayDate(bill.orderDate))}
        ${kv('Transport Mode :', esc(bill.transportMode ?? ''))}${kv('Vehicle No :', esc(bill.vehicleNo ?? ''))}
        ${kv('Date of Supply :', displayDate(bill.supplyDate))}${kv('Place of Supply :', esc(bill.placeOfSupply ?? ''))}
      </table></td></tr></table>
    ${itemTable(bill)}
    ${summary(bill)}
    ${footer(b)}
  </section>`;
}

export function renderInvoiceHtml(input: InvoiceRenderInput): string {
  const labels: (string | null)[] = input.copyLabels.length ? input.copyLabels : [null];
  const title = `${input.business.title} ${input.bill.billNo ?? 'DRAFT'}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>${labels.map((l) => onePage(input, l)).join('\n')}</body></html>`;
}
