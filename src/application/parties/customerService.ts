import { GSTIN_UNREGISTERED_LABEL, stateByName } from '../../domain/gstin';
import { localDayRangeToUtc, systemClock, toLocalDateTime, type Clock } from '../../shared/clock';
import { toCsv } from '../../shared/csv';
import { AppError } from '../../shared/errors';
import { Problems } from '../../shared/validation';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { postCustomerLedger } from '../../infrastructure/db/ledgers';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import type { AuthService } from '../auth/authService';
import { blankToNull, likeEscape, normalizeParty, resolveState, type PartyFields } from './partyValidation';
import { buildStatement, type Statement } from './statement';

export type ApprovalStatus = 'APPROVED' | 'PENDING' | 'REJECTED';

export interface CustomerDto {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  state: string | null;
  stateCode: string | null;
  placeOfSupply: string | null;
  gstin: string | null;
  gstinDisplay: string; // the GSTIN, or UN-REGD as printed on the sample bill
  notes: string | null;
  balancePaise: number;
  advanceAllowed: boolean;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  createdByName: string | null;
  createdAt: string;
}

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  state?: string;
  placeOfSupply?: string;
  gstin?: string; // omit for an unregistered customer
  notes?: string;
  openingBalancePaise?: number; // owner only: dues carried in from before this software
}

export interface CustomerPatch {
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  state?: string | null;
  placeOfSupply?: string | null;
  gstin?: string | null;
  notes?: string | null;
}

export interface CustomerFilters {
  search?: string;
  approval?: 'VISIBLE' | ApprovalStatus; // VISIBLE (default) = approved + pending
  active?: boolean; // default true
  hasDues?: boolean;
  sortBy?: 'name' | 'balance' | 'newest';
  descending?: boolean;
  limit?: number;
  offset?: number;
}

export interface DuesRow {
  id: number;
  name: string;
  phone: string | null;
  balancePaise: number;
  lastSaleAt: string | null;
  lastPaymentAt: string | null;
}

interface CustomerRow {
  id: number; name: string; phone: string | null; email: string | null; address: string | null; state: string | null;
  place_of_supply: string | null; gstin: string | null; notes: string | null; balance_paise: number; advance_allowed: number;
  approval_status: ApprovalStatus; is_active: number; created_by: number | null; created_by_name: string | null; created_at: string;
}

const SELECT = `SELECT c.id, c.name, c.phone, c.email, c.address, c.state, c.place_of_supply, c.gstin, c.notes, c.balance_paise,
  c.advance_allowed, c.approval_status, c.is_active, c.created_by, u.display_name AS created_by_name, c.created_at
  FROM customer c LEFT JOIN user u ON u.id = c.created_by`;

const toDto = (r: CustomerRow): CustomerDto => ({
  id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address, state: r.state,
  stateCode: r.state ? (stateByName(r.state)?.code ?? null) : null, placeOfSupply: r.place_of_supply, gstin: r.gstin,
  gstinDisplay: r.gstin ?? GSTIN_UNREGISTERED_LABEL, notes: r.notes, balancePaise: r.balance_paise, advanceAllowed: r.advance_allowed === 1,
  approvalStatus: r.approval_status, isActive: r.is_active === 1, createdByName: r.created_by_name, createdAt: r.created_at,
});

/**
 * Used by billing: a draft may use any existing, active customer; CONFIRMING a bill additionally needs the owner's approval,
 * so an unapproved identity can never appear on an issued invoice.
 */
export function assertCustomerUsable(db: Db, customerId: number, stage: 'DRAFT' | 'CONFIRM'): void {
  const row = db.prepare('SELECT is_active, approval_status FROM customer WHERE id = ?').get(customerId) as
    | { is_active: number; approval_status: ApprovalStatus }
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'customer not found');
  if (row.is_active !== 1) throw new AppError('CONFLICT', 'this customer is inactive');
  if (row.approval_status === 'REJECTED') throw new AppError('CUSTOMER_NOT_APPROVED', 'this customer was rejected by the owner');
  if (stage === 'CONFIRM' && row.approval_status !== 'APPROVED') {
    throw new AppError('CUSTOMER_NOT_APPROVED', 'this customer is waiting for the owner\'s approval; the bill can be saved as a draft but not confirmed yet');
  }
}

const FIELD_COLUMN: Record<keyof CustomerPatch, string> = {
  name: 'name', phone: 'phone', email: 'email', address: 'address', state: 'state', placeOfSupply: 'place_of_supply', gstin: 'gstin', notes: 'notes',
};

export class CustomerService {
  private readonly uow: UnitOfWork;

  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    clock: Clock = systemClock,
  ) {
    this.uow = new UnitOfWork(db, clock);
  }

  /** Owner-created customers are approved at once; employee-created customers wait for the owner. */
  create(token: string, input: CustomerInput): number {
    const user = this.auth.authorize(token, 'customer.create');
    const isOwner = user.role === 'OWNER';
    const opening = input.openingBalancePaise ?? 0;
    if (opening !== 0 && !isOwner) throw new AppError('PERMISSION_DENIED', 'only the owner can enter an opening balance');

    const p = new Problems();
    const f = normalizeParty(p, { name: input.name, phone: input.phone, email: input.email, address: input.address, state: input.state, gstin: input.gstin, notes: input.notes }, 'customer');
    const place = blankToNull(input.placeOfSupply);
    p.require(!place || place.length <= 80, 'place of supply is too long (80 characters at most)');
    p.require(Number.isSafeInteger(opening) && opening >= 0, 'opening balance must be zero or more');
    const state = resolveState(p, f.state, f.gstin, 'the customer');
    p.throwIfAny();

    return this.uow.run(this.auth.actorFor(user), (ctx) => {
      this.assertGstinFree(ctx.db, f.gstin ?? null, null);
      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO customer (name, phone, email, address, state, place_of_supply, gstin, notes, balance_paise, approval_status, approved_by, approved_at, is_active, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`,
          )
          .run(f.name ?? '', f.phone ?? null, f.email ?? null, f.address ?? null, state, place, f.gstin ?? null, f.notes ?? null,
            isOwner ? 'APPROVED' : 'PENDING', isOwner ? user.id : null, isOwner ? ctx.now : null, user.id, ctx.now).lastInsertRowid,
      );
      recordAudit(ctx, { action: 'CUSTOMER_CREATE', entityType: 'customer', entityId: id, detail: { name: f.name, gstin: f.gstin ?? null, status: isOwner ? 'APPROVED' : 'PENDING' } });
      if (opening > 0) postCustomerLedger(ctx, { partyId: id, entryType: 'OPENING', amountPaise: opening, note: 'Opening balance' });
      return id;
    });
  }

  /**
   * Edit a customer. Needs customer.edit, except that whoever created a still-PENDING customer may correct it before the owner reviews it.
   * Only the customer record changes: bills already issued keep the name, address and GSTIN they were issued with (frozen on the bill).
   */
  update(token: string, customerId: number, patch: CustomerPatch): CustomerDto {
    const user = this.auth.requireSignedIn(token);
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const cur = ctx.db.prepare(`${SELECT} WHERE c.id = ?`).get(customerId) as CustomerRow | undefined;
      if (!cur) throw new AppError('NOT_FOUND', 'customer not found');

      const ownPending = cur.approval_status === 'PENDING' && cur.created_by === user.id;
      if (!ownPending) this.auth.authorize(token, 'customer.edit');

      const p = new Problems();
      const f = normalizeParty(p, patch as PartyFields, 'customer');
      const place = 'placeOfSupply' in patch ? blankToNull(patch.placeOfSupply) : undefined;
      p.require(!place || place.length <= 80, 'place of supply is too long (80 characters at most)');
      const next: Record<string, string | null | undefined> = { ...f, placeOfSupply: place };
      if ('gstin' in patch || 'state' in patch) {
        const g = 'gstin' in patch ? (f.gstin ?? null) : cur.gstin;
        const s = 'state' in patch ? (f.state ?? null) : cur.state;
        next.state = resolveState(p, s, g, 'the customer');
      }
      p.throwIfAny();

      const currentValues: Record<keyof CustomerPatch, string | null> = {
        name: cur.name, phone: cur.phone, email: cur.email, address: cur.address, state: cur.state, placeOfSupply: cur.place_of_supply, gstin: cur.gstin, notes: cur.notes,
      };
      const changes: Partial<Record<keyof CustomerPatch, { from: string | null; to: string | null }>> = {};
      for (const key of Object.keys(FIELD_COLUMN) as (keyof CustomerPatch)[]) {
        const to = next[key];
        if (to !== undefined && to !== currentValues[key]) changes[key] = { from: currentValues[key], to };
      }
      const keys = Object.keys(changes) as (keyof CustomerPatch)[];
      if (keys.length === 0) return;
      if (changes.gstin?.to) this.assertGstinFree(ctx.db, changes.gstin.to, customerId);

      ctx.db
        .prepare(`UPDATE customer SET ${keys.map((k) => `${FIELD_COLUMN[k]} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => changes[k]?.to ?? null), user.id, ctx.now, customerId);
      recordAudit(ctx, { action: 'CUSTOMER_UPDATE', entityType: 'customer', entityId: customerId, detail: { name: cur.name, changes } });
    });
    return this.getUnchecked(customerId);
  }

  /** A customer with a balance cannot be hidden: it would vanish from the dues list while still owing money. */
  setActive(token: string, customerId: number, active: boolean): void {
    const user = this.auth.authorize(token, 'customer.edit');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT name, balance_paise, is_active FROM customer WHERE id = ?').get(customerId) as
        | { name: string; balance_paise: number; is_active: number }
        | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'customer not found');
      if ((row.is_active === 1) === active) return;
      if (!active && row.balance_paise !== 0) throw new AppError('CONFLICT', 'this customer still has a balance; settle it before making the customer inactive');
      ctx.db.prepare('UPDATE customer SET is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, user.id, ctx.now, customerId);
      recordAudit(ctx, { action: 'CUSTOMER_UPDATE', entityType: 'customer', entityId: customerId, detail: { name: row.name, changes: { isActive: { from: row.is_active === 1, to: active } } } });
    });
  }

  // ---- owner approval ----
  pendingApprovals(token: string): CustomerDto[] {
    this.auth.authorize(token, 'customer.approve');
    return (this.db.prepare(`${SELECT} WHERE c.approval_status = 'PENDING' ORDER BY c.created_at, c.id`).all() as CustomerRow[]).map(toDto);
  }

  approve(token: string, customerId: number): void {
    const user = this.auth.authorize(token, 'customer.approve');
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT name, approval_status FROM customer WHERE id = ?').get(customerId) as { name: string; approval_status: ApprovalStatus } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'customer not found');
      if (row.approval_status === 'APPROVED') return;
      ctx.db.prepare("UPDATE customer SET approval_status = 'APPROVED', approved_by = ?, approved_at = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(user.id, ctx.now, user.id, ctx.now, customerId);
      recordAudit(ctx, { action: 'CUSTOMER_APPROVE', entityType: 'customer', entityId: customerId, detail: { name: row.name, from: row.approval_status } });
    });
  }

  reject(token: string, customerId: number, reason: string): void {
    const user = this.auth.authorize(token, 'customer.approve');
    const why = reason.trim();
    const p = new Problems();
    p.require(why.length >= 3, 'please give a reason (at least 3 characters)');
    p.throwIfAny();
    this.uow.run(this.auth.actorFor(user), (ctx) => {
      const row = ctx.db.prepare('SELECT name, approval_status FROM customer WHERE id = ?').get(customerId) as { name: string; approval_status: ApprovalStatus } | undefined;
      if (!row) throw new AppError('NOT_FOUND', 'customer not found');
      if (row.approval_status !== 'PENDING') throw new AppError('CONFLICT', 'only a customer waiting for approval can be rejected');
      ctx.db.prepare("UPDATE customer SET approval_status = 'REJECTED', approved_by = NULL, approved_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?").run(user.id, ctx.now, customerId);
      recordAudit(ctx, { action: 'CUSTOMER_REJECT', entityType: 'customer', entityId: customerId, reason: why, detail: { name: row.name } });
    });
  }

  // ---- reading ----
  get(token: string, customerId: number): CustomerDto {
    this.auth.authorize(token, 'customer.view');
    return this.getUnchecked(customerId);
  }

  list(token: string, f: CustomerFilters = {}): { rows: CustomerDto[]; total: number } {
    this.auth.authorize(token, 'customer.view');
    const where: string[] = [];
    const params: (string | number)[] = [];
    where.push(`c.is_active = ${f.active === false ? 0 : 1}`);
    const approval = f.approval ?? 'VISIBLE';
    if (approval === 'VISIBLE') where.push("c.approval_status IN ('APPROVED','PENDING')");
    else {
      where.push('c.approval_status = ?');
      params.push(approval);
    }
    if (f.hasDues) where.push('c.balance_paise <> 0');
    if (f.search?.trim()) {
      const term = f.search.trim();
      const like = `%${likeEscape(term)}%`;
      const parts = ["c.name LIKE ? ESCAPE '\\'", "c.gstin LIKE ? ESCAPE '\\'", "c.email LIKE ? ESCAPE '\\'", "c.address LIKE ? ESCAPE '\\'", "c.place_of_supply LIKE ? ESCAPE '\\'", "c.phone LIKE ? ESCAPE '\\'"];
      params.push(like, like, like, like, like, like);
      if (/^[0-9 +()-]+$/.test(term) && /\d/.test(term)) {
        // phone numbers are typed with spaces and dashes; compare digits only
        parts.push("REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.phone,' ',''),'-',''),'+',''),'(',''),')','') LIKE ? ESCAPE '\\'");
        params.push(`%${term.replace(/\D/g, '')}%`);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const sort = f.sortBy === 'balance' ? 'c.balance_paise' : f.sortBy === 'newest' ? 'c.id' : 'c.name COLLATE NOCASE';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM customer c ${whereSql}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`${SELECT} ${whereSql} ORDER BY ${sort} ${f.descending ? 'DESC' : 'ASC'}, c.id LIMIT ? OFFSET ?`)
      .all(...params, Math.max(1, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as CustomerRow[];
    return { rows: rows.map(toDto), total };
  }

  /**
   * Who owes money. Without `asOfDate` it shows today's balances; with it, balances as at the end of that local day, rebuilt from the ledger.
   * Customers holding an advance (negative balance) are listed only when `includeAdvances` is set.
   */
  dues(token: string, f: { search?: string; asOfDate?: string; includeAdvances?: boolean; sortBy?: 'balance' | 'name'; limit?: number; offset?: number } = {}): {
    rows: DuesRow[];
    totalOutstandingPaise: number;
    customerCount: number;
  } {
    this.auth.authorize(token, 'customer.view');
    let toUtc: string | undefined;
    try {
      toUtc = localDayRangeToUtc(undefined, f.asOfDate).toUtcExclusive;
    } catch (e) {
      throw new AppError('VALIDATION', (e as Error).message);
    }
    // Placeholders appear in this order in the SQL: balance, last sale, last payment (each only when asOfDate is set), then the search terms.
    const asOf = toUtc ? [toUtc, toUtc, toUtc] : [];
    const balanceExpr = toUtc
      ? '(SELECT COALESCE(SUM(l.amount_paise), 0) FROM customer_ledger l WHERE l.customer_id = c.id AND l.at < ?)'
      : 'c.balance_paise';
    const lastExpr = (type: string): string =>
      `(SELECT MAX(l.at) FROM customer_ledger l WHERE l.customer_id = c.id AND l.entry_type = '${type}'${toUtc ? ' AND l.at < ?' : ''})`;

    let searchSql = '';
    const searchParams: string[] = [];
    if (f.search?.trim()) {
      const like = `%${likeEscape(f.search.trim())}%`;
      searchSql = "AND (c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.gstin LIKE ? ESCAPE '\\')";
      searchParams.push(like, like, like);
    }
    const sql = `SELECT * FROM (
        SELECT c.id AS id, c.name AS name, c.phone AS phone, ${balanceExpr} AS balance,
               ${lastExpr('SALE')} AS last_sale, ${lastExpr('PAYMENT')} AS last_payment
        FROM customer c WHERE c.approval_status <> 'REJECTED' ${searchSql}
      ) WHERE ${f.includeAdvances ? 'balance <> 0' : 'balance > 0'}`;
    const all = this.db
      .prepare(`${sql} ORDER BY ${f.sortBy === 'name' ? 'name COLLATE NOCASE' : 'balance DESC, name COLLATE NOCASE'}`)
      .all(...asOf, ...searchParams) as { id: number; name: string; phone: string | null; balance: number; last_sale: string | null; last_payment: string | null }[];
    const rows = all.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balancePaise: r.balance, lastSaleAt: r.last_sale, lastPaymentAt: r.last_payment }));
    const start = Math.max(0, f.offset ?? 0);
    return {
      rows: rows.slice(start, start + Math.max(1, f.limit ?? 500)),
      totalOutstandingPaise: rows.filter((r) => r.balancePaise > 0).reduce((s, r) => s + r.balancePaise, 0),
      customerCount: rows.length,
    };
  }

  exportDuesCsv(token: string, f: Parameters<CustomerService['dues']>[1] = {}): string {
    const { rows } = this.dues(token, { ...f, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return toCsv(
      ['Customer', 'Phone', 'Balance due (Rs)', 'Last sale', 'Last payment'],
      rows.map((r) => [r.name, r.phone, r.balancePaise / 100, r.lastSaleAt ? toLocalDateTime(r.lastSaleAt) : '', r.lastPaymentAt ? toLocalDateTime(r.lastPaymentAt) : '']),
    );
  }

  /** Account statement for one customer over a range of local dates: opening balance, every entry, closing balance. */
  statement(token: string, customerId: number, fromDate?: string, toDate?: string): { customer: CustomerDto } & Statement {
    this.auth.authorize(token, 'customer.view');
    const customer = this.getUnchecked(customerId);
    return { customer, ...buildStatement(this.db, 'customer', customerId, fromDate, toDate) };
  }

  exportStatementCsv(token: string, customerId: number, fromDate?: string, toDate?: string): string {
    const s = this.statement(token, customerId, fromDate, toDate);
    const rows: (string | number | null)[][] = [['', 'Opening balance', '', '', '', '', s.openingPaise / 100]];
    for (const e of s.entries) {
      rows.push([toLocalDateTime(e.at), e.label, e.refNo, e.note, e.amountPaise > 0 ? e.amountPaise / 100 : '', e.amountPaise < 0 ? -e.amountPaise / 100 : '', e.balanceAfterPaise / 100]);
    }
    rows.push(['', 'Closing balance', '', '', s.increasesPaise / 100, s.reducesPaise / 100, s.closingPaise / 100]);
    return toCsv(['Date and time', 'Entry', 'Reference', 'Note', 'Debit (Rs)', 'Credit (Rs)', 'Balance (Rs)'], rows);
  }

  // ---- internals ----
  private getUnchecked(customerId: number): CustomerDto {
    const row = this.db.prepare(`${SELECT} WHERE c.id = ?`).get(customerId) as CustomerRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'customer not found');
    return toDto(row);
  }

  private assertGstinFree(db: Db, gstin: string | null, exceptId: number | null): void {
    if (!gstin) return;
    const other = db.prepare('SELECT id, name FROM customer WHERE gstin = ? AND id <> ?').get(gstin, exceptId ?? -1) as { id: number; name: string } | undefined;
    if (other) throw new AppError('CONFLICT', `GSTIN ${gstin} already belongs to customer "${other.name}"`, { customerId: other.id });
  }

}
