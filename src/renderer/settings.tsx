import { useEffect, useState, type ReactNode } from 'react';
import { call } from './api';
import { Err, Field, Msg, StateSelect, useAction, useFields, useLoad } from './ui';

interface S {
  businessName: string | null; businessState: string | null; invoicePrefix: string | null; businessAddress: string | null; businessPhone: string | null; businessEmail: string | null;
  businessGstin: string | null; bankName: string | null; bankBranch: string | null; bankAccountNo: string | null; bankIfsc: string | null; invoiceTerms: string | null;
  warnBelowCost: boolean; backupReminderDays: number;
}

export function Settings(): ReactNode {
  const { data } = useLoad<S>('settings.get');
  const [f, set, setAll] = useFields({
    businessName: '', businessState: '', invoicePrefix: '', businessAddress: '', businessPhone: '', businessEmail: '', businessGstin: '', bankName: '', bankBranch: '', bankAccountNo: '', bankIfsc: '', invoiceTerms: '', reminder: '7',
  });
  const [warn, setWarn] = useState(true);
  const [st, run] = useAction();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!data) return;
    setAll({
      businessName: data.businessName ?? '', businessState: data.businessState ?? '', invoicePrefix: data.invoicePrefix ?? '', businessAddress: data.businessAddress ?? '', businessPhone: data.businessPhone ?? '',
      businessEmail: data.businessEmail ?? '', businessGstin: data.businessGstin ?? '', bankName: data.bankName ?? '', bankBranch: data.bankBranch ?? '', bankAccountNo: data.bankAccountNo ?? '',
      bankIfsc: data.bankIfsc ?? '', invoiceTerms: data.invoiceTerms ?? '', reminder: String(data.backupReminderDays),
    });
    setWarn(data.warnBelowCost);
  }, [data]);
  const save = (): void => {
    void run(async () => {
      const patch: Record<string, unknown> = {
        businessAddress: f.businessAddress, businessPhone: f.businessPhone, businessEmail: f.businessEmail, businessGstin: f.businessGstin, bankName: f.bankName, bankBranch: f.bankBranch,
        bankAccountNo: f.bankAccountNo, bankIfsc: f.bankIfsc, invoiceTerms: f.invoiceTerms, warnBelowCost: warn, backupReminderDays: Number(f.reminder),
      };
      if (f.businessName.trim()) patch.businessName = f.businessName; // these three cannot be emptied, only changed
      if (f.businessState) patch.businessState = f.businessState;
      if (f.invoicePrefix.trim()) patch.invoicePrefix = f.invoicePrefix;
      await call('settings.update', patch);
      setMsg({ ok: true, text: 'Settings saved.' });
    });
  };
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">These details are printed on your invoices. Please check every one before you issue real bills. Anything you leave empty is simply left off the invoice.</p>
      <div className="card" style={{ maxWidth: 860 }}>
        <div className="form">
          <Field label="Business name"><input value={f.businessName} onChange={set('businessName')} /></Field>
          <Field label="Your state (required)" hint="Decides CGST+SGST versus IGST"><StateSelect value={f.businessState} onChange={set('businessState')} /></Field>
          <Field label="Invoice number prefix (required)" hint="For example BZ gives BZ260001"><input value={f.invoicePrefix} onChange={set('invoicePrefix')} /></Field>
          <Field label="GSTIN"><input value={f.businessGstin} onChange={set('businessGstin')} /></Field>
          <div className="full"><Field label="Address (printed on the invoice)"><textarea value={f.businessAddress} onChange={set('businessAddress')} /></Field></div>
          <Field label="Phone"><input value={f.businessPhone} onChange={set('businessPhone')} /></Field>
          <Field label="Email"><input value={f.businessEmail} onChange={set('businessEmail')} /></Field>
          <Field label="Bank name"><input value={f.bankName} onChange={set('bankName')} /></Field>
          <Field label="Bank branch"><input value={f.bankBranch} onChange={set('bankBranch')} /></Field>
          <Field label="Bank account number"><input value={f.bankAccountNo} onChange={set('bankAccountNo')} /></Field>
          <Field label="IFSC code"><input value={f.bankIfsc} onChange={set('bankIfsc')} /></Field>
          <div className="full"><Field label="Terms and conditions (printed on the invoice)"><textarea value={f.invoiceTerms} onChange={set('invoiceTerms')} /></Field></div>
          <Field label="Remind me to back up every (days)" hint="0 = never remind"><input value={f.reminder} onChange={set('reminder')} /></Field>
          <div><label style={{ fontWeight: 400, marginTop: 34 }}><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={warn} onChange={(e) => setWarn(e.target.checked)} />Warn me when a bill is priced below cost</label></div>
        </div>
        <Err text={st.error} /><Msg m={msg} />
        <div className="actions"><button className="primary" disabled={st.busy} onClick={save}>Save settings</button></div>
      </div>
    </>
  );
}
