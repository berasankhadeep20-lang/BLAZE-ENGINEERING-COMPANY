/** Financial year (April to March) and bill-number formatting. */

export function financialYear(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`invalid ISO date: "${isoDate}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`invalid calendar date: "${isoDate}"`);
  }
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** brand "BZ" + FY "2026-27" -> "BZ26" */
export function seriesPrefix(brand: string, fy: string): string {
  if (!/^\d{4}-\d{2}$/.test(fy)) throw new Error(`invalid financial year: "${fy}"`);
  return `${brand}${fy.slice(2, 4)}`;
}

/** ("BZ26", 150) -> "BZ260150" */
export function formatBillNo(prefix: string, sequence: number, width = 4): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('sequence must be a positive integer');
  return `${prefix}${String(sequence).padStart(width, '0')}`;
}
