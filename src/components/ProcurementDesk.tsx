'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Boxes, CheckCircle2, Database, LogOut, PackageCheck, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ProcurementSnapshot } from '@/lib/economy/procurement';
import type { ProcurementActionDescriptor, ProcurementActionKind, ProcurementCockpitSnapshot } from '@/lib/economy/procurementActions';

type Failure = { readonly kind?: string; readonly code?: string; readonly detail?: string; readonly remedy?: string };
type Portfolio = { readonly kind: 'procurement_portfolio'; readonly procurements: readonly ProcurementSnapshot[] };

const inputClass = 'mt-1.5 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--cyan-primary)]/45';

function Field({ label, name, type = 'text', required = true, defaultValue, min, step, placeholder }: {
  readonly label: string; readonly name: string; readonly type?: string; readonly required?: boolean;
  readonly defaultValue?: string | number; readonly min?: string; readonly step?: string; readonly placeholder?: string;
}) {
  return <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
    {label}{!required && <span className="ml-1 normal-case tracking-normal text-[var(--text-muted)]">optional</span>}
    <input className={inputClass} name={name} type={type} required={required} defaultValue={defaultValue} min={min} step={step} placeholder={placeholder} />
  </label>;
}

function Select({ label, name, children, defaultValue }: { readonly label: string; readonly name: string; readonly children: React.ReactNode; readonly defaultValue?: string }) {
  return <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
    {label}<select className={inputClass} name={name} defaultValue={defaultValue}>{children}</select>
  </label>;
}

function localDateTime(value?: string | null): string {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function text(form: FormData, name: string): string { return String(form.get(name) ?? '').trim(); }
function optionalNumber(form: FormData, name: string): number | undefined {
  const value = text(form, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function minor(form: FormData, name: string): number | undefined {
  const value = optionalNumber(form, name);
  return value === undefined ? undefined : Math.round(value * 100);
}
function iso(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : value;
}

function UnitSelect({ defaultValue }: { readonly defaultValue?: string }) {
  return <Select label="Quantity unit" name="unit" defaultValue={defaultValue ?? 'tonne'}>
    <option value="tonne">Tonnes</option><option value="kg">Kilograms</option><option value="lb">Pounds</option>
    <option value="unit">Units</option><option value="liter">Litres</option><option value="m3">Cubic metres</option>
  </Select>;
}

function CheckSelect({ label, name }: { readonly label: string; readonly name: string }) {
  return <Select label={label} name={name} defaultValue="satisfied">
    <option value="satisfied">Satisfied</option><option value="undetermined">Undetermined</option><option value="refused">Refused</option>
  </Select>;
}

function ActionFields({ action, cockpit }: { readonly action: ProcurementActionKind; readonly cockpit: ProcurementCockpitSnapshot | null }) {
  const procurement = cockpit?.procurement;
  const selected = cockpit?.actions.find(item => item.action === action);
  const unitValue = procurement?.requirement.quantity.unit ?? 'tonne';
  const currency = procurement?.purchase?.committedPrice.currency
    ?? procurement?.alternatives[0]?.alternative.quotedTotal.currency ?? 'CAD';
  if (action === 'register_requirement') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Procurement ID" name="procurementId" placeholder="procurement:customer:material:001" />
    <Field label="RFQ / requirement reference" name="sourceReference" placeholder="rfq:artifact:001" />
    <Field label="Material ID" name="materialId" placeholder="material:hdpe" />
    <Field label="Specification ID" name="specificationId" placeholder="spec:hdpe:5502" />
    <Field label="Required quantity" name="quantity" type="number" min="0.000001" step="any" /><UnitSelect />
    <Field label="Destination facility ID" name="destinationId" placeholder="facility:customer:ontario" />
    <Field label="Currency" name="currency" defaultValue="CAD" />
    <Field label="Delivery window starts" name="deliveryStart" type="datetime-local" />
    <Field label="Delivery window ends" name="deliveryEnd" type="datetime-local" />
    <Field label="Maximum landed cost" name="maximumLandedCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Customer commitment ID" name="customerCommitmentId" required={false} />
  </div>;
  if (action === 'add_supplier_alternative') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Quote reference" name="sourceReference" /><Field label="Supplier ID" name="supplierId" />
    <Field label="Supplier facility ID" name="facilityId" required={false} /><Field label="Available quantity" name="quantity" type="number" min="0.000001" step="any" defaultValue={procurement?.requirement.quantity.amount} />
    <UnitSelect defaultValue={unitValue} /><Field label="Quoted total" name="quotedTotal" type="number" min="0" step="0.01" />
    <Field label="Currency" name="currency" defaultValue={currency} /><Field label="Incoterm" name="incoterm" placeholder="FCA supplier plant" />
    <Field label="Availability starts" name="availabilityStart" type="datetime-local" /><Field label="Availability ends" name="availabilityEnd" type="datetime-local" />
    <Field label="Quote valid until" name="validUntil" type="datetime-local" />
  </div>;
  if (action === 'authorize_supplier') return <div className="grid gap-3 sm:grid-cols-2">
    <Select label="Supplier alternative" name="actionId">{(selected?.alternatives ?? []).map(item => <option key={item.actionId} value={item.actionId}>{item.supplierId}</option>)}</Select>
    <Field label="Qualification dossier reference" name="sourceReference" />
    <CheckSelect label="Counterparty eligibility" name="counterpartyEligibility" /><CheckSelect label="Sanctions screening" name="sanctionsScreening" />
    <CheckSelect label="Specification match" name="specificationMatch" /><CheckSelect label="Credit terms" name="creditTerms" />
    <CheckSelect label="Authority to buy" name="authorityToBuy" />
  </div>;
  if (action === 'select_supplier') return <div className="grid gap-3">
    <Select label="Authorized supplier" name="actionId">{(selected?.alternatives ?? []).map(item => <option key={item.actionId} value={item.actionId}>{item.supplierId}</option>)}</Select>
    <Field label="Selection rationale" name="rationale" placeholder="Best specification, delivery-risk, and landed-cost fit." />
  </div>;
  if (action === 'commit_purchase') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Contract ID" name="contractId" /><Field label="Signed contract reference" name="sourceReference" />
    <Field label="Purchased quantity" name="quantity" type="number" min="0.000001" step="any" defaultValue={procurement?.requirement.quantity.amount} /><UnitSelect defaultValue={unitValue} />
    <Field label="Committed total price" name="committedPrice" type="number" min="0" step="0.01" /><Field label="Currency" name="currency" defaultValue={currency} />
    <Field label="Incoterm" name="incoterm" defaultValue={procurement?.alternatives.find(item => item.alternative.actionId === procurement.selection?.selectedActionId)?.alternative.incoterm} />
    <Field label="Title transfer point" name="titleTransferPoint" /><Field label="Committed at" name="committedAt" type="datetime-local" defaultValue={localDateTime()} />
  </div>;
  if (action === 'create_logistics_requirement') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Routing / logistics reference" name="sourceReference" /><Field label="Origin facility ID" name="originId" />
    <Field label="Ready window starts" name="readyStart" type="datetime-local" /><Field label="Ready window ends" name="readyEnd" type="datetime-local" />
    <Field label="Delivery window starts" name="deliveryStart" type="datetime-local" defaultValue={localDateTime(procurement?.requirement.deliveryWindow.start)} />
    <Field label="Delivery window ends" name="deliveryEnd" type="datetime-local" defaultValue={localDateTime(procurement?.requirement.deliveryWindow.end)} />
    <Field label="Handling profile ID" name="handlingProfileId" required={false} />
  </div>;
  if (action === 'record_receipt') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Receipt / inspection reference" name="sourceReference" /><Field label="Received quantity" name="quantity" type="number" min="0.000001" step="any" />
    <UnitSelect defaultValue={unitValue} /><Field label="Received at" name="receivedAt" type="datetime-local" defaultValue={localDateTime()} />
    <Field label="Receiving location ID" name="locationId" defaultValue={procurement?.requirement.destinationId} />
    <Select label="Quality disposition" name="disposition" defaultValue="accepted"><option value="accepted">Accepted</option><option value="quarantined">Quarantined</option><option value="rejected">Rejected</option></Select>
  </div>;
  if (action === 'capture_settlement') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Settlement reference" name="sourceReference" /><Field label="Currency" name="currency" defaultValue={currency} />
    <Field label="Purchase invoice" name="purchaseInvoice" type="number" min="0" step="0.01" required={false} />
    <Field label="Freight cost" name="freightCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Duty cost" name="dutyCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Insurance cost" name="insuranceCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Storage cost" name="storageCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Financing cost" name="financingCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Loss / shortage cost" name="lossCost" type="number" min="0" step="0.01" required={false} />
    <Field label="Sale revenue" name="saleRevenue" type="number" min="0" step="0.01" required={false} />
    <p className="sm:col-span-2 text-xs leading-5 text-[var(--text-muted)]">Leave unknown values blank. Enter 0 only when an evidence-backed record establishes the actual cost is zero.</p>
  </div>;
  return <div className="rounded-lg border border-[var(--cyan-primary)]/20 bg-[var(--cyan-primary)]/5 p-4 text-sm text-[var(--text-secondary)]">Payload will freeze the current authorized supplier set and its knowledge cutoff. Confirm to continue.</div>;
}

function payloadFor(action: ProcurementActionKind, procurementId: string | null, form: FormData): Record<string, unknown> {
  if (action === 'register_requirement') return {
    procurementId: text(form, 'procurementId'), sourceReference: text(form, 'sourceReference'), materialId: text(form, 'materialId'), specificationId: text(form, 'specificationId'),
    quantity: optionalNumber(form, 'quantity'), unit: text(form, 'unit'), destinationId: text(form, 'destinationId'), deliveryStart: iso(form, 'deliveryStart'), deliveryEnd: iso(form, 'deliveryEnd'),
    maximumLandedCostMinor: minor(form, 'maximumLandedCost'), currency: text(form, 'currency').toUpperCase(), customerCommitmentId: text(form, 'customerCommitmentId') || undefined,
  };
  const base = { procurementId };
  if (action === 'add_supplier_alternative') return { ...base, sourceReference: text(form, 'sourceReference'), supplierId: text(form, 'supplierId'), facilityId: text(form, 'facilityId') || undefined, quantity: optionalNumber(form, 'quantity'), unit: text(form, 'unit'), quotedTotalMinor: minor(form, 'quotedTotal'), currency: text(form, 'currency').toUpperCase(), incoterm: text(form, 'incoterm'), availabilityStart: iso(form, 'availabilityStart'), availabilityEnd: iso(form, 'availabilityEnd'), validUntil: iso(form, 'validUntil') };
  if (action === 'authorize_supplier') return { ...base, actionId: text(form, 'actionId'), sourceReference: text(form, 'sourceReference'), counterpartyEligibility: text(form, 'counterpartyEligibility'), sanctionsScreening: text(form, 'sanctionsScreening'), specificationMatch: text(form, 'specificationMatch'), creditTerms: text(form, 'creditTerms'), authorityToBuy: text(form, 'authorityToBuy') };
  if (action === 'select_supplier') return { ...base, actionId: text(form, 'actionId'), rationale: text(form, 'rationale') };
  if (action === 'commit_purchase') return { ...base, contractId: text(form, 'contractId'), sourceReference: text(form, 'sourceReference'), quantity: optionalNumber(form, 'quantity'), unit: text(form, 'unit'), committedPriceMinor: minor(form, 'committedPrice'), currency: text(form, 'currency').toUpperCase(), incoterm: text(form, 'incoterm'), titleTransferPoint: text(form, 'titleTransferPoint'), committedAt: iso(form, 'committedAt') };
  if (action === 'create_logistics_requirement') return { ...base, sourceReference: text(form, 'sourceReference'), originId: text(form, 'originId'), readyStart: iso(form, 'readyStart'), readyEnd: iso(form, 'readyEnd'), deliveryStart: iso(form, 'deliveryStart'), deliveryEnd: iso(form, 'deliveryEnd'), handlingProfileId: text(form, 'handlingProfileId') || undefined };
  if (action === 'record_receipt') return { ...base, sourceReference: text(form, 'sourceReference'), quantity: optionalNumber(form, 'quantity'), unit: text(form, 'unit'), receivedAt: iso(form, 'receivedAt'), locationId: text(form, 'locationId'), disposition: text(form, 'disposition') };
  if (action === 'capture_settlement') return { ...base, sourceReference: text(form, 'sourceReference'), currency: text(form, 'currency').toUpperCase(), purchaseInvoiceMinor: minor(form, 'purchaseInvoice'), freightCostMinor: minor(form, 'freightCost'), dutyCostMinor: minor(form, 'dutyCost'), insuranceCostMinor: minor(form, 'insuranceCost'), storageCostMinor: minor(form, 'storageCost'), financingCostMinor: minor(form, 'financingCost'), lossCostMinor: minor(form, 'lossCost'), saleRevenueMinor: minor(form, 'saleRevenue') };
  return base;
}

function ActionPanel({ token, procurementId, onClose, onCommitted }: { readonly token: string; readonly procurementId: string | null; readonly onClose: () => void; readonly onCommitted: () => void }) {
  const [actorId, setActorId] = useState('desk:procurement');
  const [cockpit, setCockpit] = useState<ProcurementCockpitSnapshot | null>(null);
  const [action, setAction] = useState<ProcurementActionKind>(procurementId ? 'add_supplier_alternative' : 'register_requirement');
  const [loading, setLoading] = useState(!!procurementId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const requestRef = useRef<{ payloadKey: string; requestId: string; submittedAt: string } | null>(null);

  useEffect(() => {
    if (!procurementId) return;
    let active = true;
    fetch(`/api/procurement/actions?procurementId=${encodeURIComponent(procurementId)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(async response => {
        const body = await response.json() as ProcurementCockpitSnapshot | Failure;
        if (!response.ok || body.kind !== 'procurement_cockpit_snapshot') throw new Error([(body as Failure).detail, (body as Failure).remedy].filter(Boolean).join(' ') || 'Unable to load procurement.');
        if (!active) return;
        setCockpit(body as ProcurementCockpitSnapshot);
        const available = (body as ProcurementCockpitSnapshot).actions;
        setAction(available.find(item => item.recommended)?.action ?? available[0]?.action ?? 'capture_settlement');
      }).catch(cause => active && setError(cause instanceof Error ? cause.message : 'Unable to load procurement.')).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [procurementId, token]);

  const selected = useMemo<ProcurementActionDescriptor | null>(() => cockpit?.actions.find(item => item.action === action) ?? null, [action, cockpit]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setError(null); setSuccess(null);
    const payload = payloadFor(action, procurementId, new FormData(event.currentTarget));
    const payloadKey = JSON.stringify({ action, actorId: actorId.trim(), payload });
    if (requestRef.current?.payloadKey !== payloadKey) requestRef.current = { payloadKey, requestId: `request:${crypto.randomUUID()}`, submittedAt: new Date().toISOString() };
    const body = { action, actorId: actorId.trim(), requestId: requestRef.current.requestId, submittedAt: requestRef.current.submittedAt, payload };
    try {
      const response = await fetch('/api/procurement/actions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as Failure;
      if (!response.ok) throw new Error([result.detail, result.remedy].filter(Boolean).join(' ') || `Action refused (${response.status}).`);
      requestRef.current = null; setSuccess(`${selected?.label ?? 'Procurement action'} recorded.`); onCommitted(); window.setTimeout(onClose, 700);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed.'); }
    finally { setSubmitting(false); }
  };
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog" aria-modal="true">
    <section className="flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-[var(--bg-panel)] shadow-2xl shadow-black">
      <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] p-5"><div>
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--gold-primary)]">PayloadOS procurement action</p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--text-heading)]">{procurementId ?? 'New procurement requirement'}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Enter commercial facts only. Payload derives event, evidence, decision, and position bindings.</p>
      </div><button type="button" onClick={onClose} className="rounded-lg border border-white/10 p-2 text-[var(--text-secondary)]"><X size={18} /></button></header>
      <div className="flex-1 overflow-y-auto p-5"><label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">Acting operator ID<input className={inputClass} value={actorId} onChange={event => setActorId(event.target.value)} /></label>
        {loading ? <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]"><RefreshCw className="animate-spin" size={16} /> Resolving durable position…</div> : <>
          {procurementId && cockpit && <div className="mt-5 grid gap-2 sm:grid-cols-2">{cockpit.actions.map(item => <button key={item.action} type="button" onClick={() => { requestRef.current = null; setAction(item.action); setError(null); }} className={`rounded-lg border p-3 text-left ${action === item.action ? 'border-[var(--gold-primary)]/50 bg-[var(--gold-primary)]/10' : 'border-white/10 bg-black/15'}`}><span className="text-sm font-semibold text-[var(--text-heading)]">{item.label}</span>{item.recommended && <span className="ml-2 rounded bg-[var(--alert-green)]/10 px-1.5 py-0.5 text-[9px] uppercase text-[var(--alert-green)]">next</span>}<p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{item.summary}</p></button>)}</div>}
          {procurementId && cockpit?.actions.length === 0 ? <div className="mt-5 flex gap-2 rounded-lg border border-[var(--alert-green)]/25 bg-[var(--alert-green)]/5 p-4 text-sm text-[var(--alert-green)]"><CheckCircle2 size={18} /> This position is fully received and settled.</div> : <form key={action} onSubmit={submit} className="mt-6 space-y-5"><div><h3 className="font-semibold text-[var(--text-heading)]">{selected?.label ?? 'Create procurement requirement'}</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{selected?.summary ?? 'Define the material, specification, quantity, destination, and delivery constraint.'}</p></div><ActionFields action={action} cockpit={cockpit} />
            {error && <div role="alert" className="flex gap-2 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-3 text-sm text-[var(--alert-red)]"><AlertTriangle size={17} />{error}</div>}
            {success && <div className="flex gap-2 rounded-lg border border-[var(--alert-green)]/30 bg-[var(--alert-green)]/8 p-3 text-sm text-[var(--alert-green)]"><CheckCircle2 size={17} />{success}</div>}
            <button disabled={submitting || !actorId.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--gold-primary)]/40 bg-[var(--gold-primary)]/15 px-4 py-3 text-sm font-semibold text-[var(--gold-light)] disabled:opacity-40">{submitting ? <RefreshCw className="animate-spin" size={16} /> : <ShieldCheck size={16} />}{submitting ? 'Recording…' : `Confirm ${selected?.label ?? 'requirement'}`}</button>
          </form>}
        </>}
      </div>
    </section>
  </div>;
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountMinor / 100);
}

export default function ProcurementDesk() {
  const [token, setToken] = useState(''); const [draft, setDraft] = useState(''); const [portfolio, setPortfolio] = useState<readonly ProcurementSnapshot[] | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null); const [panelId, setPanelId] = useState<string | null | undefined>(undefined);
  const load = useCallback(async (credential: string) => { setLoading(true); try { const response = await fetch('/api/procurement/actions', { headers: { authorization: `Bearer ${credential}` }, cache: 'no-store' }); const body = await response.json() as Portfolio | Failure; if (!response.ok || body.kind !== 'procurement_portfolio') throw new Error([(body as Failure).detail, (body as Failure).remedy].filter(Boolean).join(' ') || 'Unable to open procurement book.'); setPortfolio((body as Portfolio).procurements); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open procurement book.'); } finally { setLoading(false); } }, []);
  const unlock = (event: FormEvent) => { event.preventDefault(); const credential = draft.trim(); if (!credential) return; setToken(credential); setDraft(''); void load(credential); };
  if (!token || portfolio === null) return <main className="docs-root min-h-screen bg-[radial-gradient(circle_at_50%_-20%,rgba(var(--gold-rgb),0.16),transparent_38%),var(--bg-void)] px-5 py-8"><div className="mx-auto flex min-h-[80vh] max-w-lg items-center justify-center"><section className="w-full rounded-2xl border border-[var(--border-active)] bg-[var(--bg-panel)] p-7 shadow-2xl"><Boxes className="text-[var(--gold-primary)]" size={28} /><p className="mt-5 font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--gold-primary)]">PayloadOS</p><h1 className="mt-2 text-2xl font-semibold text-[var(--text-heading)]">Procurement & Positions</h1><p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">Source, qualify, buy, move, receive, and settle physical positions through one durable workflow.</p><form onSubmit={unlock} className="mt-7 space-y-4"><label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">Operations access token<input type="password" value={draft} onChange={event => setDraft(event.target.value)} className={inputClass} placeholder="Enter desk token" aria-label="Operations access token" autoComplete="off" /></label><button disabled={loading || !draft.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--gold-primary)]/45 bg-[var(--gold-primary)]/15 px-4 py-3 text-sm font-semibold text-[var(--gold-light)] disabled:opacity-40">{loading ? <RefreshCw className="animate-spin" size={16} /> : <Database size={16} />} Open procurement workspace</button></form>{error && <p className="mt-4 text-sm text-[var(--alert-red)]">{error}</p>}<Link href="/operations" className="mt-6 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]"><ArrowLeft size={14} /> Freight operations</Link></section></div></main>;
  const attention = portfolio.filter(item => item.phase !== 'settled' || item.landedCost?.kind === 'incomplete').length;
  const purchases = portfolio.flatMap(item => item.purchase ? [item.purchase.committedPrice] : []);
  const purchaseCurrencies = new Set(purchases.map(item => item.currency));
  const committedValue = purchaseCurrencies.size === 0 ? '—'
    : purchaseCurrencies.size > 1 ? `${purchaseCurrencies.size} currencies`
      : formatMoney(purchases.reduce((sum, item) => sum + item.amountMinor, 0), purchases[0].currency);
  return <main className="docs-root min-h-screen bg-[var(--bg-void)] text-[var(--text-primary)]"><header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[rgba(4,4,10,.92)] px-5 py-4 backdrop-blur-xl"><div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--gold-primary)]">PayloadOS · Commercial execution</p><h1 className="mt-1 text-lg font-semibold text-[var(--text-heading)]">Procurement & Physical Positions</h1></div><div className="flex gap-2"><Link href="/operations" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[var(--text-secondary)]">Freight tower</Link><button onClick={() => setPanelId(null)} className="flex items-center gap-2 rounded-lg border border-[var(--gold-primary)]/30 bg-[var(--gold-primary)]/8 px-3 py-2 text-xs font-semibold text-[var(--gold-light)]"><Plus size={15} /> New requirement</button><button onClick={() => void load(token)} className="rounded-lg border border-white/10 p-2"><RefreshCw className={loading ? 'animate-spin' : ''} size={16} /></button><button onClick={() => { setToken(''); setPortfolio(null); }} className="rounded-lg border border-white/10 p-2 text-[var(--text-secondary)]"><LogOut size={16} /></button></div></div></header>
    <div className="mx-auto max-w-[1500px] px-5 py-7"><section className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Requirements</p><p className="mt-2 font-mono text-2xl">{portfolio.length}</p></div><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Needs action</p><p className="mt-2 font-mono text-2xl text-[var(--gold-primary)]">{attention}</p></div><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Committed purchase value</p><p className="mt-2 font-mono text-2xl">{committedValue}</p></div></section>
      {error && <div className="mt-5 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-3 text-sm text-[var(--alert-red)]">{error}</div>}
      <section className="mt-6 grid gap-3">{portfolio.map(item => <article key={item.procurementId} className="grid gap-4 rounded-xl border border-white/[0.08] bg-[var(--bg-panel)] p-5 md:grid-cols-[1.3fr_1fr_1fr_auto] md:items-center"><div><div className="flex items-center gap-2"><span className="rounded border border-[var(--gold-primary)]/30 px-2 py-1 text-[10px] uppercase text-[var(--gold-primary)]">{item.phase.replaceAll('_', ' ')}</span><span className="font-mono text-xs text-[var(--text-muted)]">{item.procurementId}</span></div><h2 className="mt-3 text-lg font-semibold text-[var(--text-heading)]">{item.requirement.materialId}</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.requirement.specificationId} · {item.requirement.quantity.amount.toLocaleString()} {item.requirement.quantity.unit}</p></div><div><p className="text-[10px] uppercase text-[var(--text-muted)]">Supplier / position</p><p className="mt-2 font-mono text-sm text-[var(--cyan-primary)]">{item.position?.supplierId ?? 'Not selected'}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.position?.positionId ?? item.requirement.destinationId}</p></div><div><p className="text-[10px] uppercase text-[var(--text-muted)]">Economics</p><p className="mt-2 text-sm">{item.landedCost?.kind === 'complete' ? `${formatMoney(item.landedCost.amountMinor, item.landedCost.currency)} landed` : item.landedCost?.kind === 'incomplete' ? 'Landed cost incomplete' : item.purchase ? formatMoney(item.purchase.committedPrice.amountMinor, item.purchase.committedPrice.currency) : 'Not committed'}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.position?.qualityState ?? 'Quality pending'}</p></div><button onClick={() => setPanelId(item.procurementId)} className="flex items-center justify-center gap-2 rounded-lg border border-[var(--cyan-primary)]/25 bg-[var(--cyan-primary)]/5 px-4 py-2 text-xs font-semibold text-[var(--cyan-primary)]"><PackageCheck size={15} /> Operate</button></article>)}{portfolio.length === 0 && <div className="flex min-h-60 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-[var(--bg-panel)] p-8 text-center"><Boxes className="text-[var(--gold-primary)]" size={30} /><h2 className="mt-3 font-semibold">No procurement positions yet</h2><p className="mt-2 text-sm text-[var(--text-secondary)]">Create the first requirement to begin sourcing.</p></div>}</section>
    </div>{panelId !== undefined && <ActionPanel token={token} procurementId={panelId} onClose={() => setPanelId(undefined)} onCommitted={() => void load(token)} />}
  </main>;
}
