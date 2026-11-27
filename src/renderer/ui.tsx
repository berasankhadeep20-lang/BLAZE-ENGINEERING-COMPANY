import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { INDIAN_STATES } from '../domain/gstin';
import { formatPlainRupees, formatQty, parseQty, parseRupees } from '../domain/money';
import { call, errText } from './api';

export { formatQty };

export function useLoad<T>(method: string, ...args: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(args);
  const reload = useCallback(() => {
    setError(null);
    call<T>(method, ...(JSON.parse(key) as unknown[])).then(setData, (e: unknown) => setError(errText(e)));
  }, [method, key]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/** Runs a button's work: shows "busy" while it runs and keeps any error message. Returns whether it succeeded. */
export function useAction(): [{ busy: boolean; error: string | null }, (fn: () => Promise<void>) => Promise<boolean>, (e: string | null) => void] {
  const [st, setSt] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setSt({ busy: true, error: null });
    try {
      await fn();
      setSt({ busy: false, error: null });
      return true;
    } catch (e) {
      setSt({ busy: false, error: errText(e) });
      return false;
    }
  };
  return [st, run, (error) => setSt({ busy: false, error })];
}

export function useFields<T extends Record<string, string>>(init: T): [T, (k: keyof T) => (e: { target: { value: string } }) => void, (v: Partial<T>) => void] {
  const [f, setF] = useState(init);
  return [f, (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value })), (v) => setF((cur) => ({ ...cur, ...v }))];
}

export const Err = ({ text }: { text: string | null }): ReactNode => (text ? <div className="err">{text}</div> : null);
export const Msg = ({ m }: { m: { ok: boolean; text: string } | null }): ReactNode => (m ? <div className={m.ok ? 'ok' : 'err'}>{m.text}</div> : null);

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }): ReactNode {
  return (
    <div className="overlay"><div className={`modal ${wide ? 'wide' : ''}`}>
      <div className="mh"><h2>{title}</h2><button onClick={onClose}>Close</button></div>
      {children}
    </div></div>
  );
}

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode => (
  <div className="fld"><label>{label}</label>{children}{hint && <div className="hint">{hint}</div>}</div>
);

export const StateSelect = ({ value, onChange }: { value: string; onChange: (e: { target: { value: string } }) => void }): ReactNode => (
  <select value={value} onChange={onChange}><option value="">Choose state…</option>{INDIAN_STATES.map((s) => (<option key={s.code} value={s.name}>{s.name}</option>))}</select>
);

export const Search = ({ value, onChange, children }: { value: string; onChange: (v: string) => void; children?: ReactNode }): ReactNode => (
  <div className="bar"><input type="search" placeholder="Search…" value={value} onChange={(e) => onChange(e.target.value)} />{children}</div>
);

// ---- numbers typed by people: rupees ("925.50") and quantities ("2.5"); null when they are not valid
export const toPaise = (s: string): number | null => {
  try {
    return parseRupees(s);
  } catch {
    return null;
  }
};
export const toMilli = (s: string): number | null => {
  try {
    return parseQty(s);
  } catch {
    return null;
  }
};
export const rs = formatPlainRupees;
const pad = (n: number): string => String(n).padStart(2, '0');
export const todayLocal = (): string => {
  const d = new Date();
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });

export interface ItemRow {
  id: number; code: string; name: string; category: string | null; categoryId: number | null; hsn: string | null; unit: string; packSize: string | null; uomLabel: string;
  purchaseRatePaise: number; saleRatePaise: number; gstRateBp: number; qtyMilli: number; reorderQtyMilli: number; stockStatus: string; isActive: boolean;
}

/** A search box that lists matching items to click on. */
export function ItemPicker({ onPick }: { onPick: (item: ItemRow) => void }): ReactNode {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ItemRow[]>([]);
  useEffect(() => {
    if (!q.trim()) {
      setRows([]);
      return;
    }
    const t = setTimeout(() => {
      call<{ rows: ItemRow[] }>('items.list', { search: q, limit: 8 }).then((r) => setRows(r.rows), () => setRows([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="picker">
      <input placeholder="Type to find an item to add…" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows.length > 0 && (
        <div className="dd">{rows.map((r) => (
          <div key={r.id} onClick={() => { onPick(r); setQ(''); setRows([]); }}>{r.code} - {r.name} <span className="muted">({r.uomLabel}, in stock {formatQty(r.qtyMilli)})</span></div>
        ))}</div>
      )}
    </div>
  );
}
