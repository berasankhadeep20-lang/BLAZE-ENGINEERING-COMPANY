/**
 * GST and bill-total engine.
 *
 * Rules (see docs/adr/0001-money-and-rounding.md):
 *  - line amount   = round(qty * rate)               (paise, half away from zero)
 *  - taxable value = amount - discount
 *  - intra-state   : CGST = SGST = round(taxable * rate / 2)  (each rounded separately, per line)
 *  - inter-state   : IGST = round(taxable * rate)
 *  - delivery charge is taxed like a one-line item with its own rate
 *  - the invoice total is rounded to the nearest rupee and the difference is shown as an explicit round-off
 */
import { MoneyError, assertSafeInt, divRound, mulDivRound, type Paise, type QtyMilli } from './money';

export type TaxType = 'INTRA' | 'INTER';
export type RoundOffMode = 'NEAREST_RUPEE' | 'NONE';

export interface LineInput {
  qtyMilli: QtyMilli;
  ratePaise: Paise;
  discountPaise?: Paise;
  gstRateBp: number; // basis points: 1800 = 18%
}

export interface TaxSplit {
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
}

export interface LineResult extends TaxSplit {
  amountPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  gstRateBp: number;
  totalPaise: Paise;
}

export interface DeliveryInput {
  amountPaise: Paise; // pre-tax delivery charge
  gstRateBp: number;
}

export interface DeliveryResult extends TaxSplit {
  taxablePaise: Paise;
  gstRateBp: number;
  totalPaise: Paise;
}

export interface BillInput {
  lines: LineInput[];
  taxType: TaxType;
  delivery?: DeliveryInput | null;
  roundOff?: RoundOffMode;
}

export interface BillTotals extends TaxSplit {
  lines: LineResult[];
  delivery: DeliveryResult | null;
  goodsTaxablePaise: Paise; // sum of line taxable values
  goodsTotalPaise: Paise; // sum of line totals (goods incl. tax)
  taxableTotalPaise: Paise; // "Total Amount before Tax": goods taxable + delivery
  totalTaxPaise: Paise;
  preRoundTotalPaise: Paise;
  roundOffPaise: Paise;
  totalPaise: Paise; // "Total Amount after Tax"
}

function assertRate(bp: number): void {
  assertSafeInt(bp, 'GST rate');
  if (bp < 0 || bp > 10000) throw new MoneyError(`GST rate out of range: ${String(bp)} bp`);
}

function taxOn(taxable: Paise, gstRateBp: number, taxType: TaxType): TaxSplit {
  assertRate(gstRateBp);
  if (taxType === 'INTRA') {
    const half = mulDivRound(taxable, gstRateBp, 20000);
    return { cgstPaise: half, sgstPaise: half, igstPaise: 0 };
  }
  return { cgstPaise: 0, sgstPaise: 0, igstPaise: mulDivRound(taxable, gstRateBp, 10000) };
}

const taxSum = (t: TaxSplit): Paise => t.cgstPaise + t.sgstPaise + t.igstPaise;

export function computeLine(input: LineInput, taxType: TaxType): LineResult {
  const { qtyMilli, ratePaise, gstRateBp } = input;
  const discountPaise = input.discountPaise ?? 0;
  assertSafeInt(qtyMilli, 'quantity');
  assertSafeInt(ratePaise, 'rate');
  assertSafeInt(discountPaise, 'discount');
  if (qtyMilli <= 0) throw new MoneyError('quantity must be greater than zero');
  if (ratePaise < 0) throw new MoneyError('rate cannot be negative');
  if (discountPaise < 0) throw new MoneyError('discount cannot be negative');

  const amountPaise = mulDivRound(qtyMilli, ratePaise, 1000);
  if (discountPaise > amountPaise) throw new MoneyError('discount cannot exceed the line amount');
  const taxablePaise = amountPaise - discountPaise;
  const tax = taxOn(taxablePaise, gstRateBp, taxType);
  return {
    amountPaise,
    discountPaise,
    taxablePaise,
    gstRateBp,
    ...tax,
    totalPaise: taxablePaise + taxSum(tax),
  };
}

export function computeDelivery(input: DeliveryInput, taxType: TaxType): DeliveryResult {
  assertSafeInt(input.amountPaise, 'delivery charge');
  if (input.amountPaise < 0) throw new MoneyError('delivery charge cannot be negative');
  const tax = taxOn(input.amountPaise, input.gstRateBp, taxType);
  return {
    taxablePaise: input.amountPaise,
    gstRateBp: input.gstRateBp,
    ...tax,
    totalPaise: input.amountPaise + taxSum(tax),
  };
}

export function computeBill(input: BillInput): BillTotals {
  if (input.lines.length === 0) throw new MoneyError('a bill needs at least one line');
  const lines = input.lines.map((l) => computeLine(l, input.taxType));
  const delivery =
    input.delivery && input.delivery.amountPaise > 0 ? computeDelivery(input.delivery, input.taxType) : null;

  const sum = (f: (l: LineResult) => Paise): Paise => lines.reduce((acc, l) => acc + f(l), 0);
  const goodsTaxablePaise = sum((l) => l.taxablePaise);
  const goodsTotalPaise = sum((l) => l.totalPaise);

  const cgstPaise = sum((l) => l.cgstPaise) + (delivery?.cgstPaise ?? 0);
  const sgstPaise = sum((l) => l.sgstPaise) + (delivery?.sgstPaise ?? 0);
  const igstPaise = sum((l) => l.igstPaise) + (delivery?.igstPaise ?? 0);
  const taxableTotalPaise = goodsTaxablePaise + (delivery?.taxablePaise ?? 0);
  const totalTaxPaise = cgstPaise + sgstPaise + igstPaise;
  const preRoundTotalPaise = taxableTotalPaise + totalTaxPaise;

  const mode = input.roundOff ?? 'NEAREST_RUPEE';
  const rounded = mode === 'NEAREST_RUPEE' ? divRound(preRoundTotalPaise, 100) * 100 : preRoundTotalPaise;
  const roundOffPaise = rounded - preRoundTotalPaise;

  return {
    lines,
    delivery,
    goodsTaxablePaise,
    goodsTotalPaise,
    taxableTotalPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalTaxPaise,
    preRoundTotalPaise,
    roundOffPaise,
    totalPaise: rounded,
  };
}

/**
 * Back-solve the pre-tax delivery charge so that the invoice total lands on `targetTotalPaise`
 * (the workflow visible on the sample bill, where the total was fixed at a round figure).
 * Among the candidates that hit the target, the one with the smallest round-off wins.
 */
export function solveDeliveryForTarget(
  base: { lines: LineInput[]; taxType: TaxType },
  deliveryGstRateBp: number,
  targetTotalPaise: Paise,
): { amountPaise: Paise; bill: BillTotals } {
  assertSafeInt(targetTotalPaise, 'target total');
  const noDelivery = computeBill({ ...base, roundOff: 'NONE' });
  const gap = targetTotalPaise - noDelivery.preRoundTotalPaise;
  if (gap < 0) throw new MoneyError('target total is below the goods total');
  const estimate = mulDivRound(gap, 10000, 10000 + deliveryGstRateBp);

  let best: { amountPaise: Paise; bill: BillTotals } | null = null;
  for (let d = Math.max(0, estimate - 5); d <= estimate + 5; d++) {
    const bill = computeBill({
      ...base,
      delivery: { amountPaise: d, gstRateBp: deliveryGstRateBp },
      roundOff: 'NEAREST_RUPEE',
    });
    if (bill.totalPaise !== targetTotalPaise) continue;
    if (!best || Math.abs(bill.roundOffPaise) < Math.abs(best.bill.roundOffPaise)) {
      best = { amountPaise: d, bill };
    }
  }
  if (!best) throw new MoneyError('no delivery charge reaches the target total');
  return best;
}
