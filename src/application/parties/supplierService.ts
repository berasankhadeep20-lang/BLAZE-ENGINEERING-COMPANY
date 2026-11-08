import { GSTIN_UNREGISTERED_LABEL, stateByName } from '../../domain/gstin';
import { systemClock, toLocalDateTime, type Clock } from '../../shared/clock';
import { toCsv } from '../../shared/csv';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postSupplierLedger } from '../../infrastructure/db/ledgers';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import { likeEscape, normalizeParty, resolveState, type PartyFields } from './partyValidation';
import { buildStatement, type Statement } from './statement';

export interface SupplierDto {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  stateCode: string | null;
  gstin: string | null;
  gstinDisplay: string;
  notes: string | null;
  balancePaise: number; // what we owe them
  isActive: boolean;
  createdByName: string | null;
  createdAt: string;
}

export interface SupplierInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  state?: string;
  gstin?: string;
  notes?: string;
  openingBalancePaise?: number; // owner only: what we already owe from before this software
}

export type SupplierPatch = Pick<PartyFields, 'name' | 'phone' | 'email' | 'address' | 'state' | 'gstin' | 'notes'>;

export interface SupplierFilters {
  search?: string;
  active?: boolean; // default true
  owedOnly?: boolean; // only suppliers we owe money
  sortBy?: 'name' | 'balance' | 'newest';
  descending?: boolean;
  limit?: number;
  offset?: number;
}

interface SupplierRow {
  id: number; name: string; phone: string | null; email: string | null; address: string | null; state: string | null; gstin: string | null;
  notes: string | null; balance_paise: number; is_active: number; created_by_name: string | null; created_at: string;
}

const SELECT = `SELECT s.id, s.name, s.phone, s.email, s.address, s.state, s.gstin, s.notes, s.balance_paise, s.is_active,
  u.display_name AS created_by_name, s.created_at FROM supplier s LEFT JOIN user u ON u.id = s.created_by`;

const toDto = (r: SupplierRow): SupplierDto => ({
  id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address, state: r.state,
  stateCode: r.state ? (stateByName(r.state)?.code ?? null) : null, gstin: r.gstin, gstinDisplay: r.gstin ?? GSTIN_UNREGISTERED_LABEL,
  notes: r.notes, balancePaise: r.balance_paise, isActive: r.is_active === 1, createdByName: r.created_by_name, createdAt: r.created_at,
});

/** Used by purchase billing: the supplier must exist and be active. */
export function assertSupplierUsable(db: Db, supplierId: number): void {
  const row = db.prepare('SELECT is_active FROM supplier WHERE id = ?').get(supplierId) as { is_active: number } | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'supplier not found');
  if (row.is_active !== 1) throw new AppError('CONFLICT', 'this supplier is inactive');
}

const FIELDS = ['name', 'phone', 'email', 'address', 'state', 'gstin', 'notes'] as const;

export class SupplierService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  create(token: string, input: SupplierInput): number {
    const user = this.auth.authorize(token, 'supplier.edit');
    const opening = input.openingBalancePaise ?? 0;
    if (opening !== 0 && user.role !== 'OWNER') throw new AppError('PERMISSION_DENIED', 'only the owner can enter an opening balance');

    const p = new Problems();
    const f = normalizeParty(p, { name: input.name, phone: input.phone, email: input.email, address: input.address, state: input.state, gstin: input.gstin, notes: input.notes }, 'supplier');
    p.require(Number.isSafeInteger(opening) && opening >= 0, 'opening balance must be zero or more');
    const state = resolveState(p, f.state, f.gstin, 'the supplier');
    p.throwIfAny();

    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      this.assertGstinFree(ctx.db, f.gstin ?? null, null);
      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO supplier (name, phone, email, address, state, gstin, notes, balance_paise, is_active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
          )
          .run(f.name ?? '', f.phone ?? null, f.email ?? null, f.address ?? null, state, f.gstin ?? null, f.notes ?? null, user.id, ctx.now).lastInsertRowid,
      );
      recordAudit(ctx, { action: 'SUPPLIER_CREATE', entityType: 'supplier', entityId: id, detail: { name: f.name, gstin: f.gstin ?? null } });
      if (opening > 0) postSupplierLedger(ctx, { partyId: id, entryType: 'OPENING', amountPaise: opening, note: 'Opening balance' });
      return id;
    });
  }

  update(token: string, supplierId: number, patch: SupplierPatch): SupplierDto {
    const user = this.auth.authorize(token, 'supplier.edit');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const cur = ctx.db.prepare(`${SELECT} WHERE s.id = ?`).get(supplierId) as SupplierRow | undefined;
      if (!cur) throw new AppError('NOT_FOUND', 'supplier not found');

      const p = new Problems();
      const f = normalizeParty(p, patch, 'supplier');
      const next: Record<string, string | null | undefined> = { ...f };
      if ('gstin' in patch || 'state' in patch) {
        const g = 'gstin' in patch ? (f.gstin ?? null) : cur.gstin;
        const s = 'state' in patch ? (f.state ?? null) : cur.state;
        next.state = resolveState(p, s, g, 'the supplier');
      }
      p.throwIfAny();

      const currentValues: Record<(typeof FIELDS)[number], string | null> = {
        name: cur.name, phone: cur.phone, email: cur.email, address: cur.address, state: cur.state, gstin: cur.gstin, notes: cur.notes,
      };
      const changes: Partial<Record<(typeof FIELDS)[number], { from: string | null; to: string | null }>> = {};
      for (const k of FIELDS) {
        const to = next[k];
        if (to !== undefined && to !== currentValues[k]) changes[k] = { from: currentValues[k], to };
      }
      const keys = Object.keys(changes) as (typeof FIELDS)[number][];
      if (keys.length === 0) return;
      if (changes.gstin?.to) this.assertGstinFree(ctx.db, changes.gstin.to, supplierId);

      ctx.db.prepare(`UPDATE supplier SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`).run(...keys.map((k) => changes[k]?.to ?? null), user.id, ctx.now, supplierId);
      recordAudit(ctx, { action: 'SUPPLIER_UPDATE', entityType: 'supplier', entityId: supplierId, detail: { name: cur.name, changes } });
    });
    return this.getUnchecked(supplierId);
  }

  /** A supplier we still owe (or who owes us) cannot be hidden. */
  setActive(token: string, supplierId: number, active: boolean): void {
    const user = this.auth.authorize(token, 'supplier.edit');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT name, balance_paise, is_active FROM supplier WHERE id = ?').get(supplierId) as { name: string; balance_paise: number; is_active: number } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'supplier not found');
      if ((row.is_active === 1) === active) return;
      if (!active && row.balance_paise !== 0) throw new AppError('CONFLICT', 'this supplier still has a balance; settle it before making the supplier inactive');
      ctx.db.prepare('UPDATE supplier SET is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, user.id, ctx.now, supplierId);
      recordAudit(ctx, { action: 'SUPPLIER_UPDATE', entityType: 'supplier', entityId: supplierId, detail: { name: row.name, changes: { isActive: { from: row.is_active === 1, to: active } } } });
    });
  }

  get(token: string, supplierId: number): SupplierDto {
    this.auth.authorize(token, 'supplier.view');
    return this.getUnchecked(supplierId);
  }

  list(token: string, f: SupplierFilters = {}): { rows: SupplierDto[]; total: number; totalOwedPaise: number } {
    this.auth.authorize(token, 'supplier.view');
    const where: string[] = [`s.is_active = ${f.active === false ? 0 : 1}`];
    const params: (string | number)[] = [];
    if (f.owedOnly) where.push('s.balance_paise > 0');
    if (f.search?.trim()) {
      const like = `%${likeEscape(f.search.trim())}%`;
      where.push("(s.name LIKE ? ESCAPE '\\' OR s.gstin LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\' OR s.address LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sort = f.sortBy === 'balance' ? 's.balance_paise' : f.sortBy === 'newest' ? 's.id' : 's.name COLLATE NOCASE';
    const agg = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.balance_paise > 0 THEN s.balance_paise ELSE 0 END), 0) AS owed FROM supplier s ${whereSql}`).get(...params) as { n: number; owed: number };
    const rows = this.db
      .prepare(`${SELECT} ${whereSql} ORDER BY ${sort} ${f.descending ? 'DESC' : 'ASC'}, s.id LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as SupplierRow[];
    return { rows: rows.map(toDto), total: agg.n, totalOwedPaise: agg.owed };
  }

  /** Purchase and payment history with this supplier (ledger entries) over a range of local dates. */
  statement(token: string, supplierId: number, fromDate?: string, toDate?: string): { supplier: SupplierDto } & Statement {
    this.auth.authorize(token, 'supplier.view');
    const supplier = this.getUnchecked(supplierId);
    return { supplier, ...buildStatement(this.db, 'supplier', supplierId, fromDate, toDate) };
  }

  exportStatementCsv(token: string, supplierId: number, fromDate?: string, toDate?: string): string {
    const s = this.statement(token, supplierId, fromDate, toDate);
    const rows: (string | number | null)[][] = [['', 'Opening balance', '', '', '', '', s.openingPaise / 100]];
    for (const e of s.entries) {
      rows.push([toLocalDateTime(e.at), e.label, e.refNo, e.note, e.amountPaise > 0 ? e.amountPaise / 100 : '', e.amountPaise < 0 ? -e.amountPaise / 100 : '', e.balanceAfterPaise / 100]);
    }
    rows.push(['', 'Closing balance', '', '', s.increasesPaise / 100, s.reducesPaise / 100, s.closingPaise / 100]);
    return toCsv(['Date and time', 'Entry', 'Reference', 'Note', 'Owed increases (Rs)', 'Paid or reduced (Rs)', 'Balance owed (Rs)'], rows);
  }

  private getUnchecked(supplierId: number): SupplierDto {
    const row = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(supplierId) as SupplierRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'supplier not found');
    return toDto(row);
  }

  private assertGstinFree(db: Db, gstin: string | null, exceptId: number | null): void {
    if (!gstin) return;
    const other = db.prepare('SELECT id, name FROM supplier WHERE gstin = ? AND id <> ?').get(gstin, exceptId ?? -1) as { id: number; name: string } | undefined;
    if (other) throw new AppError('CONFLICT', `GSTIN ${gstin} already belongs to supplier "${other.name}"`, { supplierId: other.id });
  }
}
