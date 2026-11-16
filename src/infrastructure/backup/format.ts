/**
 * The .blazebak file: a small header, a JSON manifest, and the whole SQLite database compressed.
 *
 *   "BLAZEBAK1\n"  (10 bytes)  |  manifest length (4 bytes, big-endian)  |  manifest (JSON)  |  payload (gzip of the database file)
 *
 * The manifest says what is inside (format and app version, schema version, row counts per table, which business, demo or real data) and carries
 * SHA-256 checksums of the payload and of the database, so a damaged or tampered file is noticed before anything is trusted.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AppError } from '../../shared/errors';

export const MAGIC = Buffer.from('BLAZEBAK1\n', 'utf8');
export const FORMAT_NAME = 'blaze-engineering-backup';
export const FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 1_000_000;

export type BackupKind = 'MANUAL' | 'PRE_RESTORE' | 'PRE_MIGRATION';
export type DataMode = 'REAL' | 'DEMO';

export interface BackupManifest {
  format: typeof FORMAT_NAME;
  formatVersion: number;
  createdAt: string; // UTC ISO
  appVersion: string;
  schemaVersion: number; // highest migration applied to the data inside
  kind: BackupKind;
  mode: DataMode;
  businessName: string | null;
  createdBy: string | null;
  rowCounts: Record<string, number>;
  dbBytes: number;
  dbSha256: string;
  payloadBytes: number;
  payloadSha256: string;
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const invalid = (why: string): AppError => new AppError('BACKUP_INVALID', `this is not a usable backup file: ${why}`, { reason: why });

export function encodeBackup(m: Omit<BackupManifest, 'dbBytes' | 'dbSha256' | 'payloadBytes' | 'payloadSha256'>, dbBytes: Buffer): { file: Buffer; manifest: BackupManifest } {
  const payload = gzipSync(dbBytes, { level: 9 });
  const manifest: BackupManifest = { ...m, dbBytes: dbBytes.length, dbSha256: sha256(dbBytes), payloadBytes: payload.length, payloadSha256: sha256(payload) };
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return { file: Buffer.concat([MAGIC, len, json, payload]), manifest };
}

function parseManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== 'object') throw invalid('the description inside is damaged');
  const m = raw as Record<string, unknown>;
  const str = (k: string): boolean => typeof m[k] === 'string';
  const int = (k: string): boolean => typeof m[k] === 'number' && Number.isSafeInteger(m[k]) && (m[k] as number) >= 0;
  if (m.format !== FORMAT_NAME) throw invalid('it was not made by this program');
  if (m.formatVersion !== FORMAT_VERSION) throw invalid(`it uses backup format ${String(m.formatVersion)}, which this version does not understand`);
  if (!str('createdAt') || !str('appVersion') || !int('schemaVersion') || !int('dbBytes') || !int('payloadBytes') || !str('dbSha256') || !str('payloadSha256')) throw invalid('the description inside is incomplete');
  if (m.kind !== 'MANUAL' && m.kind !== 'PRE_RESTORE' && m.kind !== 'PRE_MIGRATION') throw invalid('unknown kind of backup');
  if (m.mode !== 'REAL' && m.mode !== 'DEMO') throw invalid('unknown kind of data');
  const rc = m.rowCounts;
  if (!rc || typeof rc !== 'object' || Object.values(rc as object).some((v) => typeof v !== 'number')) throw invalid('the table counts inside are damaged');
  return m as unknown as BackupManifest;
}

/** Read and check a backup file's container: header, manifest, and both checksums. Returns the manifest and the original database bytes. */
export function decodeBackup(file: Buffer): { manifest: BackupManifest; dbBytes: Buffer } {
  if (file.length < MAGIC.length + 4 || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid('it does not start like a backup file');
  const mlen = file.readUInt32BE(MAGIC.length);
  const mStart = MAGIC.length + 4;
  if (mlen === 0 || mlen > MAX_MANIFEST_BYTES || mStart + mlen > file.length) throw invalid('the description inside is damaged');
  let manifest: BackupManifest;
  try {
    manifest = parseManifest(JSON.parse(file.subarray(mStart, mStart + mlen).toString('utf8')));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw invalid('the description inside is damaged');
  }
  const payload = file.subarray(mStart + mlen);
  if (payload.length !== manifest.payloadBytes) throw invalid('the file is incomplete or has extra data (it may have been cut short while copying)');
  if (sha256(payload) !== manifest.payloadSha256) throw invalid('the file is damaged (its checksum does not match)');
  let dbBytes: Buffer;
  try {
    dbBytes = gunzipSync(payload, { maxOutputLength: manifest.dbBytes }); // never inflate beyond what the manifest promised
  } catch {
    throw invalid('the data inside could not be unpacked');
  }
  if (dbBytes.length !== manifest.dbBytes || sha256(dbBytes) !== manifest.dbSha256) throw invalid('the data inside is damaged (its checksum does not match)');
  return { manifest, dbBytes };
}
