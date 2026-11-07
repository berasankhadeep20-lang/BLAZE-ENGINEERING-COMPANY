import { describe, expect, it } from 'vitest';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { setupHarness, type Harness } from '../helpers/auth';

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<ErrorCode | 'NO_ERROR'> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}

/** An employee who has already replaced the temporary password and is signed in. */
async function signedInEmployee(h: Harness, username = 'ravi', permissions?: string[]): Promise<{ id: number; token: string }> {
  const id = await h.users.createEmployee(h.ownerToken, { username, displayName: username, temporaryPassword: 'temp-pass-123', permissions });
  const { token } = await h.auth.login(username, 'temp-pass-123');
  await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
  return { id, token };
}

describe('creating employees', () => {
  it('gives daily-work permissions only and forces a password change at first sign-in', async () => {
    const h = await setupHarness();
    const id = await h.users.createEmployee(h.ownerToken, { username: 'ravi', displayName: ' Ravi ', temporaryPassword: 'temp-pass-123' });
    const ravi = h.users.list(h.ownerToken).find((u) => u.id === id);
    expect(ravi).toMatchObject({ role: 'EMPLOYEE', displayName: 'Ravi', isActive: true, mustChangePassword: true });
    expect(ravi?.permissions).toEqual(expect.arrayContaining(['sale.create', 'payment.record', 'inventory.view']));
    expect(ravi?.permissions).not.toContain('price.edit');

    const { token, user } = await h.auth.login('ravi', 'temp-pass-123');
    expect(user.mustChangePassword).toBe(true);
    expect(await codeOf(() => h.auth.authorize(token, 'sale.create'))).toBe('PASSWORD_CHANGE_REQUIRED');
    await h.auth.changePassword(token, 'temp-pass-123', 'my-own-pass-456');
    expect(h.auth.authorize(token, 'sale.create').username).toBe('ravi');
  });

  it('records who created the account and audits it without the password', async () => {
    const h = await setupHarness();
    const id = await h.users.createEmployee(h.ownerToken, { username: 'ravi', displayName: 'Ravi', temporaryPassword: 'temp-pass-123' });
    expect(h.db.prepare('SELECT created_by FROM user WHERE id = ?').get(id)).toEqual({ created_by: 1 });
    const audit = JSON.stringify(h.db.prepare("SELECT user_id, detail_json FROM audit_log WHERE action = 'USER_CREATE'").all());
    expect(audit).toContain('"user_id":1');
    expect(audit).not.toContain('temp-pass-123');
  });

  it('rejects duplicate usernames, weak passwords and unknown or owner-only permissions', async () => {
    const h = await setupHarness();
    await h.users.createEmployee(h.ownerToken, { username: 'ravi', displayName: 'Ravi', temporaryPassword: 'temp-pass-123' });
    const mk = (over: object): Promise<number> =>
      h.users.createEmployee(h.ownerToken, { username: 'new.user', displayName: 'N', temporaryPassword: 'temp-pass-123', ...over });
    expect(await codeOf(mk({ username: 'RAVI' }))).toBe('CONFLICT');
    expect(await codeOf(mk({ temporaryPassword: 'short' }))).toBe('VALIDATION');
    expect(await codeOf(mk({ permissions: ['made.up'] }))).toBe('VALIDATION');
    expect(await codeOf(mk({ permissions: ['user.manage'] }))).toBe('VALIDATION');
    expect(await codeOf(mk({ permissions: ['settings.edit'] }))).toBe('VALIDATION');
  });
});

describe('who may do what', () => {
  it('stops an employee from administering accounts', async () => {
    const h = await setupHarness();
    const ravi = await signedInEmployee(h);
    expect(await codeOf(() => h.users.list(ravi.token))).toBe('PERMISSION_DENIED');
    expect(await codeOf(h.users.createEmployee(ravi.token, { username: 'x.y', displayName: 'X', temporaryPassword: 'temp-pass-123' }))).toBe('PERMISSION_DENIED');
    expect(await codeOf(() => h.users.setPermissions(ravi.token, ravi.id, ['price.edit']))).toBe('PERMISSION_DENIED');
    expect(await codeOf(() => h.users.setActive(ravi.token, 1, false))).toBe('PERMISSION_DENIED');
  });

  it('checks permissions on every action and applies a change immediately', async () => {
    const h = await setupHarness();
    const ravi = await signedInEmployee(h);
    expect(await codeOf(() => h.auth.authorize(ravi.token, 'price.edit'))).toBe('PERMISSION_DENIED');
    h.users.setPermissions(h.ownerToken, ravi.id, ['price.edit', 'sale.create']);
    expect(h.auth.authorize(ravi.token, 'price.edit').username).toBe('ravi'); // same session, no re-login
    expect(await codeOf(() => h.auth.authorize(ravi.token, 'payment.record'))).toBe('PERMISSION_DENIED'); // removed
    const change = h.db.prepare("SELECT detail_json FROM audit_log WHERE action = 'PERMISSION_CHANGE'").get() as { detail_json: string };
    expect(JSON.parse(change.detail_json)).toEqual({
      added: ['price.edit'],
      removed: expect.arrayContaining(['payment.record', 'inventory.view']),
    });
  });

  it('never lets an employee hold an owner-only permission, even if a row sneaks into the database', async () => {
    const h = await setupHarness();
    const ravi = await signedInEmployee(h);
    h.db.prepare("INSERT INTO user_permission (user_id, permission) VALUES (?, 'user.manage')").run(ravi.id);
    expect(await codeOf(() => h.auth.authorize(ravi.token, 'user.manage'))).toBe('PERMISSION_DENIED');
    expect(await codeOf(() => h.users.list(ravi.token))).toBe('PERMISSION_DENIED');
  });

  it('lets the owner do everything', async () => {
    const h = await setupHarness();
    for (const p of ['user.manage', 'settings.edit', 'backup.restore', 'price.edit', 'customer.approve'] as const) {
      expect(h.auth.authorize(h.ownerToken, p).role).toBe('OWNER');
    }
  });
});

describe('disabling and resetting', () => {
  it('disabling cuts off a signed-in employee immediately and blocks sign-in until re-enabled', async () => {
    const h = await setupHarness();
    const ravi = await signedInEmployee(h);
    h.users.setActive(h.ownerToken, ravi.id, false);
    expect(await codeOf(() => h.auth.getSession(ravi.token))).toBe('AUTH_FAILED');
    expect(await codeOf(h.auth.login('ravi', 'my-own-pass-456'))).toBe('AUTH_FAILED');
    h.users.setActive(h.ownerToken, ravi.id, true);
    expect(await codeOf(h.auth.login('ravi', 'my-own-pass-456'))).toBe('NO_ERROR');
    const actions = (h.db.prepare('SELECT action FROM audit_log').all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['USER_DISABLE', 'USER_ENABLE']));
  });

  it('the owner account cannot be disabled or reset through user management', async () => {
    const h = await setupHarness();
    expect(await codeOf(() => h.users.setActive(h.ownerToken, 1, false))).toBe('VALIDATION');
    expect(await codeOf(h.users.resetPassword(h.ownerToken, 1, 'sneaky-pass-12'))).toBe('VALIDATION');
    expect(await codeOf(() => h.users.setPermissions(h.ownerToken, 1, []))).toBe('VALIDATION');
    expect(await codeOf(() => h.users.setActive(h.ownerToken, 999, false))).toBe('NOT_FOUND');
  });

  it('reset sets a temporary password, clears a lockout, ends sessions and forces a change', async () => {
    const h = await setupHarness();
    const ravi = await signedInEmployee(h);
    for (let i = 0; i < 5; i++) await h.auth.login('ravi', 'wrong-pass-1').catch(() => undefined);
    expect(await codeOf(h.auth.login('ravi', 'my-own-pass-456'))).toBe('ACCOUNT_LOCKED');
    await h.users.resetPassword(h.ownerToken, ravi.id, 'temp-again-789');
    expect(await codeOf(() => h.auth.getSession(ravi.token))).toBe('AUTH_FAILED');
    const { token, user } = await h.auth.login('ravi', 'temp-again-789');
    expect(user.mustChangePassword).toBe(true);
    expect(await codeOf(() => h.auth.authorize(token, 'sale.create'))).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(await codeOf(h.users.resetPassword(h.ownerToken, ravi.id, 'short'))).toBe('VALIDATION');
  });
});
