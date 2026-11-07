import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Open a SQLite database with the safety settings this app relies on:
 *  - foreign_keys=ON      : enforce references
 *  - journal_mode=WAL     : crash-safe, readers never block the writer
 *  - synchronous=FULL     : a committed transaction survives power loss
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Run `fn` inside one transaction: all writes commit together, or none do if `fn` throws. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}
