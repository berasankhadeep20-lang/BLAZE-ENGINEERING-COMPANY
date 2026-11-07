import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection';

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3,}_.+\.sql$/.test(f))
    .sort();
  const out: MigrationFile[] = [];
  for (const file of files) {
    const m = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!m) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    out.push({
      version: Number(m[1]),
      name: m[2] ?? file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    if (cur && cur.version !== i + 1) {
      throw new MigrationError(`migration versions must be contiguous from 1; found ${String(cur.version)} at position ${String(i + 1)}`);
    }
  }
  return out;
}

export interface MigrateOptions {
  /** Called with the pending migrations before any is applied (e.g. to take a pre-migration backup). Throwing aborts. */
  beforeMigrate?: (pending: MigrationFile[]) => void;
  now?: () => string;
}

/**
 * Apply pending migrations. Each migration runs in its own transaction together with its bookkeeping row,
 * so a failing migration leaves the database exactly as it was.
 * Refuses to run if an already-applied migration file was modified, or if the database is newer than this app.
 */
export function migrate(db: Db, migrations: MigrationFile[], opts: MigrateOptions = {}): number[] {
  const now = opts.now ?? ((): string => new Date().toISOString());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string }[];
  const known = new Map(migrations.map((m) => [m.version, m]));

  for (const row of applied) {
    const file = known.get(row.version);
    if (!file) {
      throw new MigrationError(
        `database has migration ${String(row.version)} (${row.name}) that this version of the app does not know; the database is newer than the app`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(`migration ${String(row.version)} (${row.name}) was modified after it was applied`);
    }
  }

  const appliedVersions = new Set(applied.map((r) => r.version));
  const pending = migrations.filter((m) => !appliedVersions.has(m.version));
  if (pending.length === 0) return [];

  opts.beforeMigrate?.(pending);

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
  const done: number[] = [];
  for (const m of pending) {
    try {
      db.transaction(() => {
        db.exec(m.sql);
        insert.run(m.version, m.name, m.checksum, now());
      })();
    } catch (e) {
      throw new MigrationError(`migration ${String(m.version)} (${m.name}) failed and was rolled back: ${(e as Error).message}`);
    }
    done.push(m.version);
  }
  return done;
}
