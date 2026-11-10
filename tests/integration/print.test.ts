import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { makeEmployee, quickBill, sampleLines, shopHarness, type Shop } from '../helpers/shop';

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const BUSINESS = {
  businessName: 'BLAZE ENGINEERING COMPANY', businessAddress: '12 EXAMPLE ROAD, EXAMPLE NAGAR, KOLKATA-700000.', businessPhone: '+91 90000 00000',
  businessEmail: 'accounts@example.invalid', businessGstin: '19ABCDE1234F1ZX', bankName: 'EXAMPLE BANK', bankBranch: 'Example Branch', bankAccountNo: '000000000000',
  bankIfsc: 'EXAM0000001', invoiceTerms: 'SAMPLE TERMS: interest will be charged if the bill is not paid within 30 days.',
};
const count = (s: string, needle: string): number => s.split(needle).length - 1;

/** The sample bill, issued, with the business details filled in. */
async function issued(over: Record<string, unknown> = {}): Promise<{ h: Shop; billId: number }> {
  const h = await shopHarness();
  h.settings.update(h.ownerToken, { ...BUSINESS, ...over });
  const d = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-10-31', lines: sampleLines(h.ids), delivery: { amountPaise: 9237, gstRateBp: 1800 } });
  return { h, billId: h.sales.confirm(h.ownerToken, d.id).id };
}

describe('the printed invoice', () => {
  it('has every section of the sample, with the sample\'s figures', async () => {
    const { h, billId } = await issued();
    const r = h.print.invoice(h.ownerToken, billId);
    for (const needle of [
      'BLAZE ENGINEERING COMPANY', '12 EXAMPLE ROAD', 'GSTIN : 19ABCDE1234F1ZX', 'accounts@example.invalid', 'Tax Invoice cum Challan',
      'Bill To', 'TEST DAIRY FARM', 'GSTIN: UN-REGD', 'Invoice No :', 'BZ260001', 'Invoice Date :', '31/10/2026', 'Order No :', 'Order Date :', 'Transport Mode :', 'Vehicle No :',
      'Date of Supply :', 'Place of Supply :', 'EXAMPLEPUR', 'Product Description', 'HSN Code', 'Rate %', 'Amt (Rs.)', 'CGST', 'SGST',
      'PLASTIC MILK CAN', '40 - LTR', 'PCS - PCS', '500 - ML', '3923', '185,000'.replace(',', '').slice(0, 0) + '1,850.00', '166.50', '2,183.00', '129.80', '578.20', '2,891.00',
      'Invoice Amount in Words', 'Three Thousand only', 'Delivery charges Rs.92.37 added in Bill with 18.00% GST',
      'Total Amount before Tax', 'Rs. 2,542.37', 'Add : CGST', 'Add : SGST', 'Rs. 228.81', 'Total Tax Amount', 'Rs. 457.62', 'Round off', '+0.01', 'Total Amount after Tax', 'Rs. 3,000.00',
      'Bank Details:', 'EXAMPLE BANK, Example Branch', 'A/c No.: 000000000000', 'Bank IFSC: EXAM0000001', 'Terms and Conditions', 'SAMPLE TERMS',
      'Certified that the particulars given above are true and correct', 'For BLAZE ENGINEERING COMPANY', 'Authorized Signatory', 'Common Seal', "Buyer's Signature",
    ]) {
      expect(r.html, `missing: ${needle}`).toContain(needle);
    }
    expect(count(r.html, 'Add : CGST') + count(r.html, 'Add : SGST')).toBe(6); // once per copy
    expect(r.warnings).toEqual([]);
    expect(r.fileName).toBe('Invoice-BZ260001.pdf');
  });

  it('prints one page per configured copy, labelled; the labels are editable', async () => {
    const { h, billId } = await issued();
    const all = h.print.invoice(h.ownerToken, billId);
    expect(all.copies).toEqual(['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier']);
    expect(count(all.html, '<section class="copy">')).toBe(3);
    for (const label of all.copies) expect(all.html).toContain(`<td class="copy-label">${label}</td>`);

    const dup = h.print.invoice(h.ownerToken, billId, { copy: 1 });
    expect(dup.copies).toEqual(['Duplicate for Transporter']);
    expect(count(dup.html, '<section class="copy">')).toBe(1);

    h.settings.update(h.ownerToken, { invoiceCopies: ['Customer copy', 'Office copy'] });
    expect(h.print.invoice(h.ownerToken, billId).copies).toEqual(['Customer copy', 'Office copy']);
    h.settings.update(h.ownerToken, { invoiceCopies: [] });
    const none = h.print.invoice(h.ownerToken, billId);
    expect(count(none.html, '<section class="copy">')).toBe(1);
    expect(none.html).not.toContain('class="copy-label"');
  });

  it('uses IGST columns for an inter-state bill', async () => {
    const { h } = await issued();
    const far = h.customers.create(h.ownerToken, { name: 'PATNA DAIRY', state: 'Bihar' });
    const b = h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: far, invoiceDate: '2026-11-02', lines: [{ itemId: h.ids.can, qtyMilli: 2000 }] }).id);
    const html = h.print.invoice(h.ownerToken, b.id, { copy: 0 }).html;
    expect(html).toContain('IGST');
    expect(html).toContain('Add : IGST');
    expect(html).not.toContain('CGST');
    expect(html).not.toContain('SGST');
    expect(html).toContain('333.00'); // 18% of 1,850.00
    expect(html).toContain('Bihar'); // place of supply falls back to the customer's state
  });

  it('shows a rate changed on the bill as the rate charged, and a discount in its own column', async () => {
    const { h } = await issued();
    const b = h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-02', lines: [{ itemId: h.ids.can, qtyMilli: 2000, ratePaise: 90000, discountPaise: 5000 }] }).id);
    const html = h.print.invoice(h.ownerToken, b.id, { copy: 0 }).html;
    expect(html).toContain('900.00'); // the rate charged per piece
    expect(html).toContain('1,800.00'); // amount before discount
    expect(html).toContain('50.00'); // discount
    expect(html).toContain('1,750.00'); // taxable value
    expect(html).not.toContain('925.00'); // the standard rate is not printed
  });

  it('marks a draft and a cancelled bill, and never mistakes a draft for an original', async () => {
    const { h } = await issued();
    const d = h.sales.saveDraft(h.ownerToken, { customerId: h.ids.farm, invoiceDate: '2026-11-01', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] });
    const draft = h.print.invoice(h.ownerToken, d.id);
    expect(draft.html).toContain('DRAFT - NOT A TAX INVOICE');
    expect(draft.html).toContain('>DRAFT<'); // in place of an invoice number
    expect(draft.html).not.toContain('class="copy-label"');
    expect(draft.copies).toEqual([]);
    expect(draft.warnings[0]).toMatch(/draft/i);
    expect(draft.fileName).toBe(`Invoice-DRAFT-${String(d.id)}.pdf`);

    const q = quickBill(h);
    h.sales.cancel(h.ownerToken, q.id, 'wrong customer');
    const cancelled = h.print.invoice(h.ownerToken, q.id);
    expect(cancelled.html).toContain('>CANCELLED<');
    expect(cancelled.warnings[0]).toMatch(/cancelled/i);
  });

  it('uses the details frozen on the bill, not today\'s customer record', async () => {
    const { h, billId } = await issued();
    h.customers.update(h.ownerToken, h.ids.farm, { name: 'RENAMED FARM', address: 'New address' });
    const html = h.print.invoice(h.ownerToken, billId).html;
    expect(html).toContain('TEST DAIRY FARM');
    expect(html).not.toContain('RENAMED FARM');
  });
});

describe('what the invoice never does', () => {
  it('invents no business details: with nothing set, there is no bank, GSTIN or terms block, and the user is told', async () => {
    const h = await shopHarness({ configure: false });
    h.settings.update(h.ownerToken, { businessState: 'West Bengal', invoicePrefix: 'bz' }); // only what billing itself needs
    const q = quickBill(h);
    const r = h.print.invoice(h.ownerToken, q.id, { copy: 0 });
    for (const absent of ['Bank Details', 'Terms and Conditions', 'GSTIN :', 'BANK OF BARODA', 'Email :', 'Phone :']) expect(r.html).not.toContain(absent);
    expect(r.html).toContain('(business name not set in Settings)');
    expect(r.warnings).toEqual(expect.arrayContaining(['Your business name is not set in Settings.', 'Your business address is not set in Settings.', 'Your business GSTIN is not set in Settings.', 'Your bank details are not (fully) set in Settings.']));
  });

  it('is safe: every typed value is escaped, and the page has no scripts, no external files and a lock-down content policy', async () => {
    const { h } = await issued();
    const evil = h.customers.create(h.ownerToken, { name: '<script>alert(1)</script> & "Sons" <img src=x onerror=alert(2)>', address: 'Line 1\nLine <b>2</b>', state: 'West Bengal' });
    const b = h.sales.confirm(h.ownerToken, h.sales.saveDraft(h.ownerToken, { customerId: evil, invoiceDate: '2026-11-02', orderNo: '<i>PO</i>', notes: '</td><script>x</script>', lines: [{ itemId: h.ids.can, qtyMilli: 1000 }] }).id);
    h.settings.update(h.ownerToken, { invoiceTerms: '<script>steal()</script>\nsecond line', businessAddress: 'A & B <Road>' });
    const html = h.print.invoice(h.ownerToken, b.id).html;
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>2</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Sons&quot;');
    expect(html).toContain('Line 1<br>Line &lt;b&gt;2&lt;/b&gt;');
    expect(html).toContain('A &amp; B &lt;Road&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/(src|href)\s*=\s*"https?:/i);
    expect(html).not.toMatch(/@import|url\(/i);
  });
});

describe('the logo', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

  it('is embedded in the invoice; only PNG or JPEG of a sensible size is accepted, judged by the file\'s own bytes', async () => {
    const { h, billId } = await issued();
    expect(h.settings.get(h.ownerToken).hasLogo).toBe(false);
    expect(h.print.invoice(h.ownerToken, billId).html).not.toContain('<img');
    h.settings.setLogo(h.ownerToken, png);
    expect(h.settings.get(h.ownerToken).hasLogo).toBe(true);
    expect(h.print.invoice(h.ownerToken, billId).html).toContain('<img class="logo" src="data:image/png;base64,iVBORw0KGgo');
    h.settings.setLogo(h.ownerToken, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
    expect(h.print.invoice(h.ownerToken, billId).html).toContain('data:image/jpeg;base64,');

    expect(codeOf(() => h.settings.setLogo(h.ownerToken, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')))).toBe('VALIDATION');
    expect(codeOf(() => h.settings.setLogo(h.ownerToken, Uint8Array.from([1, 2, 3])))).toBe('VALIDATION');
    expect(codeOf(() => h.settings.setLogo(h.ownerToken, new Uint8Array(300 * 1024 + 1).fill(0xff)))).toBe('VALIDATION');
    h.settings.clearLogo(h.ownerToken);
    expect(h.print.invoice(h.ownerToken, billId).html).not.toContain('<img');
  });

  it('needs settings.edit, and the audit trail records the change without the picture', async () => {
    const { h } = await issued();
    const clerk = await makeEmployee(h, 'clerk', ['sale.create']);
    expect(codeOf(() => h.settings.setLogo(clerk, png))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.settings.clearLogo(clerk))).toBe('PERMISSION_DENIED');
    h.settings.setLogo(h.ownerToken, png);
    const details = (h.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'SETTINGS_UPDATE'").all() as { detail_json: string }[]).map((r) => r.detail_json);
    expect(details.map((d) => JSON.parse(d) as object)).toContainEqual({ logo: 'set', bytes: 16, type: 'png' });
    expect(details.join('')).not.toContain('iVBOR'); // the picture itself is never copied into the audit trail
  });
});

describe('printing is audited and permissioned', () => {
  it('records each real print or PDF export, and needs permission to see bills', async () => {
    const { h, billId } = await issued();
    h.print.recordPrint(h.ownerToken, billId, 'PRINT', ['Original for Recipient']);
    h.print.recordPrint(h.ownerToken, billId, 'PDF');
    const rows = h.db.prepare("SELECT detail_json, user_id FROM audit_log WHERE action = 'INVOICE_PRINT' ORDER BY id").all() as { detail_json: string; user_id: number }[];
    expect(rows.map((r) => JSON.parse(r.detail_json))).toEqual([
      { billNo: 'BZ260001', status: 'CONFIRMED', kind: 'PRINT', copies: ['Original for Recipient'] },
      { billNo: 'BZ260001', status: 'CONFIRMED', kind: 'PDF', copies: [] },
    ]);
    expect(rows[0]?.user_id).toBe(1);
    const nobody = await makeEmployee(h, 'nobody', ['inventory.view']);
    expect(codeOf(() => h.print.invoice(nobody, billId))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.print.recordPrint(nobody, billId, 'PRINT'))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.print.invoice(h.ownerToken, 999))).toBe('NOT_FOUND');
    const cashier = await makeEmployee(h, 'cashier', ['sale.create']);
    expect(codeOf(() => h.print.invoice(cashier, billId))).toBe('NO_ERROR');
  });
});

describe('other printouts', () => {
  it('customer statement: opening, every entry, closing, with safe file name and escaped text', async () => {
    const { h } = await issued();
    const c = h.customers.create(h.ownerToken, { name: 'A/B: <Co>*', state: 'West Bengal', openingBalancePaise: 12345 });
    const r = h.print.customerStatement(h.ownerToken, c);
    expect(r.title).toBe('Statement of Account - A/B: <Co>*');
    expect(r.html).toContain('A/B: &lt;Co&gt;*');
    expect(r.html).not.toContain('<Co>');
    expect(r.html).toContain('Opening balance');
    expect(r.html).toContain('123.45');
    expect(r.html).toContain('Closing balance');
    expect(r.html).toContain('Balance due: Rs. 123.45');
    expect(r.html).toContain('Generated 07/11/2026 15:30'); // dd/mm/yyyy, shop-local time (the test clock is 10:00 UTC)
    expect(r.fileName).toBe('Statement-A-B-Co.pdf');
    expect(h.print.customerStatement(h.ownerToken, h.ids.farm, '2026-10-01', '2026-10-31').html).toContain('Period: 01/10/2026 to 31/10/2026');
    expect(codeOf(() => h.print.customerStatement(h.ownerToken, 999))).toBe('NOT_FOUND');
  });

  it('dues, stock list and stock movements print with the same rules', async () => {
    const { h } = await issued();
    const dues = h.print.customerDues(h.ownerToken);
    expect(dues.html).toContain('Customers with balance due');
    expect(dues.html).toContain('TEST DAIRY FARM');
    expect(dues.html).toContain('Total outstanding: Rs. 3,000.00 across 1 customer(s)');
    const stock = h.print.stockList(h.ownerToken, { sortBy: 'code' });
    expect(stock.html).toContain('@page { size: A4 landscape');
    expect(stock.html).toContain('MC-40');
    expect(stock.html).toContain('PLASTIC MILK CAN');
    expect(stock.fileName).toBe('Stock-list.pdf');
    const moves = h.print.stockMovements(h.ownerToken, { fromDate: '2026-11-01' });
    expect(moves.html).toContain('Stock movements');
    expect(moves.html).toContain('SALE');
    expect(moves.html).toContain('BZ260001');
    const clerk = await makeEmployee(h, 'clerk', ['sale.create']);
    expect(codeOf(() => h.print.stockList(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.print.customerDues(clerk))).toBe('PERMISSION_DENIED');
    expect(codeOf(() => h.print.stockMovements(clerk))).toBe('PERMISSION_DENIED');
  });

  it('a long bill spills onto more pages with the item table header repeating (CSS rules present)', async () => {
    const { h } = await issued();
    const html = h.print.invoice(h.ownerToken, h.sales.list(h.ownerToken).rows[0]?.id ?? 0, { copy: 0 }).html;
    expect(html).toContain('table.items thead { display: table-header-group; }');
    expect(html).toContain('table.items tr { page-break-inside: avoid; }');
    expect(html).toContain('@page { size: A4; margin: 7mm; }');
  });
});
