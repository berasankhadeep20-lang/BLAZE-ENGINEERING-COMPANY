import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServices } from '../application/composition';
import { openDemo, type DemoHandle } from '../application/demo/demoDatabase';
import { openAppDatabase } from '../infrastructure/backup/startup';
import { loadMigrations } from '../infrastructure/db/migrate';
import { argon2idHasher } from '../infrastructure/security/passwordHasher';
import { ApiHost, type HostHooks } from './apiHost';

let win: BrowserWindow | null = null;
let host: ApiHost;
let demo: DemoHandle | null = null;
let realDb: { close(): void } | null = null;

const logFile = (): string => join(app.getPath('userData'), 'blaze.log');
function log(message: string, error?: unknown): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(logFile(), `${new Date().toISOString()} ${message} ${error instanceof Error ? (error.stack ?? error.message) : error === undefined ? '' : String(error)}\n`, { flag: 'a' });
  } catch {
    /* logging must never break the program */
  }
}

// In the installed program the migrations are shipped next to the app (see "extraResources" in package.json); when run from the source they are in src/.
const migrationsDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'migrations') : join(__dirname, '..', '..', 'src', 'infrastructure', 'db', 'migrations'));
const dataDir = (): string => join(app.getPath('userData'), 'data');

async function pdfFromHtml(html: string): Promise<Buffer> {
  const hidden = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await hidden.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await hidden.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    hidden.destroy();
  }
}

/** Opens the normal Windows print dialog for an invoice (the same HTML as the PDF). */
async function printHtml(html: string): Promise<boolean> {
  const hidden = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await hidden.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await new Promise<boolean>((resolve) => hidden.webContents.print({ silent: false, printBackground: true, pageSize: 'A4', margins: { marginType: 'none' } }, (ok) => resolve(ok)));
  } finally {
    hidden.destroy();
  }
}

function makeHooks(): HostHooks {
  return {
    appVersion: app.getVersion(),
    log,
    async enterDemo() {
      demo ??= await openDemo({ migrationsDir: migrationsDir(), dataDir: dataDir(), realDbPath: join(dataDir(), 'blaze.sqlite') });
      return { services: demo.services, ownerToken: demo.ownerToken };
    },
    exitDemo() {
      demo?.db.close();
      demo = null;
    },
    async chooseFolder() {
      const options = { title: 'Choose where to save backups (for example a USB drive)', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
      const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async printInvoice(billId) {
      const s = host.activeServices();
      const token = host.sessionToken();
      const r = s.print.invoice(token, billId);
      const ok = await printHtml(r.html);
      if (ok) s.print.recordPrint(token, billId, 'PRINT', r.copies);
      return { printed: ok };
    },
    async saveInvoicePdf(billId) {
      const s = host.activeServices();
      const token = host.sessionToken();
      const r = s.print.invoice(token, billId);
      const options = { title: 'Save invoice as PDF', defaultPath: r.fileName, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
      const pick = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (pick.canceled || !pick.filePath) return { saved: false };
      writeFileSync(pick.filePath, await pdfFromHtml(r.html));
      s.print.recordPrint(token, billId, 'PDF', r.copies);
      return { saved: true, path: pick.filePath };
    },
  };
}

async function start(): Promise<void> {
  const dbPath = join(dataDir(), 'blaze.sqlite');
  const opened = openAppDatabase({ dbPath, migrationsDir: migrationsDir(), dataDir: dataDir(), appVersion: app.getVersion() });
  realDb = opened.db;
  const known = loadMigrations(migrationsDir()).length;
  const services = createServices({ db: opened.db, hasher: argon2idHasher, backup: { appVersion: app.getVersion(), knownSchemaVersion: known, paths: { dbPath, dataDir: dataDir() } } });
  host = new ApiHost(services, makeHooks());
  ipcMain.handle('api:invoke', (e, method: unknown, args: unknown) => {
    if (e.sender !== win?.webContents) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'not allowed' } };
    return host.invoke(String(method), Array.isArray(args) ? args : []);
  });

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1000, minHeight: 640, show: false, title: 'Blaze Billing', backgroundColor: '#f4f5f7',
    webPreferences: { preload: join(__dirname, '..', 'preload', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));
  await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit(); // two copies must never open the same database
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app
    .whenReady()
    .then(start)
    .catch((e: unknown) => {
      log('start-up failed', e);
      dialog.showErrorBox('Blaze Billing could not start', `${e instanceof Error ? e.message : String(e)}\n\nDetails were saved in ${logFile()}`);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    demo?.db.close();
    realDb?.close();
  });
}
