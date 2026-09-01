'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, X } from 'lucide-react';
import type {
  OperatorActionDescriptor,
  OperatorActionKind,
  OperatorCockpitSnapshot,
} from '@/lib/economy/operatorActions';

type Failure = { readonly detail?: string; readonly remedy?: string; readonly error?: string };

function localDateTime(value?: string | null): string {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function iso(form: FormData, name: string): string | undefined {
  const value = String(form.get(name) ?? '').trim();
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

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

const inputClass = 'mt-1.5 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--cyan-primary)]/45';

function Field({ label, name, type = 'text', required = true, defaultValue, placeholder, min, step }: {
  readonly label: string;
  readonly name: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly defaultValue?: string | number;
  readonly placeholder?: string;
  readonly min?: string;
  readonly step?: string;
}) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
      {label}{!required && <span className="ml-1 normal-case tracking-normal text-[var(--text-muted)]">optional</span>}
      <input className={inputClass} name={name} type={type} required={required} defaultValue={defaultValue} placeholder={placeholder} min={min} step={step} />
    </label>
  );
}

function Select({ label, name, children, defaultValue }: {
  readonly label: string;
  readonly name: string;
  readonly children: React.ReactNode;
  readonly defaultValue?: string;
}) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
      {label}
      <select className={inputClass} name={name} defaultValue={defaultValue}>{children}</select>
    </label>
  );
}

function NewOpportunityFields({ now }: { readonly now: number }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Operation / opportunity ID" name="operationId" placeholder="opp:customer:lane:001" />
        <Field label="Source reference" name="sourceReference" placeholder="email:message-id" />
        <Field label="Origin" name="origin" placeholder="Toronto, ON" />
        <Field label="Destination" name="destination" placeholder="Detroit, MI" />
        <Field label="Equipment" name="equipment" placeholder="53 ft dry van" />
        <Field label="Commodity" name="commodity" required={false} placeholder="Packaged food" />
        <Field label="Pickup window starts" name="pickupStart" type="datetime-local" defaultValue={localDateTime(new Date(now + 60 * 60_000).toISOString())} />
        <Field label="Pickup window ends" name="pickupEnd" type="datetime-local" defaultValue={localDateTime(new Date(now + 3 * 60 * 60_000).toISOString())} />
        <Field label="Delivery window starts" name="deliveryStart" type="datetime-local" required={false} />
        <Field label="Delivery window ends" name="deliveryEnd" type="datetime-local" required={false} />
        <Field label="Weight (lb)" name="weightLbs" type="number" required={false} min="0" step="1" />
        <Field label="Target rate" name="targetRate" type="number" required={false} min="0" step="0.01" />
      </div>
    </>
  );
}

function ActionFields({ action, cockpit }: { readonly action: OperatorActionKind; readonly cockpit: OperatorCockpitSnapshot }) {
  const load = cockpit.operation;
  const selected = cockpit.actions.find(item => item.action === action);
  const pickupStart = load.opportunity.fields.pickupWindow.state === 'present'
    ? String(load.opportunity.fields.pickupWindow.value).split('/')[0]
    : null;
  const pickupEnd = load.opportunity.fields.pickupWindow.state === 'present'
    ? String(load.opportunity.fields.pickupWindow.value).split('/')[1]
    : null;
  const currency = load.alternatives.find(item => item.alternative.quotedCost)?.alternative.quotedCost?.currency ?? 'CAD';

  if (action === 'add_carrier_alternative') return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Quote / capacity reference" name="sourceReference" placeholder="quote:carrier:123" />
      <Field label="Carrier ID" name="carrierId" placeholder="carrier:mc-123456" />
      <Field label="Lane ID" name="laneId" placeholder="lane:TOR-DET" />
      <Field label="Quoted carrier cost" name="quotedCost" type="number" min="0" step="0.01" />
      <Field label="Departure starts" name="departureStart" type="datetime-local" defaultValue={localDateTime(pickupStart)} />
      <Field label="Departure ends" name="departureEnd" type="datetime-local" defaultValue={localDateTime(pickupEnd)} />
      <Field label="Currency" name="currency" defaultValue={currency} />
    </div>
  );
  if (action === 'authorize_carrier') return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Carrier alternative" name="actionId">
        {(selected?.alternatives ?? []).map(item => <option key={item.actionId} value={item.actionId}>{item.carrierId} · {item.actionId.slice(0, 18)}…</option>)}
      </Select>
      <Field label="Compliance record reference" name="sourceReference" placeholder="coi:carrier:2026" />
      <Field label="Load ID" name="loadId" placeholder="load:customer:001" />
      <Field label="BOL carrier ID" name="bolCarrierId" placeholder="Must match selected carrier" />
      <Field label="Declared cargo value" name="declaredValue" type="number" min="0" step="0.01" required={false} />
      <Field label="Cargo cover limit" name="cargoCover" type="number" min="0" step="0.01" />
      <Field label="Currency" name="currency" defaultValue={currency} />
      <Field label="Insurance expires" name="insuranceExpiresAt" type="datetime-local" />
      <Field label="Authority granted" name="authorityGrantedAt" type="datetime-local" />
      <Field label="Authority revoked" name="authorityRevokedAt" type="datetime-local" required={false} />
    </div>
  );
  if (action === 'assign_carrier') return (
    <div className="grid gap-3">
      <Select label="Authorized carrier" name="actionId">
        {(selected?.alternatives ?? []).map(item => <option key={item.actionId} value={item.actionId}>{item.carrierId}</option>)}
      </Select>
      <Field label="Selection rationale" name="rationale" placeholder="Best authorized service/cost fit for this load." />
    </div>
  );
  if (action === 'record_carrier_acknowledgement') return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Carrier response" name="status" defaultValue="accepted"><option value="accepted">Accepted</option><option value="rejected">Rejected</option></Select>
      <Field label="Response occurred at" name="occurredAt" type="datetime-local" defaultValue={localDateTime()} />
      <Field label="Response reference" name="sourceReference" placeholder="email:ack:123" />
    </div>
  );
  if (action === 'record_tracking') return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Physical status" name="status" defaultValue="in_transit">
        <option value="picked_up">Picked up</option><option value="in_transit">In transit</option><option value="arrived">Arrived</option><option value="delivered">Delivered</option><option value="exception">Exception</option>
      </Select>
      <Field label="Status occurred at" name="occurredAt" type="datetime-local" defaultValue={localDateTime()} />
      <Field label="Tracking reference" name="sourceReference" placeholder="telematics:event:123" />
    </div>
  );
  if (action === 'capture_settlement') return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Settlement / POD reference" name="sourceReference" placeholder="settlement:load:001" />
      <Field label="Currency" name="currency" defaultValue={currency} />
      <Field label="Picked up at" name="pickupAt" type="datetime-local" defaultValue={localDateTime(pickupStart)} />
      <Field label="Delivered at" name="deliveredAt" type="datetime-local" defaultValue={localDateTime()} />
      <Field label="Carrier invoice" name="carrierInvoice" type="number" min="0" step="0.01" required={false} />
      <Field label="Accessorial cost" name="accessorialCost" type="number" min="0" step="0.01" required={false} />
      <Field label="Shipper revenue" name="shipperRevenue" type="number" min="0" step="0.01" required={false} />
      <Field label="Damage cost" name="damageCost" type="number" min="0" step="0.01" required={false} />
      <Select label="Carrier rejected load" name="rejected" defaultValue="false"><option value="false">No</option><option value="true">Yes</option></Select>
      <div />
      <Field label="Origin arrived" name="originArrivedAt" type="datetime-local" required={false} />
      <Field label="Origin departed" name="originDepartedAt" type="datetime-local" required={false} />
      <Field label="Destination arrived" name="destinationArrivedAt" type="datetime-local" required={false} />
      <Field label="Destination departed" name="destinationDepartedAt" type="datetime-local" required={false} />
    </div>
  );
  return (
    <div className="rounded-lg border border-[var(--cyan-primary)]/20 bg-[var(--cyan-primary)]/5 p-4 text-sm leading-6 text-[var(--text-secondary)]">
      The server will derive all journal identities and exact load/carrier bindings. Confirm to continue.
    </div>
  );
}

function payloadFor(action: OperatorActionKind, operationId: string | null, form: FormData): Record<string, unknown> {
  if (action === 'create_opportunity') return {
    operationId: text(form, 'operationId'), sourceReference: text(form, 'sourceReference'),
    origin: text(form, 'origin'), destination: text(form, 'destination'), equipment: text(form, 'equipment'),
    pickupStart: iso(form, 'pickupStart'), pickupEnd: iso(form, 'pickupEnd'),
    deliveryStart: iso(form, 'deliveryStart'), deliveryEnd: iso(form, 'deliveryEnd'),
    commodity: text(form, 'commodity') || undefined, weightLbs: optionalNumber(form, 'weightLbs'),
    targetRate: optionalNumber(form, 'targetRate'),
  };
  const base = { operationId };
  if (action === 'add_carrier_alternative') return {
    ...base, sourceReference: text(form, 'sourceReference'), carrierId: text(form, 'carrierId'), laneId: text(form, 'laneId'),
    departureStart: iso(form, 'departureStart'), departureEnd: iso(form, 'departureEnd'),
    quotedCostMinor: minor(form, 'quotedCost'), currency: text(form, 'currency').toUpperCase(),
  };
  if (action === 'authorize_carrier') return {
    ...base, actionId: text(form, 'actionId'), sourceReference: text(form, 'sourceReference'), loadId: text(form, 'loadId'),
    bolCarrierId: text(form, 'bolCarrierId'), declaredValueMinor: minor(form, 'declaredValue'),
    currency: text(form, 'currency').toUpperCase(), insuranceExpiresAt: iso(form, 'insuranceExpiresAt'),
    cargoCoverAmountMinor: minor(form, 'cargoCover'), authorityGrantedAt: iso(form, 'authorityGrantedAt'),
    authorityRevokedAt: iso(form, 'authorityRevokedAt'),
  };
  if (action === 'assign_carrier') return { ...base, actionId: text(form, 'actionId'), rationale: text(form, 'rationale') };
  if (action === 'record_carrier_acknowledgement' || action === 'record_tracking') return {
    ...base, status: text(form, 'status'), occurredAt: iso(form, 'occurredAt'), sourceReference: text(form, 'sourceReference'),
  };
  if (action === 'capture_settlement') return {
    ...base, sourceReference: text(form, 'sourceReference'), pickupAt: iso(form, 'pickupAt'), deliveredAt: iso(form, 'deliveredAt'),
    currency: text(form, 'currency').toUpperCase(), carrierInvoiceMinor: minor(form, 'carrierInvoice'),
    accessorialCostMinor: minor(form, 'accessorialCost'), shipperRevenueMinor: minor(form, 'shipperRevenue'),
    damageCostMinor: minor(form, 'damageCost'), rejected: text(form, 'rejected') === 'true',
    originArrivedAt: iso(form, 'originArrivedAt'), originDepartedAt: iso(form, 'originDepartedAt'),
    destinationArrivedAt: iso(form, 'destinationArrivedAt'), destinationDepartedAt: iso(form, 'destinationDepartedAt'),
  };
  return base;
}

export default function OperatorActionCockpit({ token, operationId, onClose, onCommitted }: {
  readonly token: string;
  readonly operationId: string | null;
  readonly onClose: () => void;
  readonly onCommitted: () => void;
}) {
  const [actorId, setActorId] = useState('desk:operator');
  const [cockpit, setCockpit] = useState<OperatorCockpitSnapshot | null>(null);
  const [action, setAction] = useState<OperatorActionKind>(operationId ? 'add_carrier_alternative' : 'create_opportunity');
  const [loading, setLoading] = useState(!!operationId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formDefaultNow] = useState(() => Date.now());
  const requestRef = useRef<{ readonly payloadKey: string; readonly requestId: string } | null>(null);

  useEffect(() => {
    if (!operationId) return;
    let active = true;
    fetch(`/api/freight/operator-actions?operationId=${encodeURIComponent(operationId)}`, {
      headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
    }).then(async response => {
      const body = await response.json() as OperatorCockpitSnapshot | Failure;
      if (!response.ok || !('kind' in body) || body.kind !== 'operator_cockpit_snapshot') {
        const failure = body as Failure;
        throw new Error([failure.detail, failure.remedy].filter(Boolean).join(' ') || 'Unable to open action cockpit.');
      }
      if (!active) return;
      setCockpit(body);
      setAction(body.actions.find(item => item.recommended)?.action ?? body.actions[0]?.action ?? 'record_tracking');
      setError(null);
    }).catch(cause => active && setError(cause instanceof Error ? cause.message : 'Unable to open action cockpit.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [operationId, token]);

  const selected = useMemo<OperatorActionDescriptor | null>(() =>
    cockpit?.actions.find(item => item.action === action) ?? null, [action, cockpit]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    const form = new FormData(event.currentTarget);
    const payload = payloadFor(action, operationId, form);
    const payloadKey = JSON.stringify({ action, actorId: actorId.trim(), payload });
    const requestId = requestRef.current?.payloadKey === payloadKey
      ? requestRef.current.requestId
      : `request:${crypto.randomUUID()}`;
    requestRef.current = { payloadKey, requestId };
    const body = {
      action,
      requestId,
      actorId: actorId.trim(),
      payload,
    };
    try {
      const response = await fetch('/api/freight/operator-actions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json() as Failure & { action?: string };
      if (!response.ok) throw new Error([result.detail, result.remedy].filter(Boolean).join(' ') || `Action refused (${response.status}).`);
      requestRef.current = null;
      setSuccess(`${selected?.label ?? 'Action'} recorded in the durable workflow.`);
      onCommitted();
      window.setTimeout(onClose, 900);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Operator action cockpit">
      <section className="flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-[var(--bg-panel)] shadow-2xl shadow-black">
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] p-5">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--gold-primary)]">Safe operator action</p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--text-heading)]">{operationId ?? 'New load opportunity'}</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">Enter business facts only. Payload derives command, evidence, and binding identities on the server.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-white/10 p-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]" aria-label="Close action cockpit"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
            Acting operator ID
            <input className={inputClass} value={actorId} onChange={event => setActorId(event.target.value)} required />
          </label>

          {loading ? <div className="flex min-h-52 items-center justify-center gap-3 text-sm text-[var(--text-secondary)]"><Loader2 className="animate-spin" size={18} /> Resolving durable load state…</div> : (
            <>
              {operationId && cockpit && (
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  {cockpit.actions.map(item => (
                    <button key={item.action} type="button" onClick={() => { requestRef.current = null; setAction(item.action); setError(null); setSuccess(null); }}
                      className={`rounded-lg border p-3 text-left ${action === item.action ? 'border-[var(--gold-primary)]/50 bg-[var(--gold-primary)]/10' : 'border-white/10 bg-black/15 hover:border-white/20'}`}>
                      <span className="text-sm font-semibold text-[var(--text-heading)]">{item.label}</span>
                      {item.recommended && <span className="ml-2 rounded bg-[var(--alert-green)]/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--alert-green)]">next</span>}
                      <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{item.summary}</p>
                    </button>
                  ))}
                </div>
              )}

              {operationId && cockpit?.actions.length === 0 ? (
                <div className="mt-5 flex gap-3 rounded-lg border border-[var(--alert-green)]/25 bg-[var(--alert-green)]/5 p-4 text-sm text-[var(--alert-green)]"><CheckCircle2 className="shrink-0" size={18} /> No cockpit action is required for this completed load.</div>
              ) : (
                <form key={action} onSubmit={submit} className="mt-6 space-y-5">
                  <div>
                    <div className="flex items-center gap-2"><ShieldCheck className="text-[var(--cyan-primary)]" size={17} /><h3 className="font-semibold text-[var(--text-heading)]">{selected?.label ?? 'Create load opportunity'}</h3></div>
                    <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{selected?.summary ?? 'Start a new typed load workflow from sanitized business facts.'}</p>
                  </div>
                  {operationId && cockpit ? <ActionFields action={action} cockpit={cockpit} /> : <NewOpportunityFields now={formDefaultNow} />}
                  {error && <div role="alert" className="flex gap-3 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-3 text-sm leading-5 text-[var(--alert-red)]"><AlertTriangle className="mt-0.5 shrink-0" size={16} />{error}</div>}
                  {success && <div role="status" className="flex gap-3 rounded-lg border border-[var(--alert-green)]/30 bg-[var(--alert-green)]/8 p-3 text-sm text-[var(--alert-green)]"><CheckCircle2 className="shrink-0" size={16} />{success}</div>}
                  <button type="submit" disabled={submitting || !actorId.trim()} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--gold-primary)]/45 bg-[var(--gold-primary)]/15 px-4 py-3 text-sm font-semibold text-[var(--gold-light)] disabled:cursor-not-allowed disabled:opacity-40">
                    {submitting ? <Loader2 className="animate-spin" size={16} /> : <ShieldCheck size={16} />}
                    {submitting ? 'Validating and recording…' : `Confirm ${selected?.label ?? 'load opportunity'}`}
                  </button>
                </form>
              )}
            </>
          )}
          {error && loading && <div role="alert" className="mt-5 flex gap-3 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-3 text-sm text-[var(--alert-red)]"><AlertTriangle size={16} />{error}</div>}
        </div>
      </section>
    </div>
  );
}
