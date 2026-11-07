/** Amount in words using Indian numbering (thousand, lakh, crore). */
import { MoneyError, assertSafeInt, type Paise } from './money';

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  const o = ONES[n % 10] ?? '';
  return o ? `${t} ${o}` : t;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h] ?? ''} Hundred`);
  if (r) parts.push(below100(r));
  return parts.join(' ');
}

export function numberToWordsIndian(n: number): string {
  assertSafeInt(n, 'number');
  if (n < 0) throw new MoneyError('negative numbers are not supported');
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${numberToWordsIndian(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

/** 300000 paise -> "Three Thousand only"; 305050 -> "Three Thousand Fifty and Fifty Paise only". */
export function amountInWords(paise: Paise): string {
  assertSafeInt(paise, 'amount');
  if (paise < 0) throw new MoneyError('amount in words needs a non-negative amount');
  const rupees = Math.floor(paise / 100);
  const ps = paise % 100;
  if (rupees === 0 && ps === 0) return 'Zero only';
  const parts: string[] = [];
  if (rupees > 0) parts.push(numberToWordsIndian(rupees));
  if (ps > 0) parts.push(`${rupees > 0 ? 'and ' : ''}${numberToWordsIndian(ps)} Paise`);
  return `${parts.join(' ')} only`;
}
