import { stockStatus, uomLabel, type StockStatus } from '../../domain/inventory';
import { formatPlainRupees } from '../../domain/money';
import { systemClock, type Clock } from '../../shared/clock';
import { toCsv } from '../../shared/csv';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postStockMovement } from '../../infrastructure/db/ledgers';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';

export interface ItemDto {
  id: number;
  code: string;
  name: string;
  description: string | null;
  hsn: string | null;
  categoryId: number | null;
  category: string | null;
  unit: string;
  packSize: string | null;
  uomLabel: string;
  purchaseRatePaise: number;
  saleRatePaise: number;
  gstRateBp: number;
  qtyMilli: number;
  reorderQtyMilli: number;
  supplierId: number | null;
  location: string | null;
  isActive: boolean;
  stockStatus: StockStatus;
}

export interface ItemInput {
  code: string;
  name: string;
  description?: string;
  hsn?: string;
  categoryId?: number;
  unit: string;
  packSize?: string;
  purchaseRatePaise: number;
  saleRatePaise: number;
  gstRateBp: number; // always explicit: the app never assumes a tax rate
  reorderQtyMilli?: number;
  supplierId?: number;
  location?: string;
  openingQtyMilli?: number;
}

export interface ItemPatch {
  code?: string;
  name?: string;
  description?: string | null;
  hsn?: string | null;
  categoryId?: number | null;
  unit?: string;
  packSize?: string | null;
  reorderQtyMilli?: number;
  supplierId?: number | null;
  location?: string | null;
  purchaseRatePaise?: number;
  saleRatePaise?: number;
  gstRateBp?: number;
}

export interface ItemFilters {
  search?: string;
  categoryId?: number;
  status?: 'ACTIVE' | 'INACTIVE' | 'ALL'; // default ACTIVE
  lowStockOnly?: boolean; // low or out of stock
  sortBy?: 'name' | 'code' | 'qty';
  descending?: boolean;
  limit?: number; // default 100, max 500
  offset?: number;
}

interface ItemRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  hsn: string | null;
  category_id: number | null;
  category: string | null;
  unit: string;
  pack_size: string | null;
  purchase_rate_paise: number;
  sale_rate_paise: number;
  gst_rate_bp: number;
  qty_milli: number;
  reorder_qty_milli: number;
  supplier_id: number | null;
  location: string | null;
  is_active: number;
}

const SELECT = `SELECT i.id, i.code, i.name, i.description, i.hsn, i.category_id, c.name AS category, i.unit, i.pack_size,
  i.purchase_rate_paise, i.sale_rate_paise, i.gst_rate_bp, i.qty_milli, i.reorder_qty_milli, i.supplier_id, i.location, i.is_active
  FROM item i LEFT JOIN category c ON c.id = i.category_id`;

function toDto(r: ItemRow): ItemDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    hsn: r.hsn,
    categoryId: r.category_id,
    category: r.category,
    unit: r.unit,
    packSize: r.pack_size,
    uomLabel: uomLabel(r.unit, r.pack_size),
    purchaseRatePaise: r.purchase_rate_paise,
    saleRatePaise: r.sale_rate_paise,
    gstRateBp: r.gst_rate_bp,
    qtyMilli: r.qty_milli,
    reorderQtyMilli: r.reorder_qty_milli,
    supplierId: r.supplier_id,
    location: r.location,
    isActive: r.is_active === 1,
    stockStatus: stockStatus(r.qty_milli, r.reorder_qty_milli),
  };
}

const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
const blankToNull = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === '' ? null : s.trim());

function checkFields(p: Problems, f: Partial<Record<string, unknown>>): void {
  if ('code' in f) p.require(typeof f.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/.test(f.code), 'item code must be 1 to 32 letters, digits or . _ / - (no spaces)');
  if ('name' in f) p.require(typeof f.name === 'string' && f.name.trim().length >= 1 && f.name.trim().length <= 120, 'item name must be 1 to 120 characters');
  if ('description' in f && f.description) p.require(String(f.description).length <= 500, 'description is too long (500 characters at most)');
  // Format only: the app does not know whether a code is the right one for the goods; the owner must verify HSN codes.
  if ('hsn' in f && f.hsn) p.require(/^\d{2,8}$/.test(String(f.hsn)), 'HSN code must be 2 to 8 digits');
  if ('unit' in f) p.require(typeof f.unit === 'string' && /^[A-Za-z]{1,10}$/.test(f.unit), 'unit must be 1 to 10 letters (for example PCS, KG, LTR)');
  if ('packSize' in f && f.packSize) p.require(/^[A-Za-z0-9. ]{1,10}$/.test(String(f.packSize)), 'pack size must be up to 10 letters, digits or dots (for example 40 or 0.5)');
  if ('location' in f && f.location) p.require(String(f.location).length <= 60, 'storage location is too long (60 characters at most)');
  if ('purchaseRatePaise' in f) p.require(isMoney(f.purchaseRatePaise), 'purchase rate must be zero or more');
  if ('saleRatePaise' in f) p.require(isMoney(f.saleRatePaise), 'sale rate must be zero or more');
  if ('gstRateBp' in f) p.require(typeof f.gstRateBp === 'number' && Number.isSafeInteger(f.gstRateBp) && f.gstRateBp >= 0 && f.gstRateBp <= 10000, 'GST rate must be between 0% and 100%');
  if ('reorderQtyMilli' in f) p.require(typeof f.reorderQtyMilli === 'number' && Number.isSafeInteger(f.reorderQtyMilli) && f.reorderQtyMilli >= 0, 'reorder level must be zero or more');
}

/** '%' and '_' typed by the user must match literally in LIKE. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const PRICE_FIELDS = ['purchaseRatePaise', 'saleRatePaise', 'gstRateBp'] as const;
const COLUMN: Record<keyof ItemPatch, string> = {
  code: 'code',
  name: 'name',
  description: 'description',
  hsn: 'hsn',
  categoryId: 'category_id',
  unit: 'unit',
  packSize: 'pack_size',
  reorderQtyMilli: 'reorder_qty_milli',
  supplierId: 'supplier_id',
  location: 'location',
  purchaseRatePaise: 'purchase_rate_paise',
  saleRatePaise: 'sale_rate_paise',
  gstRateBp: 'gst_rate_bp',
};

export class ItemService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  /** Creating an item needs both item.create and price.edit (it sets rates and tax); opening stock also needs stock.adjust. */
  create(token: string, input: ItemInput): number {
    this.auth.authorize(token, 'item.create');
    const user = this.auth.authorize(token, 'price.edit');
    const opening = input.openingQtyMilli ?? 0;
    if (opening > 0) this.auth.authorize(token, 'stock.adjust');

    const p = new Problems();
    checkFields(p, { ...input, hsn: blankToNull(input.hsn), packSize: blankToNull(input.packSize) });
    p.require(Number.isSafeInteger(opening) && opening >= 0, 'opening stock must be zero or more');
    p.throwIfAny();

    const code = input.code.trim();
    const unit = input.unit.trim().toUpperCase();
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      if (ctx.db.prepare('SELECT 1 FROM item WHERE code = ?').get(code)) throw new AppError('CONFLICT', `an item with code ${code} already exists`);
      if (input.categoryId !== undefined && !ctx.db.prepare('SELECT 1 FROM category WHERE id = ?').get(input.categoryId)) throw new AppError('NOT_FOUND', 'category not found');
      if (input.supplierId !== undefined && !ctx.db.prepare('SELECT 1 FROM supplier WHERE id = ?').get(input.supplierId)) throw new AppError('NOT_FOUND', 'supplier not found');

      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO item (code, name, description, hsn, category_id, unit, pack_size, purchase_rate_paise, sale_rate_paise, gst_rate_bp,
               qty_milli, reorder_qty_milli, supplier_id, location, is_active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            code, input.name.trim(), blankToNull(input.description), blankToNull(input.hsn), input.categoryId ?? null, unit,
            blankToNull(input.packSize), input.purchaseRatePaise, input.saleRatePaise, input.gstRateBp,
            input.reorderQtyMilli ?? 0, input.supplierId ?? null, blankToNull(input.location), user.id, ctx.now,
          ).lastInsertRowid,
      );
      recordAudit(ctx, { action: 'ITEM_CREATE', entityType: 'item', entityId: id, detail: { code, name: input.name.trim() } });
      if (opening > 0) postStockMovement(ctx, { itemId: id, qtyDeltaMilli: opening, reason: 'OPENING', note: 'Opening stock' });
      return id;
    });
  }

  /**
   * Edit an item. Descriptive fields need item.edit; rate and GST fields need price.edit. Only fields that actually change are
   * checked, written and audited. Quantity is never editable here (stock changes only through the ledger).
   */
  update(token: string, itemId: number, patch: ItemPatch): ItemDto {
    const user = this.auth.requireSignedIn(token);
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const current = ctx.db.prepare(`${SELECT} WHERE i.id = ?`).get(itemId) as ItemRow | undefined;
      if (!current) throw new AppError('NOT_FOUND', 'item not found');

      const normalized: ItemPatch = { ...patch };
      for (const k of ['description', 'hsn', 'packSize', 'location'] as const) if (k in patch) normalized[k] = blankToNull(patch[k]);
      if (typeof normalized.code === 'string') normalized.code = normalized.code.trim();
      if (typeof normalized.unit === 'string') normalized.unit = normalized.unit.trim().toUpperCase();
      if (typeof normalized.name === 'string') normalized.name = normalized.name.trim();
      const p = new Problems();
      checkFields(p, normalized as Record<string, unknown>);
      p.throwIfAny();

      const currentValues: Record<keyof ItemPatch, unknown> = {
        code: current.code, name: current.name, description: current.description, hsn: current.hsn, categoryId: current.category_id,
        unit: current.unit, packSize: current.pack_size, reorderQtyMilli: current.reorder_qty_milli, supplierId: current.supplier_id,
        location: current.location, purchaseRatePaise: current.purchase_rate_paise, saleRatePaise: current.sale_rate_paise, gstRateBp: current.gst_rate_bp,
      };
      const changes: Partial<Record<keyof ItemPatch, { from: unknown; to: unknown }>> = {};
      for (const key of Object.keys(normalized) as (keyof ItemPatch)[]) {
        const to = normalized[key];
        if (to !== undefined && to !== currentValues[key]) changes[key] = { from: currentValues[key], to };
      }
      const changedKeys = Object.keys(changes) as (keyof ItemPatch)[];
      if (changedKeys.length === 0) return;

      const priceKeys = changedKeys.filter((k) => (PRICE_FIELDS as readonly string[]).includes(k));
      const otherKeys = changedKeys.filter((k) => !(PRICE_FIELDS as readonly string[]).includes(k));
      if (priceKeys.length) this.auth.authorize(token, 'price.edit');
      if (otherKeys.length) this.auth.authorize(token, 'item.edit');

      if (changes.code && ctx.db.prepare('SELECT 1 FROM item WHERE code = ? AND id <> ?').get(changes.code.to, itemId)) {
        throw new AppError('CONFLICT', `an item with code ${String(changes.code.to)} already exists`);
      }
      if (changes.unit && ctx.db.prepare('SELECT 1 FROM stock_movement WHERE item_id = ? LIMIT 1').get(itemId)) {
        throw new AppError('CONFLICT', 'the unit cannot change once the item has stock history; create a new item instead');
      }
      if (changes.categoryId?.to != null && !ctx.db.prepare('SELECT 1 FROM category WHERE id = ?').get(changes.categoryId.to)) throw new AppError('NOT_FOUND', 'category not found');
      if (changes.supplierId?.to != null && !ctx.db.prepare('SELECT 1 FROM supplier WHERE id = ?').get(changes.supplierId.to)) throw new AppError('NOT_FOUND', 'supplier not found');

      const sets = changedKeys.map((k) => `${COLUMN[k]} = ?`);
      const values = changedKeys.map((k) => changes[k]?.to as string | number | null);
      ctx.db.prepare(`UPDATE item SET ${sets.join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...values, user.id, ctx.now, itemId);

      const pick = (keys: (keyof ItemPatch)[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, changes[k]]));
      if (otherKeys.length) recordAudit(ctx, { action: 'ITEM_UPDATE', entityType: 'item', entityId: itemId, detail: { code: current.code, changes: pick(otherKeys) } });
      if (priceKeys.length) recordAudit(ctx, { action: 'PRICE_CHANGE', entityType: 'item', entityId: itemId, detail: { code: current.code, changes: pick(priceKeys) } });
    });
    return this.getUnchecked(itemId);
  }

  /** Inactive items vanish from new bills but stay in history and reports. */
  setActive(token: string, itemId: number, active: boolean): void {
    const user = this.auth.authorize(token, 'item.edit');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT code, is_active FROM item WHERE id = ?').get(itemId) as { code: string; is_active: number } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'item not found');
      if ((row.is_active === 1) === active) return;
      ctx.db.prepare('UPDATE item SET is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, user.id, ctx.now, itemId);
      recordAudit(ctx, { action: 'ITEM_UPDATE', entityType: 'item', entityId: itemId, detail: { code: row.code, changes: { isActive: { from: row.is_active === 1, to: active } } } });
    });
  }

  get(token: string, itemId: number): ItemDto {
    this.auth.authorize(token, 'inventory.view');
    return this.getUnchecked(itemId);
  }

  list(token: string, filters: ItemFilters = {}): { rows: ItemDto[]; total: number } {
    this.auth.authorize(token, 'inventory.view');
    return this.query(filters);
  }

  /** Spreadsheet-ready stock list (same filters as list, no paging). */
  exportCsv(token: string, filters: ItemFilters = {}): string {
    this.auth.authorize(token, 'inventory.view');
    const { rows } = this.query({ ...filters, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return toCsv(
      ['Code', 'Item', 'Category', 'HSN', 'Unit', 'Quantity', 'Reorder level', 'Sale rate (Rs)', 'Status'],
      rows.map((r) => [r.code, r.name, r.category, r.hsn, r.uomLabel, r.qtyMilli / 1000, r.reorderQtyMilli / 1000, formatPlainRupees(r.saleRatePaise), r.isActive ? r.stockStatus : 'INACTIVE']),
    );
  }

  // ---- categories ----
  listCategories(token: string): { id: number; name: string }[] {
    this.auth.authorize(token, 'inventory.view');
    return this.db.prepare('SELECT id, name FROM category ORDER BY name COLLATE NOCASE').all() as { id: number; name: string }[];
  }

  createCategory(token: string, name: string): number {
    const user = this.auth.authorize(token, 'item.create');
    const clean = name.trim();
    const p = new Problems();
    p.require(clean.length >= 1 && clean.length <= 60, 'category name must be 1 to 60 characters');
    p.throwIfAny();
    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      if (ctx.db.prepare('SELECT 1 FROM category WHERE name = ? COLLATE NOCASE').get(clean)) throw new AppError('CONFLICT', 'that category already exists');
      const id = Number(ctx.db.prepare('INSERT INTO category (name) VALUES (?)').run(clean).lastInsertRowid);
      recordAudit(ctx, { action: 'ITEM_UPDATE', entityType: 'category', entityId: id, detail: { created: clean } });
      return id;
    });
  }

  renameCategory(token: string, categoryId: number, name: string): void {
    const user = this.auth.authorize(token, 'item.edit');
    const clean = name.trim();
    const p = new Problems();
    p.require(clean.length >= 1 && clean.length <= 60, 'category name must be 1 to 60 characters');
    p.throwIfAny();
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT name FROM category WHERE id = ?').get(categoryId) as { name: string } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'category not found');
      if (ctx.db.prepare('SELECT 1 FROM category WHERE name = ? COLLATE NOCASE AND id <> ?').get(clean, categoryId)) throw new AppError('CONFLICT', 'that category already exists');
      ctx.db.prepare('UPDATE category SET name = ? WHERE id = ?').run(clean, categoryId);
      recordAudit(ctx, { action: 'ITEM_UPDATE', entityType: 'category', entityId: categoryId, detail: { renamed: { from: row.name, to: clean } } });
    });
  }

  // ---- internals ----
  private getUnchecked(itemId: number): ItemDto {
    const row = this.db.prepare(`${SELECT} WHERE i.id = ?`).get(itemId) as ItemRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'item not found');
    return toDto(row);
  }

  private query(f: ItemFilters): { rows: ItemDto[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const status = f.status ?? 'ACTIVE';
    if (status !== 'ALL') where.push(`i.is_active = ${status === 'ACTIVE' ? 1 : 0}`);
    if (f.categoryId !== undefined) {
      where.push('i.category_id = ?');
      params.push(f.categoryId);
    }
    if (f.search?.trim()) {
      const like = `%${likeEscape(f.search.trim())}%`;
      where.push("(i.name LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR i.hsn LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    if (f.lowStockOnly) where.push('(i.qty_milli <= 0 OR (i.reorder_qty_milli > 0 AND i.qty_milli <= i.reorder_qty_milli))');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortCol = f.sortBy === 'code' ? 'i.code COLLATE NOCASE' : f.sortBy === 'qty' ? 'i.qty_milli' : 'i.name COLLATE NOCASE';
    const limit = Math.max(1, Math.min(f.limit ?? 100, Number.MAX_SAFE_INTEGER));
    const offset = Math.max(0, f.offset ?? 0);

    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM item i LEFT JOIN category c ON c.id = i.category_id ${whereSql}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`${SELECT} ${whereSql} ORDER BY ${sortCol} ${f.descending ? 'DESC' : 'ASC'}, i.id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ItemRow[];
    return { rows: rows.map(toDto), total };
  }
}
