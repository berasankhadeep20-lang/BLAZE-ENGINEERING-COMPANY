import { join } from 'node:path';
import { fixedClock } from '../../src/shared/clock';
import { openDatabase, type Db } from '../../src/infrastructure/db/connection';
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrate';
import { UnitOfWork, type Actor } from '../../src/infrastructure/db/unitOfWork';

const MIGRATIONS = join(__dirname, '../../src/infrastructure/db/migrations');

export const owner: Actor = { userId: 1, role: 'OWNER' };

/** Fresh in-memory database, fully migrated, with one owner account (id 1) and fictional master data. */
export function testDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db, loadMigrations(MIGRATIONS));
  db.exec(`
    INSERT INTO user (id, username, display_name, password_hash, role, created_at) VALUES (1,'owner','Owner','x','OWNER','t');
    INSERT INTO customer (id, name, created_at) VALUES (1,'TEST CUSTOMER A','t'), (2,'TEST CUSTOMER B','t');
    INSERT INTO supplier (id, name, created_at) VALUES (1,'TEST SUPPLIER','t');
    INSERT INTO item (id, code, name, unit, created_at) VALUES (1,'I1','Test item 1','PCS','t'), (2,'I2','Test item 2','LTR','t');
  `);
  return db;
}

export function uowFor(db: Db, iso = '2026-11-07T10:00:00.000Z'): UnitOfWork {
  return new UnitOfWork(db, fixedClock(iso));
}
