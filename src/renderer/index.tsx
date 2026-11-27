import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { formatINR, formatQty } from '../domain/money';
import { displayDate } from '../shared/format';
import { call, can, errText, type User } from './api';
import { Items } from './items';
import { Parties } from './parties';
import { Purchases } from './purchases';
import { Reports } from './reports';
import { Sales } from './sales';
import { Settings } from './settings';
import { Err, Msg, useFields, useLoad } from './ui';

interface AppState { firstRun: boolean; mode: 'REAL' | 'DEMO'; version: string; user: User | null }

// ---- first run, sign in, forgotten password, change password
function Setup({ onDone }: { onDone: () => void }): ReactNode {
  const [f, set] = useFields({ displayName: '', username: '', password: '', again: '' });
  const [err, setErr] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (code) {
    return (
      <div className="center"><div className="card login">
        <h1>Save your recovery code</h1>
        <p className="muted">If you ever forget the owner password, this code is the ONLY way back in. It is shown once. Write it down or print it, and keep it somewhere safe, away from this computer.</p>
        <div className="code">{code}</div>
        <button onClick={() => void navigator.clipboard.writeText(code)}>Copy</button>
        <label style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved this code in a safe place</label>
        <button className="primary" style={{ marginTop: 14 }} disabled={!saved} onClick={onDone}>Continue to sign-in</button>
      </div></div>
    );
  }
  const submit = async (): Promise<void> => {
    setErr('');
    if (f.password !== f.again) return setErr('The two passwords are not the same.');
    try {
      setCode((await call<{ recoveryCode: string }>('auth.firstRunSetup', { username: f.username, displayName: f.displayName, password: f.password })).recoveryCode);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className="center"><div className="card login">
      <h1>Welcome to Blaze Billing</h1>
      <p className="muted">Create the owner account. You will use it to sign in and to manage everyone else.</p>
      <label>Your name</label><input value={f.displayName} onChange={set('displayName')} autoFocus />
      <label>Username</label><input value={f.username} onChange={set('username')} />
      <label>Password (at least 8 characters)</label><input type="password" value={f.password} onChange={set('password')} />
      <label>Password again</label><input type="password" value={f.again} onChange={set('again')} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      {err && <div className="err">{err}</div>}
      <button className="primary" style={{ marginTop: 16, width: '100%' }} onClick={() => void submit()}>Create owner account</button>
    </div></div>
  );
}

function Login({ onDone }: { onDone: () => void }): ReactNode {
  const [f, set] = useFields({ u: '', p: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [recover, setRecover] = useState(false);
  const go = async (): Promise<void> => {
    setErr('');
    setBusy(true);
    try {
      await call('auth.login', f.u, f.p);
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (recover) return <Recover onBack={() => setRecover(false)} />;
  return (
    <div className="center"><div className="card login">
      <h1>Blaze Billing</h1>
      <p className="muted">Sign in to continue.</p>
      <label>Username</label><input value={f.u} onChange={set('u')} autoFocus />
      <label>Password</label><input type="password" value={f.p} onChange={set('p')} onKeyDown={(e) => e.key === 'Enter' && void go()} />
      {err && <div className="err">{err}</div>}
      <button className="primary" style={{ marginTop: 16, width: '100%' }} disabled={busy || !f.u || !f.p} onClick={() => void go()}>Sign in</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
        <button className="link" onClick={() => setRecover(true)}>Forgot the owner password?</button>
        <button className="link" onClick={() => void call('demo.enter').then(onDone, (e: unknown) => setErr(errText(e)))}>Try the demo</button>
      </div>
    </div></div>
  );
}

function Recover({ onBack }: { onBack: () => void }): ReactNode {
  const [f, set] = useFields({ username: '', code: '', password: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async (): Promise<void> => {
    try {
      const r = await call<{ recoveryCode: string }>('auth.recoverOwnerPassword', f.username, f.code, f.password);
      setMsg({ ok: true, text: `Password changed. Your NEW recovery code is ${r.recoveryCode}. The old one no longer works: write the new one down now.` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };
  return (
    <div className="center"><div className="card login">
      <h1>Recover the owner account</h1>
      <label>Owner username</label><input value={f.username} onChange={set('username')} />
      <label>Recovery code</label><input value={f.code} onChange={set('code')} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" />
      <label>New password</label><input type="password" value={f.password} onChange={set('password')} />
      {msg && <div className={msg.ok ? 'ok' : 'err'}>{msg.text}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}><button className="primary" onClick={() => void go()}>Reset password</button><button onClick={onBack}>Back to sign-in</button></div>
    </div></div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }): ReactNode {
  const [f, set] = useFields({ current: '', next: '', again: '' });
  const [err, setErr] = useState('');
  const go = async (): Promise<void> => {
    if (f.next !== f.again) return setErr('The two new passwords are not the same.');
    try {
      await call('auth.changePassword', f.current, f.next);
      onDone();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className="center"><div className="card login">
      <h1>Choose your own password</h1>
      <p className="muted">You are using a temporary password. Please set a new one before you continue.</p>
      <label>Temporary password</label><input type="password" value={f.current} onChange={set('current')} />
      <label>New password</label><input type="password" value={f.next} onChange={set('next')} />
      <label>New password again</label><input type="password" value={f.again} onChange={set('again')} />
      {err && <div className="err">{err}</div>}
      <button className="primary" style={{ marginTop: 16, width: '100%' }} onClick={() => void go()}>Save new password</button>
    </div></div>
  );
}

// ---- screens
interface Dash {
  sales: { today: { bills: number; totalPaise: number }; monthToDate: { bills: number; totalPaise: number } } | null;
  dues: { totalOutstandingPaise: number; customersWithDues: number } | null;
  stock: { activeItems: number; outOfStock: number; lowStock: number; stockValueAtCostPaise: number | null } | null;
  lowStockItems: { id: number; code: string; name: string; qtyMilli: number; reorderQtyMilli: number }[] | null;
  recentBills: { id: number; billNo: string | null; invoiceDate: string; customerName: string; totalPaise: number; outstandingPaise: number | null; status: string }[] | null;
  openDrafts: number | null; pendingApprovals: number | null; goodsAwaited: number | null; owedToSuppliersPaise: number | null;
}
interface BackupStatus { folder: string | null; reminderDue: boolean; lastBackup: { at: string; path: string; daysAgo: number } | null; lastFailure: { reason: string } | null }

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }): ReactNode => (
  <div className="card stat"><div className="l">{label}</div><div className="n">{value}</div>{sub && <div className="muted">{sub}</div>}</div>
);

function Dashboard({ user, go }: { user: User; go: (page: string) => void }): ReactNode {
  const { data: d, error } = useLoad<Dash>('dashboard.get');
  const canBackup = can(user, 'backup.create', 'backup.restore');
  const { data: b } = useLoad<BackupStatus | null>(canBackup ? 'backup.status' : 'app.state');
  const backup = canBackup ? b : null;
  const cfg = useLoad<{ businessState: string | null; invoicePrefix: string | null }>(can(user, 'settings.edit') ? 'settings.get' : 'app.state');
  const needsSetup = can(user, 'settings.edit') && !!cfg.data && 'invoicePrefix' in cfg.data && (!cfg.data.businessState || !cfg.data.invoicePrefix);
  if (error) return <Err text={error} />;
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">Hello, {user.displayName}.</p>
      {needsSetup && <div className="warn"><span><b>First step:</b> enter your business details (state, invoice number prefix, address, GSTIN, bank details) in Settings. Bills cannot be issued until the state and prefix are set.</span><button className="primary" onClick={() => go('settings')}>Open Settings</button></div>}
      {backup?.reminderDue && (
        <div className="warn"><span>{backup.lastBackup ? `Your last backup was ${String(backup.lastBackup.daysAgo)} days ago.` : 'You have not made a backup yet.'} Back up now to keep your data safe.</span><button onClick={() => go('backup')}>Go to Backup</button></div>
      )}
      {backup?.lastFailure && <div className="err" style={{ marginBottom: 14 }}>The last backup attempt failed: {backup.lastFailure.reason}</div>}
      <div className="grid">
        {d.sales && <Stat label="Sales today" value={`Rs. ${formatINR(d.sales.today.totalPaise)}`} sub={`${String(d.sales.today.bills)} bill(s)`} />}
        {d.sales && <Stat label="Sales this month" value={`Rs. ${formatINR(d.sales.monthToDate.totalPaise)}`} sub={`${String(d.sales.monthToDate.bills)} bill(s)`} />}
        {d.dues && <Stat label="Customers owe you" value={`Rs. ${formatINR(d.dues.totalOutstandingPaise)}`} sub={`${String(d.dues.customersWithDues)} customer(s)`} />}
        {d.owedToSuppliersPaise !== null && <Stat label="You owe suppliers" value={`Rs. ${formatINR(d.owedToSuppliersPaise)}`} />}
        {d.stock && <Stat label="Items in stock list" value={String(d.stock.activeItems)} sub={`${String(d.stock.outOfStock)} sold out, ${String(d.stock.lowStock)} running low`} />}
        {d.stock?.stockValueAtCostPaise != null && <Stat label="Stock value (at cost)" value={`Rs. ${formatINR(d.stock.stockValueAtCostPaise)}`} />}
        {d.pendingApprovals ? <Stat label="Customers awaiting approval" value={String(d.pendingApprovals)} /> : null}
        {d.goodsAwaited ? <Stat label="Purchases with goods still to arrive" value={String(d.goodsAwaited)} /> : null}
        {d.openDrafts ? <Stat label="Unfinished draft bills" value={String(d.openDrafts)} /> : null}
      </div>
      <div className="cols">
        {d.recentBills && (
          <div><h2>Recent bills</h2>
            <table><thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th className="r">Total</th><th className="r">Due</th></tr></thead><tbody>
              {d.recentBills.map((r) => (<tr key={r.id}><td>{r.billNo}{r.status === 'CANCELLED' && <span className="chip bad" style={{ marginLeft: 6 }}>cancelled</span>}</td><td>{displayDate(r.invoiceDate)}</td><td>{r.customerName}</td><td className="r">{formatINR(r.totalPaise)}</td><td className="r">{r.outstandingPaise === null ? '' : formatINR(r.outstandingPaise)}</td></tr>))}
              {d.recentBills.length === 0 && <tr><td colSpan={5} className="muted">No bills yet.</td></tr>}
            </tbody></table></div>
        )}
        {d.lowStockItems && (
          <div><h2>Running low or sold out</h2>
            <table><thead><tr><th>Item</th><th className="r">In stock</th><th className="r">Reorder at</th></tr></thead><tbody>
              {d.lowStockItems.map((i) => (<tr key={i.id}><td>{i.code} - {i.name}</td><td className="r">{formatQty(i.qtyMilli)}</td><td className="r">{formatQty(i.reorderQtyMilli)}</td></tr>))}
              {d.lowStockItems.length === 0 && <tr><td colSpan={3} className="muted">Nothing is running low.</td></tr>}
            </tbody></table></div>
        )}
      </div>
    </>
  );
}

interface Hist { id: number; at: string; kind: string; path: string; verified: boolean; fileStillThere: boolean }
function Backup({ mode }: { mode: string }): ReactNode {
  const st = useLoad<BackupStatus | null>('backup.status');
  const hist = useLoad<Hist[]>('backup.history');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (choose: boolean): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const folder = choose ? await call<string | null>('backup.chooseFolder') : undefined;
      if (choose && !folder) return;
      const r = await call<{ path: string } | null>('backup.create', ...(folder ? [folder] : []));
      if (r) setMsg({ ok: true, text: `Backup saved and checked: ${r.path}` });
      st.reload();
      hist.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const s = st.data;
  return (<><h1>Backup</h1>
    <div className="card" style={{ maxWidth: 640 }}>
      <p>{s?.lastBackup ? <>Last backup: <b>{s.lastBackup.at.slice(0, 10)}</b> ({String(s.lastBackup.daysAgo)} day(s) ago)<br /><span className="muted">{s.lastBackup.path}</span></> : <b>No backup has been made yet.</b>}</p>
      <p className="muted">Folder: {s?.folder ?? 'not chosen yet'}</p>
      {mode === 'DEMO' && <div className="warn">You are in demo mode: backups here contain only sample data.</div>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="primary" disabled={busy} onClick={() => void run(!s?.folder)}>{busy ? 'Backing up…' : 'Back up now'}</button>
        <button disabled={busy} onClick={() => void run(true)}>Choose another folder…</button>
      </div>
      <Msg m={msg} /><Err text={st.error} />
      <p className="muted" style={{ marginTop: 16 }}>A backup is only reported as saved after the file has been written, read back and checked. Keep a copy on a USB drive away from the shop. Restoring from a backup is coming in the next update.</p>
    </div>
    {hist.data && hist.data.length > 0 && (<><h2 style={{ marginTop: 20 }}>Recent backups</h2><table style={{ maxWidth: 900 }}><thead><tr><th>When</th><th>Kind</th><th>File</th><th>Checked</th></tr></thead><tbody>
      {hist.data.map((h) => (<tr key={h.id}><td>{h.at.slice(0, 16).replace('T', ' ')}</td><td>{h.kind}</td><td>{h.path}{!h.fileStillThere && <span className="chip bad" style={{ marginLeft: 6 }}>file missing</span>}</td><td>{h.verified ? 'yes' : 'no'}</td></tr>))}</tbody></table></>)}
  </>);
}

// ---- frame
const PAGES: { id: string; label: string; show: (u: User) => boolean }[] = [
  { id: 'dashboard', label: 'Dashboard', show: () => true },
  { id: 'sales', label: 'Sale bills', show: (u) => can(u, 'sale.create', 'customer.view', 'report.view') },
  { id: 'purchases', label: 'Purchase bills', show: (u) => can(u, 'purchase.create', 'supplier.view', 'report.view') },
  { id: 'inventory', label: 'Inventory', show: (u) => can(u, 'inventory.view') },
  { id: 'customers', label: 'Customers and dues', show: (u) => can(u, 'customer.view') },
  { id: 'suppliers', label: 'Suppliers', show: (u) => can(u, 'supplier.view') },
  { id: 'reports', label: 'Reports', show: (u) => can(u, 'report.view') },
  { id: 'settings', label: 'Settings', show: (u) => can(u, 'settings.edit') },
  { id: 'backup', label: 'Backup', show: (u) => can(u, 'backup.create', 'backup.restore') },
];

function Shell({ state, refresh }: { state: AppState; refresh: () => void }): ReactNode {
  const user = state.user as User;
  const [page, setPage] = useState('dashboard');
  const leave = async (): Promise<void> => {
    await call(state.mode === 'DEMO' ? 'demo.exit' : 'auth.logout');
    refresh();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {state.mode === 'DEMO' && <div className="demo">DEMO MODE: sample data only. Nothing here is real, and your real records are untouched.</div>}
      <div className="app" style={{ flex: 1, minHeight: 0 }}>
        <nav className="side">
          <div className="brand">Blaze Billing</div>
          {PAGES.filter((p) => p.show(user)).map((p) => (<button key={p.id} className={`nav ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>{p.label}</button>))}
          <div className="soon">Coming next: user accounts and permissions, and restoring a backup.</div>
          <div className="who">{user.displayName}<br /><span style={{ opacity: 0.7 }}>{user.role === 'OWNER' ? 'Owner' : 'Employee'} · v{state.version}</span>
            <button onClick={() => void leave()}>{state.mode === 'DEMO' ? 'Leave demo' : 'Sign out'}</button></div>
        </nav>
        <main className="main">
          {page === 'dashboard' && <Dashboard user={user} go={setPage} />}
          {page === 'sales' && <Sales user={user} />}
          {page === 'purchases' && <Purchases user={user} />}
          {page === 'inventory' && <Items user={user} />}
          {page === 'customers' && <Parties kind="customer" user={user} />}
          {page === 'suppliers' && <Parties kind="supplier" user={user} />}
          {page === 'reports' && <Reports />}
          {page === 'settings' && <Settings />}
          {page === 'backup' && <Backup mode={state.mode} />}
        </main>
      </div>
    </div>
  );
}

function App(): ReactNode {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [afterSetup, setAfterSetup] = useState(false);
  const refresh = useCallback(() => {
    call<AppState>('app.state').then((s) => { setState(s); setAfterSetup(false); }, (e: unknown) => setError(errText(e)));
  }, []);
  useEffect(refresh, [refresh]);
  if (error) return <div className="center"><div className="err">{error}</div></div>;
  if (!state) return <div className="center muted">Starting…</div>;
  if (state.firstRun && !afterSetup) return <Setup onDone={() => { setAfterSetup(true); setState({ ...state, firstRun: false }); }} />;
  if (!state.user) return <Login onDone={refresh} />;
  if (state.user.mustChangePassword) return <ChangePassword onDone={refresh} />;
  return <Shell state={state} refresh={refresh} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
