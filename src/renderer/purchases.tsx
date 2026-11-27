import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatINR } from '../domain/money';
import { displayDate } from '../shared/format';
import { call, can, errText, type User } from './api';
import { Err, Field, formatQty, ItemPicker, Modal, Msg, rs, Search, toMilli, toPaise, todayLocal, useAction, useFields, useLoad, type ItemRow } from './ui';

interface Settings { paymentMethods: string[] }
interface PQuote { itemId: number; code: string; description: string; uomLabel: string; currentRatePaise: number; stockQtyMilli: number; lastRatePaise: number | null }
interface PLine { key: number; itemId: number; label: string; inv: string; recv: string; touched: boolean; rate: string; discount: string; q: PQuote }
interface PTotals { goodsTaxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; deliveryPaise: number; roundOffPaise: number; totalPaise: number }
interface PPreview { taxType: string; lines: { totalPaise: number }[]; totals: PTotals }
interface PBill {
  id: number; billNo: string | null; status: string; billDate: string; supplierInvoiceNo: string; supplier: { id: number; name: string }; taxType: string; goodsPending: boolean;
  lines: { lineNo: number; description: string; uomLabel: string; invoicedQtyMilli: number; receivedQtyMilli: number; pendingQtyMilli: number; ratePaise: number; totalPaise: number }[];
  totals: PTotals; outstandingPaise: number | null; cancelReason: string | null;
}
let pKey = 1;
const bpOf = (pct: string): number | null => {
  const n = Number(pct);
  return pct.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
};

function PurchaseEditor({ user, onClose }: { user: User; onClose: () => void }): ReactNode {
  const settings = useLoad<Settings>('settings.get');
  const suppliers = useLoad<{ rows: { id: number; name: string }[] }>('suppliers.list', { limit: 500 });
  const [f, set] = useFields({ supplierId: '', invNo: '', invDate: todayLocal(), billDate: todayLocal(), delAmt: '', delGst: '18', paid: '', method: '', notes: '' });
  const [lines, setLines] = useState<PLine[]>([]);
  const [updateRates, setUpdateRates] = useState(false);
  const [preview, setPreview] = useState<PPreview | null>(null);
  const [prevErr, setPrevErr] = useState('');
  const [st, run] = useAction();
  const [done, setDone] = useState<PBill | null>(null);

  const addItem = (item: ItemRow): void => {
    void run(async () => {
      const q = await call<PQuote>('purchases.quoteLine', { itemId: item.id, ...(f.supplierId ? { supplierId: Number(f.supplierId) } : {}) });
      setLines((cur) => [...cur, { key: pKey++, itemId: item.id, label: `${q.code} - ${q.description}`, inv: '1', recv: '1', touched: false, rate: rs(q.currentRatePaise), discount: '', q }]);
    });
  };
  const patch = (key: number, p: Partial<PLine>): void => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const built = useMemo(() => {
    if (!f.supplierId) return { input: null, why: 'Choose the supplier.' };
    if (!f.invNo.trim()) return { input: null, why: "Type the supplier's invoice number." };
    if (lines.length === 0) return { input: null, why: 'Add at least one item.' };
    const out = [];
    for (const l of lines) {
      const inv = toMilli(l.inv);
      const recv = toMilli(l.recv);
      const rate = toPaise(l.rate);
      const disc = l.discount.trim() ? toPaise(l.discount) : 0;
      if (inv === null || inv <= 0) return { input: null, why: `Type the invoiced quantity for ${l.label}.` };
      if (recv === null || recv < 0 || recv > inv) return { input: null, why: `The quantity received for ${l.label} must be between 0 and the invoiced quantity.` };
      if (rate === null || rate < 0 || disc === null || disc < 0) return { input: null, why: `Check the rate and discount for ${l.label}.` };
      out.push({ itemId: l.itemId, invoicedQtyMilli: inv, receivedQtyMilli: recv, ratePaise: rate, discountPaise: disc });
    }
    const delAmt = f.delAmt.trim() ? toPaise(f.delAmt) : 0;
    const delBp = bpOf(f.delGst);
    if (delAmt === null || delAmt < 0 || (delAmt > 0 && delBp === null)) return { input: null, why: 'Check the delivery charge and its GST rate.' };
    const paid = f.paid.trim() ? toPaise(f.paid) : 0;
    if (paid === null || paid < 0) return { input: null, why: 'The amount paid is not a number.' };
    return {
      why: '',
      input: {
        supplierId: Number(f.supplierId), supplierInvoiceNo: f.invNo, supplierInvoiceDate: f.invDate, billDate: f.billDate, notes: f.notes, lines: out,
        delivery: delAmt && delBp !== null ? { amountPaise: delAmt, gstRateBp: delBp } : null,
        ...(paid ? { paidPaise: paid, paymentMethod: f.method || settings.data?.paymentMethods[0] || 'Cash' } : {}),
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
      call<PPreview>('purchases.preview', built.input).then(setPreview, (e: unknown) => { setPreview(null); setPrevErr(errText(e)); });
    }, 350);
    return () => clearTimeout(t);
  }, [built]);

  if (done) {
    return (
      <div className="card" style={{ maxWidth: 600 }}>
        <h1>Purchase {done.billNo} entered</h1>
        <p>From <b>{done.supplier.name}</b>, invoice {done.supplierInvoiceNo}. Total <b>Rs. {formatINR(done.totals.totalPaise)}</b>. Stock has been increased by what you received.{done.goodsPending && ' Some goods are still to arrive: use "Open" on the purchase list when they come.'}</p>
        <div className="actions"><button className="primary" onClick={onClose}>Back to purchases</button></div>
      </div>
    );
  }
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><button onClick={onClose}>Back</button><h1 style={{ margin: 0 }}>New purchase</h1></div>
      <div className="editor" style={{ marginTop: 14 }}>
        <div>
          <div className="form" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
            <Field label="Supplier"><select value={f.supplierId} onChange={set('supplierId')}><option value="">Choose a supplier…</option>{suppliers.data?.rows.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}</select></Field>
            <Field label="Supplier's invoice no."><input value={f.invNo} onChange={set('invNo')} /></Field>
            <Field label="Supplier's invoice date"><input type="date" value={f.invDate} max={todayLocal()} onChange={set('invDate')} /></Field>
            <Field label="Entered on"><input type="date" value={f.billDate} max={todayLocal()} onChange={set('billDate')} /></Field>
          </div>
          <table className="tight" style={{ marginTop: 12 }}><thead><tr><th>Item</th><th className="r">Invoiced</th><th className="r">Received</th><th className="r">Rate (Rs. per piece)</th><th className="r">Discount</th><th className="r">Amount</th><th /></tr></thead><tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td>{l.label}<div className="sub">{l.q.uomLabel} · in stock {formatQty(l.q.stockQtyMilli)} · your usual rate Rs. {rs(l.q.currentRatePaise)}{l.q.lastRatePaise !== null && ` · this supplier last charged Rs. ${rs(l.q.lastRatePaise)}`}</div></td>
                <td className="num"><input style={{ width: 80 }} value={l.inv} onChange={(e) => patch(l.key, { inv: e.target.value, ...(l.touched ? {} : { recv: e.target.value }) })} /></td>
                <td className="num"><input style={{ width: 80 }} value={l.recv} onChange={(e) => patch(l.key, { recv: e.target.value, touched: true })} /></td>
                <td className="num"><input value={l.rate} onChange={(e) => patch(l.key, { rate: e.target.value })} /></td>
                <td className="num"><input style={{ width: 90 }} value={l.discount} onChange={(e) => patch(l.key, { discount: e.target.value })} /></td>
                <td className="r">{preview?.lines[i] ? formatINR(preview.lines[i].totalPaise) : ''}</td>
                <td><button onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>Remove</button></td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={7} className="muted">No items yet. Search below and click an item to add it.</td></tr>}
          </tbody></table>
          <p className="muted" style={{ marginTop: 6 }}>You are billed for the quantity on the supplier's invoice, but stock only goes up by the quantity you actually received. Goods that arrive later are added from the purchase list.</p>
          <div style={{ marginTop: 6 }}><ItemPicker onPick={addItem} /></div>
          <div className="form" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 8 }}>
            <Field label="Delivery charge (Rs.)"><input value={f.delAmt} onChange={set('delAmt')} /></Field>
            <Field label="Delivery GST (%)"><input value={f.delGst} onChange={set('delGst')} /></Field>
            <Field label="Paid now (Rs.)"><input value={f.paid} onChange={set('paid')} /></Field>
            <Field label="Paid by"><select value={f.method || settings.data?.paymentMethods[0] || ''} onChange={set('method')}>{settings.data?.paymentMethods.map((m) => (<option key={m}>{m}</option>))}</select></Field>
          </div>
          {can(user, 'price.edit') && <label style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={updateRates} onChange={(e) => setUpdateRates(e.target.checked)} />Also update each item's purchase rate to the rate on this bill</label>}
        </div>
        <div className="card totals">
          <h2>Bill total</h2>
          {preview ? (<>
            <div className="row"><span>Goods (before tax)</span><span>{formatINR(preview.totals.goodsTaxablePaise)}</span></div>
            {preview.totals.deliveryPaise > 0 && <div className="row"><span>Delivery</span><span>{formatINR(preview.totals.deliveryPaise)}</span></div>}
            {preview.taxType === 'INTER' ? <div className="row"><span>IGST</span><span>{formatINR(preview.totals.igstPaise)}</span></div> : (<><div className="row"><span>CGST</span><span>{formatINR(preview.totals.cgstPaise)}</span></div><div className="row"><span>SGST</span><span>{formatINR(preview.totals.sgstPaise)}</span></div></>)}
            <div className="row big"><span>Total</span><span>Rs. {formatINR(preview.totals.totalPaise)}</span></div>
          </>) : <p className="muted">{built.why || prevErr || 'Working it out…'}</p>}
          {!preview && prevErr && <div className="err">{prevErr}</div>}
          <Err text={st.error} />
          <div className="actions">
            <button className="primary" disabled={st.busy || !built.input} onClick={() => void run(async () => {
              if (!built.input) return;
              const saved = await call<PBill>('purchases.saveDraft', built.input);
              setDone(await call<PBill>('purchases.confirm', saved.id, { updateItemPurchaseRates: updateRates }));
            })}>Enter purchase</button>
          </div>
        </div>
      </div>
    </>
  );
}

function PurchaseView({ id, user, onClose, onChanged }: { id: number; user: User; onClose: () => void; onChanged: () => void }): ReactNode {
  const { data: b, error, reload } = useLoad<PBill>('purchases.get', id);
  const settings = useLoad<Settings>('settings.get');
  const [st, run] = useAction();
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [pay, setPay] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = (): void => { reload(); onChanged(); };
  return (
    <Modal wide title={b ? `${b.billNo ?? 'Draft'} · ${b.supplier.name} · invoice ${b.supplierInvoiceNo}` : 'Loading…'} onClose={onClose}>
      <Err text={error ?? st.error} /><Msg m={msg} />
      {b && (<>
        <p className="muted">{displayDate(b.billDate)}{b.status === 'CANCELLED' && <span className="chip bad" style={{ marginLeft: 8 }}>cancelled: {b.cancelReason}</span>}</p>
        <table className="tight"><thead><tr><th>Item</th><th className="r">Invoiced</th><th className="r">Received</th><th className="r">Still to arrive</th><th className="r">Rate</th><th className="r">Total</th><th /></tr></thead><tbody>
          {b.lines.map((l) => (<tr key={l.lineNo}><td>{l.description}<div className="sub">{l.uomLabel}</div></td><td className="r">{formatQty(l.invoicedQtyMilli)}</td><td className="r">{formatQty(l.receivedQtyMilli)}</td><td className="r">{formatQty(l.pendingQtyMilli)}</td><td className="r">{formatINR(l.ratePaise)}</td><td className="r">{formatINR(l.totalPaise)}</td>
            <td className="num">{b.status === 'CONFIRMED' && l.pendingQtyMilli > 0 && can(user, 'purchase.create') && <input style={{ width: 90 }} placeholder={formatQty(l.pendingQtyMilli)} value={recv[l.lineNo] ?? ''} onChange={(e) => setRecv({ ...recv, [l.lineNo]: e.target.value })} />}</td></tr>))}
        </tbody></table>
        <p>Total <b>Rs. {formatINR(b.totals.totalPaise)}</b>{b.outstandingPaise !== null && <> · still to pay <b>Rs. {formatINR(b.outstandingPaise)}</b></>}</p>
        <div className="actions" style={{ alignItems: 'flex-end' }}>
          {b.status === 'CONFIRMED' && b.goodsPending && can(user, 'purchase.create') && (
            <button className="primary" disabled={st.busy} onClick={() => void run(async () => {
              const rows = b.lines.filter((l) => l.pendingQtyMilli > 0).flatMap((l) => {
                const typed = recv[l.lineNo];
                const q = typed === undefined || typed.trim() === '' ? l.pendingQtyMilli : toMilli(typed);
                if (q === null) throw new Error('Please type the quantities as numbers.');
                return q > 0 ? [{ lineNo: l.lineNo, qtyMilli: q }] : [];
              });
              await call('purchases.receive', b.id, { lines: rows });
              setRecv({});
              setMsg({ ok: true, text: 'Goods received and added to stock.' });
              refresh();
            })}>Goods arrived: add to stock</button>
          )}
          {b.status === 'CONFIRMED' && (b.outstandingPaise ?? 0) > 0 && can(user, 'supplier.pay') && (<>
            <Field label="Pay supplier (Rs.)"><input value={pay} placeholder={rs(b.outstandingPaise ?? 0)} onChange={(e) => setPay(e.target.value)} /></Field>
            <button disabled={st.busy} onClick={() => void run(async () => {
              const amount = toPaise(pay || rs(b.outstandingPaise ?? 0));
              if (amount === null || amount <= 0) throw new Error('Please type the amount as a number.');
              await call('supplierPayments.record', { supplierId: b.supplier.id, amountPaise: amount, method: settings.data?.paymentMethods[0] ?? 'Cash', purchaseBillId: b.id });
              setPay('');
              setMsg({ ok: true, text: 'Payment recorded.' });
              refresh();
            })}>Record payment</button>
          </>)}
          {b.status === 'CONFIRMED' && can(user, 'bill.cancel') && <button onClick={() => { const why = window.prompt('Why is this purchase being cancelled? (required)'); if (why) void run(async () => { await call('purchases.cancel', b.id, why); refresh(); }); }}>Cancel this purchase</button>}
        </div>
      </>)}
    </Modal>
  );
}

export function Purchases({ user }: { user: User }): ReactNode {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const { data, error, reload } = useLoad<{ rows: { id: number; billNo: string | null; status: string; billDate: string; supplierName: string; supplierInvoiceNo: string; totalPaise: number; outstandingPaise: number | null; goodsPending: boolean }[] }>('purchases.list', { search: q });
  if (editing) return <PurchaseEditor user={user} onClose={() => { setEditing(false); reload(); }} />;
  return (
    <>
      <h1>Purchase bills</h1>
      <Search value={q} onChange={setQ}>{can(user, 'purchase.create') && <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>New purchase</button>}</Search>
      <Err text={error} />
      <table><thead><tr><th>Our no.</th><th>Date</th><th>Supplier</th><th>Their invoice</th><th className="r">Total</th><th className="r">Still to pay</th><th>Status</th><th /></tr></thead><tbody>
        {data?.rows.map((b) => (
          <tr key={b.id}><td>{b.billNo ?? 'DRAFT'}</td><td>{displayDate(b.billDate)}</td><td>{b.supplierName}</td><td>{b.supplierInvoiceNo}</td><td className="r">{formatINR(b.totalPaise)}</td><td className="r">{b.outstandingPaise === null ? '' : formatINR(b.outstandingPaise)}</td>
            <td>{b.status === 'CANCELLED' ? <span className="chip bad">cancelled</span> : b.status === 'DRAFT' ? <span className="chip low">draft</span> : b.goodsPending ? <span className="chip low">goods awaited</span> : ''}</td>
            <td><button onClick={() => setView(b.id)}>Open</button></td></tr>
        ))}
        {data && data.rows.length === 0 && <tr><td colSpan={8} className="muted">No purchases yet.</td></tr>}
      </tbody></table>
      {view !== null && <PurchaseView id={view} user={user} onClose={() => setView(null)} onChanged={reload} />}
    </>
  );
}
