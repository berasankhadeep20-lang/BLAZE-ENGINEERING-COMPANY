/**
 * GSTIN and Indian state reference data.
 * The checksum rule was verified against known real GSTINs. The state list follows the GST state codes; the owner should
 * confirm it against the GST portal if a code ever looks wrong. The app validates FORMAT and CHECK DIGIT only: it cannot
 * know whether a number is actually registered or belongs to the named party.
 */

export interface IndianState {
  code: string; // two-digit GST state code
  name: string;
}

export const INDIAN_STATES: readonly IndianState[] = [
  { code: '01', name: 'Jammu and Kashmir' }, { code: '02', name: 'Himachal Pradesh' }, { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' }, { code: '05', name: 'Uttarakhand' }, { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' }, { code: '08', name: 'Rajasthan' }, { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' }, { code: '11', name: 'Sikkim' }, { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' }, { code: '14', name: 'Manipur' }, { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' }, { code: '17', name: 'Meghalaya' }, { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' }, { code: '20', name: 'Jharkhand' }, { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' }, { code: '23', name: 'Madhya Pradesh' }, { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' }, { code: '27', name: 'Maharashtra' },
  { code: '28', name: 'Andhra Pradesh (old)' }, { code: '29', name: 'Karnataka' }, { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' }, { code: '32', name: 'Kerala' }, { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' }, { code: '35', name: 'Andaman and Nicobar Islands' }, { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' }, { code: '38', name: 'Ladakh' }, { code: '97', name: 'Other Territory' },
  { code: '99', name: 'Centre Jurisdiction' },
];

export const GSTIN_UNREGISTERED_LABEL = 'UN-REGD'; // as printed on the sample bill

export function stateByName(name: string): IndianState | undefined {
  const n = name.trim().toLowerCase();
  return INDIAN_STATES.find((s) => s.name.toLowerCase() === n);
}

export function stateByCode(code: string): IndianState | undefined {
  return INDIAN_STATES.find((s) => s.code === code);
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The 15th character: a base-36 check digit over the first 14. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < first14.length; i++) {
    const v = ALPHABET.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return ALPHABET.charAt((36 - (sum % 36)) % 36);
}

const GSTIN_FORMAT = /^(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Problems with a GSTIN (empty list = format, state code and check digit are all fine). Input should already be upper-case. */
export function gstinProblems(gstin: string): string[] {
  const m = GSTIN_FORMAT.exec(gstin);
  if (!m) return ['GSTIN must be 15 characters in the standard format (for example 19ABCDE1234F1Z5)'];
  const problems: string[] = [];
  if (!stateByCode(m[1] ?? '')) problems.push('GSTIN starts with an unknown state code');
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin.charAt(14)) problems.push('GSTIN check digit is wrong; please re-check the number');
  return problems;
}

export function stateFromGstin(gstin: string): IndianState | undefined {
  return stateByCode(gstin.slice(0, 2));
}

/** CGST+SGST when seller and buyer are in the same state, IGST otherwise. */
export function taxTypeForSupply(sellerState: string, buyerState: string): 'INTRA' | 'INTER' {
  return sellerState.trim().toLowerCase() === buyerState.trim().toLowerCase() ? 'INTRA' : 'INTER';
}
