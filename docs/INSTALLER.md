# Getting the Windows installer

You do not build anything on your own computer. GitHub builds the installer for you.

1. Put this project in your GitHub repository (extract the zip into the repository folder, then commit and push).
2. On GitHub open the repository, click **Actions**, choose **Build Windows installer** on the left, then **Run workflow**.
3. Wait about 5 to 10 minutes. When the run turns green, open it and scroll down to **Artifacts**.
4. Download **Blaze-Billing-Windows-Installer** (a zip), unzip it, and run **Blaze-Billing-Setup-0.1.0.exe**.
   (If you push a tag such as `v0.1.0`, the installer is also attached to a GitHub Release.)

## When Windows warns you
The installer is not code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**. (Signing needs a paid certificate.)

## After installing
- Start **Blaze Billing** from the desktop or Start menu. The first time, it asks you to create the owner account and shows a **recovery code once**: write it down.
- Your data lives in `%APPDATA%\Blaze Billing\data\`. Uninstalling the program does NOT delete it. Back up regularly from the Backup screen.
- Problems are written to `%APPDATA%\Blaze Billing\blaze.log`.

## What this first version contains
Sign-in and first-run setup, dashboard, inventory list, customers and dues list, sale bills list with Save-as-PDF (the A4 invoice), backup with verification, and a demo mode. The screens for CREATING bills, purchases and payments, reports, settings and restore are the next update; the code behind them is already built and tested.

## For developers
- `npm test` / `npm run check`: typecheck, lint and tests (run on Node).
- `npm run build`: bundles the program into `dist/`.
- `npm run dist:win`: what the workflow runs. It first swaps the database engine for its Electron build, so afterwards run `npm rebuild better-sqlite3` before running the tests again.
