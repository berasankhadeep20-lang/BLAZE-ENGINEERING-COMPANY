import { join } from 'node:path';
import { SessionStore } from '../../src/application/auth/sessionStore';
import { AuthService } from '../../src/application/auth/authService';
import { UserService } from '../../src/application/auth/userService';
import { openDatabase, type Db } from '../../src/infrastructure/db/connection';
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrate';
import type { PasswordHasher } from '../../src/infrastructure/security/passwordHasher';
import type { Clock } from '../../src/shared/clock';

/** Deterministic clock the test can move forward. */
export class TestClock implements Clock {
  private t: number;
  constructor(iso = '2026-11-07T10:00:00.000Z') {
    this.t = new Date(iso).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceMinutes(m: number): void {
    this.t += m * 60_000;
  }
}

/** Fast, NOT secure: only for tests that are not about hashing itself. */
export const fakeHasher: PasswordHasher = {
  hash: (pw) => Promise.resolve(`fake$${Buffer.from(pw).toString('base64')}`),
  verify: (h, pw) => Promise.resolve(h === `fake$${Buffer.from(pw).toString('base64')}`),
};

const MIGRATIONS = join(__dirname, '../../src/infrastructure/db/migrations');

export interface Harness {
  db: Db;
  clock: TestClock;
  sessions: SessionStore;
  auth: AuthService;
  users: UserService;
  ownerToken: string;
}

export const OWNER_PASSWORD = 'owner-pass-1';

/** Migrated empty database. */
export function emptyDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db, loadMigrations(MIGRATIONS));
  return db;
}

export function buildServices(opts: { idleTimeoutMs?: number } = {}): Omit<Harness, 'ownerToken'> {
  const db = emptyDb();
  const clock = new TestClock();
  const sessions = new SessionStore(clock, opts.idleTimeoutMs ?? 0);
  const auth = new AuthService({ db, hasher: fakeHasher, sessions, clock });
  const users = new UserService({ db, auth, hasher: fakeHasher, sessions, clock });
  return { db, clock, sessions, auth, users };
}

/** Services after first-run setup, with the owner signed in. */
export async function setupHarness(opts: { idleTimeoutMs?: number } = {}): Promise<Harness & { recoveryCode: string }> {
  const s = buildServices(opts);
  const { recoveryCode } = await s.auth.firstRunSetup({ username: 'owner', displayName: 'Shop Owner', password: OWNER_PASSWORD });
  const { token } = await s.auth.login('owner', OWNER_PASSWORD);
  return { ...s, ownerToken: token, recoveryCode };
}
