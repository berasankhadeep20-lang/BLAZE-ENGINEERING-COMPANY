import { useState, type ReactNode } from 'react';
import { formatINR } from '../domain/money';
import { call, can, type User } from './api';
import { Err, Field, Modal, Msg, Search, StateSelect, toPaise, todayLocal, useAction, useFields, useLoad, when } from './ui';

type Kind = 'customer' | 'supplier';
interface Party { id: number; name: string; phone: string | null; email: string | null; address: string | null; state: string | null; gstin: string | null; gstinDisplay: string; notes: string | null; balancePaise: number; placeOfSupply?: string | null; approvalStatus?: string }
interface Statement { openingPaise: number; closingPaise: number; entries: { id: number; at: string; label: string; refNo: string | null; note: string | null; amountPaise: number; balanceAfterPaise: number }[] }

function PartyForm({ kind, party, user, onClose, onSaved }: { kind: Kind; party?: Party; user: User; onClose: () => void; onSaved: () => void }): ReactNode {
  const [f, set] = useFields({
    name: party?.name ?? '', phone: party?.phone ?? '', email: party?.email ?? '', address: party?.address ?? '', state: party?.state ?? '', gstin: party?.gstin ?? '',
    place: party?.placeOfSupply ?? '', notes: party?.notes ?? '', opening: '',
  });
  const [st, run, fail] = useAction();
  const save = (): void => {
    const common = { name: f.name, phone: f.phone, email: f.email, address: f.address, state: f.state, gstin: f.gstin, notes: f.notes };
    const extra = kind === 'customer' ? { placeOfSupply: f.place } : {};
    let opening: number | undefined;
    if (!party && f.opening.trim()) {
      const p = toPaise(f.opening);
      if (p === null || p < 0) return fail('Please type the opening balance as a number, for example 2500.');
      opening = p;
    }
    void run(async () => {
      const m = kind === 'customer' ? 'customers' : 'suppliers';
      if (party) await call(`${m}.update`, party.id, { ...common, ...extra });
      else await call(`${m}.create`, { ...common, ...extra, ...(opening ? { openingBalancePaise: opening } : {}) });
      onSaved();
    });
  };
  const label = kind === 'customer' ? 'customer' : 'supplier';
  return (
    <Modal title={party ? `Edit ${party.name}` : `Add a ${label}`} onClose={onClose}>
      <div className="form">
        <div className="full"><Field label="Name"><input value={f.name} onChange={set('name')} autoFocus /></Field></div>
        <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input value={f.email} onChange={set('email')} /></Field>
        <div className="full"><Field label="Address"><textarea value={f.address} onChange={set('address')} /></Field></div>
        <Field label="State" hint="Decides whether bills use CGST+SGST or IGST"><StateSelect value={f.state} onChange={set('state')} /></Field>
        <Field label="GSTIN" hint="Leave empty if not registered"><input value={f.gstin} onChange={set('gstin')} /></Field>
        {kind === 'customer' && <Field label="Place of supply (town)" hint="Printed on the bill; the state is used if empty"><input value={f.place} onChange={set('place')} /></Field>}
        {!party && user.role === 'OWNER' && <Field label={kind === 'customer' ? 'Amount they already owe you (Rs.)' : 'Amount you already owe them (Rs.)'} hint="From before you started using this program"><input value={f.opening} onChange={set('opening')} /></Field>}
        <div className="full"><Field label="Notes"><input value={f.notes} onChange={set('notes')} /></Field></div>
      </div>
      {kind === 'customer' && !party && user.role !== 'OWNER' && <p className="muted">New customers need the owner's approval before a bill can be issued to them.</p>}
      <Err text={st.error} />
      <div className="actions"><button className="primary" disabled={st.busy} onClick={save}>{party ? 'Save changes' : `Add ${label}`}</button><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function PartyDetail({ kind, id, user, onClose, onChanged }: { kind: Kind; id: number; user: User; onClose: () => void; onChanged: () => void }): ReactNode {
  const m = kind === 'customer' ? 'customers' : 'suppliers';
  const { data, error, reload } = useLoad<{ customer?: Party; supplier?: Party } & Statement>(`${m}.statement`, id);
  const settings = useLoad<{ paymentMethods: string[] }>('settings.get');
  const [f, set] = useFields({ amount: '', method: '', date: todayLocal(), reference: '', note: '' });
  const [st, run, fail] = useAction();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const party = data?.customer ?? data?.supplier;
  const canPay = kind === 'customer' ? can(user, 'payment.record') : can(user, 'supplier.pay');
  const pay = (): void => {
    const amount = toPaise(f.amount);
    if (amount === null || amount <= 0) return fail('Please type the amount as a number, for example 500.');
    void run(async () => {
      const method = f.method || settings.data?.paymentMethods[0] || 'Cash';
      const base = { amountPaise: amount, method, paidOn: f.date, reference: f.reference, note: f.note };
      if (kind === 'customer') await call('payments.record', { customerId: id, ...base });
      else await call('supplierPayments.record', { supplierId: id, ...base });
      setMsg({ ok: true, text: 'Payment recorded.' });
      set('amount')({ target: { value: '' } });
      reload();
      onChanged();
    });
  };
  return (
    <Modal wide title={party ? party.name : 'Loading…'} onClose={onClose}>
      <Err text={error} />
      {data && party && (<>
        <p>{kind === 'customer' ? 'Owes you' : 'You owe them'}: <b>Rs. {formatINR(data.closingPaise)}</b>{party.address && <span className="muted"> · {party.address}</span>}</p>
        {canPay && (
          <div className="card" style={{ marginBottom: 14 }}>
            <h2>{kind === 'customer' ? 'Record a payment received' : 'Record a payment made'}</h2>
            <div className="form" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <Field label="Amount (Rs.)"><input value={f.amount} onChange={set('amount')} /></Field>
              <Field label="How paid"><select value={f.method || settings.data?.paymentMethods[0] || ''} onChange={set('method')}>{settings.data?.paymentMethods.map((x) => (<option key={x}>{x}</option>))}</select></Field>
              <Field label="Date"><input type="date" value={f.date} onChange={set('date')} /></Field>
              <Field label="Reference (cheque / UPI no.)"><input value={f.reference} onChange={set('reference')} /></Field>
            </div>
            <div className="actions"><button className="primary" disabled={st.busy} onClick={pay}>Record payment</button></div>
            <Err text={st.error} /><Msg m={msg} />
          </div>
        )}
        <h2>Account statement</h2>
        <table className="tight"><thead><tr><th>When</th><th>Entry</th><th>Reference</th><th className="r">Debit</th><th className="r">Credit</th><th className="r">Balance</th></tr></thead><tbody>
          <tr><td /><td>Opening balance</td><td /><td /><td /><td className="r">{formatINR(data.openingPaise)}</td></tr>
          {data.entries.map((e) => (<tr key={e.id}><td>{when(e.at)}</td><td>{e.label}{e.note ? <span className="muted"> · {e.note}</span> : ''}</td><td>{e.refNo}</td><td className="r">{e.amountPaise > 0 ? formatINR(e.amountPaise) : ''}</td><td className="r">{e.amountPaise < 0 ? formatINR(-e.amountPaise) : ''}</td><td className="r">{formatINR(e.balanceAfterPaise)}</td></tr>))}
        </tbody></table>
      </>)}
    </Modal>
  );
}

export function Parties({ kind, user }: { kind: Kind; user: User }): ReactNode {
  const m = kind === 'customer' ? 'customers' : 'suppliers';
  const [q, setQ] = useState('');
  const [dues, setDues] = useState(false);
  const { data, error, reload } = useLoad<{ rows: Party[]; total: number }>(`${m}.list`, kind === 'customer' ? { search: q, hasDues: dues } : { search: q, owedOnly: dues });
  const [form, setForm] = useState<{ party?: Party } | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [st, run] = useAction();
  const canAdd = kind === 'customer' ? can(user, 'customer.create') : can(user, 'supplier.edit');
  const canEdit = kind === 'customer' ? can(user, 'customer.edit') : can(user, 'supplier.edit');
  return (
    <>
      <h1>{kind === 'customer' ? 'Customers and dues' : 'Suppliers'}</h1>
      <Search value={q} onChange={setQ}>
        <label style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={dues} onChange={(e) => setDues(e.target.checked)} />{kind === 'customer' ? 'Only customers who owe money' : 'Only suppliers I owe'}</label>
        {canAdd && <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setForm({})}>{kind === 'customer' ? 'Add customer' : 'Add supplier'}</button>}
      </Search>
      <Err text={error ?? st.error} />
      <table><thead><tr><th>Name</th><th>Phone</th><th>State</th><th>GSTIN</th><th className="r">{kind === 'customer' ? 'Owes you' : 'You owe'}</th><th /><th /></tr></thead><tbody>
        {data?.rows.map((p) => (
          <tr key={p.id}><td>{p.name}</td><td>{p.phone}</td><td>{p.state}</td><td>{p.gstinDisplay}</td><td className="r">{formatINR(p.balancePaise)}</td>
            <td>{p.approvalStatus === 'PENDING' ? <span className="chip low">awaiting approval</span> : ''}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button onClick={() => setDetail(p.id)}>Statement / payment</button>{' '}
              {canEdit && <button onClick={() => setForm({ party: p })}>Edit</button>}{' '}
              {p.approvalStatus === 'PENDING' && can(user, 'customer.approve') && (<>
                <button className="primary" onClick={() => void run(async () => { await call('customers.approve', p.id); reload(); })}>Approve</button>{' '}
                <button onClick={() => { const why = window.prompt('Why is this customer being rejected?'); if (why) void run(async () => { await call('customers.reject', p.id, why); reload(); }); }}>Reject</button>
              </>)}
            </td></tr>
        ))}
        {data && data.rows.length === 0 && <tr><td colSpan={7} className="muted">Nothing here yet.</td></tr>}
      </tbody></table>
      {form && <PartyForm kind={kind} user={user} {...(form.party ? { party: form.party } : {})} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {detail !== null && <PartyDetail kind={kind} id={detail} user={user} onClose={() => setDetail(null)} onChanged={reload} />}
    </>
  );
}
