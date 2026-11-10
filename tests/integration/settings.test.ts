import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYMENT_METHODS, readSettings, requireBillingSettings } from '../../src/application/settings/settingsService';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { setupHarness } from '../helpers/auth';
import { makeEmployee } from '../helpers/shop';

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

describe('settings', () => {
  it('has no invented business details: name, state and invoice prefix start empty', async () => {
    const h = await setupHarness();
    const s = h.settings.get(h.ownerToken);
    expect(s).toMatchObject({ businessName: null, businessState: null, invoicePrefix: null, invoiceNumberWidth: 4, purchasePrefix: 'PB', supplierReceiptPrefix: 'SP', roundOff: 'NEAREST_RUPEE', warnBelowCost: true, paymentMethods: DEFAULT_PAYMENT_METHODS });
    expect(codeOf(() => requireBillingSettings(s))).toBe('VALIDATION');
  });

  it('only the owner can change settings; any signed-in user can read them', async () => {
    const h = await setupHarness();
    const clerk = await makeEmployee(h, 'clerk', ['sale.create']);
    expect(codeOf(() => h.settings.update(clerk, { warnBelowCost: false }))).toBe('PERMISSION_DENIED');
    expect(h.settings.get(clerk).warnBelowCost).toBe(true);
  });

  it('stores, normalises and audits changes, and ignores a change to the same value', async () => {
    const h = await setupHarness();
    const s = h.settings.update(h.ownerToken, { businessName: ' TEST CO ', businessState: 'west bengal', invoicePrefix: 'bz', receiptPrefix: 'rc', paymentMethods: ['Cash', 'UPI'], warnBelowCost: false, roundOff: 'NONE', invoiceNumberWidth: 5 });
    expect(s).toMatchObject({ businessName: 'TEST CO', businessState: 'West Bengal', invoicePrefix: 'BZ', receiptPrefix: 'RC', paymentMethods: ['Cash', 'UPI'], warnBelowCost: false, roundOff: 'NONE', invoiceNumberWidth: 5 });
    expect(requireBillingSettings(readSettings(h.db))).toEqual({ businessState: 'West Bengal', invoicePrefix: 'BZ' });
    const audits = (): number => (h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SETTINGS_UPDATE'").get() as { n: number }).n;
    expect(audits()).toBe(1);
    h.settings.update(h.ownerToken, { businessName: 'TEST CO' });
    expect(audits()).toBe(1);
  });

  it('rejects bad values', async () => {
    const h = await setupHarness();
    for (const bad of [
      { businessState: 'Atlantis' }, { invoicePrefix: 'TOO-LONG-1' }, { invoicePrefix: '' }, { invoiceNumberWidth: 2 }, { invoiceNumberWidth: 9 },
      { paymentMethods: [] }, { paymentMethods: ['Cash', 'cash'] }, { businessName: '  ' },
    ]) {
      expect(codeOf(() => h.settings.update(h.ownerToken, bad))).toBe('VALIDATION');
    }
  });

  describe('business profile and invoice details', () => {
    it('are stored, normalised, and can be cleared with an empty value; the title and declaration fall back to defaults', async () => {
      const h = await setupHarness();
      const s1 = h.settings.update(h.ownerToken, {
        businessAddress: ' 12 Example Road\nKolkata ', businessPhone: '+91 90000 00000', businessEmail: 'a@example.invalid', businessGstin: '19abcde1234f1zx', businessState: 'West Bengal',
        bankName: 'EXAMPLE BANK', bankBranch: 'Example Branch', bankAccountNo: '0000 0000 0000', bankIfsc: 'exam0000001', invoiceTerms: 'Pay in 30 days.', invoiceTitle: 'Tax Invoice',
        invoiceDeclaration: 'We declare this is true.', invoiceCopies: ['Original', 'Duplicate'],
      });
      expect(s1).toMatchObject({
        businessAddress: '12 Example Road\nKolkata', businessGstin: '19ABCDE1234F1ZX', bankAccountNo: '000000000000', bankIfsc: 'EXAM0000001', invoiceTerms: 'Pay in 30 days.',
        invoiceTitle: 'Tax Invoice', invoiceDeclaration: 'We declare this is true.', invoiceCopies: ['Original', 'Duplicate'],
      });
      const s2 = h.settings.update(h.ownerToken, { businessAddress: '', bankName: '', invoiceTerms: '  ', invoiceTitle: '', invoiceDeclaration: '' });
      expect(s2).toMatchObject({ businessAddress: null, bankName: null, invoiceTerms: null, invoiceTitle: 'Tax Invoice cum Challan', invoiceDeclaration: 'Certified that the particulars given above are true and correct' });
      expect(h.settings.update(h.ownerToken, { invoiceCopies: [] }).invoiceCopies).toEqual([]);
    });

    it('checks the GSTIN (format, check digit, and agreement with the business state) and the bank details', async () => {
      const h = await setupHarness();
      const bad = (patch: object): ErrorCode | 'NO_ERROR' => codeOf(() => h.settings.update(h.ownerToken, patch));
      expect(bad({ businessGstin: '19ABCDE1234F1ZY' })).toBe('VALIDATION'); // check digit
      expect(bad({ businessGstin: 'not a gstin' })).toBe('VALIDATION');
      h.settings.update(h.ownerToken, { businessState: 'West Bengal', businessGstin: '19ABCDE1234F1ZX' });
      expect(bad({ businessGstin: '27ABCDE1234F1Z0' })).toBe('VALIDATION'); // Maharashtra GSTIN, West Bengal business
      expect(bad({ businessState: 'Maharashtra' })).toBe('VALIDATION'); // state would no longer match the GSTIN
      expect(bad({ businessState: 'Maharashtra', businessGstin: '27ABCDE1234F1Z0' })).toBe('NO_ERROR'); // both changed together
      expect(bad({ bankAccountNo: '12ab' })).toBe('VALIDATION');
      expect(bad({ bankIfsc: 'NOPE' })).toBe('VALIDATION');
      expect(bad({ businessEmail: 'nope' })).toBe('VALIDATION');
      expect(bad({ businessPhone: 'call me' })).toBe('VALIDATION');
      expect(bad({ invoiceCopies: ['A', 'B', 'C', 'D'] })).toBe('VALIDATION');
      expect(bad({ invoiceCopies: ['A', 'a'] })).toBe('VALIDATION');
      expect(bad({ invoiceTerms: 'x'.repeat(601) })).toBe('VALIDATION');
    });

    it('masks the bank account number in the audit trail', async () => {
      const h = await setupHarness();
      h.settings.update(h.ownerToken, { bankAccountNo: '123456789012' });
      const rows = JSON.stringify(h.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'SETTINGS_UPDATE'").all());
      expect(rows).toContain('••••9012');
      expect(rows).not.toContain('123456789012');
    });
  });
});
