import { useState, type ReactNode } from 'react';
import { formatINR } from '../domain/money';
import { displayDate } from '../shared/format';
import { call } from './api';
import { Err, Field, formatQty, toMilli, useAction, useFields, useLoad } from './ui';

interface Table { title: string; subtitle: string[]; columns: { header: string; kind: string }[]; rows: (string | number | null)[][]; totalsRow: (string | number | null)[] | null }

const cell = (v: string | number | null, kind: string): string => {
  if (v === null || v === '') return '';
  if (typeof v === 'number') return kind === 'money' ? formatINR(v) : kind === 'qty' ? formatQty(v) : String(v);
  return kind === 'date' ? displayDate(v) || v : v;
};

export function Reports(): ReactNode {
  const [f, set] = useFields({ report: 'BEST_SELLERS', from: '', to: '', groupBy: 'day', customerId: '', maxSold: '0' });
  const customers = useLoad<{ rows: { id: number; name: string }[] }>('customers.list', { limit: 500 });
  const [table, setTable] = useState<Table | null>(null);
  const [st, run] = useAction();
  const go = (): void => {
    void run(async () => {
      const range = { ...(f.from ? { fromDate: f.from } : {}), ...(f.to ? { toDate: f.to } : {}) };
      let req: object = { report: f.report, ...range };
      if (f.report === 'SALES_AND_PURCHASES') req = { ...req, groupBy: f.groupBy };
      if (f.report === 'CUSTOMER_HISTORY') {
        if (!f.customerId) throw new Error('Choose a customer.');
        req = { ...req, customerId: Number(f.customerId) };
      }
      if (f.report === 'LOW_MOVEMENT') {
        const m = toMilli(f.maxSold || '0');
        if (m === null) throw new Error('Type the number of units as a number.');
        req = { ...req, maxSoldMilli: m };
      }
      setTable(await call<Table>('reports.table', req));
    });
  };
  return (
    <>
      <h1>Reports</h1>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="form" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <Field label="Report"><select value={f.report} onChange={set('report')}>
            <option value="BEST_SELLERS">Best-selling items</option><option value="SALES_AND_PURCHASES">Sales and purchases by day or month</option><option value="CUSTOMER_HISTORY">What a customer has bought</option>
            <option value="LOW_MOVEMENT">Items that are not selling</option><option value="PURCHASES_BY_SUPPLIER">Purchases by supplier</option></select></Field>
          <Field label="From (empty = from the start)"><input type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To (empty = until today)"><input type="date" value={f.to} onChange={set('to')} /></Field>
          {f.report === 'SALES_AND_PURCHASES' && <Field label="Group by"><select value={f.groupBy} onChange={set('groupBy')}><option value="day">Day</option><option value="month">Month</option><option value="total">Whole period</option></select></Field>}
          {f.report === 'CUSTOMER_HISTORY' && <Field label="Customer"><select value={f.customerId} onChange={set('customerId')}><option value="">Choose…</option>{customers.data?.rows.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}</select></Field>}
          {f.report === 'LOW_MOVEMENT' && <Field label="Sold at most (units)" hint="0 = nothing sold at all (default: last 90 days)"><input value={f.maxSold} onChange={set('maxSold')} /></Field>}
        </div>
        <div className="actions"><button className="primary" disabled={st.busy} onClick={go}>Show report</button></div>
        <Err text={st.error} />
      </div>
      {table && (<>
        <h2>{table.title}</h2>
        {table.subtitle.map((s) => (<div key={s} className="muted">{s}</div>))}
        <table style={{ marginTop: 10 }}><thead><tr>{table.columns.map((c) => (<th key={c.header} className={['money', 'qty', 'int'].includes(c.kind) ? 'r' : ''}>{c.header}</th>))}</tr></thead><tbody>
          {table.rows.map((r, i) => (<tr key={i}>{r.map((v, j) => (<td key={j} className={['money', 'qty', 'int'].includes(table.columns[j]?.kind ?? '') ? 'r' : ''}>{cell(v, table.columns[j]?.kind ?? 'text')}</td>))}</tr>))}
          {table.rows.length === 0 && <tr><td colSpan={table.columns.length} className="muted">Nothing to show for these choices.</td></tr>}
          {table.totalsRow && table.rows.length > 0 && <tr style={{ fontWeight: 700, background: '#f9fafb' }}>{table.totalsRow.map((v, j) => (<td key={j} className={['money', 'qty', 'int'].includes(table.columns[j]?.kind ?? '') ? 'r' : ''}>{cell(v, table.columns[j]?.kind ?? 'text')}</td>))}</tr>}
        </tbody></table>
      </>)}
    </>
  );
}
