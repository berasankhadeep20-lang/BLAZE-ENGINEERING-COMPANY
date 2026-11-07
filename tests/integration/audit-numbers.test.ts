import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/infrastructure/db/connection';
import { recordAudit, redactSecrets } from '../../src/infrastructure/db/audit';
import { allocateNumber } from '../../src/infrastructure/db/numberSeries';
import { financialYear, seriesPrefix } from '../../src/domain/billNumber';
import { owner, testDb, uowFor } from '../helpers/db';

let db: Db;
beforeEach(() => {
  db = testDb();
});
afterEach(() => db.close());

describe('audit', () => {
  it('stores action, entity, reason and JSON detail', () => {
    uowFor(db).run(owner, (ctx) =>
      recordAudit(ctx, { action: 'SALE_CANCEL', entityType: 'sale_bill', entityId: 7, reason: 'wrong customer', detail: { billNo: 'BZ260001' } }),
    );
    expect(db.prepare('SELECT action, entity_type, entity_id, reason, detail_json FROM audit_log').get()).toEqual({
      action: 'SALE_CANCEL',
      entity_type: 'sale_bill',
      entity_id: 7,
      reason: 'wrong customer',
      detail_json: '{"billNo":"BZ260001"}',
    });
  });

  it('never stores secrets', () => {
    expect(redactSecrets({ username: 'u', password: 'p', nested: { password_hash: 'h', apiToken: 't', ok: 1 } })).toEqual({
      username: 'u',
      password: '[redacted]',
      nested: { password_hash: '[redacted]', apiToken: '[redacted]', ok: 1 },
    });
    uowFor(db).run(owner, (ctx) => recordAudit(ctx, { action: 'PASSWORD_RESET', detail: { newPassword: 'hunter2' } }));
    const row = db.prepare('SELECT detail_json FROM audit_log').get() as { detail_json: string };
    expect(row.detail_json).not.toContain('hunter2');
  });
});

describe('number series', () => {
  const fy = financialYear('2026-10-31');
  const prefix = seriesPrefix('BZ', fy);

  it('issues sequential numbers in the sample format', () => {
    const uow = uowFor(db);
    const a = uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, prefix));
    const b = uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, prefix));
    expect(a).toEqual({ number: 'BZ260001', sequence: 1 });
    expect(b).toEqual({ number: 'BZ260002', sequence: 2 });
  });

  it('leaves no gap when the transaction rolls back', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, prefix)); // BZ260001
    expect(() =>
      uow.run(owner, (ctx) => {
        allocateNumber(ctx, 'SALE', fy, prefix); // would be BZ260002
        throw new Error('confirm failed');
      }),
    ).toThrow('confirm failed');
    const next = uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, prefix));
    expect(next.number).toBe('BZ260002');
  });

  it('keeps series and financial years independent', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, prefix));
    const receipt = uow.run(owner, (ctx) => allocateNumber(ctx, 'RECEIPT', fy, 'RC26'));
    const nextYear = financialYear('2027-04-01');
    const sale27 = uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', nextYear, seriesPrefix('BZ', nextYear)));
    expect(receipt.number).toBe('RC260001');
    expect(sale27.number).toBe('BZ270001');
  });

  it('keeps the stored prefix once a series exists', () => {
    const uow = uowFor(db);
    uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, 'BZ26'));
    expect(uow.run(owner, (ctx) => allocateNumber(ctx, 'SALE', fy, 'OTHER')).number).toBe('BZ260002');
  });
});
