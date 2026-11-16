# ADR 0010: Backup, restore and demo mode

**Status:** accepted (M9)

## The backup file (`.blazebak`)
One file holding the WHOLE database (users and roles, settings, items, customers, suppliers, bills and their lines, stock movements, payments, balances, the audit history, numbering, backup history), compressed, behind a small
manifest: format and program version, database (schema) version, row count per table, real or demo data, business name, who made it, and SHA-256 checksums of the payload and of the database.
A snapshot is taken with SQLite's `VACUUM INTO`, which is consistent even while the program is running. The file is written under a temporary name, flushed to disk, then renamed, so a half-written backup never looks real.

## "Back up now" never claims success it has not earned
After writing, the finished file is **read back from disk and verified**: container and checksums, then unpacked into a temporary database and checked with SQLite's own integrity check, foreign-key check, exact row counts per
table against the manifest, the schema version (a backup from a NEWER program is refused), and whether the books inside agree (stock and balances against their ledgers). Only then is it logged (`backup_log`, verified) and audited.
If anything fails the file is deleted, nothing is logged as a success, `BACKUP_FAILED` is audited, and the status shows the failure until a good backup replaces it. A compression bomb cannot inflate beyond what the manifest promises.
The folder is remembered (USB drive, network folder). A reminder is due when there is no backup or the last good one is as old as `backupReminderDays` (default 7, 0 = off). Backups are not encrypted: they contain password hashes and all business data (see "Advice" below).

## Restore replaces everything
Merging would mean reconciling two sets of financial records, which cannot be done safely, so restore REPLACES all data with the backup's. The workflow:
1. **Inspect** (`backup.restore`): verifies the file; shows what is in it against what is there now, what would be LOST (everything recorded since), warnings (damaged books, older program version, automatic safety copy), a plain-language explanation, and a **confirmation token** (this file only, 15 minutes, single use, and void if the file changes).
2. **Restore** with that token: re-verifies, saves a **verified safety copy of the current data first** (if that fails nothing happens), and **stages** the restore.
3. **At the next start** (before the database is opened) the live files are moved aside, never deleted (`replaced-by-restore/`), and the staged file is put in place. The program then records the restore in the restored data's audit trail and re-adds the safety copy to its backup history.
Why two halves: SQLite cannot safely swap its file under a running program. Staging writes the marker file last (the commit point); applying is idempotent. Crashes at every step were tested: the result is the old data or the new data, never a mixture.
A restore can be **undone**: the safety copy is itself a backup, restored the same way. After a restore everyone must sign in again, with the accounts and passwords as they were in the backup.
Real and demo data never cross: a demo backup is refused by real data and vice versa.

## Automatic safety copy before a database upgrade
`openAppDatabase` is the only way the program opens its database. Before applying any pending upgrade to an existing database it saves a verified safety copy (`<data folder>/backups/before-upgrade`, the newest 30 kept) and **refuses to upgrade if that fails**. It also creates the data folder on a first start.

## Older backups keep working
The "do the books agree" check (`reconcile`) now runs each check only where its tables exist, so a backup made by an older version verifies (and restores, then upgrades) instead of failing for lacking a newer table.

## Demo mode
A complete fictional business (9 items, 4 customers incl. one in Bihar for IGST, 2 suppliers, purchases with a partial receipt, 6 issued bills + 1 cancelled + 1 draft, part payments, low stock, a sold-out item, dead stock) in its OWN file, `<data folder>/demo/demo.sqlite`, marked inside (`app.mode = DEMO`). Dates are relative to today.
It is entered through a ready-made owner session (the demo owner's password is random and never shown; there are no real accounts to protect, and there are no hard-coded passwords). Demo invoices use the prefix `DM` and the title "DEMO - Tax Invoice cum Challan (sample data)"; demo backups are named `blaze-DEMO-backup-...`.
**Reset** deletes only a file proven to be demo data; it refuses a real database, any other file, or a path equal to the real database. Real data is never opened, read or written by demo mode (tested: the real data is byte-for-byte unchanged by a demo reset).

## Advice for the owner (to go in the user guide)
- Back up at least weekly, and keep copies in two places (for example a USB drive kept off the premises).
- A backup holds ALL business data and password hashes and is not encrypted: keep the drive safe and turn on BitLocker for it.
- Test a restore occasionally on a spare folder ("Check this backup" verifies without restoring).
- The file that was in use before a restore is kept in `replaced-by-restore`; delete it only when you are sure.

## Not in this milestone
Automatic scheduled backups (the program only reminds), backup encryption, and cloud copies. Backups run on the main thread, which is fine for a shop-sized database (seconds at most) but should move to a background thread if the database grows very large.
