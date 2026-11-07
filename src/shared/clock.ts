/** Time is injected so tests are deterministic and "today" is decided in one place. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO timestamp: "${iso}"`);
  return { now: () => new Date(d.getTime()) };
}

/** Local calendar date as yyyy-mm-dd (the shop's own "today", not UTC's). */
export function localDateString(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`invalid ISO date: "${iso}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(y, mo - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) {
    throw new Error(`invalid calendar date: "${iso}"`);
  }
  return { y, m: mo, d };
}

/**
 * Timestamps are stored in UTC but the shop thinks in local days. Turn an inclusive local date range into UTC bounds:
 * `fromUtc` is local midnight at the start of `from`; `toUtcExclusive` is local midnight after `to`.
 */
export function localDayRangeToUtc(from?: string, to?: string): { fromUtc?: string; toUtcExclusive?: string } {
  const out: { fromUtc?: string; toUtcExclusive?: string } = {};
  if (from) {
    const { y, m, d } = parseIsoDate(from);
    out.fromUtc = new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  }
  if (to) {
    const { y, m, d } = parseIsoDate(to);
    out.toUtcExclusive = new Date(y, m - 1, d + 1, 0, 0, 0, 0).toISOString();
  }
  if (from && to && from > to) throw new Error('the start date is after the end date');
  return out;
}

/** UTC ISO timestamp -> local "YYYY-MM-DD HH:mm" for display and exports. */
export function toLocalDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${localDateString(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
