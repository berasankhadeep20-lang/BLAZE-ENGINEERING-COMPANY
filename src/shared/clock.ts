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

/**
 * Time zone handling. Timestamps are stored in UTC, but the shop thinks in LOCAL days. All "local" conversions go through Intl with an explicit zone,
 * so they behave identically on every operating system. By default the zone is the computer's own; tests (and, if ever needed, a setting) can pin it.
 * (Setting process.env.TZ at run time is NOT portable: Windows ignores it.)
 */
let zone: string | undefined;
let formatter: Intl.DateTimeFormat | null = null;

/** Pin the shop's time zone (an IANA name such as "Asia/Kolkata"), or pass undefined to follow the computer's own setting again. */
export function setShopTimeZone(tz?: string): void {
  if (tz !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new Error(`unknown time zone: ${tz}`);
    }
  }
  zone = tz;
  formatter = null;
}

export function shopTimeZone(): string {
  return zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsOf(date: Date): Parts {
  formatter ??= new Intl.DateTimeFormat('en-US', {
    ...(zone ? { timeZone: zone } : {}), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of formatter.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year ?? 0, mo: o.month ?? 0, d: o.day ?? 0, h: o.hour ?? 0, mi: o.minute ?? 0, s: o.second ?? 0 };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date as yyyy-mm-dd (the shop's own "today", not UTC's). */
export function localDateString(d: Date): string {
  const p = partsOf(d);
  return `${String(p.y).padStart(4, '0')}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** UTC ISO timestamp -> local "YYYY-MM-DD HH:mm" for display and exports. */
export function toLocalDateTime(iso: string): string {
  const d = new Date(iso);
  const p = partsOf(d);
  return `${localDateString(d)} ${pad2(p.h)}:${pad2(p.mi)}`;
}

/** Local time as yyyymmdd-hhmmss, for file names. */
export function localStamp(d: Date): string {
  const p = partsOf(d);
  return `${String(p.y).padStart(4, '0')}${pad2(p.mo)}${pad2(p.d)}-${pad2(p.h)}${pad2(p.mi)}${pad2(p.s)}`;
}

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`invalid ISO date: "${iso}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`invalid calendar date: "${iso}"`);
  return { y, m: mo, d };
}

/** yyyy-mm-dd plus (or minus) a number of days: pure calendar arithmetic, no time zone involved. */
export function addDays(iso: string, n: number): string {
  const { y, m, d } = parseIsoDate(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** How far the shop's zone is ahead of UTC at a given instant, in milliseconds. */
function offsetMs(t: number): number {
  const whole = Math.floor(t / 1000) * 1000;
  const p = partsOf(new Date(whole));
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - whole;
}

/** The UTC instant at which a local calendar day begins (local midnight). */
function localMidnightUtc(y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const first = offsetMs(guess);
  let t = guess - first;
  const second = offsetMs(t);
  if (second !== first) t = guess - second; // the zone changed offset in between (daylight saving)
  return new Date(t);
}

/**
 * Timestamps are stored in UTC but the shop thinks in local days. Turn an inclusive local date range into UTC bounds:
 * `fromUtc` is local midnight at the start of `from`; `toUtcExclusive` is local midnight after `to`.
 */
export function localDayRangeToUtc(from?: string, to?: string): { fromUtc?: string; toUtcExclusive?: string } {
  const out: { fromUtc?: string; toUtcExclusive?: string } = {};
  if (from) {
    const { y, m, d } = parseIsoDate(from);
    out.fromUtc = localMidnightUtc(y, m, d).toISOString();
  }
  if (to) {
    const next = parseIsoDate(addDays(to, 1));
    parseIsoDate(to);
    out.toUtcExclusive = localMidnightUtc(next.y, next.m, next.d).toISOString();
  }
  if (from && to && from > to) throw new Error('the start date is after the end date');
  return out;
}
