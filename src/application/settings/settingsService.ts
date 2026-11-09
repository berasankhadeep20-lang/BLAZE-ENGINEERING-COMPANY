import { stateByName } from '../../domain/gstin';
import type { RoundOffMode } from '../../domain/gst';
import { systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';

export const DEFAULT_PAYMENT_METHODS = ['Cash', 'UPI', 'Cheque', 'Bank transfer', 'Card'];

export interface AppSettings {
  businessName: string | null;
  businessState: string | null; // decides CGST+SGST (same state) versus IGST
  invoicePrefix: string | null; // e.g. "BZ": bills are numbered prefix + 2-digit year + sequence
  invoiceNumberWidth: number;
  receiptPrefix: string;
  purchasePrefix: string; // internal purchase bill numbers (not a legal series); defaults to PB
  supplierReceiptPrefix: string; // numbers for payments made to suppliers; defaults to SP
  roundOff: RoundOffMode;
  warnBelowCost: boolean;
  paymentMethods: string[];
}

const KEY = {
  businessName: 'business.name',
  businessState: 'business.state',
  invoicePrefix: 'invoice.prefix',
  invoiceNumberWidth: 'invoice.number_width',
  receiptPrefix: 'receipt.prefix',
  purchasePrefix: 'purchase.prefix',
  supplierReceiptPrefix: 'supplier_receipt.prefix',
  roundOff: 'invoice.round_off',
  warnBelowCost: 'sale.warn_below_cost',
  paymentMethods: 'payment.methods',
} as const satisfies Record<keyof AppSettings, string>;

/** Read settings with defaults. Business name, state and invoice prefix have no default: the app never invents them. */
export function readSettings(db: Db): AppSettings {
  const rows = db.prepare('SELECT key, value FROM app_setting').all() as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, r.value]));
  let methods = DEFAULT_PAYMENT_METHODS;
  try {
    const parsed: unknown = JSON.parse(m.get(KEY.paymentMethods) ?? 'null');
    if (Array.isArray(parsed) && parsed.length && parsed.every((x) => typeof x === 'string')) methods = parsed as string[];
  } catch {
    /* fall back to the defaults */
  }
  const width = Number(m.get(KEY.invoiceNumberWidth));
  return {
    businessName: m.get(KEY.businessName) ?? null,
    businessState: m.get(KEY.businessState) ?? null,
    invoicePrefix: m.get(KEY.invoicePrefix) ?? null,
    invoiceNumberWidth: Number.isInteger(width) && width >= 3 && width <= 8 ? width : 4,
    receiptPrefix: m.get(KEY.receiptPrefix) ?? 'RC',
    purchasePrefix: m.get(KEY.purchasePrefix) ?? 'PB',
    supplierReceiptPrefix: m.get(KEY.supplierReceiptPrefix) ?? 'SP',
    roundOff: m.get(KEY.roundOff) === 'NONE' ? 'NONE' : 'NEAREST_RUPEE',
    warnBelowCost: m.get(KEY.warnBelowCost) !== 'false',
    paymentMethods: methods,
  };
}

/** Settings can be changed but not cleared, so null is not allowed in a patch. */
export type SettingsPatch = { [K in keyof AppSettings]?: NonNullable<AppSettings[K]> };

/** Owner-only business settings. (More settings, such as address, bank details and the logo, arrive with the settings screen.) */
export class SettingsService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  get(token: string): AppSettings {
    this.auth.requireSignedIn(token);
    return readSettings(this.db);
  }

  update(token: string, patch: SettingsPatch): AppSettings {
    const user = this.auth.authorize(token, 'settings.edit');
    const p = new Problems();
    const next: Record<string, string> = {};
    if (patch.businessName !== undefined) {
      p.require(patch.businessName.trim().length >= 1 && patch.businessName.trim().length <= 120, 'business name must be 1 to 120 characters');
      next[KEY.businessName] = patch.businessName.trim();
    }
    if (patch.businessState !== undefined) {
      const st = stateByName(patch.businessState);
      p.require(!!st, 'business state is not a recognised Indian state or union territory');
      next[KEY.businessState] = st?.name ?? '';
    }
    for (const k of ['invoicePrefix', 'receiptPrefix', 'purchasePrefix', 'supplierReceiptPrefix'] as const) {
      const v = patch[k];
      if (v !== undefined) {
        p.require(/^[A-Za-z0-9]{1,6}$/.test(v.trim()), `${k} must be 1 to 6 letters or digits`);
        next[KEY[k]] = v.trim().toUpperCase();
      }
    }
    if (patch.invoiceNumberWidth !== undefined) {
      p.require(Number.isInteger(patch.invoiceNumberWidth) && patch.invoiceNumberWidth >= 3 && patch.invoiceNumberWidth <= 8, 'number width must be 3 to 8');
      next[KEY.invoiceNumberWidth] = String(patch.invoiceNumberWidth);
    }
    if (patch.roundOff !== undefined) {
      p.require(patch.roundOff === 'NEAREST_RUPEE' || patch.roundOff === 'NONE', 'rounding must be NEAREST_RUPEE or NONE');
      next[KEY.roundOff] = patch.roundOff;
    }
    if (patch.warnBelowCost !== undefined) next[KEY.warnBelowCost] = patch.warnBelowCost ? 'true' : 'false';
    if (patch.paymentMethods !== undefined) {
      const list = patch.paymentMethods.map((x) => x.trim());
      p.require(list.length >= 1 && list.length <= 10, 'give 1 to 10 payment methods');
      p.require(list.every((x) => x.length >= 1 && x.length <= 30), 'each payment method must be 1 to 30 characters');
      p.require(new Set(list.map((x) => x.toLowerCase())).size === list.length, 'payment methods must be different from each other');
      next[KEY.paymentMethods] = JSON.stringify(list);
    }
    p.throwIfAny();

    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const changes: Record<string, { from: string | null; to: string }> = {};
      for (const [key, value] of Object.entries(next)) {
        const cur = ctx.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as { value: string } | undefined;
        if (cur?.value === value) continue;
        ctx.db
          .prepare(`INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(key, value, user.id, ctx.now);
        changes[key] = { from: cur?.value ?? null, to: value };
      }
      if (Object.keys(changes).length) recordAudit(ctx, { action: 'SETTINGS_UPDATE', entityType: 'settings', detail: { changes } });
    });
    return readSettings(this.db);
  }
}

/** Purchases only need the business state (to decide CGST+SGST versus IGST). */
export function requireBusinessState(s: AppSettings): string {
  if (!s.businessState) throw new AppError('VALIDATION', 'please set your business state in Settings before entering purchases', { missing: ['your business state'] });
  return s.businessState;
}

/** Throws a clear VALIDATION error naming whatever setting is missing before a bill can be issued. */
export function requireBillingSettings(s: AppSettings): { businessState: string; invoicePrefix: string } {
  const missing: string[] = [];
  if (!s.businessState) missing.push('your business state');
  if (!s.invoicePrefix) missing.push('the invoice number prefix');
  if (missing.length || !s.businessState || !s.invoicePrefix) {
    throw new AppError('VALIDATION', `please set ${missing.join(' and ')} in Settings before issuing bills`, { missing });
  }
  return { businessState: s.businessState, invoicePrefix: s.invoicePrefix };
}
