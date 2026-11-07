import { localDayRangeToUtc, systemClock, toLocalDateTime, type Clock } from '../../shared/clock';
import { toCsv } from '../../shared/csv';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { STOCK_REASONS, postStockMovement, type StockReason } from '../../infrastructure/db/ledgers';
import { reconcile, type ReconcileIssue } from '../../infrastructure/db/reconcile';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import type { ItemDto } from './itemService';
import { stockStatus } from '../../domain/inventory';

export interface MovementFilters {
  itemId?: number;
  reasons?: StockReason[];
  fromDate?: string; // local calendar date, inclusive
  toDate?: string; // local calendar date, inclusive
  limit?: number; // default 100
  offset?: number;
}

export interface MovementDto {
  id: number;
  at: string; // UTC ISO
  itemId: number;
  itemCode: string;
  itemName: string;
  qtyDeltaMilli: number;
  reason: StockReason;
  refType: string | null;
  refId: number | null;
  refNo: string | null;
  note: string | null;
  qtyAfterMilli: number;
  userName: string;
}

interface MovementRow {
  id: number;
  at: string;
  item_id: number;
  item_code: string;
  item_name: string;
  qty_delta_milli: number;
  reason: StockReason;
  ref_type: string | null;
  ref_id: number | null;
  ref_no: string | null;
  note: string | null;
  qty_after_milli: number;
  user_name: string;
}

const toMovement = (r: MovementRow): MovementDto => ({
  id: r.id, at: r.at, itemId: r.item_id, itemCode: r.item_code, itemName: r.item_name, qtyDeltaMilli: r.qty_delta_milli,
  reason: r.reason, refType: r.ref_type, refId: r.ref_id, refNo: r.ref_no, note: r.note, qtyAfterMilli: r.qty_after_milli, userName: r.user_name,
});

const MIN_NOTE = 3;

export class StockService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  /** Remove damaged or missing stock. `qtyMilli` is the positive amount lost; a written reason is mandatory. */
  recordLoss(token: string, input: { itemId: number; kind: 'DAMAGED' | 'MISSING'; qtyMilli: number; note: string }): { qtyAfterMilli: number } {
    const user = this.auth.authorize(token, 'stock.adjust');
    const note = this.checkNote(input.note);
    const p = new Problems();
    p.require(Number.isSafeInteger(input.qtyMilli) && input.qtyMilli > 0, 'quantity lost must be more than zero');
    p.require(input.kind === 'DAMAGED' || input.kind === 'MISSING', 'kind must be DAMAGED or MISSING');
    p.throwIfAny();

    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const before = this.qtyOf(ctx.db, input.itemId);
      const r = postStockMovement(ctx, { itemId: input.itemId, qtyDeltaMilli: -input.qtyMilli, reason: input.kind, note, refType: 'stock_adjustment' });
      recordAudit(ctx, {
        action: 'STOCK_ADJUST', entityType: 'item', entityId: input.itemId, reason: note,
        detail: { kind: input.kind, beforeMilli: before.qty, afterMilli: r.qtyAfterMilli, itemCode: before.code },
      });
      return r;
    });
  }

  /**
   * Physical count: the owner types what is actually on the shelf and the change is worked out here, inside the transaction,
   * from the system quantity at that moment, so it cannot be wrong because a sale happened while the form was open.
   */
  recordCount(token: string, input: { itemId: number; countedQtyMilli: number; note: string }): { qtyBeforeMilli: number; qtyAfterMilli: number; deltaMilli: number } {
    const user = this.auth.authorize(token, 'stock.adjust');
    const note = this.checkNote(input.note);
    const p = new Problems();
    p.require(Number.isSafeInteger(input.countedQtyMilli) && input.countedQtyMilli >= 0, 'counted quantity must be zero or more');
    p.throwIfAny();

    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      const before = this.qtyOf(ctx.db, input.itemId);
      const delta = input.countedQtyMilli - before.qty;
      if (delta === 0) throw new AppError('VALIDATION', 'the counted quantity matches the system quantity; there is nothing to correct');
      const r = postStockMovement(ctx, { itemId: input.itemId, qtyDeltaMilli: delta, reason: 'COUNT_ADJUST', note, refType: 'stock_adjustment' });
      recordAudit(ctx, {
        action: 'STOCK_ADJUST', entityType: 'item', entityId: input.itemId, reason: note,
        detail: { kind: 'COUNT', beforeMilli: before.qty, countedMilli: input.countedQtyMilli, itemCode: before.code },
      });
      return { qtyBeforeMilli: before.qty, qtyAfterMilli: r.qtyAfterMilli, deltaMilli: delta };
    });
  }

  movements(token: string, f: MovementFilters = {}): { rows: MovementDto[]; total: number } {
    this.auth.authorize(token, 'inventory.view');
    return this.queryMovements(f);
  }

  exportMovementsCsv(token: string, f: MovementFilters = {}): string {
    this.auth.authorize(token, 'inventory.view');
    const { rows } = this.queryMovements({ ...f, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return toCsv(
      ['Date and time', 'Item code', 'Item', 'Change', 'Reason', 'Reference', 'Note', 'Balance after', 'User'],
      rows.map((m) => [
        toLocalDateTime(m.at), m.itemCode, m.itemName,
        m.qtyDeltaMilli / 1000, // real numbers, so spreadsheets can sum them (text starting with +/- would be quoted as a formula)
        m.reason, m.refNo, m.note, m.qtyAfterMilli / 1000, m.userName,
      ]),
    );
  }

  /** Active items that are out of stock or at/below their reorder level, lowest first. */
  lowStock(token: string): Pick<ItemDto, 'id' | 'code' | 'name' | 'uomLabel' | 'qtyMilli' | 'reorderQtyMilli' | 'stockStatus'>[] {
    this.auth.authorize(token, 'inventory.view');
    const rows = this.db
      .prepare(
        `SELECT id, code, name, unit, pack_size, qty_milli, reorder_qty_milli FROM item
         WHERE is_active = 1 AND (qty_milli <= 0 OR (reorder_qty_milli > 0 AND qty_milli <= reorder_qty_milli))
         ORDER BY qty_milli, name COLLATE NOCASE`,
      )
      .all() as { id: number; code: string; name: string; unit: string; pack_size: string | null; qty_milli: number; reorder_qty_milli: number }[];
    return rows.map((r) => ({
      id: r.id, code: r.code, name: r.name,
      uomLabel: `${r.pack_size?.trim() || r.unit} - ${r.unit}`,
      qtyMilli: r.qty_milli, reorderQtyMilli: r.reorder_qty_milli, stockStatus: stockStatus(r.qty_milli, r.reorder_qty_milli),
    }));
  }

  /** Integrity check: every cached stock/balance figure against its ledger. Empty list = the books agree. */
  checkIntegrity(token: string): ReconcileIssue[] {
    this.auth.authorize(token, 'audit.view');
    return reconcile(this.db);
  }

  private checkNote(raw: string): string {
    const note = raw.trim();
    const p = new Problems();
    p.require(note.length >= MIN_NOTE, `please give a reason (at least ${String(MIN_NOTE)} characters)`);
    p.require(note.length <= 500, 'the reason is too long (500 characters at most)');
    p.throwIfAny();
    return note;
  }

  private qtyOf(db: Db, itemId: number): { code: string; qty: number } {
    const row = db.prepare('SELECT code, qty_milli FROM item WHERE id = ?').get(itemId) as { code: string; qty_milli: number } | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'item not found');
    return { code: row.code, qty: row.qty_milli };
  }

  private queryMovements(f: MovementFilters): { rows: MovementDto[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.itemId !== undefined) {
      where.push('m.item_id = ?');
      params.push(f.itemId);
    }
    if (f.reasons?.length) {
      for (const r of f.reasons) if (!STOCK_REASONS.includes(r)) throw new AppError('VALIDATION', `unknown reason: ${String(r)}`);
      where.push(`m.reason IN (${f.reasons.map(() => '?').join(',')})`);
      params.push(...f.reasons);
    }
    let range: { fromUtc?: string; toUtcExclusive?: string };
    try {
      range = localDayRangeToUtc(f.fromDate, f.toDate);
    } catch (e) {
      throw new AppError('VALIDATION', (e as Error).message);
    }
    if (range.fromUtc) {
      where.push('m.at >= ?');
      params.push(range.fromUtc);
    }
    if (range.toUtcExclusive) {
      where.push('m.at < ?');
      params.push(range.toUtcExclusive);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM stock_movement m JOIN item i ON i.id = m.item_id JOIN user u ON u.id = m.user_id';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c ${from} ${whereSql}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT m.id, m.at, m.item_id, i.code AS item_code, i.name AS item_name, m.qty_delta_milli, m.reason, m.ref_type, m.ref_id, m.ref_no,
                m.note, m.qty_after_milli, u.display_name AS user_name
         ${from} ${whereSql} ORDER BY m.at DESC, m.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as MovementRow[];
    return { rows: rows.map(toMovement), total };
  }
}
