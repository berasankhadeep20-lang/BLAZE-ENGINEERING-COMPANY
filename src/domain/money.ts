/**
 * Money and quantity primitives.
 *
 * - Money is an integer number of paise (1 rupee = 100 paise). Never a float.
 * - Quantity is an integer number of thousandths ("milli" units), so 2.5 kg = 2500.
 * - Division always goes through divRound (exact, BigInt based, half away from zero).
 */

export type Paise = number;
export type QtyMilli = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertSafeInt(n: number, label = 'value'): void {
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(`${label} must be a safe integer, got ${String(n)}`);
  }
}

/** Exact n / d rounded to the nearest integer, halves rounded away from zero. */
export function divRound(n: number, d: number): number {
  assertSafeInt(n, 'numerator');
  assertSafeInt(d, 'denominator');
  if (d === 0) throw new MoneyError('division by zero');
  const N = BigInt(n);
  const D = BigInt(d);
  const negative = N < 0n !== D < 0n;
  const absN = N < 0n ? -N : N;
  const absD = D < 0n ? -D : D;
  const q = (2n * absN + absD) / (2n * absD); // floor(absN/absD + 1/2)
  return Number(negative ? -q : q);
}

/** Exact (a * b) / d rounded half away from zero; the product is computed in BigInt so it cannot overflow. */
export function mulDivRound(a: number, b: number, d: number): number {
  assertSafeInt(a, 'a');
  assertSafeInt(b, 'b');
  assertSafeInt(d, 'denominator');
  if (d === 0) throw new MoneyError('division by zero');
  const N = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  const negative = N < 0n !== D < 0n;
  const absN = N < 0n ? -N : N;
  const absD = D < 0n ? -D : D;
  const q = (2n * absN + absD) / (2n * absD);
  const result = negative ? -q : q;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('result out of safe integer range');
  }
  return Number(result);
}

/** Parse a rupee string such as "92.37", "1,250", "₹ 55" into paise. More than 2 decimals is an error (never silently rounded). */
export function parseRupees(input: string): Paise {
  const cleaned = input.replace(/[₹\s,]|^Rs\.?/gi, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new MoneyError(`invalid rupee amount: "${input}"`);
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  const paise = whole * 100 + frac;
  assertSafeInt(paise, 'amount');
  return m[1] ? -paise : paise;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Format paise with Indian digit grouping, e.g. 12345678 -> "1,23,456.78". */
export function formatINR(paise: Paise, opts: { symbol?: string } = {}): string {
  assertSafeInt(paise, 'amount');
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const ps = String(abs % 100).padStart(2, '0');
  const body = `${groupIndian(String(rupees))}.${ps}`;
  const withSymbol = opts.symbol ? `${opts.symbol}${body}` : body;
  return paise < 0 ? `-${withSymbol}` : withSymbol;
}

/** Parse a quantity string with up to 3 decimals into thousandths. */
export function parseQty(input: string): QtyMilli {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!m) throw new MoneyError(`invalid quantity: "${input}"`);
  const milli = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'));
  assertSafeInt(milli, 'quantity');
  return milli;
}

/** Format thousandths, trimming trailing zeros: 2000 -> "2", 2500 -> "2.5". */
export function formatQty(milli: QtyMilli): string {
  assertSafeInt(milli, 'quantity');
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}
