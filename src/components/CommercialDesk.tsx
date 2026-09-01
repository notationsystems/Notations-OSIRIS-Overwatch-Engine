'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Boxes, CheckCircle2, Database, LogOut, PackageOpen, Plus, RefreshCw, ShieldCheck, ShoppingCart, Truck, X } from 'lucide-react';
import type { CommercialBookSnapshot, CustomerCommitmentSnapshot } from '@/lib/economy/commercial';
import type { CommercialActionDescriptor, CommercialActionKind, CommercialCockpitSnapshot } from '@/lib/economy/commercialActions';

type Failure = { readonly kind?: string; readonly code?: string; readonly detail?: string; readonly remedy?: string };
type PanelTarget = { kind: 'open_lot' } | { kind: 'refresh_cost' } | { kind: 'new_commitment' } | { kind: 'commitment'; commitmentId: string };

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
function number(form: FormData, name: string): number | undefined { const raw = text(form, name); if (!raw) return undefined; const value = Number(raw); return Number.isFinite(value) ? value : undefined; }
function minor(form: FormData, name: string): number | undefined { const value = text(form, name); return value ? Math.round(Number(value) * 100) : undefined; }
function iso(form: FormData, name: string): string | undefined { const value = text(form, name); return value ? new Date(value).toISOString() : undefined; }

function UnitSelect({ defaultValue = 'tonne' }: { readonly defaultValue?: string }) {
  return <Select label="Quantity unit" name="unit" defaultValue={defaultValue}>
    <option value="tonne">Tonnes</option><option value="kg">Kilograms</option><option value="lb">Pounds</option>
    <option value="unit">Units</option><option value="liter">Litres</option><option value="m3">Cubic metres</option>
  </Select>;
}

function ActionFields({ action, cockpit }: { readonly action: CommercialActionKind; readonly cockpit: CommercialCockpitSnapshot | null }) {
  const commitment = cockpit?.commitment;
  const selected = cockpit?.actions.find(item => item.action === action);
  const unit = commitment?.commitment.requiredQuantity.unit ?? 'tonne';
  const currency = commitment?.contract?.totalRevenue.currency
    ?? (commitment?.commitment.minimumRevenue.kind === 'observed' ? commitment.commitment.minimumRevenue.value.currency : 'CAD');
  if (action === 'open_inventory_lot' || action === 'refresh_inventory_cost') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Completed procurement ID" name="procurementId" placeholder="procurement:material:001" />
    <Field label={action === 'open_inventory_lot' ? 'Warehouse receipt reference' : 'Cost reconciliation reference'} name="sourceReference" placeholder={action === 'open_inventory_lot' ? 'warehouse-receipt:001' : 'cost-reconciliation:001'} />
    <p className="sm:col-span-2 text-xs leading-5 text-[var(--text-muted)]">{action === 'open_inventory_lot' ? 'Payload imports the accepted quantity, material, specification, location, and landed-cost evidence from the procurement position. They cannot be retyped here.' : 'Payload appends complete landed cost only from a newer snapshot of the exact procurement position. Existing inventory history is not overwritten.'}</p>
  </div>;
  if (action === 'register_customer_commitment') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Commitment ID" name="commitmentId" placeholder="customer-commitment:001" /><Field label="Customer ID" name="customerId" />
    <Field label="Customer purchase order" name="customerPurchaseOrderId" /><Field label="Destination facility ID" name="destinationId" />
    <Field label="Material ID" name="materialId" /><Field label="Specification ID" name="specificationId" />
    <Field label="Required quantity" name="quantity" type="number" min="0.000001" step="any" /><UnitSelect />
    <Field label="Delivery window starts" name="deliveryStart" type="datetime-local" /><Field label="Delivery window ends" name="deliveryEnd" type="datetime-local" />
    <Field label="Minimum approved revenue" name="minimumRevenue" type="number" min="0" step="0.01" required={false} /><Field label="Currency" name="currency" defaultValue="CAD" />
  </div>;
  if (action === 'reserve_inventory') {
    const lots = selected?.lots ?? [];
    return <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Compatible inventory lot" name="lotId">{lots.map(lot => <option key={lot.lotId} value={lot.lotId}>{lot.lotId} · {lot.availableAmount} {lot.unit} available</option>)}</Select>
      <Field label="Allocation approval reference" name="sourceReference" />
      <Field label="Quantity to reserve" name="quantity" type="number" min="0.000001" step="any" defaultValue={lots[0] ? Math.min(lots[0].availableAmount, commitment?.remainingAmount ?? lots[0].availableAmount) : undefined} />
      <UnitSelect defaultValue={unit} />
      {lots.length === 0 && <p className="sm:col-span-2 text-xs text-[var(--alert-red)]">No compatible available inventory is currently present. Receive procurement into inventory first.</p>}
    </div>;
  }
  if (action === 'commit_sale') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Sale contract ID" name="saleContractId" /><Field label="Signed contract reference" name="sourceReference" />
    <Field label="Contract total revenue" name="totalRevenue" type="number" min="0" step="0.01" /><Field label="Currency" name="currency" defaultValue={currency} />
    <Field label="Incoterm" name="incoterm" placeholder="DAP customer facility" /><Field label="Title transfer point" name="titleTransferPoint" />
    <Field label="Signed at" name="signedAt" type="datetime-local" defaultValue={localDateTime()} />
  </div>;
  if (action === 'dispatch_sale') return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Dispatch / tender reference" name="sourceReference" /><Field label="Freight load operation ID" name="loadOperationId" placeholder="load-operation:customer:001" />
    <Field label="Dispatched at" name="dispatchedAt" type="datetime-local" defaultValue={localDateTime()} />
    <p className="sm:col-span-2 text-xs leading-5 text-[var(--text-muted)]">The inventory allocation is bound to this exact freight operation. Changed freight requires a new dispatch identity.</p>
  </div>;
  if (action === 'record_customer_delivery') {
    const allocations = selected?.allocations ?? [];
    return <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Inventory allocation" name="allocationId">{allocations.map(item => <option key={item.allocationId} value={item.allocationId}>{item.lotId} · {item.undeliveredAmount} {item.unit} outstanding</option>)}</Select>
      <Field label="Proof of delivery reference" name="sourceReference" />
      <Field label="Delivered quantity" name="quantity" type="number" min="0.000001" step="any" defaultValue={allocations[0]?.undeliveredAmount} /><UnitSelect defaultValue={unit} />
      <Field label="Delivered at" name="deliveredAt" type="datetime-local" defaultValue={localDateTime()} /><Field label="Delivery location ID" name="locationId" defaultValue={commitment?.commitment.destinationId} />
      <Select label="Customer disposition" name="disposition" defaultValue="accepted"><option value="accepted">Accepted</option><option value="quarantined">Quarantined</option><option value="rejected">Rejected</option></Select>
    </div>;
  }
  return <div className="grid gap-3 sm:grid-cols-2">
    <Field label="Settlement / remittance reference" name="sourceReference" /><Field label="Currency" name="currency" defaultValue={currency} />
    <Field label="Settled gross revenue" name="grossRevenue" type="number" min="0" step="0.01" required={false} />
    <Field label="Deductions / credits" name="deductions" type="number" min="0" step="0.01" required={false} />
    <p className="sm:col-span-2 text-xs leading-5 text-[var(--text-muted)]">Leave unknown amounts blank. Enter 0 only when the settlement evidence establishes a true zero.</p>
  </div>;
}

function payloadFor(action: CommercialActionKind, commitmentId: string | null, form: FormData): Record<string, unknown> {
  if (action === 'open_inventory_lot' || action === 'refresh_inventory_cost') return { procurementId: text(form, 'procurementId'), sourceReference: text(form, 'sourceReference') };
  if (action === 'register_customer_commitment') return {
    commitmentId: text(form, 'commitmentId'), customerId: text(form, 'customerId'), customerPurchaseOrderId: text(form, 'customerPurchaseOrderId'),
    materialId: text(form, 'materialId'), specificationId: text(form, 'specificationId'), quantity: number(form, 'quantity'), unit: text(form, 'unit'),
    destinationId: text(form, 'destinationId'), deliveryStart: iso(form, 'deliveryStart'), deliveryEnd: iso(form, 'deliveryEnd'),
    minimumRevenueMinor: minor(form, 'minimumRevenue'), currency: text(form, 'currency').toUpperCase(),
  };
  const base = { commitmentId };
  if (action === 'reserve_inventory') return { ...base, lotId: text(form, 'lotId'), quantity: number(form, 'quantity'), unit: text(form, 'unit'), sourceReference: text(form, 'sourceReference') };
  if (action === 'commit_sale') return { ...base, saleContractId: text(form, 'saleContractId'), sourceReference: text(form, 'sourceReference'), totalRevenueMinor: minor(form, 'totalRevenue'), currency: text(form, 'currency').toUpperCase(), incoterm: text(form, 'incoterm'), titleTransferPoint: text(form, 'titleTransferPoint'), signedAt: iso(form, 'signedAt') };
  if (action === 'dispatch_sale') return { ...base, sourceReference: text(form, 'sourceReference'), loadOperationId: text(form, 'loadOperationId'), dispatchedAt: iso(form, 'dispatchedAt') };
  if (action === 'record_customer_delivery') return { ...base, allocationId: text(form, 'allocationId'), sourceReference: text(form, 'sourceReference'), quantity: number(form, 'quantity'), unit: text(form, 'unit'), deliveredAt: iso(form, 'deliveredAt'), locationId: text(form, 'locationId'), disposition: text(form, 'disposition') };
  return { ...base, sourceReference: text(form, 'sourceReference'), currency: text(form, 'currency').toUpperCase(), grossRevenueMinor: minor(form, 'grossRevenue'), deductionsMinor: minor(form, 'deductions') };
}

function ActionPanel({ token, target, onClose, onCommitted }: { readonly token: string; readonly target: PanelTarget; readonly onClose: () => void; readonly onCommitted: () => void }) {
  const commitmentId = target.kind === 'commitment' ? target.commitmentId : null;
  const initialAction: CommercialActionKind = target.kind === 'open_lot' ? 'open_inventory_lot' : target.kind === 'refresh_cost' ? 'refresh_inventory_cost' : target.kind === 'new_commitment' ? 'register_customer_commitment' : 'reserve_inventory';
  const [actorId, setActorId] = useState('desk:commercial'); const [cockpit, setCockpit] = useState<CommercialCockpitSnapshot | null>(null);
  const [action, setAction] = useState<CommercialActionKind>(initialAction); const [loading, setLoading] = useState(!!commitmentId);
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null); const [success, setSuccess] = useState<string | null>(null);
  const requestRef = useRef<{ payloadKey: string; requestId: string; submittedAt: string } | null>(null);
  useEffect(() => {
    if (!commitmentId) return;
    let active = true;
    fetch(`/api/commercial/actions?commitmentId=${encodeURIComponent(commitmentId)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(async response => { const body = await response.json() as CommercialCockpitSnapshot | Failure; if (!response.ok || body.kind !== 'commercial_cockpit_snapshot') throw new Error([(body as Failure).detail, (body as Failure).remedy].filter(Boolean).join(' ') || 'Unable to load commercial commitment.'); if (!active) return; setCockpit(body as CommercialCockpitSnapshot); const available = (body as CommercialCockpitSnapshot).actions; setAction(available.find(item => item.recommended)?.action ?? available[0]?.action ?? 'capture_sale_settlement'); })
      .catch(cause => active && setError(cause instanceof Error ? cause.message : 'Unable to load commercial commitment.')).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [commitmentId, token]);
  const selected = useMemo<CommercialActionDescriptor | null>(() => cockpit?.actions.find(item => item.action === action) ?? null, [action, cockpit]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setError(null); setSuccess(null);
    const payload = payloadFor(action, commitmentId, new FormData(event.currentTarget)); const payloadKey = JSON.stringify({ action, actorId: actorId.trim(), payload });
    if (requestRef.current?.payloadKey !== payloadKey) requestRef.current = { payloadKey, requestId: `request:${crypto.randomUUID()}`, submittedAt: new Date().toISOString() };
    try {
      const response = await fetch('/api/commercial/actions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, actorId: actorId.trim(), requestId: requestRef.current.requestId, submittedAt: requestRef.current.submittedAt, payload }) });
      const body = await response.json() as Failure; if (!response.ok) throw new Error([body.detail, body.remedy].filter(Boolean).join(' ') || `Action refused (${response.status}).`);
      requestRef.current = null; setSuccess(`${selected?.label ?? (action === 'open_inventory_lot' ? 'Inventory lot' : action === 'refresh_inventory_cost' ? 'Inventory cost' : 'Customer commitment')} recorded.`); onCommitted(); window.setTimeout(onClose, 700);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed.'); } finally { setSubmitting(false); }
  };
  const title = commitmentId ?? (target.kind === 'open_lot' ? 'Receive procurement into inventory' : target.kind === 'refresh_cost' ? 'Refresh inventory landed cost' : 'New customer commitment');
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog" aria-modal="true"><section className="flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-[var(--bg-panel)] shadow-2xl shadow-black"><header className="flex items-start justify-between gap-4 border-b border-white/[0.08] p-5"><div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--cyan-primary)]">PayloadOS commercial action</p><h2 className="mt-2 text-xl font-semibold text-[var(--text-heading)]">{title}</h2><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Enter business facts only. Payload derives inventory, allocation, contract, fulfillment, and evidence bindings.</p></div><button type="button" onClick={onClose} className="rounded-lg border border-white/10 p-2"><X size={18} /></button></header>
    <div className="flex-1 overflow-y-auto p-5"><label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">Acting operator ID<input className={inputClass} value={actorId} onChange={event => setActorId(event.target.value)} /></label>{loading ? <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-[var(--text-secondary)]"><RefreshCw className="animate-spin" size={16} /> Resolving commercial book…</div> : <>{commitmentId && cockpit && <div className="mt-5 grid gap-2 sm:grid-cols-2">{cockpit.actions.map(item => <button key={item.action} type="button" onClick={() => { setAction(item.action); requestRef.current = null; }} className={`rounded-lg border p-3 text-left ${action === item.action ? 'border-[var(--cyan-primary)]/50 bg-[var(--cyan-primary)]/10' : 'border-white/10 bg-black/15'}`}><span className="text-sm font-semibold">{item.label}</span>{item.recommended && <span className="ml-2 rounded bg-[var(--alert-green)]/10 px-1.5 py-0.5 text-[9px] uppercase text-[var(--alert-green)]">next</span>}<p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{item.summary}</p></button>)}</div>}{commitmentId && cockpit?.actions.length === 0 ? <div className="mt-5 flex gap-2 rounded-lg border border-[var(--alert-green)]/25 bg-[var(--alert-green)]/5 p-4 text-sm text-[var(--alert-green)]"><CheckCircle2 size={18} /> This customer commitment is fully delivered and economically complete.</div> : <form key={action} onSubmit={submit} className="mt-6 space-y-5"><div><h3 className="font-semibold text-[var(--text-heading)]">{selected?.label ?? title}</h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{selected?.summary ?? 'Record the next exact commercial fact.'}</p></div><ActionFields action={action} cockpit={cockpit} />{error && <div role="alert" className="flex gap-2 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-3 text-sm text-[var(--alert-red)]"><AlertTriangle size={17} />{error}</div>}{success && <div className="flex gap-2 rounded-lg border border-[var(--alert-green)]/30 bg-[var(--alert-green)]/8 p-3 text-sm text-[var(--alert-green)]"><CheckCircle2 size={17} />{success}</div>}<button disabled={submitting || !actorId.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--cyan-primary)]/40 bg-[var(--cyan-primary)]/12 px-4 py-3 text-sm font-semibold text-[var(--cyan-primary)] disabled:opacity-40">{submitting ? <RefreshCw className="animate-spin" size={16} /> : <ShieldCheck size={16} />}{submitting ? 'Recording…' : `Confirm ${selected?.label ?? title}`}</button></form>}</>}</div>
  </section></div>;
}

function formatMoney(amountMinor: number, currency: string): string { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amountMinor / 100); }
function marginLabel(commitment: CustomerCommitmentSnapshot): string {
  const margin = commitment.realizedMargin ?? commitment.expectedMargin;
  return margin?.kind === 'complete' ? formatMoney(margin.grossMarginMinor, margin.currency) : margin ? 'Margin evidence incomplete' : 'Not contracted';
}

export default function CommercialDesk() {
  const [token, setToken] = useState(''); const [draft, setDraft] = useState(''); const [book, setBook] = useState<CommercialBookSnapshot | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null); const [panel, setPanel] = useState<PanelTarget | null>(null);
  const load = useCallback(async (credential: string) => { setLoading(true); try { const response = await fetch('/api/commercial/actions', { headers: { authorization: `Bearer ${credential}` }, cache: 'no-store' }); const body = await response.json() as CommercialBookSnapshot | Failure; if (!response.ok || body.kind !== 'commercial_book_snapshot') throw new Error([(body as Failure).detail, (body as Failure).remedy].filter(Boolean).join(' ') || 'Unable to open the commercial book.'); setBook(body as CommercialBookSnapshot); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open the commercial book.'); } finally { setLoading(false); } }, []);
  const unlock = (event: FormEvent) => { event.preventDefault(); const credential = draft.trim(); if (!credential) return; setToken(credential); setDraft(''); void load(credential); };
  if (!token || !book) return <main className="docs-root min-h-screen bg-[radial-gradient(circle_at_50%_-20%,rgba(0,210,255,0.13),transparent_38%),var(--bg-void)] px-5 py-8"><div className="mx-auto flex min-h-[80vh] max-w-lg items-center justify-center"><section className="w-full rounded-2xl border border-[var(--border-active)] bg-[var(--bg-panel)] p-7 shadow-2xl"><ShoppingCart className="text-[var(--cyan-primary)]" size={28} /><p className="mt-5 font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--cyan-primary)]">PayloadOS</p><h1 className="mt-2 text-2xl font-semibold">Commercial Book</h1><p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">Operate inventory, customer commitments, allocation, sales, fulfillment, and margin exposure from one durable book.</p><form onSubmit={unlock} className="mt-7 space-y-4"><label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">Operations access token<input type="password" value={draft} onChange={event => setDraft(event.target.value)} className={inputClass} placeholder="Enter desk token" autoComplete="off" /></label><button disabled={loading || !draft.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--cyan-primary)]/45 bg-[var(--cyan-primary)]/12 px-4 py-3 text-sm font-semibold text-[var(--cyan-primary)] disabled:opacity-40">{loading ? <RefreshCw className="animate-spin" size={16} /> : <Database size={16} />} Open commercial workspace</button></form>{error && <p className="mt-4 text-sm text-[var(--alert-red)]">{error}</p>}<Link href="/procurement" className="mt-6 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]"><ArrowLeft size={14} /> Procurement & positions</Link></section></div></main>;
  const attention = book.commitments.filter(item => item.phase !== 'settled' || item.realizedMargin?.kind === 'incomplete').length;
  const revenues = book.commitments.flatMap(item => item.contract ? [item.contract.totalRevenue] : []); const currencies = new Set(revenues.map(item => item.currency));
  const contractedRevenue = currencies.size === 0 ? '—' : currencies.size > 1 ? `${currencies.size} currencies` : formatMoney(revenues.reduce((sum, item) => sum + item.amountMinor, 0), revenues[0].currency);
  return <main className="docs-root min-h-screen bg-[var(--bg-void)] text-[var(--text-primary)]"><header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[rgba(4,4,10,.92)] px-5 py-4 backdrop-blur-xl"><div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-4"><div><p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--cyan-primary)]">PayloadOS · Sell & fulfill</p><h1 className="mt-1 text-lg font-semibold">Inventory & Commercial Positions</h1></div><div className="flex gap-2"><Link href="/procurement" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[var(--text-secondary)]">Procurement</Link><Link href="/projects" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[var(--text-secondary)]">Project cargo</Link><Link href="/operations" className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[var(--text-secondary)]">Freight</Link><button onClick={() => setPanel({ kind: 'open_lot' })} className="flex items-center gap-2 rounded-lg border border-[var(--gold-primary)]/30 bg-[var(--gold-primary)]/8 px-3 py-2 text-xs font-semibold text-[var(--gold-light)]"><PackageOpen size={15} /> Receive inventory</button><button onClick={() => setPanel({ kind: 'refresh_cost' })} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-[var(--text-secondary)]">Refresh cost</button><button onClick={() => setPanel({ kind: 'new_commitment' })} className="flex items-center gap-2 rounded-lg border border-[var(--cyan-primary)]/30 bg-[var(--cyan-primary)]/8 px-3 py-2 text-xs font-semibold text-[var(--cyan-primary)]"><Plus size={15} /> Customer demand</button><button onClick={() => void load(token)} className="rounded-lg border border-white/10 p-2"><RefreshCw className={loading ? 'animate-spin' : ''} size={16} /></button><button onClick={() => { setToken(''); setBook(null); }} className="rounded-lg border border-white/10 p-2"><LogOut size={16} /></button></div></div></header>
    <div className="mx-auto max-w-[1500px] px-5 py-7"><section className="grid gap-3 sm:grid-cols-4"><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Inventory lots</p><p className="mt-2 font-mono text-2xl">{book.lots.length}</p></div><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Customer commitments</p><p className="mt-2 font-mono text-2xl">{book.commitments.length}</p></div><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Needs action</p><p className="mt-2 font-mono text-2xl text-[var(--gold-primary)]">{attention}</p></div><div className="rounded-xl border border-white/10 bg-[var(--bg-panel)] p-4"><p className="text-xs uppercase text-[var(--text-muted)]">Contracted revenue</p><p className="mt-2 font-mono text-2xl">{contractedRevenue}</p></div></section>{error && <div className="mt-5 rounded-lg border border-[var(--alert-red)]/30 p-3 text-sm text-[var(--alert-red)]">{error}</div>}
      <section className="mt-7"><div className="mb-3 flex items-center gap-2"><Boxes size={17} className="text-[var(--gold-primary)]" /><h2 className="font-semibold">Inventory lots</h2></div><div className="grid gap-3 lg:grid-cols-2">{book.lots.map(item => <article key={item.lot.lotId} className="rounded-xl border border-white/[0.08] bg-[var(--bg-panel)] p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-[10px] text-[var(--text-muted)]">{item.lot.lotId}</p><h3 className="mt-2 font-semibold">{item.lot.materialId}</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.lot.specificationId} · {item.lot.locationId}</p></div><span className="rounded border border-[var(--gold-primary)]/30 px-2 py-1 text-[10px] text-[var(--gold-primary)]">{item.availableAmount} {item.lot.initialQuantity.unit} available</span></div><div className="mt-4 grid grid-cols-3 gap-2 text-xs"><div><p className="text-[var(--text-muted)]">Allocated</p><p className="mt-1 font-mono">{item.allocatedAmount}</p></div><div><p className="text-[var(--text-muted)]">In movement</p><p className="mt-1 font-mono">{item.dispatchedAmount}</p></div><div><p className="text-[var(--text-muted)]">Delivered</p><p className="mt-1 font-mono">{item.deliveredAmount}</p></div></div></article>)}{book.lots.length === 0 && <div className="rounded-xl border border-dashed border-white/10 p-8 text-sm text-[var(--text-secondary)]">No inventory lots. Receive a fully accepted procurement position to begin.</div>}</div></section>
      <section className="mt-8"><div className="mb-3 flex items-center gap-2"><ShoppingCart size={17} className="text-[var(--cyan-primary)]" /><h2 className="font-semibold">Customer commitments</h2></div><div className="grid gap-3">{book.commitments.map(item => <article key={item.commitment.commitmentId} className="grid gap-4 rounded-xl border border-white/[0.08] bg-[var(--bg-panel)] p-5 md:grid-cols-[1.35fr_1fr_1fr_auto] md:items-center"><div><div className="flex items-center gap-2"><span className="rounded border border-[var(--cyan-primary)]/30 px-2 py-1 text-[10px] uppercase text-[var(--cyan-primary)]">{item.phase.replaceAll('_', ' ')}</span><span className="font-mono text-xs text-[var(--text-muted)]">{item.commitment.commitmentId}</span></div><h3 className="mt-3 font-semibold">{item.commitment.customerId}</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.commitment.materialId} · {item.commitment.specificationId}</p></div><div><p className="text-[10px] uppercase text-[var(--text-muted)]">Allocation</p><p className="mt-2 font-mono text-sm">{item.allocatedAmount} / {item.commitment.requiredQuantity.amount} {item.commitment.requiredQuantity.unit}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.allocations.length} lot allocation{item.allocations.length === 1 ? '' : 's'}</p></div><div><p className="text-[10px] uppercase text-[var(--text-muted)]">Margin exposure</p><p className="mt-2 text-sm">{marginLabel(item)}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{item.contract?.saleContractId ?? item.commitment.customerPurchaseOrderId}</p></div><button onClick={() => setPanel({ kind: 'commitment', commitmentId: item.commitment.commitmentId })} className="flex items-center justify-center gap-2 rounded-lg border border-[var(--cyan-primary)]/25 bg-[var(--cyan-primary)]/5 px-4 py-2 text-xs font-semibold text-[var(--cyan-primary)]"><Truck size={15} /> Operate</button></article>)}{book.commitments.length === 0 && <div className="rounded-xl border border-dashed border-white/10 p-8 text-sm text-[var(--text-secondary)]">No customer commitments. Register the first purchase order to begin allocation.</div>}</div></section>
    </div>{panel && <ActionPanel token={token} target={panel} onClose={() => setPanel(null)} onCommitted={() => void load(token)} />}</main>;
}
