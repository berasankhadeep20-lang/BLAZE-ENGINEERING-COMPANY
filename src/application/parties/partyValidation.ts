import { gstinProblems, stateByName, stateFromGstin } from '../../domain/gstin';
import { Problems } from '../../shared/validation';

export interface PartyFields {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  state?: string | null;
  gstin?: string | null;
  notes?: string | null;
}

export const blankToNull = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === '' ? null : s.trim());

/** Trim, upper-case the GSTIN, store the canonical state name; validate whichever fields are present. */
export function normalizeParty<T extends PartyFields>(p: Problems, fields: T, label: string): T {
  const out: PartyFields = { ...fields };
  if ('name' in fields) {
    out.name = (fields.name ?? '').trim();
    p.require(out.name.length >= 1 && out.name.length <= 120, `${label} name must be 1 to 120 characters`);
  }
  for (const k of ['phone', 'email', 'address', 'notes'] as const) if (k in fields) out[k] = blankToNull(fields[k]);
  if (out.phone) p.require(/^\+?[0-9][0-9 ()-]{5,19}$/.test(out.phone), 'phone number looks wrong (digits, spaces, + ( ) - only)');
  if (out.email) p.require(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email) && out.email.length <= 120, 'email address looks wrong');
  if (out.address) p.require(out.address.length <= 300, 'address is too long (300 characters at most)');
  if (out.notes) p.require(out.notes.length <= 500, 'notes are too long (500 characters at most)');

  if ('gstin' in fields) {
    const g = blankToNull(fields.gstin)?.toUpperCase().replace(/\s/g, '') ?? null;
    out.gstin = g;
    if (g) for (const m of gstinProblems(g)) p.require(false, m);
  }
  if ('state' in fields) {
    const raw = blankToNull(fields.state);
    if (raw === null) out.state = null;
    else {
      const st = stateByName(raw);
      p.require(!!st, `"${raw}" is not a recognised Indian state or union territory`);
      out.state = st?.name ?? raw;
    }
  }
  return out as T;
}

/** After normalisation: the state must exist, and must agree with the GSTIN's state code when there is one. Returns the state to store. */
export function resolveState(p: Problems, state: string | null | undefined, gstin: string | null | undefined, label: string): string | null {
  const fromGstin = gstin ? stateFromGstin(gstin) : undefined;
  if (state && fromGstin && stateByName(state)?.code !== fromGstin.code) {
    p.require(false, `${label}'s state (${state}) does not match the GSTIN, which is for ${fromGstin.name}`);
  }
  const resolved = state ?? fromGstin?.name ?? null;
  p.require(resolved !== null, `${label}'s state is required: it decides whether a bill uses CGST+SGST or IGST`);
  return resolved;
}

/** '%' and '_' typed by the user must match literally in LIKE. */
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);
