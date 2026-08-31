'use client';

import { useEffect, useState } from 'react';
import { Activity, Command, Database, Layers3, Map, Search, ShieldCheck } from 'lucide-react';

interface Props {
  backendStatus: 'connecting' | 'connected' | 'error';
  /** Features fetched in this session. Not a world count, not the render sample. */
  entityCount: number;
  showLayers: boolean;
  showMarkets: boolean;
  showEconomy: boolean;
  showAlerts: boolean;
  onSearch: () => void;
  onLayers: () => void;
  onMarkets: () => void;
  onEconomy: () => void;
  onAlerts: () => void;
}

const nav = [
  { key: 'layers', label: 'Layers', icon: Layers3 },
  { key: 'markets', label: 'Markets', icon: Activity },
  { key: 'economy', label: 'Economy', icon: Database },
  { key: 'alerts', label: 'Exceptions', icon: ShieldCheck },
] as const;

export default function PayloadCommandBar({
  backendStatus,
  entityCount,
  showLayers,
  showMarkets,
  showEconomy,
  showAlerts,
  onSearch,
  onLayers,
  onMarkets,
  onEconomy,
  onAlerts,
}: Props) {
  const [isCompact, setIsCompact] = useState(false);

  useEffect(() => {
    const update = () => setIsCompact(window.innerWidth < 1100);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const active = { layers: showLayers, markets: showMarkets, economy: showEconomy, alerts: showAlerts };
  const handlers = { layers: onLayers, markets: onMarkets, economy: onEconomy, alerts: onAlerts };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[420] pointer-events-none w-[min(92vw,1180px)]">
      <div className="pointer-events-auto rounded-2xl border border-white/[0.08] bg-[#080A10]/90 backdrop-blur-2xl shadow-[0_12px_50px_rgba(0,0,0,0.45)] px-2 py-2 md:px-3 md:py-2">
        <div className="flex items-center gap-2 md:gap-3">
          <button
            onClick={onSearch}
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-left transition hover:border-[var(--border-active)] hover:bg-white/[0.05]"
            aria-label="Search the terminal"
          >
            <Search className="h-4 w-4 shrink-0 text-[var(--cyan-primary)]" />
            <span className="hidden truncate text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-secondary)] sm:block">
              Search entities, lanes, ports, carriers
            </span>
            <span className="truncate text-[10px] font-mono text-[var(--text-secondary)] sm:hidden">Search</span>
            <kbd className="ml-auto hidden rounded border border-white/[0.08] bg-black/30 px-1.5 py-0.5 text-[9px] font-mono text-white/35 md:block">⌘K</kbd>
          </button>

          <div className="hidden h-7 w-px bg-white/[0.08] md:block" />

          <div className="hidden items-center gap-1 lg:flex">
            {nav.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={handlers[key]}
                className={`flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-[9px] font-mono uppercase tracking-[0.14em] transition ${
                  active[key]
                    ? 'bg-[var(--gold-primary)]/12 text-[var(--gold-primary)] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.18)]'
                    : 'text-white/45 hover:bg-white/[0.04] hover:text-white/80'
                }`}
                aria-pressed={active[key]}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-2">
            <Map className="h-3.5 w-3.5 text-white/30" />
            <div className="hidden sm:block">
              {/* `Loaded`, not `World state`. The number is what THIS browser
                  has fetched across the active layers — not a census of the
                  world, and not the sampled render set. A label that overstates
                  its own number is the cheapest kind of overclaim. */}
              <div className="text-[8px] font-mono uppercase tracking-[0.18em] text-white/25">Loaded</div>
              <div className="text-[10px] font-mono tabular-nums text-white/75">{entityCount.toLocaleString()} features</div>
            </div>
            <span className={`h-1.5 w-1.5 rounded-full ${
              backendStatus === 'connected' ? 'bg-[var(--alert-green)] shadow-[0_0_8px_var(--alert-green)]' :
              backendStatus === 'connecting' ? 'bg-[var(--gold-primary)] animate-pulse' : 'bg-[var(--alert-red)]'
            }`} aria-label={backendStatus} />
          </div>

          {!isCompact && (
            <button
              onClick={onSearch}
              className="hidden items-center gap-1.5 rounded-xl px-2.5 py-2 text-[9px] font-mono uppercase tracking-[0.14em] text-white/30 hover:bg-white/[0.04] hover:text-white/70 xl:flex"
            >
              <Command className="h-3.5 w-3.5" />
              Cmd
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
