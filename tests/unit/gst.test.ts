import { describe, expect, it } from 'vitest';
import { computeBill, computeLine, solveDeliveryForTarget, type LineInput } from '../../src/domain/gst';
import { parseQty, parseRupees } from '../../src/domain/money';
import { amountInWords } from '../../src/domain/words';

// Figures reproduce the supplied sample bill (intra-state, 9% + 9% on every line), with fictional parties.
const sampleLines: LineInput[] = [
  { qtyMilli: parseQty('2'), ratePaise: parseRupees('925.00'), gstRateBp: 1800 }, // plastic milk can
  { qtyMilli: parseQty('2'), ratePaise: parseRupees('55.00'), gstRateBp: 1800 }, // butyrometer
  { qtyMilli: parseQty('2'), ratePaise: parseRupees('245.00'), gstRateBp: 1800 }, // sodium hydroxide solution
];

describe('golden test: sample bill', () => {
  it('reproduces every line of the sample', () => {
    const b = computeBill({ lines: sampleLines, taxType: 'INTRA' });
    expect(b.lines.map((l) => l.amountPaise)).toEqual([185000, 11000, 49000]);
    expect(b.lines.map((l) => l.taxablePaise)).toEqual([185000, 11000, 49000]);
    expect(b.lines.map((l) => l.cgstPaise)).toEqual([16650, 990, 4410]);
    expect(b.lines.map((l) => l.sgstPaise)).toEqual([16650, 990, 4410]);
    expect(b.lines.map((l) => l.totalPaise)).toEqual([218300, 12980, 57820]);
    expect(b.goodsTaxablePaise).toBe(245000);
    expect(b.goodsTotalPaise).toBe(289100);
  });

  it('reproduces the invoice totals with delivery Rs 92.37 @ 18%', () => {
    const b = computeBill({
      lines: sampleLines,
      taxType: 'INTRA',
      delivery: { amountPaise: parseRupees('92.37'), gstRateBp: 1800 },
    });
    expect(b.delivery?.cgstPaise).toBe(831);
    expect(b.delivery?.sgstPaise).toBe(831);
    expect(b.taxableTotalPaise).toBe(254237); // Total Amount before Tax  2542.37
    expect(b.cgstPaise).toBe(22881); //          Add: CGST               228.81
    expect(b.sgstPaise).toBe(22881); //          Add: SGST               228.81
    expect(b.totalTaxPaise).toBe(45762); //      Total Tax Amount        457.62
    expect(b.preRoundTotalPaise).toBe(299999); // 2999.99
    expect(b.roundOffPaise).toBe(1); //          explicit round-off      +0.01
    expect(b.totalPaise).toBe(300000); //        Total Amount after Tax  3000.00
    expect(amountInWords(b.totalPaise)).toBe('Three Thousand only');
  });

  it('can back-solve a delivery charge that lands on the target total', () => {
    const { amountPaise, bill } = solveDeliveryForTarget({ lines: sampleLines, taxType: 'INTRA' }, 1800, 300000);
    expect(bill.totalPaise).toBe(300000);
    expect(Math.abs(bill.roundOffPaise)).toBe(0); // 92.38 gives an exact 3000.00; the sample's 92.37 needed +0.01
    expect(amountPaise).toBe(9238);
  });

  it('rejects a target below the goods total', () => {
    expect(() => solveDeliveryForTarget({ lines: sampleLines, taxType: 'INTRA' }, 1800, 100000)).toThrow();
  });
});

describe('computeLine', () => {
  it('applies discount before tax', () => {
    const l = computeLine({ qtyMilli: 3000, ratePaise: 10000, discountPaise: 5000, gstRateBp: 1800 }, 'INTRA');
    expect(l.amountPaise).toBe(30000);
    expect(l.taxablePaise).toBe(25000);
    expect(l.cgstPaise).toBe(2250);
    expect(l.sgstPaise).toBe(2250);
    expect(l.totalPaise).toBe(29500);
  });

  it('uses IGST for inter-state supply', () => {
    const l = computeLine({ qtyMilli: 1000, ratePaise: 10000, gstRateBp: 1800 }, 'INTER');
    expect(l.cgstPaise + l.sgstPaise).toBe(0);
    expect(l.igstPaise).toBe(1800);
    expect(l.totalPaise).toBe(11800);
  });

  it('handles fractional quantities', () => {
    const l = computeLine({ qtyMilli: 2500, ratePaise: 12000, gstRateBp: 500 }, 'INTRA'); // 2.5 x 120.00 @ 5%
    expect(l.amountPaise).toBe(30000);
    expect(l.cgstPaise).toBe(750);
    expect(l.totalPaise).toBe(31500);
  });

  it('rounds each tax half separately, half away from zero', () => {
    // taxable 0.05 @ 18% -> half-tax 0.0045 -> 0.00 ; taxable 0.50 @ 18% -> 0.045 -> 0.05
    expect(computeLine({ qtyMilli: 1000, ratePaise: 5, gstRateBp: 1800 }, 'INTRA').cgstPaise).toBe(0);
    expect(computeLine({ qtyMilli: 1000, ratePaise: 50, gstRateBp: 1800 }, 'INTRA').cgstPaise).toBe(5);
  });

  it('rejects invalid input', () => {
    expect(() => computeLine({ qtyMilli: 0, ratePaise: 100, gstRateBp: 1800 }, 'INTRA')).toThrow();
    expect(() => computeLine({ qtyMilli: 1000, ratePaise: -1, gstRateBp: 1800 }, 'INTRA')).toThrow();
    expect(() => computeLine({ qtyMilli: 1000, ratePaise: 100, discountPaise: 101, gstRateBp: 1800 }, 'INTRA')).toThrow();
    expect(() => computeLine({ qtyMilli: 1000, ratePaise: 100, gstRateBp: 20000 }, 'INTRA')).toThrow();
  });
});

describe('computeBill', () => {
  it('requires at least one line', () => {
    expect(() => computeBill({ lines: [], taxType: 'INTRA' })).toThrow();
  });

  it('rounds the total to the nearest rupee with an explicit round-off', () => {
    const b = computeBill({ lines: [{ qtyMilli: 1000, ratePaise: 10050, gstRateBp: 1800 }], taxType: 'INTRA' });
    // 100.50 + 9.045->9.05 + 9.05 = 118.60 -> 119.00 (round-off +0.40)
    expect(b.preRoundTotalPaise).toBe(11860);
    expect(b.totalPaise).toBe(11900);
    expect(b.roundOffPaise).toBe(40);
  });

  it('can switch rounding off', () => {
    const b = computeBill({
      lines: [{ qtyMilli: 1000, ratePaise: 10050, gstRateBp: 1800 }],
      taxType: 'INTRA',
      roundOff: 'NONE',
    });
    expect(b.roundOffPaise).toBe(0);
    expect(b.totalPaise).toBe(11860);
  });

  it('keeps the invariant total = taxable + tax + roundOff on random bills', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const lines: LineInput[] = Array.from({ length: 1 + rnd(5) }, () => ({
        qtyMilli: 1 + rnd(20000),
        ratePaise: rnd(500000),
        discountPaise: 0,
        gstRateBp: [0, 500, 1200, 1800, 2800][rnd(5)] ?? 1800,
      }));
      const taxType = rnd(2) === 0 ? 'INTRA' : 'INTER';
      const b = computeBill({
        lines,
        taxType,
        delivery: rnd(2) === 0 ? { amountPaise: rnd(100000), gstRateBp: 1800 } : null,
      });
      expect(b.totalPaise).toBe(b.taxableTotalPaise + b.totalTaxPaise + b.roundOffPaise);
      expect(b.totalPaise % 100).toBe(0);
      expect(Math.abs(b.roundOffPaise)).toBeLessThanOrEqual(50);
    }
  });
});
