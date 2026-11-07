import { describe, expect, it } from 'vitest';
import { financialYear, formatBillNo, seriesPrefix } from '../../src/domain/billNumber';

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear('2026-10-31')).toBe('2026-27');
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2027-04-01')).toBe('2027-28');
    expect(financialYear('2099-12-01')).toBe('2099-00');
  });
  it('rejects bad dates', () => {
    expect(() => financialYear('31/10/2026')).toThrow();
    expect(() => financialYear('2026-02-30')).toThrow();
  });
});

describe('bill numbers', () => {
  it('reproduces the sample number format BZ260150', () => {
    const prefix = seriesPrefix('BZ', financialYear('2026-10-31'));
    expect(prefix).toBe('BZ26');
    expect(formatBillNo(prefix, 150)).toBe('BZ260150');
    expect(formatBillNo(prefix, 1)).toBe('BZ260001');
    expect(formatBillNo(prefix, 12345)).toBe('BZ2612345');
  });
  it('rejects a non-positive sequence', () => {
    expect(() => formatBillNo('BZ26', 0)).toThrow();
  });
});
