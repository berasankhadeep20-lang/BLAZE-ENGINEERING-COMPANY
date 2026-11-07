import { describe, expect, it } from 'vitest';
import { MoneyError, divRound, formatINR, formatQty, mulDivRound, parseQty, parseRupees } from '../../src/domain/money';

describe('divRound', () => {
  it('rounds halves away from zero', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 3)).toBe(1);
    expect(divRound(2, 3)).toBe(1);
    expect(divRound(1, 3)).toBe(0);
    expect(divRound(0, 7)).toBe(0);
  });
  it('rejects division by zero and non-integers', () => {
    expect(() => divRound(1, 0)).toThrow(MoneyError);
    expect(() => divRound(1.5, 2)).toThrow(MoneyError);
  });
  it('mulDivRound avoids overflow in the intermediate product', () => {
    expect(mulDivRound(9_000_000_000_000, 1000, 1000)).toBe(9_000_000_000_000);
    expect(mulDivRound(2, 925_00, 1000)).toBe(185);
  });
});

describe('parseRupees / formatINR', () => {
  it('parses without floating point', () => {
    expect(parseRupees('92.37')).toBe(9237);
    expect(parseRupees('1,250')).toBe(125000);
    expect(parseRupees('₹ 55')).toBe(5500);
    expect(parseRupees('0.1')).toBe(10);
    expect(parseRupees('-3.5')).toBe(-350);
  });
  it('refuses more than two decimals instead of rounding silently', () => {
    expect(() => parseRupees('1.234')).toThrow(MoneyError);
    expect(() => parseRupees('abc')).toThrow(MoneyError);
  });
  it('formats with Indian digit grouping', () => {
    expect(formatINR(300000)).toBe('3,000.00');
    expect(formatINR(12345678)).toBe('1,23,456.78');
    expect(formatINR(1234567890)).toBe('1,23,45,678.90');
    expect(formatINR(5)).toBe('0.05');
    expect(formatINR(-250000, { symbol: '₹' })).toBe('-₹2,500.00');
  });
});

describe('quantity', () => {
  it('parses and formats thousandths', () => {
    expect(parseQty('2')).toBe(2000);
    expect(parseQty('2.5')).toBe(2500);
    expect(parseQty('0.125')).toBe(125);
    expect(formatQty(2000)).toBe('2');
    expect(formatQty(2500)).toBe('2.5');
    expect(formatQty(125)).toBe('0.125');
  });
  it('rejects bad input', () => {
    expect(() => parseQty('1.2345')).toThrow(MoneyError);
    expect(() => parseQty('-1')).toThrow(MoneyError);
  });
});
