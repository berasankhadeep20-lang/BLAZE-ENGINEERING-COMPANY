import { randomBytes } from 'node:crypto';
import { isOwnerOnly, type Permission } from '../../domain/permissions';
import { passwordProblems, usernameProblems } from '../../domain/password';
import { systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork, type Actor } from '../../infrastructure/db/unitOfWork';
import { countUsers, findUserById, findUserByUsername, loadPrincipal, type Principal } from '../../infrastructure/db/userRepo';
import type { PasswordHasher } from '../../infrastructure/security/passwordHasher';
import type { SessionStore } from './sessionStore';

export type SessionUser = Omit<Principal, 'isActive'>;

/** Minutes locked after N consecutive failed sign-ins. */
export function lockoutMinutes(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts === 5) return 1;
  if (failedAttempts === 6) return 5;
  if (failedAttempts === 7) return 15;
  return 60;
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
const RECOVERY_KEY = 'owner_recovery_hash';

/** 25 random symbols (125 bits) shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(25);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b & 31] ?? 'A').join('');
  return chars.match(/.{5}/g)?.join('-') ?? chars;
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function toSessionUser(p: Principal): SessionUser {
  return {
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    role: p.role,
    mustChangePassword: p.mustChangePassword,
    permissions: p.permissions,
  };
}

export interface AuthDeps {
  db: Db;
  hasher: PasswordHasher;
  sessions: SessionStore;
  clock?: Clock;
}

export class AuthService {
  private readonly db: Db;
  private readonly hasher: PasswordHasher;
  private readonly sessions: SessionStore;
  private readonly clock: Clock;
  private readonly uow: UnitOfWork;
  private dummyHash: Promise<string> | null = null;

  constructor(deps: AuthDeps) {
    this.db = deps.db;
    this.hasher = deps.hasher;
    this.sessions = deps.sessions;
    this.clock = deps.clock ?? systemClock;
    this.uow = new UnitOfWork(this.db, this.clock);
  }

  isFirstRun(): boolean {
    return countUsers(this.db) === 0;
  }

  /** First launch only: create the owner account and an offline recovery code (shown once; the app must make the owner save it). */
  async firstRunSetup(input: { username: string; displayName: string; password: string }): Promise<{ userId: number; recoveryCode: string }> {
    const problems = [
      ...usernameProblems(input.username).map((p) => `username ${p}`),
      ...passwordProblems(input.password, input.username).map((p) => `password ${p}`),
      ...(input.displayName.trim() ? [] : ['name is required']),
    ];
    if (problems.length) throw new AppError('VALIDATION', problems.join('; '), { problems });
    if (!this.isFirstRun()) throw new AppError('CONFLICT', 'the application is already set up');

    const passwordHash = await this.hasher.hash(input.password);
    const recoveryCode = generateRecoveryCode();
    const recoveryHash = await this.hasher.hash(normalizeRecoveryCode(recoveryCode));

    const userId = this.uow.run(null, (ctx) => {
      if (countUsers(ctx.db) !== 0) throw new AppError('CONFLICT', 'the application is already set up');
      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO user (username, display_name, password_hash, role, is_active, must_change_password, created_at)
             VALUES (?, ?, ?, 'OWNER', 1, 0, ?)`,
          )
          .run(input.username, input.displayName.trim(), passwordHash, ctx.now).lastInsertRowid,
      );
      ctx.db
        .prepare(
          `INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(RECOVERY_KEY, recoveryHash, id, ctx.now);
      recordAudit(ctx, { action: 'FIRST_RUN_SETUP', entityType: 'user', entityId: id });
      return id;
    });
    return { userId, recoveryCode };
  }

  async login(username: string, password: string): Promise<{ token: string; user: SessionUser }> {
    const row = findUserByUsername(this.db, username);
    const nowIso = this.clock.now().toISOString();

    if (row && row.locked_until && row.locked_until > nowIso) {
      throw new AppError('ACCOUNT_LOCKED', 'too many failed attempts; try again later', { lockedUntil: row.locked_until });
    }

    // Always run one hash verification, even for an unknown user, so response time does not reveal which usernames exist.
    const storedHash = row?.password_hash ?? (await this.getDummyHash());
    const matches = await this.hasher.verify(storedHash, password);

    if (!row || row.is_active !== 1 || !matches) {
      this.uow.run(null, (ctx) => {
        if (row && row.is_active === 1) {
          const failed = row.failed_attempts + 1;
          const mins = lockoutMinutes(failed);
          const lockedUntil = mins > 0 ? new Date(this.clock.now().getTime() + mins * 60_000).toISOString() : null;
          ctx.db.prepare('UPDATE user SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(failed, lockedUntil, row.id);
        }
        recordAudit(ctx, {
          action: 'LOGIN_FAILED',
          ...(row ? { entityType: 'user', entityId: row.id, detail: { username: row.username } } : { detail: { unknownUser: true } }),
        });
      });
      throw new AppError('AUTH_FAILED', 'incorrect username or password');
    }

    this.uow.run({ userId: row.id, role: row.role }, (ctx) => {
      ctx.db.prepare('UPDATE user SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(row.id);
      recordAudit(ctx, { action: 'LOGIN', entityType: 'user', entityId: row.id });
    });
    const principal = loadPrincipal(this.db, row.id);
    if (!principal) throw new AppError('INVARIANT', 'user vanished during sign-in');
    return { token: this.sessions.create(row.id), user: toSessionUser(principal) };
  }

  logout(token: string): void {
    const userId = this.sessions.resolve(token);
    if (userId !== null) {
      const p = loadPrincipal(this.db, userId);
      if (p) this.uow.run({ userId: p.id, role: p.role }, (ctx) => recordAudit(ctx, { action: 'LOGOUT', entityType: 'user', entityId: p.id }));
    }
    this.sessions.destroy(token);
  }

  /** The signed-in user for a token. Re-read from the database every time, so a disabled account loses access immediately. */
  getSession(token: string): SessionUser {
    const userId = this.sessions.resolve(token);
    if (userId === null) throw new AppError('AUTH_FAILED', 'please sign in again');
    const p = loadPrincipal(this.db, userId);
    if (!p || !p.isActive) {
      this.sessions.destroy(token);
      throw new AppError('AUTH_FAILED', 'please sign in again');
    }
    return toSessionUser(p);
  }

  /** The signed-in user, without checking a specific permission (still refuses a session that must change its password first). */
  requireSignedIn(token: string): SessionUser {
    const user = this.getSession(token);
    if (user.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED', 'you must set a new password first');
    return user;
  }

  /** The acting user as an Actor, for UnitOfWork.run. */
  actorFor(user: SessionUser): Actor {
    return { userId: user.id, role: user.role };
  }

  /** Throws unless the signed-in user may perform `permission`. Permissions are re-read from the database on every call. */
  authorize(token: string, permission: Permission): SessionUser {
    const user = this.getSession(token);
    if (user.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED', 'you must set a new password first');
    if (user.role === 'OWNER') return user;
    if (isOwnerOnly(permission) || !user.permissions.includes(permission)) {
      throw new AppError('PERMISSION_DENIED', 'you do not have permission to do this', { permission });
    }
    return user;
  }

  /** Like authorize, but passes if the user holds ANY of the listed permissions. */
  authorizeAny(token: string, permissions: readonly Permission[]): SessionUser {
    const user = this.getSession(token);
    if (user.mustChangePassword) throw new AppError('PASSWORD_CHANGE_REQUIRED', 'you must set a new password first');
    if (user.role === 'OWNER') return user;
    if (!permissions.some((p) => !isOwnerOnly(p) && user.permissions.includes(p))) {
      throw new AppError('PERMISSION_DENIED', 'you do not have permission to do this', { anyOf: [...permissions] });
    }
    return user;
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = this.getSession(token);
    const row = findUserById(this.db, user.id);
    if (!row) throw new AppError('INVARIANT', 'user vanished');
    if (!(await this.hasher.verify(row.password_hash, currentPassword))) {
      throw new AppError('AUTH_FAILED', 'current password is incorrect');
    }
    const problems = passwordProblems(newPassword, user.username);
    if (newPassword === currentPassword) problems.push('must be different from the current password');
    if (problems.length) throw new AppError('VALIDATION', `password ${problems.join('; ')}`, { problems });

    const newHash = await this.hasher.hash(newPassword);
    this.uow.run(this.actorFor(user), (ctx) => {
      ctx.db
        .prepare('UPDATE user SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(newHash, user.id, ctx.now, user.id);
      recordAudit(ctx, { action: 'PASSWORD_CHANGE', entityType: 'user', entityId: user.id });
    });
    this.sessions.destroyAllForUser(user.id, token);
  }

  /**
   * Forgotten owner password: the recovery code shown at first run proves physical ownership of the setup.
   * On success the password is replaced, the lockout cleared, and a NEW recovery code is issued (the old one stops working).
   */
  async recoverOwnerPassword(username: string, recoveryCode: string, newPassword: string): Promise<{ recoveryCode: string }> {
    const row = findUserByUsername(this.db, username);
    const stored = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(RECOVERY_KEY) as { value: string } | undefined;
    const isOwner = !!row && row.role === 'OWNER';
    const ok = await this.hasher.verify(stored?.value ?? (await this.getDummyHash()), normalizeRecoveryCode(recoveryCode));

    if (!isOwner || !stored || !ok) {
      this.uow.run(null, (ctx) => recordAudit(ctx, { action: 'LOGIN_FAILED', detail: { via: 'recovery' } }));
      throw new AppError('AUTH_FAILED', 'recovery details are incorrect');
    }
    const problems = passwordProblems(newPassword, row.username);
    if (problems.length) throw new AppError('VALIDATION', `password ${problems.join('; ')}`, { problems });

    const newHash = await this.hasher.hash(newPassword);
    const newCode = generateRecoveryCode();
    const newCodeHash = await this.hasher.hash(normalizeRecoveryCode(newCode));
    this.uow.run({ userId: row.id, role: row.role }, (ctx) => {
      ctx.db
        .prepare('UPDATE user SET password_hash = ?, must_change_password = 0, failed_attempts = 0, locked_until = NULL, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(newHash, row.id, ctx.now, row.id);
      ctx.db.prepare('UPDATE app_setting SET value = ?, updated_by = ?, updated_at = ? WHERE key = ?').run(newCodeHash, row.id, ctx.now, RECOVERY_KEY);
      recordAudit(ctx, { action: 'PASSWORD_RESET', entityType: 'user', entityId: row.id, detail: { via: 'recovery code' } });
    });
    this.sessions.destroyAllForUser(row.id);
    return { recoveryCode: newCode };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash('not-a-real-password-used-only-for-timing');
    return this.dummyHash;
  }
}
