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
