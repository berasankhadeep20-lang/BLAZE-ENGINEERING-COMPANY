import { ALL_PERMISSIONS, isPermission, type Permission } from '../../domain/permissions';
import type { Db } from './connection';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'OWNER' | 'EMPLOYEE';
  is_active: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
}

/** A user as the rest of the app sees them: no password hash, permissions resolved. */
export interface Principal {
  id: number;
  username: string;
  displayName: string;
  role: 'OWNER' | 'EMPLOYEE';
  isActive: boolean;
  mustChangePassword: boolean;
  permissions: Permission[];
}

const COLUMNS = 'id, username, display_name, password_hash, role, is_active, must_change_password, failed_attempts, locked_until';

export function findUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM user WHERE username = ?`).get(username) as UserRow | undefined;
}

export function findUserById(db: Db, id: number): UserRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM user WHERE id = ?`).get(id) as UserRow | undefined;
}

export function countUsers(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM user').get() as { c: number }).c;
}

function permissionsFor(db: Db, row: UserRow): Permission[] {
  if (row.role === 'OWNER') return [...ALL_PERMISSIONS];
  const rows = db.prepare('SELECT permission FROM user_permission WHERE user_id = ? ORDER BY permission').all(row.id) as {
    permission: string;
  }[];
  return rows.map((r) => r.permission).filter(isPermission); // ignore unknown names written by a newer version
}

function toPrincipal(db: Db, row: UserRow): Principal {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active === 1,
    mustChangePassword: row.must_change_password === 1,
    permissions: permissionsFor(db, row),
  };
}

export function loadPrincipal(db: Db, userId: number): Principal | undefined {
  const row = findUserById(db, userId);
  return row ? toPrincipal(db, row) : undefined;
}

export function listPrincipals(db: Db): Principal[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM user ORDER BY role DESC, username`).all() as UserRow[];
  return rows.map((r) => toPrincipal(db, r));
}
