import { DEFAULT_EMPLOYEE_PERMISSIONS, isGrantable, isPermission, type Permission } from '../../domain/permissions';
import { passwordProblems, usernameProblems } from '../../domain/password';
import { AppError } from '../../shared/errors';
import type { Db } from '../../infrastructure/db/connection';
import { recordAudit } from '../../infrastructure/db/audit';
import { UnitOfWork } from '../../infrastructure/db/unitOfWork';
import { findUserById, findUserByUsername, listPrincipals, type Principal } from '../../infrastructure/db/userRepo';
import type { PasswordHasher } from '../../infrastructure/security/passwordHasher';
import { systemClock, type Clock } from '../../shared/clock';
import type { AuthService } from './authService';
import type { SessionStore } from './sessionStore';

export interface UserServiceDeps {
  db: Db;
  auth: AuthService;
  hasher: PasswordHasher;
  sessions: SessionStore;
  clock?: Clock;
}

function checkPermissions(perms: readonly string[]): Permission[] {
  const out: Permission[] = [];
  for (const p of perms) {
    if (!isPermission(p)) throw new AppError('VALIDATION', `unknown permission: ${p}`);
    if (!isGrantable(p)) throw new AppError('VALIDATION', `${p} can only be held by the owner`);
    if (!out.includes(p)) out.push(p);
  }
  return out.sort();
}

/** Owner-only account administration. Every method re-checks 'user.manage' (which only an owner can hold). */
export class UserService {
  private readonly db: Db;
  private readonly auth: AuthService;
  private readonly hasher: PasswordHasher;
  private readonly sessions: SessionStore;
  private readonly uow: UnitOfWork;

  constructor(deps: UserServiceDeps) {
    this.db = deps.db;
    this.auth = deps.auth;
    this.hasher = deps.hasher;
    this.sessions = deps.sessions;
    this.uow = new UnitOfWork(this.db, deps.clock ?? systemClock);
  }

  list(token: string): Principal[] {
    this.auth.authorize(token, 'user.manage');
    return listPrincipals(this.db);
  }

  /** Creates an employee with a temporary password they must change at first sign-in. */
  async createEmployee(
    token: string,
    input: { username: string; displayName: string; temporaryPassword: string; permissions?: readonly string[] },
  ): Promise<number> {
    const admin = this.auth.authorize(token, 'user.manage');
    const problems = [
      ...usernameProblems(input.username).map((p) => `username ${p}`),
      ...passwordProblems(input.temporaryPassword, input.username).map((p) => `password ${p}`),
      ...(input.displayName.trim() ? [] : ['name is required']),
    ];
    if (problems.length) throw new AppError('VALIDATION', problems.join('; '), { problems });
    const permissions = checkPermissions(input.permissions ?? DEFAULT_EMPLOYEE_PERMISSIONS);
    if (findUserByUsername(this.db, input.username)) throw new AppError('CONFLICT', 'that username is already taken');

    const hash = await this.hasher.hash(input.temporaryPassword);
    return this.uow.run(this.auth.actorFor(admin), (ctx) => {
      const id = Number(
        ctx.db
          .prepare(
            `INSERT INTO user (username, display_name, password_hash, role, is_active, must_change_password, created_by, created_at)
             VALUES (?, ?, ?, 'EMPLOYEE', 1, 1, ?, ?)`,
          )
          .run(input.username, input.displayName.trim(), hash, admin.id, ctx.now).lastInsertRowid,
      );
      const ins = ctx.db.prepare('INSERT INTO user_permission (user_id, permission) VALUES (?, ?)');
      for (const p of permissions) ins.run(id, p);
      recordAudit(ctx, { action: 'USER_CREATE', entityType: 'user', entityId: id, detail: { username: input.username, permissions } });
      return id;
    });
  }

  setActive(token: string, userId: number, active: boolean): void {
    const admin = this.auth.authorize(token, 'user.manage');
    const target = this.employee(userId);
    this.uow.run(this.auth.actorFor(admin), (ctx) => {
      ctx.db.prepare('UPDATE user SET is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, admin.id, ctx.now, target.id);
      recordAudit(ctx, { action: active ? 'USER_ENABLE' : 'USER_DISABLE', entityType: 'user', entityId: target.id });
    });
    if (!active) this.sessions.destroyAllForUser(target.id);
  }

  /** Sets a new temporary password, forces a change at next sign-in, clears any lockout and ends the user's sessions. */
  async resetPassword(token: string, userId: number, temporaryPassword: string): Promise<void> {
    const admin = this.auth.authorize(token, 'user.manage');
    const target = this.employee(userId);
    const problems = passwordProblems(temporaryPassword, target.username);
    if (problems.length) throw new AppError('VALIDATION', `password ${problems.join('; ')}`, { problems });
    const hash = await this.hasher.hash(temporaryPassword);
    this.uow.run(this.auth.actorFor(admin), (ctx) => {
      ctx.db
        .prepare('UPDATE user SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, updated_by = ?, updated_at = ? WHERE id = ?')
        .run(hash, admin.id, ctx.now, target.id);
      recordAudit(ctx, { action: 'PASSWORD_RESET', entityType: 'user', entityId: target.id, detail: { via: 'owner' } });
    });
    this.sessions.destroyAllForUser(target.id);
  }

  /** Replaces an employee's permission set. Takes effect on their very next action. */
  setPermissions(token: string, userId: number, permissions: readonly string[]): void {
    const admin = this.auth.authorize(token, 'user.manage');
    const target = this.employee(userId);
    const next = checkPermissions(permissions);
    this.uow.run(this.auth.actorFor(admin), (ctx) => {
      const before = (ctx.db.prepare('SELECT permission FROM user_permission WHERE user_id = ?').all(target.id) as { permission: string }[]).map((r) => r.permission);
      ctx.db.prepare('DELETE FROM user_permission WHERE user_id = ?').run(target.id);
      const ins = ctx.db.prepare('INSERT INTO user_permission (user_id, permission) VALUES (?, ?)');
      for (const p of next) ins.run(target.id, p);
      recordAudit(ctx, {
        action: 'PERMISSION_CHANGE',
        entityType: 'user',
        entityId: target.id,
        detail: { added: next.filter((p) => !before.includes(p)), removed: before.filter((p) => !(next as string[]).includes(p)) },
      });
    });
  }

  private employee(userId: number): { id: number; username: string } {
    const row = findUserById(this.db, userId);
    if (!row) throw new AppError('NOT_FOUND', 'user not found');
    if (row.role !== 'EMPLOYEE') throw new AppError('VALIDATION', 'the owner account cannot be changed this way');
    return { id: row.id, username: row.username };
  }
}
