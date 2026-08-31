'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Database, GitBranch, MapPinned, Route, Search, ShieldCheck, TimerReset } from 'lucide-react';

export type SpatialLayerKey = 'network' | 'facilities' | 'corridors' | 'restrictions' | 'temporal';

export interface SpatialLayerState {
  key: SpatialLayerKey;
  label: string;
  /** null means UNKNOWN, not zero. Renders as nothing rather than as `0`. */
  count?: number | null;
  active: boolean;
  source?: string;
  asOf?: string;
  /** False when no corpus backs this layer. A toggle that switches on an empty
   *  layer is the same overclaim as a compute button with no backend. */
  available?: boolean;
  /** Why not. Required in practice whenever `available` is false. */
  unavailableReason?: string;
}

export type SpatialOperationKey = 'route' | 'matrix' | 'isochrone' | 'service_area';

/**
 * Whether an operation can actually be answered, decided by the spatial
 * registry and passed in — never by this component.
 *
 * WHY IT IS REQUIRED RATHER THAN OPTIONAL. Four live-looking buttons over an
 * unconfigured backend claim four capabilities the terminal does not have: the
 * operator clicks, nothing happens, and the terminal reads as broken rather
 * than as unconfigured. That is the apparent-scope/effective-scope defect this
 * codebase tracks, rendered in a control rail. Making the prop optional would
 * reintroduce it by omission, so it is required and has no default.
 */
export interface SpatialComputeCapability {
  operation: SpatialOperationKey;
  available: boolean;
  /** Shown to the operator when unavailable. Never empty in that case. */
  reason: string;
}

interface Props {
  layers: SpatialLayerState[];
  onToggle: (key: SpatialLayerKey) => void;
  compute: SpatialComputeCapability[];
  onCompute?: (operation: SpatialOperationKey) => void;
  onInspect?: () => void;
  onClose?: () => void;
}

const icons = {
  network: GitBranch,
  facilities: MapPinned,
  corridors: Route,
  restrictions: ShieldCheck,
  temporal: TimerReset,
};

const operations = [
  ['route', 'Route'],
  ['matrix', 'OD Matrix'],
  ['isochrone', 'Isochrone'],
  ['service_area', 'Service Area'],
] as const;

export default function PayloadSpatialRail({ layers, onToggle, compute, onCompute, onInspect, onClose }: Props) {
  const [computeOpen, setComputeOpen] = useState(false);
  const activeCount = useMemo(() => layers.filter((layer) => layer.active).length, [layers]);
  const capability = useMemo(
    () => new Map(compute.map((c) => [c.operation, c])),
    [compute],
  );
  const unavailable = useMemo(() => compute.filter((c) => !c.available), [compute]);

  return (
    <aside className="w-[min(90vw,380px)] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080A10]/95 backdrop-blur-2xl shadow-[0_18px_70px_rgba(0,0,0,0.58)]">
      <header className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-[8px] font-mono tracking-[0.22em] text-[var(--cyan-primary)]">
            <Database className="h-3 w-3" />
            SPATIAL STATE
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text-heading)]">Physical Network</h2>
            <span className="text-[8px] font-mono uppercase tracking-[0.12em] text-white/25">{activeCount} active</span>
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-[10px] font-mono text-white/30 hover:bg-white/[0.05] hover:text-white/70">ESC</button>
        )}
      </header>

      <div className="border-b border-white/[0.06] px-4 py-3">
        <button
          onClick={onInspect}
          className="flex w-full items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5 text-left transition hover:border-[var(--border-active)] hover:bg-white/[0.045]"
        >
          <Search className="h-3.5 w-3.5 text-[var(--cyan-primary)]" />
          <span className="flex-1 text-[9px] font-mono uppercase tracking-[0.14em] text-white/45">Inspect spatial corpus</span>
          <span className="text-[8px] font-mono text-white/20">SEARCH</span>
        </button>
      </div>

      <div className="p-2">
        {layers.map((layer) => {
          const Icon = icons[layer.key];
          return (
            <button
              key={layer.key}
              onClick={layer.available === false ? undefined : () => onToggle(layer.key)}
              disabled={layer.available === false}
              aria-disabled={layer.available === false}
              aria-pressed={layer.active}
              title={layer.available === false ? layer.unavailableReason ?? 'No corpus backs this layer.' : layer.label}
              className={`group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                layer.available === false ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/[0.035]'
              }`}
            >
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${layer.active ? 'border-[var(--border-active)] bg-[var(--gold-primary)]/8 text-[var(--gold-primary)]' : 'border-white/[0.07] bg-black/20 text-white/30'}`}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[10px] font-mono uppercase tracking-[0.11em] ${layer.active ? 'text-white/75' : 'text-white/40'}`}>{layer.label}</span>
                <span className="mt-1 block truncate text-[8px] font-mono uppercase tracking-[0.1em] text-white/20">
                  {layer.source ?? 'SOURCE UNRESOLVED'}{layer.asOf ? ` · AS OF ${layer.asOf}` : ''}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {layer.count !== undefined && layer.count !== null && <span className="text-[9px] font-mono tabular-nums text-white/25">{layer.count.toLocaleString()}</span>}
                <span className={`h-1.5 w-1.5 rounded-full ${layer.active ? 'bg-[var(--alert-green)] shadow-[0_0_7px_var(--alert-green)]' : 'bg-white/15'}`} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-white/[0.06] p-3">
        <button
          onClick={() => setComputeOpen((value) => !value)}
          className="flex w-full items-center gap-2 rounded-xl border border-white/[0.07] bg-black/15 px-3 py-2.5 text-left hover:bg-white/[0.035]"
        >
          <Route className="h-3.5 w-3.5 text-[var(--gold-primary)]" />
          <span className="flex-1 text-[9px] font-mono uppercase tracking-[0.15em] text-white/55">Spatial compute</span>
          <ChevronDown className={`h-3.5 w-3.5 text-white/25 transition-transform ${computeOpen ? 'rotate-180' : ''}`} />
        </button>
        {computeOpen && (
          <>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {operations.map(([operation, label]) => {
                const cap = capability.get(operation);
                const ready = cap?.available === true;
                return (
                  <button
                    key={operation}
                    onClick={ready ? () => onCompute?.(operation) : undefined}
                    disabled={!ready}
                    title={ready ? label : cap?.reason ?? 'Capability not declared.'}
                    aria-disabled={!ready}
                    className={`rounded-lg border px-2 py-2 text-[8px] font-mono uppercase tracking-[0.1em] transition ${
                      ready
                        ? 'border-white/[0.06] text-white/35 hover:border-[var(--border-active)] hover:text-white/70'
                        : 'cursor-not-allowed border-dashed border-white/[0.05] text-white/15'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {unavailable.length > 0 && (
              /* The refusal is stated once, in full, rather than left as four
                 dead buttons for the operator to discover by clicking. */
              <p className="mt-2 rounded-lg border border-[var(--alert-orange)]/25 bg-[var(--alert-orange)]/[0.06] px-2.5 py-2 text-[9px] leading-relaxed font-mono text-[var(--alert-orange)]/85">
                {unavailable.length === operations.length ? 'No spatial compute available. ' : `${unavailable.length} of ${operations.length} operations unavailable. `}
                {unavailable[0].reason}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
