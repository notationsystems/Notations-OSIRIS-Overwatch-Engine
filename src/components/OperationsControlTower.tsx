'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Truck,
  Wrench,
} from 'lucide-react';
import OperatorActionCockpit from './OperatorActionCockpit';
import type {
  ControlTowerIssue,
  ControlTowerLoad,
  ControlTowerSeverity,
  ControlTowerSnapshot,
} from '@/lib/economy/controlTower';
import type { DecisionMetric } from '@/lib/economy/decisionEpisode';

type TowerFilter = 'attention' | 'all' | 'critical' | 'in_motion' | 'completed';
type TowerFailure = { readonly kind?: string; readonly detail?: string; readonly remedy?: string };

function isTowerSnapshot(body: ControlTowerSnapshot | TowerFailure): body is ControlTowerSnapshot {
  return body.kind === 'control_tower_snapshot' && 'loads' in body && 'portfolio' in body;
}

const FILTERS: ReadonlyArray<{ id: TowerFilter; label: string }> = [
  { id: 'attention', label: 'Needs action' },
  { id: 'all', label: 'All loads' },
  { id: 'critical', label: 'Critical' },
  { id: 'in_motion', label: 'In motion' },
  { id: 'completed', label: 'Completed' },
];

const severityStyle: Record<ControlTowerSeverity, string> = {
  critical: 'border-[var(--alert-red)]/45 bg-[var(--alert-red)]/10 text-[var(--alert-red)]',
  high: 'border-[var(--alert-orange)]/45 bg-[var(--alert-orange)]/10 text-[var(--alert-orange)]',
  medium: 'border-[var(--gold-primary)]/40 bg-[var(--gold-primary)]/10 text-[var(--gold-light)]',
  low: 'border-[var(--cyan-primary)]/35 bg-[var(--cyan-primary)]/8 text-[var(--cyan-primary)]',
  none: 'border-[var(--alert-green)]/35 bg-[var(--alert-green)]/8 text-[var(--alert-green)]',
};

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatInstant(value: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

function timeTo(value: string | null, now: string): string | null {
  if (!value) return null;
  const delta = Date.parse(value) - Date.parse(now);
  if (!Number.isFinite(delta)) return null;
  const absoluteMinutes = Math.round(Math.abs(delta) / 60_000);
  const amount = absoluteMinutes >= 1440
    ? `${Math.round(absoluteMinutes / 1440)}d`
    : absoluteMinutes >= 60
      ? `${Math.round(absoluteMinutes / 60)}h`
      : `${absoluteMinutes}m`;
  return delta < 0 ? `${amount} overdue` : `due in ${amount}`;
}

function formatMetric(metric: DecisionMetric | null): string {
  if (!metric) return '—';
  if (metric.unit === 'money_minor') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: metric.currency ?? 'USD', maximumFractionDigits: 0,
    }).format(metric.value / 100);
  }
  return `${metric.value.toLocaleString()} ${metric.unit}`;
}

function isInMotion(load: ControlTowerLoad): boolean {
  return ['picked_up', 'in_transit', 'arrived'].includes(load.state.tracking ?? '');
}

function StateChip({ label, value }: { readonly label: string; readonly value: string | null }) {
  const positive = ['authorized', 'delivered', 'accepted', 'outcome_captured', 'picked_up', 'in_transit', 'arrived'].includes(value ?? '');
  const negative = ['refused', 'failed', 'rejected', 'exception'].includes(value ?? '');
  return (
    <span
      title={label}
      className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
        negative
          ? 'border-[var(--alert-red)]/35 text-[var(--alert-red)]'
          : positive
            ? 'border-[var(--alert-green)]/30 text-[var(--alert-green)]'
            : 'border-white/10 text-[var(--text-secondary)]'
      }`}
    >
      <span className="text-[var(--text-muted)]">{label}</span>
      {value ? humanize(value) : 'Missing'}
    </span>
  );
}

function IssueDetail({ issue, asOf }: { readonly issue: ControlTowerIssue; readonly asOf: string }) {
  const deadline = timeTo(issue.deadlineAt, asOf);
  return (
    <div className="grid gap-3 rounded-lg border border-white/[0.07] bg-black/20 p-4 lg:grid-cols-[150px_1fr_1fr]">
      <div>
        <span className={`inline-flex rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.15em] ${severityStyle[issue.severity]}`}>
          {issue.severity} · {humanize(issue.code)}
        </span>
        {deadline && <p className="mt-2 font-mono text-[11px] text-[var(--text-secondary)]">{deadline}</p>}
      </div>
      <div>
        <p className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Observed</p>
        <p className="mt-1 text-sm leading-6 text-[var(--text-primary)]">{issue.detail}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Operator remedy</p>
        <p className="mt-1 text-sm leading-6 text-[var(--text-primary)]">{issue.remedy}</p>
        <p className="mt-2 font-mono text-[10px] text-[var(--text-muted)]">
          {issue.evidenceIds.length} evidence reference{issue.evidenceIds.length === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}

function LoadCard({
  load,
  asOf,
  expanded,
  onToggle,
  onOperate,
}: {
  readonly load: ControlTowerLoad;
  readonly asOf: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOperate: () => void;
}) {
  const nextDeadline = timeTo(load.nextAction?.deadlineAt ?? null, asOf);
  return (
    <article className="overflow-hidden rounded-xl border border-white/[0.08] bg-[var(--bg-panel)] shadow-2xl shadow-black/20">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full gap-4 p-4 text-left hover:bg-white/[0.025] md:grid-cols-[minmax(250px,1.35fr)_minmax(190px,1fr)_minmax(220px,1.15fr)_minmax(150px,.75fr)_28px] md:items-center md:p-5"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${severityStyle[load.attentionLevel]}`}>
              {load.attentionLevel === 'none' ? 'clear' : load.attentionLevel}
            </span>
            <span className="truncate font-mono text-xs text-[var(--text-secondary)]">{load.loadId ?? load.operationId}</span>
          </div>
          <h2 className="mt-3 text-base font-semibold text-[var(--text-heading)] md:text-lg">
            {load.route.origin ?? 'Origin missing'}
            <span className="mx-2 text-[var(--gold-primary)]">→</span>
            {load.route.destination ?? 'Destination missing'}
          </h2>
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {load.laneId ?? 'Lane not assigned'} · {load.route.equipment ?? 'Equipment missing'}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">Carrier / commitment</p>
          <p className="mt-2 truncate font-mono text-sm text-[var(--cyan-primary)]">{load.carrierId ?? 'Not assigned'}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">Pickup {formatInstant(load.timing.pickupWindow?.start ?? null)}</p>
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">Next operator action</p>
          <p className="mt-2 text-sm font-medium text-[var(--text-heading)]">
            {load.nextAction ? humanize(load.nextAction.code) : 'No exception detected'}
          </p>
          <p className={`mt-1 font-mono text-[11px] ${nextDeadline?.includes('overdue') ? 'text-[var(--alert-red)]' : 'text-[var(--text-secondary)]'}`}>
            {nextDeadline ?? (load.state.outcomeCaptured ? 'Outcome captured' : 'No deadline recorded')}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">Economics</p>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-1">
            <p className="font-mono text-xs text-[var(--text-secondary)]">Quote <span className="text-[var(--text-primary)]">{formatMetric(load.economics.quotedCost)}</span></p>
            <p className="font-mono text-xs text-[var(--text-secondary)]">Margin <span className="text-[var(--alert-green)]">{formatMetric(load.economics.grossMargin)}</span></p>
          </div>
        </div>

        <span className="hidden text-[var(--text-muted)] md:block" aria-hidden="true">
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-white/[0.07] bg-white/[0.015] p-4 md:p-5">
          <div className="mb-4 flex flex-wrap gap-2">
            <StateChip label="Phase" value={load.state.operationPhase} />
            <StateChip label="Auth" value={load.state.authorization} />
            <StateChip label="Tender" value={load.state.tenderDelivery} />
            <StateChip label="Ack" value={load.state.acknowledgement} />
            <StateChip label="Track" value={load.state.tracking} />
          </div>
          <div className="grid gap-3">
            {load.issues.length > 0
              ? load.issues.map(issue => <IssueDetail key={issue.code} issue={issue} asOf={asOf} />)
              : (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--alert-green)]/20 bg-[var(--alert-green)]/5 p-4 text-sm text-[var(--alert-green)]">
                  <CheckCircle2 size={17} /> No open exception in the durable operational record.
                </div>
              )}
          </div>
          <div className="mt-4 grid gap-2 border-t border-white/[0.06] pt-4 font-mono text-[10px] text-[var(--text-muted)] md:grid-cols-4">
            <span>Operation {load.operationId}</span>
            <span>Episode {load.episodeId ?? '—'}</span>
            <span>Action {load.actionId ?? '—'}</span>
            <span>Last known {formatInstant(load.timing.lastTrackingKnownAt)}</span>
          </div>
          {!load.state.outcomeCaptured && (
            <button
              type="button"
              onClick={onOperate}
              className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--gold-primary)]/35 bg-[var(--gold-primary)]/10 px-3 py-2 text-xs font-semibold text-[var(--gold-light)] hover:bg-[var(--gold-primary)]/15"
            >
              <Wrench size={14} /> Take typed action
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'normal',
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'critical' | 'high' | 'normal' | 'positive';
}) {
  const color = tone === 'critical'
    ? 'text-[var(--alert-red)]'
    : tone === 'high'
      ? 'text-[var(--alert-orange)]'
      : tone === 'positive'
        ? 'text-[var(--alert-green)]'
        : 'text-[var(--text-heading)]';
  return (
    <div className="rounded-xl border border-white/[0.08] bg-[var(--bg-panel)] p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-[var(--text-muted)]">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

export default function OperationsControlTower() {
  const [token, setToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [tower, setTower] = useState<ControlTowerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TowerFilter>('attention');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cockpitOperationId, setCockpitOperationId] = useState<string | null | undefined>(undefined);

  const loadTower = useCallback(async (credential: string, silent = false) => {
    if (!credential) return;
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/freight/control-tower', {
        method: 'GET',
        headers: { authorization: `Bearer ${credential}` },
        cache: 'no-store',
      });
      const body = await response.json() as ControlTowerSnapshot | TowerFailure;
      if (!response.ok || !isTowerSnapshot(body)) {
        const failure = body as TowerFailure;
        throw new Error([failure.detail, failure.remedy].filter(Boolean).join(' ')
          || `Operations service returned ${response.status}.`);
      }
      setTower(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load the operations record.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadTower(token, true);
    };
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadTower, token]);

  const unlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const credential = tokenDraft.trim();
    if (!credential) return;
    setToken(credential);
    setTokenDraft('');
    void loadTower(credential);
  };

  const lock = () => {
    setToken('');
    setTokenDraft('');
    setTower(null);
    setError(null);
    setExpanded(new Set());
    setCockpitOperationId(undefined);
  };

  const filteredLoads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (tower?.loads ?? []).filter(load => {
      const matchesFilter = filter === 'all'
        || (filter === 'attention' && load.nextAction !== null)
        || (filter === 'critical' && load.attentionLevel === 'critical')
        || (filter === 'in_motion' && isInMotion(load))
        || (filter === 'completed' && load.state.outcomeCaptured);
      if (!matchesFilter) return false;
      if (!normalized) return true;
      return [
        load.operationId,
        load.loadId,
        load.carrierId,
        load.laneId,
        load.route.origin,
        load.route.destination,
        load.nextAction?.code,
      ].some(value => value?.toLowerCase().includes(normalized));
    });
  }, [filter, query, tower]);

  if (!token || !tower) {
    return (
      <main className="docs-root min-h-screen bg-[radial-gradient(circle_at_50%_-20%,rgba(var(--gold-rgb),0.16),transparent_38%),var(--bg-void)] px-5 py-8 md:px-10 md:py-12">
        <div className="mx-auto flex min-h-[80vh] max-w-lg items-center justify-center">
          <section className="w-full rounded-2xl border border-[var(--border-active)] bg-[var(--bg-panel)] p-6 shadow-2xl shadow-black/50 md:p-8">
            <div className="mb-8 flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--gold-primary)]">Payload Terminal</p>
                <h1 className="mt-2 text-2xl font-semibold text-[var(--text-heading)]">Operations Control Tower</h1>
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  One exception queue across intake, carrier authorization, dispatch, tracking, delivery, and settlement.
                </p>
              </div>
              <div className="rounded-xl border border-[var(--gold-primary)]/20 bg-[var(--gold-primary)]/8 p-3 text-[var(--gold-primary)]">
                <ShieldCheck size={22} />
              </div>
            </div>

            <form onSubmit={unlock} className="space-y-4">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">Operations access token</span>
                <input
                  type="password"
                  value={tokenDraft}
                  onChange={event => setTokenDraft(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-[var(--text-primary)] outline-none focus:border-[var(--gold-primary)]/60 focus:ring-2 focus:ring-[var(--gold-primary)]/10"
                  placeholder="Enter desk token"
                  aria-label="Operations access token"
                />
              </label>
              <button
                type="submit"
                disabled={loading || !tokenDraft.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--gold-primary)]/45 bg-[var(--gold-primary)]/15 px-4 py-3 text-sm font-semibold text-[var(--gold-light)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loading ? <RefreshCw className="animate-spin" size={16} /> : <Database size={16} />}
                {loading ? 'Opening durable record…' : 'Open operations workspace'}
              </button>
            </form>

            {error && (
              <div role="alert" className="mt-4 flex gap-3 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-3 text-sm leading-5 text-[var(--alert-red)]">
                <AlertTriangle className="mt-0.5 shrink-0" size={16} />
                <span>{error}</span>
              </div>
            )}
            <p className="mt-5 text-center font-mono text-[10px] leading-5 text-[var(--text-muted)]">
              The credential stays in this tab&apos;s memory and is cleared when you lock or close the workspace.
            </p>
            <Link href="/" className="mt-5 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--cyan-primary)]">
              <ArrowLeft size={14} /> Return to world view
            </Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="docs-root min-h-screen bg-[radial-gradient(circle_at_50%_-20%,rgba(var(--gold-rgb),0.12),transparent_32%),var(--bg-void)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[rgba(4,4,10,.92)] px-4 py-4 backdrop-blur-xl md:px-8">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/" aria-label="Return to world view" className="rounded-lg border border-white/10 p-2 text-[var(--text-secondary)] hover:border-[var(--gold-primary)]/35 hover:text-[var(--gold-primary)]">
              <ArrowLeft size={17} />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--alert-green)] shadow-[0_0_10px_var(--alert-green)]" />
                <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--gold-primary)]">Payload · Operations OS</p>
              </div>
              <h1 className="mt-1 text-lg font-semibold text-[var(--text-heading)]">Control Tower</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <p className="hidden font-mono text-[10px] text-[var(--text-muted)] sm:block">As of {formatInstant(tower.asOf)}</p>
            <button
              type="button"
              onClick={() => setCockpitOperationId(null)}
              className="flex items-center gap-2 rounded-lg border border-[var(--gold-primary)]/30 bg-[var(--gold-primary)]/8 px-3 py-2 text-xs font-semibold text-[var(--gold-light)]"
            >
              <Plus size={15} /> New load
            </button>
            <button
              type="button"
              onClick={() => void loadTower(token)}
              disabled={loading}
              className="rounded-lg border border-white/10 p-2 text-[var(--text-secondary)] hover:text-[var(--cyan-primary)] disabled:opacity-40"
              aria-label="Refresh operations"
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} size={17} />
            </button>
            <button
              type="button"
              onClick={lock}
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-[var(--text-secondary)] hover:border-[var(--alert-red)]/35 hover:text-[var(--alert-red)]"
            >
              <LogOut size={15} /> Lock
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8 md:py-8">
        {error && (
          <div role="alert" className="mb-5 flex items-start gap-3 rounded-lg border border-[var(--alert-red)]/30 bg-[var(--alert-red)]/8 p-4 text-sm text-[var(--alert-red)]">
            <AlertTriangle className="mt-0.5 shrink-0" size={17} />
            <div><strong>Refresh failed.</strong> {error} The last verified snapshot remains visible.</div>
          </div>
        )}

        <section aria-label="Portfolio summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <SummaryCard label="Active loads" value={tower.portfolio.activeLoads} />
          <SummaryCard label="Needs action" value={tower.portfolio.needingAttention} tone="high" />
          <SummaryCard label="Critical" value={tower.portfolio.critical} tone="critical" />
          <SummaryCard label="High" value={tower.portfolio.high} tone="high" />
          <SummaryCard label="In motion" value={tower.portfolio.inMotion} />
          <SummaryCard label="Awaiting close" value={tower.portfolio.awaitingSettlement} tone="positive" />
        </section>

        <section className="mt-6 flex flex-col justify-between gap-4 rounded-xl border border-white/[0.07] bg-[var(--bg-panel)] p-3 md:flex-row md:items-center">
          <div className="flex gap-1 overflow-x-auto pb-1 md:pb-0">
            {FILTERS.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium ${filter === item.id
                  ? 'bg-[var(--gold-primary)]/15 text-[var(--gold-light)]'
                  : 'text-[var(--text-secondary)] hover:bg-white/[0.04] hover:text-[var(--text-primary)]'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="relative block md:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={15} />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Load, carrier, lane, location…"
              className="w-full rounded-lg border border-white/10 bg-black/20 py-2 pl-9 pr-3 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--cyan-primary)]/35"
            />
          </label>
        </section>

        <div className="mt-5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <p>{filteredLoads.length} of {tower.portfolio.totalLoads} loads</p>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5"><Clock3 size={12} /> Refreshes every 30s</span>
            <span className="hidden items-center gap-1.5 sm:flex"><Truck size={12} /> Exception-first order</span>
          </div>
        </div>

        <section aria-label="Load operations" className="mt-3 grid gap-3">
          {filteredLoads.map(load => (
            <LoadCard
              key={load.operationId}
              load={load}
              asOf={tower.asOf}
              expanded={expanded.has(load.operationId)}
              onToggle={() => setExpanded(current => {
                const next = new Set(current);
                if (next.has(load.operationId)) next.delete(load.operationId);
                else next.add(load.operationId);
                return next;
              })}
              onOperate={() => setCockpitOperationId(load.operationId)}
            />
          ))}
          {filteredLoads.length === 0 && (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-[var(--bg-panel)] p-8 text-center">
              <CheckCircle2 className="text-[var(--alert-green)]" size={28} />
              <h2 className="mt-3 font-semibold text-[var(--text-heading)]">No loads match this view</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-[var(--text-secondary)]">
                Change the filter or search. A blank attention queue means the journals expose no current exception—not that missing data was treated as success.
              </p>
            </div>
          )}
        </section>
      </div>
      {cockpitOperationId !== undefined && (
        <OperatorActionCockpit
          token={token}
          operationId={cockpitOperationId}
          onClose={() => setCockpitOperationId(undefined)}
          onCommitted={() => void loadTower(token)}
        />
      )}
    </main>
  );
}
