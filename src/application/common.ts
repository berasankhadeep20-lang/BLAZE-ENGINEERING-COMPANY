import { MoneyError } from '../domain/money';
import { AppError } from '../shared/errors';

/** True for a real calendar date written yyyy-mm-dd. */
export const isoDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** Trimmed text, or null when blank. */
export const clean = (s: string | undefined | null): string | null => (s === undefined || s === null || s.trim() === '' ? null : s.trim());

/** The engine throws MoneyError for impossible figures (such as a discount above the line amount); show those as ordinary validation errors. */
export function priced<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MoneyError) throw new AppError('VALIDATION', e.message);
    throw e;
  }
}
