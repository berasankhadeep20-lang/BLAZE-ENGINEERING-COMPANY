import { assertInTransaction, type TxContext } from './unitOfWork';

export const AUDIT_ACTIONS = [
  'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'FIRST_RUN_SETUP',
  'USER_CREATE', 'USER_UPDATE', 'USER_DISABLE', 'USER_ENABLE', 'PASSWORD_RESET', 'PASSWORD_CHANGE', 'PERMISSION_CHANGE',
  'ITEM_CREATE', 'ITEM_UPDATE', 'PRICE_CHANGE', 'STOCK_ADJUST',
  'CUSTOMER_CREATE', 'CUSTOMER_UPDATE', 'CUSTOMER_APPROVE', 'CUSTOMER_REJECT',
  'SUPPLIER_CREATE', 'SUPPLIER_UPDATE',
  'SALE_SAVE_DRAFT', 'SALE_DELETE_DRAFT', 'SALE_CONFIRM', 'SALE_CANCEL', 'BELOW_COST_ACK',
  'PURCHASE_SAVE_DRAFT', 'PURCHASE_DELETE_DRAFT', 'PURCHASE_CONFIRM', 'PURCHASE_RECEIVE', 'PURCHASE_CANCEL',
  'PAYMENT_ADD', 'PAYMENT_REVERSE', 'SUPPLIER_PAYMENT_ADD', 'SUPPLIER_PAYMENT_REVERSE',
  'INVOICE_PRINT', 'BACKUP_CREATE', 'BACKUP_RESTORE', 'SETTINGS_UPDATE', 'DEMO_RESET',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  action: AuditAction;
  entityType?: string;
  entityId?: number;
  reason?: string;
  detail?: Record<string, unknown>;
}

const SECRET_KEY = /pass(word)?|hash|secret|token/i;

/** Copy of `value` with anything that looks like a secret replaced, so the audit trail can never leak credentials. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** Append one audit row inside the caller's transaction (so it commits or rolls back with the action it describes). */
export function recordAudit(ctx: TxContext, entry: AuditEntry): number {
  assertInTransaction(ctx, 'recordAudit');
  const info = ctx.db
    .prepare(
      `INSERT INTO audit_log (at, user_id, action, entity_type, entity_id, reason, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.now,
      ctx.actor?.userId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.reason ?? null,
      entry.detail ? JSON.stringify(redactSecrets(entry.detail)) : null,
    );
  return Number(info.lastInsertRowid);
}
