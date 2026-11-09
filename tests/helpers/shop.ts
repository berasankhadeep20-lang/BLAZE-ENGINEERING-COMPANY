import type { SaleLineInput } from '../../src/application/sales/saleService';
import { setupHarness, type Harness } from './auth';

export type Shop = Harness & { recoveryCode: string; ids: { can: number; buty: number; naoh: number; farm: number; supplier: number } };

/** Create an employee who has changed their temporary password and is signed in. */
export async function makeEmployee(h: Harness, username: string, permissions: string[]): Promise<string> {
  await h.users.createEmployee(h.ownerToken, { username, displayName: `Clerk ${username}`, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await h.auth.login(username, 'temp-pass-123');
  await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return token;
}

/**
 * A shop like the sample bill's: three items (milk can, butyrometer, sodium hydroxide solution, all 18% GST) with stock,
 * one approved West Bengal customer, and the business settings filled in. All names are fictional.
 */
export async function shopHarness(opts: { configure?: boolean } = {}): Promise<Shop> {
  const h = await setupHarness();
  if (opts.configure !== false) {
    h.settings.update(h.ownerToken, { businessName: 'TEST ENGINEERING CO', businessState: 'West Bengal', invoicePrefix: 'bz' });
  }
  const base = { gstRateBp: 1800 };
  const can = h.items.create(h.ownerToken, { ...base, code: 'MC-40', name: 'PLASTIC MILK CAN', hsn: '3923', unit: 'LTR', packSize: '40', purchaseRatePaise: 80000, saleRatePaise: 92500, reorderQtyMilli: 2000, openingQtyMilli: 10000 });
  const buty = h.items.create(h.ownerToken, { ...base, code: 'BUT-10', name: 'BUTYROMETER FOR MILK 0-10% ISI', hsn: '7017', unit: 'PCS', purchaseRatePaise: 4000, saleRatePaise: 5500, openingQtyMilli: 100000 });
  const naoh = h.items.create(h.ownerToken, { ...base, code: 'NAOH-500', name: 'SODIUM HYDROXIDE N/10 SOLUTION', hsn: '2815', unit: 'ML', packSize: '500', purchaseRatePaise: 20000, saleRatePaise: 24500, openingQtyMilli: 50000 });
  const farm = h.customers.create(h.ownerToken, { name: 'TEST DAIRY FARM', state: 'West Bengal', address: 'Vill Example, Hooghly 712000', placeOfSupply: 'EXAMPLEPUR' });
  const supplier = h.suppliers.create(h.ownerToken, { name: 'SAMPLE DAIRY EQUIPMENT CO', state: 'West Bengal', address: 'Plot 1, Example Estate' });
  return { ...h, ids: { can, buty, naoh, farm, supplier } };
}

/** The three lines of the sample bill: two of each item. */
export const sampleLines = (ids: Shop['ids']): SaleLineInput[] => [
  { itemId: ids.can, qtyMilli: 2000 },
  { itemId: ids.buty, qtyMilli: 2000 },
  { itemId: ids.naoh, qtyMilli: 2000 },
];

/** Draft + confirm one bill of `buty` butyrometers; returns its id and total. */
export function quickBill(h: Shop, opts: { customerId?: number; date?: string; qtyMilli?: number } = {}): { id: number; billNo: string; totalPaise: number } {
  const draft = h.sales.saveDraft(h.ownerToken, { customerId: opts.customerId ?? h.ids.farm, invoiceDate: opts.date ?? '2026-11-01', lines: [{ itemId: h.ids.buty, qtyMilli: opts.qtyMilli ?? 10000 }] });
  const bill = h.sales.confirm(h.ownerToken, draft.id);
  return { id: bill.id, billNo: bill.billNo ?? '', totalPaise: bill.totals.totalPaise };
}
