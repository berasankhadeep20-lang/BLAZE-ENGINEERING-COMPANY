import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { systemClock, type Clock } from '../../shared/clock';
import { AppError } from '../../shared/errors';
import { openDatabase, type Db } from '../db/connection';
import { loadMigrations, migrate } from '../db/migrate';
import { createSafetyBackup, type CreatedBackup } from './backupFile';
import { applyPendingRestore, finishPendingRestore } from './restoreStaging';

export interface OpenAppDatabaseOptions {
  dbPath: string;
  migrationsDir: string;
  dataDir: string; // the program's own folder: automatic safety copies go in <dataDir>/backups
  appVersion: string;
  clock?: Clock;
}

export interface OpenedAppDatabase {
  db: Db;
  restoreApplied: boolean;
  restoreDiscarded: string | null;
  restoreRecorded: boolean;
  migrated: number[];
  safetyBackup: CreatedBackup | null; // the copy taken just before a database upgrade, if one was needed
}

/**
 * The one way the program opens its database at start-up:
 *  1. finish a restore that was staged before the last shutdown (swap the files, keeping the old data aside);
 *  2. open it with the safe settings;
 *  3. if the database needs upgrading, FIRST take a verified safety copy (and refuse to upgrade if that fails), then upgrade;
 *  4. record in the database that a restore happened.
 */
export function openAppDatabase(o: OpenAppDatabaseOptions): OpenedAppDatabase {
  const clock = o.clock ?? systemClock;
  mkdirSync(dirname(o.dbPath), { recursive: true }); // the very first start has no data folder yet
  const restore = applyPendingRestore(o.dbPath, clock.now());
  const db = openDatabase(o.dbPath);
  try {
    const migrations = loadMigrations(o.migrationsDir);
    const known = migrations[migrations.length - 1]?.version ?? 0;
    let safety: CreatedBackup | null = null;
    const migrated = migrate(db, migrations, {
      beforeMigrate: () => {
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() && db.prepare('SELECT 1 FROM schema_migrations LIMIT 1').get();
        if (!has) return; // a brand-new database has nothing to protect
        try {
          safety = createSafetyBackup(db, { dir: join(o.dataDir, 'backups', 'before-upgrade'), kind: 'PRE_MIGRATION', appVersion: o.appVersion, createdBy: null, now: clock.now(), knownSchemaVersion: known });
        } catch (e) {
          // never upgrade the data without a verified copy of it: stop, and say why
          throw new AppError('BACKUP_FAILED', `the data was NOT upgraded because a safety copy of it could not be saved first: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
    const recorded = finishPendingRestore(db, o.dbPath, clock);
    return { db, restoreApplied: restore.applied, restoreDiscarded: restore.discarded ?? null, restoreRecorded: recorded, migrated, safetyBackup: safety };
  } catch (e) {
    db.close();
    throw e;
  }
}
