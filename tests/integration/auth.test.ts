import { describe, expect, it } from 'vitest';
import { generateRecoveryCode, lockoutMinutes } from '../../src/application/auth/authService';
import { AppError, type ErrorCode } from '../../src/shared/errors';
import { OWNER_PASSWORD, buildServices, setupHarness } from '../helpers/auth';

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<ErrorCode | 'NO_ERROR'> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 'NO_ERROR';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
const auditActions = (db: ReturnType<typeof buildServices>['db']): string[] =>
  (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);

describe('first-run setup', () => {
  it('creates the owner once and returns a recovery code', async () => {
    const s = buildServices();
    expect(s.auth.isFirstRun()).toBe(true);
    const r = await s.auth.firstRunSetup({ username: 'owner', displayName: 'Shop Owner', password: 'owner-pass-1' });
    expect(r.recoveryCode).toMatch(/^([A-Z2-9]{5}-){4}[A-Z2-9]{5}$/);
    expect(s.auth.isFirstRun()).toBe(false);
    const row = s.db.prepare('SELECT role, password_hash FROM user').get() as { role: string; password_hash: string };
    expect(row.role).toBe('OWNER');
    expect(row.password_hash).not.toBe('owner-pass-1');
    expect(auditActions(s.db)).toEqual(['FIRST_RUN_SETUP']);
    expect(await codeOf(s.auth.firstRunSetup({ username: 'again', displayName: 'X', password: 'another-pass-9' }))).toBe('CONFLICT');
  });

  it('rejects weak credentials without creating anything', async () => {
    const s = buildServices();
    expect(await codeOf(s.auth.firstRunSetup({ username: 'owner', displayName: 'O', password: 'short' }))).toBe('VALIDATION');
    expect(await codeOf(s.auth.firstRunSetup({ username: 'o', displayName: 'O', password: 'long-enough-pass' }))).toBe('VALIDATION');
    expect(s.auth.isFirstRun()).toBe(true);
  });

  it('generates unpredictable recovery codes', () => {
    expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
  });
});

describe('sign-in', () => {
  it('signs in with correct credentials (username is case-insensitive)', async () => {
    const h = await setupHarness();
    const { user } = await h.auth.login('OWNER', OWNER_PASSWORD);
    expect(user.role).toBe('OWNER');
    expect(user).not.toHaveProperty('password_hash');
    expect(auditActions(h.db)).toContain('LOGIN');
  });

  it('gives the same error for a wrong password and an unknown user', async () => {
    const h = await setupHarness();
    const wrong = await h.auth.login('owner', 'nope-nope-1').catch((e: AppError) => e);
    const unknown = await h.auth.login('ghost', 'nope-nope-1').catch((e: AppError) => e);
    expect((wrong as AppError).code).toBe('AUTH_FAILED');
    expect((unknown as AppError).code).toBe('AUTH_FAILED');
    expect((wrong as AppError).message).toBe((unknown as AppError).message);
  });

  it('never writes the password into the audit trail', async () => {
    const h = await setupHarness();
    await h.auth.login('owner', 'secret-guess-77').catch(() => undefined);
    const rows = h.db.prepare('SELECT detail_json, reason FROM audit_log').all() as { detail_json: string | null; reason: string | null }[];
    expect(JSON.stringify(rows)).not.toContain('secret-guess-77');
    expect(JSON.stringify(rows)).not.toContain(OWNER_PASSWORD);
  });

  it('locks after repeated failures, blocks even the right password, and unlocks with time', async () => {
    const h = await setupHarness();
    expect([0, 0, 0, 0, 0, 1, 5, 15, 60].map((_, i) => lockoutMinutes(i))).toEqual([0, 0, 0, 0, 0, 1, 5, 15, 60]);
    for (let i = 0; i < 5; i++) expect(await codeOf(h.auth.login('owner', 'wrong-pass-1'))).toBe('AUTH_FAILED');
    expect(await codeOf(h.auth.login('owner', OWNER_PASSWORD))).toBe('ACCOUNT_LOCKED');
    h.clock.advanceMinutes(2);
    const { token } = await h.auth.login('owner', OWNER_PASSWORD);
    expect(h.auth.getSession(token).username).toBe('owner');
    const row = h.db.prepare('SELECT failed_attempts, locked_until FROM user').get() as { failed_attempts: number; locked_until: string | null };
    expect(row).toEqual({ failed_attempts: 0, locked_until: null });
  });

  it('escalates the lock if the wrong password is tried again after it expires', async () => {
    const h = await setupHarness();
    for (let i = 0; i < 5; i++) await h.auth.login('owner', 'wrong-pass-1').catch(() => undefined);
    h.clock.advanceMinutes(2);
    await h.auth.login('owner', 'wrong-pass-1').catch(() => undefined); // 6th failure -> 5 minutes
    h.clock.advanceMinutes(3);
    expect(await codeOf(h.auth.login('owner', OWNER_PASSWORD))).toBe('ACCOUNT_LOCKED');
    h.clock.advanceMinutes(3);
    expect(await codeOf(h.auth.login('owner', OWNER_PASSWORD))).toBe('NO_ERROR');
  });

  it('logout ends the session and is audited', async () => {
    const h = await setupHarness();
    h.auth.logout(h.ownerToken);
    expect(await codeOf(() => h.auth.getSession(h.ownerToken))).toBe('AUTH_FAILED');
    expect(auditActions(h.db)).toContain('LOGOUT');
  });

  it('signs out an idle session when an idle timeout is set', async () => {
    const h = await setupHarness({ idleTimeoutMs: 10 * 60_000 });
    h.clock.advanceMinutes(5);
    expect(h.auth.getSession(h.ownerToken).username).toBe('owner'); // activity resets the timer
    h.clock.advanceMinutes(9);
    expect(h.auth.getSession(h.ownerToken).username).toBe('owner');
    h.clock.advanceMinutes(11);
    expect(await codeOf(() => h.auth.getSession(h.ownerToken))).toBe('AUTH_FAILED');
  });
});

describe('changing and recovering passwords', () => {
  it('requires the current password, enforces the rules, and ends other sessions', async () => {
    const h = await setupHarness();
    const second = (await h.auth.login('owner', OWNER_PASSWORD)).token;
    expect(await codeOf(h.auth.changePassword(h.ownerToken, 'wrong-pass-1', 'brand-new-pass-2'))).toBe('AUTH_FAILED');
    expect(await codeOf(h.auth.changePassword(h.ownerToken, OWNER_PASSWORD, 'short'))).toBe('VALIDATION');
    expect(await codeOf(h.auth.changePassword(h.ownerToken, OWNER_PASSWORD, OWNER_PASSWORD))).toBe('VALIDATION');
    await h.auth.changePassword(h.ownerToken, OWNER_PASSWORD, 'brand-new-pass-2');
    expect(await codeOf(() => h.auth.getSession(second))).toBe('AUTH_FAILED'); // other session ended
    expect(h.auth.getSession(h.ownerToken).username).toBe('owner'); // this one continues
    expect(await codeOf(h.auth.login('owner', OWNER_PASSWORD))).toBe('AUTH_FAILED');
    expect(await codeOf(h.auth.login('owner', 'brand-new-pass-2'))).toBe('NO_ERROR');
  });

  it('recovers the owner account with the recovery code, then rotates the code', async () => {
    const h = await setupHarness();
    expect(await codeOf(h.auth.recoverOwnerPassword('owner', 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', 'fresh-pass-77'))).toBe('AUTH_FAILED');
    for (let i = 0; i < 5; i++) await h.auth.login('owner', 'wrong-pass-1').catch(() => undefined); // locked out
    const messy = ` ${h.recoveryCode.toLowerCase().replace(/-/g, ' ')} `; // forgiving about case and separators
    const { recoveryCode: next } = await h.auth.recoverOwnerPassword('owner', messy, 'fresh-pass-77');
    expect(next).not.toBe(h.recoveryCode);
    expect(await codeOf(h.auth.recoverOwnerPassword('owner', h.recoveryCode, 'another-pass-8'))).toBe('AUTH_FAILED'); // old code dead
    expect(await codeOf(() => h.auth.getSession(h.ownerToken))).toBe('AUTH_FAILED'); // old sessions ended
    expect(await codeOf(h.auth.login('owner', 'fresh-pass-77'))).toBe('NO_ERROR'); // lockout cleared
    expect(auditActions(h.db)).toContain('PASSWORD_RESET');
  });

  it('does not offer recovery for employee accounts', async () => {
    const h = await setupHarness();
    await h.users.createEmployee(h.ownerToken, { username: 'ravi', displayName: 'Ravi', temporaryPassword: 'temp-pass-123' });
    expect(await codeOf(h.auth.recoverOwnerPassword('ravi', h.recoveryCode, 'fresh-pass-77'))).toBe('AUTH_FAILED');
  });
});
