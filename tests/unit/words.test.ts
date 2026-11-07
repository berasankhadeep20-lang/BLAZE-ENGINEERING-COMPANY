import { describe, expect, it } from 'vitest';
import { amountInWords, numberToWordsIndian } from '../../src/domain/words';

describe('numberToWordsIndian', () => {
  it('handles small numbers and teens', () => {
    expect(numberToWordsIndian(0)).toBe('Zero');
    expect(numberToWordsIndian(7)).toBe('Seven');
    expect(numberToWordsIndian(19)).toBe('Nineteen');
    expect(numberToWordsIndian(40)).toBe('Forty');
    expect(numberToWordsIndian(99)).toBe('Ninety Nine');
  });
  it('uses thousand / lakh / crore', () => {
    expect(numberToWordsIndian(100)).toBe('One Hundred');
    expect(numberToWordsIndian(1250)).toBe('One Thousand Two Hundred Fifty');
    expect(numberToWordsIndian(100000)).toBe('One Lakh');
    expect(numberToWordsIndian(1234567)).toBe('Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven');
    expect(numberToWordsIndian(10000000)).toBe('One Crore');
    expect(numberToWordsIndian(1_500_000_000)).toBe('One Hundred Fifty Crore');
  });
});

describe('amountInWords', () => {
  it('matches the sample bill wording', () => {
    expect(amountInWords(300000)).toBe('Three Thousand only');
  });
  it('includes paise when present', () => {
    expect(amountInWords(305050)).toBe('Three Thousand Fifty and Fifty Paise only');
    expect(amountInWords(5)).toBe('Five Paise only');
    expect(amountInWords(0)).toBe('Zero only');
  });
  it('rejects negatives', () => {
    expect(() => amountInWords(-1)).toThrow();
  });
});
