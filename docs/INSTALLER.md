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

## What version 0.2.0 contains
- **Settings** (owner): business name, state, invoice prefix, GSTIN, address, phone, email, bank details, terms. Fill in the state and the prefix first: bills cannot be issued without them.
- **Inventory**: add and edit items (with the stock you have now), categories, correct stock after a count or damage, deactivate items.
- **Customers and suppliers**: add, edit, statements, record payments received or made; new customers added by an employee wait for the owner to approve them.
- **Sale bills**: choose the customer, add items (the item's current rate is shown first and can be changed for this bill), live totals, discounts, delivery charge, money received now, a warning if a bill is priced below cost, issue, print, save as PDF, record later payments, cancel with a reason.
- **Purchase bills**: the supplier's invoice, invoiced versus received quantities (stock only goes up by what arrived), add the rest later, pay the supplier, cancel.
- **Reports**: best sellers, sales and purchases by day or month, what a customer has bought, items that are not selling, purchases by supplier.
- Dashboard, backup with verification, demo mode, and sign-in as before.

Not in this version yet: managing user accounts and permissions (only the owner account exists for now), restoring a backup, and uploading a logo. The code behind them is built and tested; the screens are next.

## Updating from 0.1.0
Run the new installer over the old one. Your data stays (it lives in `%APPDATA%\Blaze Billing\data\`).

## For developers
- `npm test` / `npm run check`: typecheck, lint and tests (run on Node).
- `npm run build`: bundles the program into `dist/`.
- `npm run dist:win`: what the workflow runs. It first swaps the database engine for its Electron build, so afterwards run `npm rebuild better-sqlite3` before running the tests again.
