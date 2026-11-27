import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatINR } from '../domain/money';
import { displayDate } from '../shared/format';
import { ApiError, call, can, errText, type User } from './api';
import { Err, Field, formatQty, ItemPicker, Modal, Msg, rs, Search, toMilli, toPaise, todayLocal, useAction, useFields, useLoad, type ItemRow } from './ui';

interface Settings { businessState: string | null; invoicePrefix: string | null; paymentMethods: string[] }
interface Quote { itemId: number; code: string; description: string; uomLabel: string; currentRatePaise: number; availableQtyMilli: number; lastRatePaise: number | null; lastSoldOn: string | null; canEditRate: boolean }
interface Line { key: number; itemId: number; label: string; qty: string; rate: string; discount: string; q: Quote }
interface Totals { goodsTaxablePaise: number; taxableTotalPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalTaxPaise: number; deliveryPaise: number; roundOffPaise: number; totalPaise: number; amountInWords: string }
interface Preview { taxType: string; lines: { totalPaise: number; belowCost: boolean; rateChanged: boolean; listRatePaise: number }[]; totals: Totals; belowCostLines: { lineNo: number; itemCode: string }[]; shortages: { itemCode: string; availableMilli: number; requestedMilli: number }[] }
interface CustomerRow { id: number; name: string; approvalStatus: string; balancePaise: number }
interface Bill {
  id: number; billNo: string | null; status: string; invoiceDate: string; orderNo: string | null; transportMode: string | null; vehicleNo: string | null; placeOfSupply: string | null; notes: string | null;
  customer: { id: number; name: string; address: string | null; gstinDisplay: string }; taxType: string;
  lines: { lineNo: number; itemId: number; description: string; hsn: string | null; qtyMilli: number; uomLabel: string; ratePaise: number; discountPaise: number; taxablePaise: number; gstRateBp: number; totalPaise: number; belowCost: boolean; listRatePaise: number; rateChanged: boolean }[];
  totals: Totals & { deliveryGstRateBp: number }; receivedAtSalePaise: number; paymentMethod: string | null; outstandingPaise: number | null; paymentStatus: string | null;
  payments: { receiptNo: string; paidOn: string; method: string; amountPaise: number; reversed: boolean }[]; cancelReason: string | null;
}

let lineKey = 1;
const bpOf = (pct: string): number | null => {
  const n = Number(pct);
  return pct.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
};

function TotalsBox({ t, taxType }: { t: Totals; taxType: string }): ReactNode {
  return (
    <>
      <div className="row"><span>Goods (before tax)</span><span>{formatINR(t.goodsTaxablePaise)}</span></div>
      {t.deliveryPaise > 0 && <div className="row"><span>Delivery charges</span><span>{formatINR(t.deliveryPaise)}</span></div>}
      {taxType === 'INTER' ? <div className="row"><span>IGST</span><span>{formatINR(t.igstPaise)}</span></div> : (<><div className="row"><span>CGST</span><span>{formatINR(t.cgstPaise)}</span></div><div className="row"><span>SGST</span><span>{formatINR(t.sgstPaise)}</span></div></>)}
      {t.roundOffPaise !== 0 && <div className="row"><span>Round off</span><span>{t.roundOffPaise > 0 ? '+' : '-'}{formatINR(Math.abs(t.roundOffPaise))}</span></div>}
      <div className="row big"><span>Total</span><span>Rs. {formatINR(t.totalPaise)}</span></div>
      <div className="muted" style={{ fontSize: 12 }}>{t.amountInWords}</div>
    </>
  );
}

export function SaleEditor({ user, draftId, onClose }: { user: User; draftId: number | null; onClose: () => void }): ReactNode {
  const settings = useLoad<Settings>('settings.get');
  const customers = useLoad<{ rows: CustomerRow[] }>('customers.list', { limit: 500 });
  const [id, setId] = useState<number | null>(draftId);
  const [f, set, setAll] = useFields({ customerId: '', date: todayLocal(), orderNo: '', transport: '', vehicle: '', place: '', notes: '', delAmt: '', delGst: '18', received: '', method: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [prevErr, setPrevErr] = useState('');
  const [st, run, fail] = useAction();
  const [ack, setAck] = useState<{ lineNo: number; itemCode: string }[] | null>(null);
  const [done, setDone] = useState<Bill | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!draftId) return;
    void (async () => {
      const b = await call<Bill>('sales.get', draftId);
      const loaded: Line[] = [];
      for (const l of b.lines) {
        const q = await call<Quote>('sales.quoteLine', { itemId: l.itemId, customerId: b.customer.id });
        loaded.push({ key: lineKey++, itemId: l.itemId, label: `${q.code} - ${q.description}`, qty: formatQty(l.qtyMilli), rate: rs(l.ratePaise), discount: l.discountPaise ? rs(l.discountPaise) : '', q });
      }
      setLines(loaded);
      setAll({ customerId: String(b.customer.id), date: b.invoiceDate, orderNo: b.orderNo ?? '', transport: b.transportMode ?? '', vehicle: b.vehicleNo ?? '', place: b.placeOfSupply ?? '', notes: b.notes ?? '' });
    })().catch((e: unknown) => fail(errText(e)));
  }, [draftId]);

  const addItem = (item: ItemRow): void => {
    void run(async () => {
      const q = await call<Quote>('sales.quoteLine', { itemId: item.id, ...(f.customerId ? { customerId: Number(f.customerId) } : {}) });
      setLines((cur) => [...cur, { key: lineKey++, itemId: item.id, label: `${q.code} - ${q.description}`, qty: '1', rate: rs(q.currentRatePaise), discount: '', q }]); // the item's CURRENT rate is shown first; the user may change it
    });
  };
  const patchLine = (key: number, p: Partial<Line>): void => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));

  /** Turns what is typed into what the program needs; `input` is null while something is missing or not a number. */
  const built = useMemo(() => {
    if (!f.customerId) return { input: null, why: 'Choose the customer.' };
    if (lines.length === 0) return { input: null, why: 'Add at least one item.' };
    const out = [];
    for (const l of lines) {
      const qty = toMilli(l.qty);
      const rate = toPaise(l.rate);
      const disc = l.discount.trim() ? toPaise(l.discount) : 0;
      if (qty === null || qty <= 0) return { input: null, why: `Type a quantity for ${l.label}.` };
      if (rate === null || rate < 0) return { input: null, why: `Type the rate for ${l.label}.` };
      if (disc === null || disc < 0) return { input: null, why: `The discount for ${l.label} is not a number.` };
      out.push({ itemId: l.itemId, qtyMilli: qty, ratePaise: rate, discountPaise: disc });
    }
    const delAmt = f.delAmt.trim() ? toPaise(f.delAmt) : 0;
    const delBp = bpOf(f.delGst);
    if (delAmt === null || delAmt < 0) return { input: null, why: 'The delivery charge is not a number.' };
    if (delAmt > 0 && delBp === null) return { input: null, why: 'The GST rate for delivery must be a percentage.' };
    const received = f.received.trim() ? toPaise(f.received) : 0;
    if (received === null || received < 0) return { input: null, why: 'The amount received is not a number.' };
    return {
      why: '',
      input: {
        customerId: Number(f.customerId), invoiceDate: f.date, orderNo: f.orderNo, transportMode: f.transport, vehicleNo: f.vehicle, placeOfSupply: f.place, notes: f.notes, lines: out,
        delivery: delAmt && delBp !== null ? { amountPaise: delAmt, gstRateBp: delBp } : null,
        ...(received ? { receivedPaise: received, paymentMethod: f.method || settings.data?.paymentMethods[0] || 'Cash' } : {}),
      },
    };
  }, [f, lines, settings.data]);

  useEffect(() => {
    setPrevErr('');
    if (!built.input) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      call<Preview>('sales.preview', built.input).then(setPreview, (e: unknown) => { setPreview(null); setPrevErr(errText(e)); });
    }, 350);
    return () => clearTimeout(t);
  }, [built]);

  const saveDraft = async (): Promise<number> => {
    if (!built.input) throw new Error(built.why);
    const bill = await call<Bill>('sales.saveDraft', { ...(id ? { id } : {}), ...built.input });
    setId(bill.id);
    return bill.id;
  };
  const issue = (acknowledge: boolean): void => {
    void run(async () => {
      const billId = await saveDraft();
      try {
        setDone(await call<Bill>('sales.confirm', billId, { acknowledgeBelowCost: acknowledge }));
        setAck(null);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'ACK_REQUIRED') {
          setAck((e.details as { lines: { lineNo: number; itemCode: string }[] }).lines);
          return;
        }
        throw e;
      }
    });
  };

  if (done) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <h1>Bill {done.billNo} issued</h1>
        <p>For <b>{done.customer.name}</b>. Total <b>Rs. {formatINR(done.totals.totalPaise)}</b>{done.outstandingPaise ? <> · still to pay <b>Rs. {formatINR(done.outstandingPaise)}</b></> : ' · fully paid'}.</p>
        <div className="actions">
          <button className="primary" onClick={() => void call('print.invoicePrint', done.id).then(() => setMsg({ ok: true, text: 'Sent to the printer dialog.' }), (e: unknown) => setMsg({ ok: false, text: errText(e) }))}>Print invoice</button>
          <button onClick={() => void call<{ saved: boolean; path?: string }>('print.invoicePdf', done.id).then((r) => setMsg(r.saved ? { ok: true, text: `Saved: ${r.path ?? ''}` } : null), (e: unknown) => setMsg({ ok: false, text: errText(e) }))}>Save as PDF</button>
          <button onClick={onClose}>Back to bills</button>
        </div>
        <Msg m={msg} />
      </div>
    );
  }
  const needsSetup = settings.data && (!settings.data.businessState || !settings.data.invoicePrefix);
  const customer = customers.data?.rows.find((c) => String(c.id) === f.customerId);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><button onClick={onClose}>Back</button><h1 style={{ margin: 0 }}>{id ? 'Edit draft bill' : 'New sale bill'}</h1></div>
      {needsSetup && <div className="warn" style={{ marginTop: 12 }}>Before you can issue bills, the owner must enter the business state and the invoice number prefix in Settings.</div>}
      <div className="editor" style={{ marginTop: 14 }}>
        <div>
          <div className="form" style={{ gridTemplateColumns: '2fr 1fr' }}>
            <Field label="Customer"><select value={f.customerId} onChange={set('customerId')}><option value="">Choose a customer…</option>{customers.data?.rows.map((c) => (<option key={c.id} value={c.id}>{c.name}{c.approvalStatus === 'PENDING' ? ' (awaiting approval)' : ''}</option>))}</select></Field>
            <Field label="Bill date"><input type="date" value={f.date} max={todayLocal()} onChange={set('date')} /></Field>
          </div>
          {customer?.approvalStatus === 'PENDING' && <div className="warn">This customer is waiting for the owner's approval. You can save the bill as a draft, but it cannot be issued until the owner approves.</div>}
          <table className="tight" style={{ marginTop: 12 }}><thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Rate (Rs. per piece)</th><th className="r">Discount (Rs.)</th><th className="r">Amount</th><th /></tr></thead><tbody>
            {lines.map((l, i) => {
              const pl = preview?.lines[i];
              return (
                <tr key={l.key} className={pl?.belowCost ? 'badrow' : ''}>
                  <td>{l.label}<div className="sub">{l.q.uomLabel} · in stock {formatQty(l.q.availableQtyMilli)} · standard rate Rs. {rs(l.q.currentRatePaise)}{l.q.lastRatePaise !== null && ` · last charged to this customer Rs. ${rs(l.q.lastRatePaise)}`}</div>{pl?.belowCost && <div className="sub" style={{ color: '#b42318' }}>Priced below what it cost you.</div>}</td>
                  <td className="num"><input value={l.qty} onChange={(e) => patchLine(l.key, { qty: e.target.value })} style={{ width: 80 }} /></td>
                  <td className="num"><input value={l.rate} disabled={!l.q.canEditRate} title={l.q.canEditRate ? '' : 'You are not allowed to change the rate'} onChange={(e) => patchLine(l.key, { rate: e.target.value })} /></td>
                  <td className="num"><input value={l.discount} disabled={!l.q.canEditRate} onChange={(e) => patchLine(l.key, { discount: e.target.value })} style={{ width: 90 }} /></td>
                  <td className="r">{pl ? formatINR(pl.totalPaise) : ''}</td>
                  <td><button onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>Remove</button></td>
                </tr>
              );
            })}
            {lines.length === 0 && <tr><td colSpan={6} className="muted">No items yet. Search below and click an item to add it.</td></tr>}
          </tbody></table>
          <div style={{ marginTop: 10 }}><ItemPicker onPick={addItem} /></div>
          <div className="form" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 8 }}>
            <Field label="Delivery charge (Rs.)"><input value={f.delAmt} onChange={set('delAmt')} /></Field>
            <Field label="Delivery GST (%)"><input value={f.delGst} onChange={set('delGst')} /></Field>
            <Field label="Received now (Rs.)"><input value={f.received} onChange={set('received')} /></Field>
            <Field label="Paid by"><select value={f.method || settings.data?.paymentMethods[0] || ''} onChange={set('method')}>{settings.data?.paymentMethods.map((m) => (<option key={m}>{m}</option>))}</select></Field>
          </div>
          <details style={{ marginTop: 8 }}><summary className="muted" style={{ cursor: 'pointer' }}>More details (order number, transport, notes)</summary>
            <div className="form" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <Field label="Order number"><input value={f.orderNo} onChange={set('orderNo')} /></Field>
              <Field label="Transport mode"><input value={f.transport} onChange={set('transport')} /></Field>
              <Field label="Vehicle number"><input value={f.vehicle} onChange={set('vehicle')} /></Field>
              <Field label="Place of supply" hint="Uses the customer's if empty"><input value={f.place} onChange={set('place')} /></Field>
              <div className="full" style={{ gridColumn: 'span 2' }}><Field label="Notes"><input value={f.notes} onChange={set('notes')} /></Field></div>
            </div></details>
        </div>
        <div className="card totals">
          <h2>Bill total</h2>
          {preview ? <TotalsBox t={preview.totals} taxType={preview.taxType} /> : <p className="muted">{built.why || prevErr || 'Working it out…'}</p>}
          {preview && prevErr === '' && preview.shortages.length > 0 && <div className="err">Not enough stock: {preview.shortages.map((s) => `${s.itemCode} (have ${formatQty(s.availableMilli)}, need ${formatQty(s.requestedMilli)})`).join('; ')}</div>}
          {!preview && prevErr && <div className="err">{prevErr}</div>}
          <Err text={st.error} />
          {ack && (
            <div className="warn" style={{ flexDirection: 'column', alignItems: 'stretch', marginTop: 12 }}>
              <b>Some lines are priced below what the goods cost you:</b>
              <span>{ack.map((a) => `line ${String(a.lineNo)} (${a.itemCode})`).join(', ')}</span>
              <div className="actions"><button className="primary" disabled={st.busy} onClick={() => issue(true)}>Issue anyway</button><button onClick={() => setAck(null)}>Go back and change the rate</button></div>
            </div>
          )}
          <div className="actions">
            <button className="primary" disabled={st.busy || !built.input || !can(user, 'sale.create')} onClick={() => issue(false)}>Issue bill</button>
            <button disabled={st.busy || !built.input} onClick={() => void run(async () => { await saveDraft(); setMsg({ ok: true, text: 'Draft saved.' }); })}>Save draft</button>
            {id && <button disabled={st.busy} onClick={() => { if (window.confirm('Delete this draft?')) void run(async () => { await call('sales.deleteDraft', id); onClose(); }); }}>Delete draft</button>}
          </div>
          <Msg m={msg} />
        </div>
      </div>
    </>
  );
}

function BillView({ id, user, onClose, onChanged, onEdit }: { id: number; user: User; onClose: () => void; onChanged: () => void; onEdit: (id: number) => void }): ReactNode {
  const { data: b, error, reload } = useLoad<Bill>('sales.get', id);
  const settings = useLoad<Settings>('settings.get');
  const [st, run] = useAction();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pay, setPay] = useState('');
  const [method, setMethod] = useState('');
  const refresh = (): void => { reload(); onChanged(); };
  return (
    <Modal wide title={b ? `${b.billNo ?? 'Draft'} · ${b.customer.name}` : 'Loading…'} onClose={onClose}>
      <Err text={error ?? st.error} />
      {b && (<>
        <p className="muted">{displayDate(b.invoiceDate)} · {b.customer.gstinDisplay}{b.status === 'CANCELLED' && <span className="chip bad" style={{ marginLeft: 8 }}>cancelled: {b.cancelReason}</span>}{b.status === 'DRAFT' && <span className="chip low" style={{ marginLeft: 8 }}>draft</span>}</p>
        <table className="tight"><thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Discount</th><th className="r">Taxable</th><th className="r">Total</th></tr></thead><tbody>
          {b.lines.map((l) => (<tr key={l.lineNo}><td>{l.description}<div className="sub">{l.uomLabel}{l.rateChanged ? ` · standard rate was ${formatINR(l.listRatePaise)}` : ''}{l.belowCost ? ' · sold below cost' : ''}</div></td><td className="r">{formatQty(l.qtyMilli)}</td><td className="r">{formatINR(l.ratePaise)}</td><td className="r">{formatINR(l.discountPaise)}</td><td className="r">{formatINR(l.taxablePaise)}</td><td className="r">{formatINR(l.totalPaise)}</td></tr>))}
        </tbody></table>
        <div className="card totals" style={{ maxWidth: 360, marginLeft: 'auto', marginTop: 12 }}><TotalsBox t={b.totals} taxType={b.taxType} /></div>
        {b.status === 'CONFIRMED' && (<>
          <p>Paid so far: <b>Rs. {formatINR(b.totals.totalPaise - (b.outstandingPaise ?? 0))}</b> · Still to pay: <b>Rs. {formatINR(b.outstandingPaise ?? 0)}</b></p>
          {b.payments.length > 0 && <table className="tight" style={{ maxWidth: 560 }}><tbody>{b.payments.map((p) => (<tr key={p.receiptNo}><td>{p.receiptNo}</td><td>{displayDate(p.paidOn)}</td><td>{p.method}</td><td className="r">{formatINR(p.amountPaise)}</td><td>{p.reversed ? <span className="chip bad">reversed</span> : ''}</td></tr>))}</tbody></table>}
          {(b.outstandingPaise ?? 0) > 0 && can(user, 'payment.record') && (
            <div className="actions" style={{ alignItems: 'flex-end' }}>
              <Field label="Payment received (Rs.)"><input value={pay} placeholder={rs(b.outstandingPaise ?? 0)} onChange={(e) => setPay(e.target.value)} /></Field>
              <Field label="Paid by"><select value={method || settings.data?.paymentMethods[0] || ''} onChange={(e) => setMethod(e.target.value)}>{settings.data?.paymentMethods.map((m) => (<option key={m}>{m}</option>))}</select></Field>
              <button className="primary" disabled={st.busy} onClick={() => void run(async () => {
                const amount = toPaise(pay || rs(b.outstandingPaise ?? 0));
                if (amount === null || amount <= 0) throw new Error('Please type the amount as a number.');
                await call('payments.record', { customerId: b.customer.id, amountPaise: amount, method: method || settings.data?.paymentMethods[0] || 'Cash', saleBillId: b.id });
                setPay('');
                refresh();
              })}>Record payment</button>
            </div>
          )}
        </>)}
        <div className="actions">
          {b.status === 'DRAFT' && <button className="primary" onClick={() => onEdit(b.id)}>Open draft</button>}
          {b.status !== 'DRAFT' && <button className="primary" onClick={() => void call('print.invoicePrint', b.id).catch((e: unknown) => setMsg({ ok: false, text: errText(e) }))}>Print invoice</button>}
          <button onClick={() => void call<{ saved: boolean; path?: string }>('print.invoicePdf', b.id).then((r) => setMsg(r.saved ? { ok: true, text: `Saved: ${r.path ?? ''}` } : null), (e: unknown) => setMsg({ ok: false, text: errText(e) }))}>Save as PDF</button>
          {b.status === 'CONFIRMED' && can(user, 'bill.cancel') && <button onClick={() => { const why = window.prompt('Why is this bill being cancelled? (required)'); if (why) void run(async () => { await call('sales.cancel', b.id, why); refresh(); }); }}>Cancel this bill</button>}
        </div>
        <Msg m={msg} />
        {b.status === 'CONFIRMED' && <p className="muted">An issued bill is never edited. To correct one, cancel it (any payments recorded against it must be reversed first) and issue a new bill.</p>}
      </>)}
    </Modal>
  );
}

export function Sales({ user }: { user: User }): ReactNode {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<{ edit: boolean; id: number | null }>({ edit: false, id: null });
  const [view, setView] = useState<number | null>(null);
  const { data, error, reload } = useLoad<{ rows: { id: number; billNo: string | null; status: string; invoiceDate: string; customerName: string; totalPaise: number; outstandingPaise: number | null }[] }>('sales.list', { search: q });
  if (mode.edit) return <SaleEditor user={user} draftId={mode.id} onClose={() => { setMode({ edit: false, id: null }); reload(); }} />;
  return (
    <>
      <h1>Sale bills</h1>
      <Search value={q} onChange={setQ}>{can(user, 'sale.create') && <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setMode({ edit: true, id: null })}>New bill</button>}</Search>
      <Err text={error} />
      <table><thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th className="r">Total</th><th className="r">Still to pay</th><th>Status</th><th /></tr></thead><tbody>
        {data?.rows.map((b) => (
          <tr key={b.id}><td>{b.billNo ?? 'DRAFT'}</td><td>{displayDate(b.invoiceDate)}</td><td>{b.customerName}</td><td className="r">{formatINR(b.totalPaise)}</td><td className="r">{b.outstandingPaise === null ? '' : formatINR(b.outstandingPaise)}</td>
            <td>{b.status === 'CANCELLED' ? <span className="chip bad">cancelled</span> : b.status === 'DRAFT' ? <span className="chip low">draft</span> : (b.outstandingPaise ?? 0) > 0 ? <span className="chip low">unpaid</span> : <span className="chip good">paid</span>}</td>
            <td><button onClick={() => setView(b.id)}>Open</button></td></tr>
        ))}
        {data && data.rows.length === 0 && <tr><td colSpan={7} className="muted">No bills yet. Click "New bill" to make your first one.</td></tr>}
      </tbody></table>
      {view !== null && <BillView id={view} user={user} onClose={() => setView(null)} onChanged={reload} onEdit={(id) => { setView(null); setMode({ edit: true, id }); }} />}
    </>
  );
}
