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
    expect(s).toMatchObject({ businessName: null, businessState: null, invoicePrefix: null, invoiceNumberWidth: 4, roundOff: 'NEAREST_RUPEE', warnBelowCost: true, paymentMethods: DEFAULT_PAYMENT_METHODS });
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
});
