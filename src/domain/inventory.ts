/** Pure inventory rules. */

export const COMMON_UNITS = ['PCS', 'KG', 'GM', 'LTR', 'ML', 'MTR', 'BOX', 'SET'] as const;

export type StockStatus = 'OK' | 'LOW' | 'OUT';

/** OUT = nothing left; LOW = at or below a (non-zero) reorder level; otherwise OK. */
export function stockStatus(qtyMilli: number, reorderQtyMilli: number): StockStatus {
  if (qtyMilli <= 0) return 'OUT';
  if (reorderQtyMilli > 0 && qtyMilli <= reorderQtyMilli) return 'LOW';
  return 'OK';
}

/** The "UOM" column as printed on the sample bill: pack size and unit ("40 - LTR", "500 - ML"), or "PCS - PCS" without a pack size. */
export function uomLabel(unit: string, packSize: string | null | undefined): string {
  return `${packSize?.trim() || unit} - ${unit}`;
}
