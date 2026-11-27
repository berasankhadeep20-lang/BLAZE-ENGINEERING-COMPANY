import { useState, type ReactNode } from 'react';
import { COMMON_UNITS } from '../domain/inventory';
import { formatINR } from '../domain/money';
import { call, can, type User } from './api';
import { Err, Field, formatQty, Modal, rs, Search, toMilli, toPaise, useAction, useFields, useLoad, type ItemRow } from './ui';

const bp = (pct: string): number | null => {
  const n = Number(pct);
  return pct.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
};

function ItemForm({ item, onClose, onSaved }: { item?: ItemRow; onClose: () => void; onSaved: () => void }): ReactNode {
  const cats = useLoad<{ id: number; name: string }[]>('items.categories');
  const [f, set] = useFields({
    code: item?.code ?? '', name: item?.name ?? '', hsn: item?.hsn ?? '', categoryId: item?.categoryId ? String(item.categoryId) : '', newCategory: '', unit: item?.unit ?? 'PCS',
    packSize: item?.packSize ?? '', purchase: item ? rs(item.purchaseRatePaise) : '', sale: item ? rs(item.saleRatePaise) : '', gst: item ? String(item.gstRateBp / 100) : '18',
    reorder: item ? formatQty(item.reorderQtyMilli) : '0', opening: '',
  });
  const [st, run, fail] = useAction();
  const save = (): void => {
    const purchase = toPaise(f.purchase || '0');
    const sale = toPaise(f.sale || '0');
    const gst = bp(f.gst);
    const reorder = toMilli(f.reorder || '0');
    const opening = toMilli(f.opening || '0');
    if (purchase === null || sale === null) return fail('Please type the rates as numbers, for example 925 or 92.50.');
    if (gst === null) return fail('Please type the GST rate as a percentage between 0 and 100.');
    if (reorder === null || opening === null) return fail('Please type the quantities as numbers.');
    void run(async () => {
      let categoryId = f.categoryId ? Number(f.categoryId) : undefined;
      if (f.newCategory.trim()) categoryId = (await call<number>('items.createCategory', f.newCategory.trim()));
      const common = { code: f.code, name: f.name, hsn: f.hsn, unit: f.unit, packSize: f.packSize, purchaseRatePaise: purchase, saleRatePaise: sale, gstRateBp: gst, reorderQtyMilli: reorder };
      if (item) await call('items.update', item.id, { ...common, categoryId: categoryId ?? null });
      else await call('items.create', { ...common, ...(categoryId ? { categoryId } : {}), openingQtyMilli: opening });
      onSaved();
    });
  };
  return (
    <Modal title={item ? `Edit ${item.code}` : 'Add an item'} onClose={onClose}>
      <div className="form">
        <Field label="Item code" hint="Short and unique, for example MC-40"><input value={f.code} onChange={set('code')} autoFocus /></Field>
        <Field label="Item name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="HSN code" hint="Check it with your accountant"><input value={f.hsn} onChange={set('hsn')} /></Field>
        <Field label="Category"><select value={f.categoryId} onChange={set('categoryId')}><option value="">(none)</option>{cats.data?.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}</select></Field>
        <Field label="Or add a new category"><input value={f.newCategory} onChange={set('newCategory')} /></Field>
        <Field label="Unit"><select value={f.unit} onChange={set('unit')}>{COMMON_UNITS.map((u) => (<option key={u}>{u}</option>))}</select></Field>
        <Field label="Pack size (optional)" hint="For example 40 for a 40 LTR can"><input value={f.packSize} onChange={set('packSize')} /></Field>
        <Field label="GST rate (%)"><input value={f.gst} onChange={set('gst')} /></Field>
        <Field label="Purchase rate (Rs. per piece)"><input value={f.purchase} onChange={set('purchase')} /></Field>
        <Field label="Sale rate (Rs. per piece)"><input value={f.sale} onChange={set('sale')} /></Field>
        <Field label="Reorder level" hint="You are warned when stock falls to this"><input value={f.reorder} onChange={set('reorder')} /></Field>
        {!item && <Field label="Stock you have now"><input value={f.opening} onChange={set('opening')} placeholder="0" /></Field>}
      </div>
      <Err text={st.error} />
      <div className="actions"><button className="primary" disabled={st.busy} onClick={save}>{item ? 'Save changes' : 'Add item'}</button><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function StockForm({ item, onClose, onSaved }: { item: ItemRow; onClose: () => void; onSaved: () => void }): ReactNode {
  const [f, set] = useFields({ kind: 'COUNT', qty: '', note: '' });
  const [st, run, fail] = useAction();
  const save = (): void => {
    const q = toMilli(f.qty);
    if (q === null) return fail('Please type the quantity as a number.');
    void run(async () => {
      if (f.kind === 'COUNT') await call('stock.recordCount', { itemId: item.id, countedQtyMilli: q, note: f.note });
      else await call('stock.recordLoss', { itemId: item.id, kind: f.kind, qtyMilli: q, note: f.note });
      onSaved();
    });
  };
  return (
    <Modal title={`Correct stock: ${item.code} - ${item.name}`} onClose={onClose}>
      <p className="muted">The program shows {formatQty(item.qtyMilli)} in stock. Every correction is recorded with your name and reason.</p>
      <Field label="What happened?"><select value={f.kind} onChange={set('kind')}><option value="COUNT">I counted the shelf (set the stock to my count)</option><option value="DAMAGED">Some stock was damaged</option><option value="MISSING">Some stock is missing</option></select></Field>
      <Field label={f.kind === 'COUNT' ? 'Quantity counted' : 'Quantity lost'}><input value={f.qty} onChange={set('qty')} autoFocus /></Field>
      <Field label="Reason (required)"><input value={f.note} onChange={set('note')} /></Field>
      <Err text={st.error} />
      <div className="actions"><button className="primary" disabled={st.busy} onClick={save}>Record correction</button><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

export function Items({ user }: { user: User }): ReactNode {
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const { data, error, reload } = useLoad<{ rows: ItemRow[]; total: number }>('items.list', { search: q, status: inactive ? 'ALL' : 'ACTIVE' });
  const [form, setForm] = useState<{ item?: ItemRow } | null>(null);
  const [stock, setStock] = useState<ItemRow | null>(null);
  const [st, run] = useAction();
  const canAdd = can(user, 'item.create') && can(user, 'price.edit');
  return (
    <>
      <h1>Inventory</h1>
      <Search value={q} onChange={setQ}>
        <label style={{ margin: 0, fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={inactive} onChange={(e) => setInactive(e.target.checked)} />Show inactive items</label>
        <span className="muted">{data ? `${String(data.total)} item(s)` : ''}</span>
        {canAdd && <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setForm({})}>Add item</button>}
      </Search>
      <Err text={error ?? st.error} />
      <table><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Unit</th><th className="r">In stock</th><th className="r">Reorder at</th><th className="r">Sale rate</th><th>Status</th><th /></tr></thead><tbody>
        {data?.rows.map((i) => (
          <tr key={i.id}><td>{i.code}</td><td>{i.name}</td><td>{i.category}</td><td>{i.uomLabel}</td><td className="r">{formatQty(i.qtyMilli)}</td><td className="r">{formatQty(i.reorderQtyMilli)}</td><td className="r">{formatINR(i.saleRatePaise)}</td>
            <td>{!i.isActive ? <span className="chip">inactive</span> : <span className={`chip ${i.stockStatus === 'OUT' ? 'bad' : i.stockStatus === 'LOW' ? 'low' : 'good'}`}>{i.stockStatus === 'OUT' ? 'sold out' : i.stockStatus === 'LOW' ? 'low' : 'ok'}</span>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {can(user, 'item.edit', 'price.edit') && <button onClick={() => setForm({ item: i })}>Edit</button>}{' '}
              {can(user, 'stock.adjust') && <button onClick={() => setStock(i)}>Stock</button>}{' '}
              {can(user, 'item.edit') && <button onClick={() => void run(async () => { await call('items.setActive', i.id, !i.isActive); reload(); })}>{i.isActive ? 'Deactivate' : 'Reactivate'}</button>}
            </td></tr>
        ))}
        {data && data.rows.length === 0 && <tr><td colSpan={9} className="muted">No items yet. {canAdd ? 'Click "Add item" to start.' : ''}</td></tr>}
      </tbody></table>
      {form && <ItemForm {...(form.item ? { item: form.item } : {})} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {stock && <StockForm item={stock} onClose={() => setStock(null)} onSaved={() => { setStock(null); reload(); }} />}
    </>
  );
}
