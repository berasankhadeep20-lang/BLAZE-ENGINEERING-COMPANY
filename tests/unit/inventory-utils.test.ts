import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stockStatus, uomLabel } from '../../src/domain/inventory';
import { formatPlainRupees } from '../../src/domain/money';
import { localDayRangeToUtc, toLocalDateTime } from '../../src/shared/clock';
import { toCsv } from '../../src/shared/csv';

describe('inventory rules', () => {
  it('stock status: OUT, LOW (at or below a non-zero reorder level), OK', () => {
    expect(stockStatus(0, 5000)).toBe('OUT');
    expect(stockStatus(0, 0)).toBe('OUT');
    expect(stockStatus(5000, 5000)).toBe('LOW');
    expect(stockStatus(4999, 5000)).toBe('LOW');
    expect(stockStatus(5001, 5000)).toBe('OK');
    expect(stockStatus(1, 0)).toBe('OK'); // no reorder level set -> never LOW
  });
  it('UOM label matches the sample bill', () => {
    expect(uomLabel('LTR', '40')).toBe('40 - LTR');
    expect(uomLabel('ML', '500')).toBe('500 - ML');
    expect(uomLabel('PCS', null)).toBe('PCS - PCS');
    expect(uomLabel('PCS', '  ')).toBe('PCS - PCS');
  });
  it('plain rupees for spreadsheets', () => {
    expect(formatPlainRupees(125000)).toBe('1250.00');
    expect(formatPlainRupees(5)).toBe('0.05');
    expect(formatPlainRupees(-250)).toBe('-2.50');
  });
});

describe('csv', () => {
  it('writes a BOM, CRLF lines, and quotes where needed', () => {
    const out = toCsv(['A', 'B'], [['x, y', 'say "hi"'], [1, null]]);
    expect(out).toBe('\uFEFFA,B\r\n"x, y","say ""hi"""\r\n1,\r\n');
  });
  it('neutralises spreadsheet formulas in text but leaves real numbers alone', () => {
    const out = toCsv(['v'], [['=HYPERLINK("http://evil")'], ['+1'], ['@cmd'], ['-5 kg'], [-5], ['normal']]);
    const lines = out.replace('\uFEFF', '').split('\r\n');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[2]).toBe("'+1");
    expect(lines[3]).toBe("'@cmd");
    expect(lines[4]).toBe("'-5 kg");
    expect(lines[5]).toBe('-5');
    expect(lines[6]).toBe('normal');
  });
});

describe('local day ranges (shop is in India, UTC+5:30)', () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Kolkata';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('turns local dates into UTC bounds', () => {
    expect(localDayRangeToUtc('2026-11-01', '2026-11-01')).toEqual({
      fromUtc: '2026-10-31T18:30:00.000Z',
      toUtcExclusive: '2026-11-01T18:30:00.000Z',
    });
  });
  it('shows UTC timestamps as local time', () => {
    expect(toLocalDateTime('2026-10-31T19:00:00.000Z')).toBe('2026-11-01 00:30');
  });
  it('rejects bad or reversed ranges', () => {
    expect(() => localDayRangeToUtc('2026-11-02', '2026-11-01')).toThrow();
    expect(() => localDayRangeToUtc('2026-02-30')).toThrow();
    expect(() => localDayRangeToUtc('01/11/2026')).toThrow();
  });
});
