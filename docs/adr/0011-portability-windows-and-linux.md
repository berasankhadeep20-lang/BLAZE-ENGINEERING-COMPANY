# ADR 0011: Behaving the same on Windows and Linux

**Status:** accepted (after the first Windows CI run failed while Linux passed)

## What went wrong, and the rules that came out of it
1. **Slow disks timed out a test.** The default 5-second test timeout was too tight for a Windows runner: building the demo business makes dozens of database commits, and with `synchronous=FULL` each one waits for the disk.
   - Tests and the disposable demo database now choose a faster durability level (`openDatabase(path, { synchronous })`); the **real program still uses FULL** so a saved bill survives a power cut.
   - The demo is built with `synchronous=OFF` and switched back to FULL when it is ready.
   - The global test and hook timeouts are 60 seconds.
2. **`process.env.TZ` is not portable.** Linux honours a time zone set at run time; Windows ignores it. Local-day logic (invoice dates, day boundaries in reports and stock filters, "today") therefore must not depend on it.
   - All local-time conversions go through `Intl` with an explicit zone (`src/shared/clock.ts`: `localDateString`, `toLocalDateTime`, `localDayRangeToUtc`, `localStamp`), and calendar arithmetic (`addDays`) uses no zone at all.
   - By default the zone is the computer's own, so the program behaves as before; tests pin it with `setShopTimeZone('Asia/Kolkata')`.
   - The whole suite passes with the computer set to UTC, Los Angeles, Auckland and India.
3. **Windows cannot delete a folder that holds an open database file.** Every database a test opens is now registered and closed before its scratch folder is removed (`trackDb`).
4. **Line endings.** A Windows checkout may turn LF into CRLF. Migration checksums are computed on LF-normalised text (so a database made from one checkout is accepted by the other), and `.gitattributes` keeps the repository on LF.

## Standing rule
A test must pass whatever the operating system, time zone and line-ending settings of the machine; anything machine-dependent is made explicit in the code or the test.
