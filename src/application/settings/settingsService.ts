import { gstinProblems, stateByName, stateFromGstin } from '../../domain/gstin';
import type { RoundOffMode } from '../../domain/gst';
import { systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';

export const DEFAULT_PAYMENT_METHODS = ['Cash', 'UPI', 'Cheque', 'Bank transfer', 'Card'];
export const DEFAULT_INVOICE_TITLE = 'Tax Invoice cum Challan';
export const DEFAULT_DECLARATION = 'Certified that the particulars given above are true and correct';
export const DEFAULT_INVOICE_COPIES = ['Original for Recipient', 'Duplicate for Transporter', 'Triplicate for Supplier'];
const MAX_LOGO_BYTES = 300 * 1024;

export interface AppSettings {
  businessName: string | null;
  businessState: string | null; // decides CGST+SGST (same state) versus IGST
  businessAddress: string | null; // may run over several lines
  businessPhone: string | null;
  businessEmail: string | null;
  businessGstin: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  invoicePrefix: string | null; // e.g. "BZ": bills are numbered prefix + 2-digit year + sequence
  invoiceNumberWidth: number;
  invoiceTitle: string; // printed heading, default "Tax Invoice cum Challan"
  invoiceTerms: string | null; // "Terms and Conditions" printed on every invoice; no default is invented
  invoiceDeclaration: string; // the "Certified that..." sentence
  invoiceCopies: string[]; // one printed page per label, e.g. Original / Duplicate / Triplicate; empty = a single page with no copy label
  receiptPrefix: string;
  purchasePrefix: string; // internal purchase bill numbers (not a legal series); defaults to PB
  supplierReceiptPrefix: string; // numbers for payments made to suppliers; defaults to SP
  roundOff: RoundOffMode;
  warnBelowCost: boolean;
  paymentMethods: string[];
  hasLogo: boolean;
}

const KEY = {
  businessName: 'business.name',
  businessState: 'business.state',
  businessAddress: 'business.address',
  businessPhone: 'business.phone',
  businessEmail: 'business.email',
  businessGstin: 'business.gstin',
  bankName: 'bank.name',
  bankBranch: 'bank.branch',
  bankAccountNo: 'bank.account_no',
  bankIfsc: 'bank.ifsc',
  invoicePrefix: 'invoice.prefix',
  invoiceNumberWidth: 'invoice.number_width',
  invoiceTitle: 'invoice.title',
  invoiceTerms: 'invoice.terms',
  invoiceDeclaration: 'invoice.declaration',
  invoiceCopies: 'invoice.copies',
  receiptPrefix: 'receipt.prefix',
  purchasePrefix: 'purchase.prefix',
  supplierReceiptPrefix: 'supplier_receipt.prefix',
  roundOff: 'invoice.round_off',
  warnBelowCost: 'sale.warn_below_cost',
  paymentMethods: 'payment.methods',
} as const satisfies Record<Exclude<keyof AppSettings, 'hasLogo'>, string>;
const LOGO_KEY = 'business.logo';

function stringList(raw: string | undefined, fallback: string[], allowEmpty: boolean): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && (allowEmpty || parsed.length > 0)) return parsed as string[];
  } catch {
    /* fall back to the defaults */
  }
  return fallback;
}

/** Read settings with defaults. Business name, address, GSTIN, state, bank details, terms and invoice prefix have no default: the app never invents them. */
export function readSettings(db: Db): AppSettings {
  const rows = db.prepare('SELECT key, value FROM app_setting WHERE key <> ?').all(LOGO_KEY) as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const width = Number(m.get(KEY.invoiceNumberWidth));
  const get = (k: string): string | null => m.get(k) ?? null;
  return {
    businessName: get(KEY.businessName),
    businessState: get(KEY.businessState),
    businessAddress: get(KEY.businessAddress),
    businessPhone: get(KEY.businessPhone),
    businessEmail: get(KEY.businessEmail),
    businessGstin: get(KEY.businessGstin),
    bankName: get(KEY.bankName),
    bankBranch: get(KEY.bankBranch),
    bankAccountNo: get(KEY.bankAccountNo),
    bankIfsc: get(KEY.bankIfsc),
    invoicePrefix: get(KEY.invoicePrefix),
    invoiceNumberWidth: Number.isInteger(width) && width >= 3 && width <= 8 ? width : 4,
    invoiceTitle: m.get(KEY.invoiceTitle) ?? DEFAULT_INVOICE_TITLE,
    invoiceTerms: get(KEY.invoiceTerms),
    invoiceDeclaration: m.get(KEY.invoiceDeclaration) ?? DEFAULT_DECLARATION,
    invoiceCopies: stringList(m.get(KEY.invoiceCopies), DEFAULT_INVOICE_COPIES, true),
    receiptPrefix: m.get(KEY.receiptPrefix) ?? 'RC',
    purchasePrefix: m.get(KEY.purchasePrefix) ?? 'PB',
    supplierReceiptPrefix: m.get(KEY.supplierReceiptPrefix) ?? 'SP',
    roundOff: m.get(KEY.roundOff) === 'NONE' ? 'NONE' : 'NEAREST_RUPEE',
    warnBelowCost: m.get(KEY.warnBelowCost) !== 'false',
    paymentMethods: stringList(m.get(KEY.paymentMethods), DEFAULT_PAYMENT_METHODS, false),
    hasLogo: !!db.prepare('SELECT 1 FROM app_setting WHERE key = ?').get(LOGO_KEY),
  };
}

/** The logo as a data: URI, or null. Read separately because it can be large. */
export function readLogo(db: Db): string | null {
  return (db.prepare('SELECT value FROM app_setting WHERE key = ?').get(LOGO_KEY) as { value: string } | undefined)?.value ?? null;
}

/**
 * Settings can be changed but not cleared with null. For the optional text settings (address, phone, email, GSTIN, bank details, terms) an empty string clears
 * them; for the title and the declaration an empty string restores the default. The logo has its own methods.
 */
export type SettingsPatch = { [K in Exclude<keyof AppSettings, 'hasLogo'>]?: NonNullable<AppSettings[K]> };

const mask = (key: string, v: string | null): string | null => (key === KEY.bankAccountNo && v ? `••••${v.slice(-4)}` : v);

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
    const current = readSettings(this.db);
    const p = new Problems();
    const next: Record<string, string | null> = {}; // null = remove the stored value (back to unset / default)
    const text = (k: keyof SettingsPatch, max: number, label: string, pattern?: { re: RegExp; msg: string }, transform?: (s: string) => string): void => {
      const raw = patch[k];
      if (raw === undefined) return;
      const v = (raw as string).trim();
      if (v === '') {
        next[KEY[k]] = null;
        return;
      }
      p.require(v.length <= max, `${label} is too long (${String(max)} characters at most)`);
      if (pattern) p.require(pattern.re.test(transform ? transform(v) : v), pattern.msg);
      next[KEY[k]] = transform ? transform(v) : v;
    };

    if (patch.businessName !== undefined) {
      p.require(patch.businessName.trim().length >= 1 && patch.businessName.trim().length <= 120, 'business name must be 1 to 120 characters');
      next[KEY.businessName] = patch.businessName.trim();
    }
    let state = current.businessState;
    if (patch.businessState !== undefined) {
      const st = stateByName(patch.businessState);
      p.require(!!st, 'business state is not a recognised Indian state or union territory');
      state = st?.name ?? state;
      next[KEY.businessState] = st?.name ?? '';
    }
    text('businessAddress', 300, 'address');
    text('businessPhone', 30, 'phone number', { re: /^\+?[0-9][0-9 ()-]{5,29}$/, msg: 'phone number looks wrong (digits, spaces, + ( ) - only)' });
    text('businessEmail', 120, 'email address', { re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: 'email address looks wrong' });
    text('bankName', 60, 'bank name');
    text('bankBranch', 60, 'bank branch');
    text('bankAccountNo', 30, 'bank account number', { re: /^[0-9]{6,20}$/, msg: 'bank account number must be 6 to 20 digits' }, (s) => s.replace(/\s/g, ''));
    text('bankIfsc', 11, 'IFSC code', { re: /^[A-Z]{4}0[A-Z0-9]{6}$/, msg: 'IFSC code looks wrong (4 letters, a zero, then 6 letters or digits)' }, (s) => s.toUpperCase());
    text('invoiceTerms', 600, 'terms and conditions');
    text('invoiceTitle', 60, 'invoice title');
    text('invoiceDeclaration', 200, 'declaration');

    if (patch.businessGstin !== undefined) {
      const g = patch.businessGstin.trim().toUpperCase().replace(/\s/g, '');
      if (g === '') next[KEY.businessGstin] = null;
      else {
        for (const msg of gstinProblems(g)) p.require(false, msg);
        next[KEY.businessGstin] = g;
      }
    }
    // the business's GSTIN and its state must agree
    const effectiveGstin = patch.businessGstin !== undefined ? (next[KEY.businessGstin] ?? null) : current.businessGstin;
    if (effectiveGstin && state && gstinProblems(effectiveGstin).length === 0 && stateFromGstin(effectiveGstin)?.name !== state) {
      p.require(false, `the business state (${state}) does not match the GSTIN, which is for ${stateFromGstin(effectiveGstin)?.name ?? 'another state'}`);
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
    if (patch.invoiceCopies !== undefined) {
      const list = patch.invoiceCopies.map((x) => x.trim());
      p.require(list.length <= 3, 'at most 3 copies (original, duplicate, triplicate)');
      p.require(list.every((x) => x.length >= 1 && x.length <= 40), 'each copy label must be 1 to 40 characters');
      p.require(new Set(list.map((x) => x.toLowerCase())).size === list.length, 'copy labels must be different from each other');
      next[KEY.invoiceCopies] = JSON.stringify(list);
    }
    p.throwIfAny();

    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const changes: Record<string, { from: string | null; to: string | null }> = {};
      for (const [key, value] of Object.entries(next)) {
        const cur = ctx.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as { value: string } | undefined;
        if ((cur?.value ?? null) === value) continue;
        if (value === null) ctx.db.prepare('DELETE FROM app_setting WHERE key = ?').run(key);
        else {
          ctx.db
            .prepare(`INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(key, value, user.id, ctx.now);
        }
        changes[key] = { from: mask(key, cur?.value ?? null), to: mask(key, value) };
      }
      if (Object.keys(changes).length) recordAudit(ctx, { action: 'SETTINGS_UPDATE', entityType: 'settings', detail: { changes } });
    });
    return readSettings(this.db);
  }

  /** Set the logo printed on invoices. PNG or JPEG only (no SVG: it can carry scripts), up to 300 KB; the type is taken from the file's own bytes, not its name. */
  setLogo(token: string, bytes: Uint8Array): void {
    const user = this.auth.authorize(token, 'settings.edit');
    const isPng = bytes.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) throw new AppError('VALIDATION', 'the logo must be a PNG or JPEG picture');
    if (bytes.length > MAX_LOGO_BYTES) throw new AppError('VALIDATION', 'the logo is too big (300 KB at most); please use a smaller picture');
    const uri = `data:${isPng ? 'image/png' : 'image/jpeg'};base64,${Buffer.from(bytes).toString('base64')}`;
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      ctx.db
        .prepare(`INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(LOGO_KEY, uri, user.id, ctx.now);
      recordAudit(ctx, { action: 'SETTINGS_UPDATE', entityType: 'settings', detail: { logo: 'set', bytes: bytes.length, type: isPng ? 'png' : 'jpeg' } });
    });
  }

  clearLogo(token: string): void {
    const user = this.auth.authorize(token, 'settings.edit');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      if (ctx.db.prepare('DELETE FROM app_setting WHERE key = ?').run(LOGO_KEY).changes > 0) {
        recordAudit(ctx, { action: 'SETTINGS_UPDATE', entityType: 'settings', detail: { logo: 'cleared' } });
      }
    });
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
