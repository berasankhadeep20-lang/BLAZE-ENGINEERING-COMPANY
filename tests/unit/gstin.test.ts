import { describe, expect, it } from 'vitest';
import { GSTIN_UNREGISTERED_LABEL, INDIAN_STATES, gstinCheckChar, gstinProblems, stateByCode, stateByName, stateFromGstin, taxTypeForSupply } from '../../src/domain/gstin';

describe('GSTIN check digit', () => {
  it('accepts a widely published example and synthetic numbers with the right check digit', () => {
    for (const g of ['27AAPFU0939F1ZV', '19ABCDE1234F1ZX', '27ABCDE1234F1Z0', '07ABCDE1234F1Z2', '29ABCDE1234F1ZW', '19PQRST5678K1ZZ']) {
      expect(gstinProblems(g)).toEqual([]);
    }
  });
  it('rejects a wrong check digit', () => {
    expect(gstinProblems('19ABCDE1234F1ZY')).toEqual(['GSTIN check digit is wrong; please re-check the number']);
    expect(gstinProblems('27AAPFU0939F1ZW')).not.toEqual([]);
  });
  it('rejects bad formats', () => {
    for (const g of ['', 'UN-REGD', '19ABCDE1234F1Z', '19ABCDE1234F1ZXX', '1ABCDE12345F1ZX', '19ABCDE1234F1AX', '19abcde1234f1zx']) {
      expect(gstinProblems(g).length).toBeGreaterThan(0);
    }
  });
  it('rejects an unknown state code even when the check digit fits', () => {
    const first14 = '40ABCDE1234F1Z';
    expect(gstinProblems(first14 + gstinCheckChar(first14))).toEqual(['GSTIN starts with an unknown state code']);
  });
});

describe('states', () => {
  it('looks states up by name (any case) and by code', () => {
    expect(stateByName(' west bengal ')?.code).toBe('19');
    expect(stateByCode('27')?.name).toBe('Maharashtra');
    expect(stateByName('Atlantis')).toBeUndefined();
    expect(stateFromGstin('19ABCDE1234F1ZX')?.name).toBe('West Bengal');
  });
  it('has unique codes and names', () => {
    expect(new Set(INDIAN_STATES.map((s) => s.code)).size).toBe(INDIAN_STATES.length);
    expect(new Set(INDIAN_STATES.map((s) => s.name)).size).toBe(INDIAN_STATES.length);
  });
  it('same state = CGST+SGST, different state = IGST', () => {
    expect(taxTypeForSupply('West Bengal', ' west bengal ')).toBe('INTRA');
    expect(taxTypeForSupply('West Bengal', 'Bihar')).toBe('INTER');
  });
  it('uses the label printed on the sample bill for unregistered parties', () => {
    expect(GSTIN_UNREGISTERED_LABEL).toBe('UN-REGD');
  });
});
