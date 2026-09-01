'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { graphLinkTreatment } from '@/lib/economy/mapStyle';
import type { SupplyStage } from '@/lib/economy/types';
import { X, Network } from 'lucide-react';

/**
 * Payload — Flow graph explorer.
 *
 * A force-directed projection of the engine's flow/dependency graph
 * (`/api/economy?view=graph`). Directional particles animate along material
 * flows (density scaled by tonnage); dashed grey links are declared
 * dependencies. Clicking a node hands the entity to the research panel, so
 * map → graph → evidence stays one investigation.
 */

interface GraphNode {
  id: string;
  name: string;
  kind: string;
  stage: string | null;
  country: string | null;
  throughputKt: number;
  bottleneckScore: number | null;
  disrupted: boolean;
  x?: number;
  y?: number;
}

interface GraphLink {
  id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  kind: 'flow' | 'dependency';
  ktPerYear?: number | null;
  /** Mass basis of ktPerYear. Non-metal-content magnitudes are NOT
   *  commensurate with contained-metal ones and never share the ramp. */
  basis?: string | null;
  form?: string;
  confidence?: string;
  disrupted?: boolean;
  strength?: number | null;
}

interface EconGraphViewProps {
  selectedId: string | null;
  asOf: string | null;
  knowledge: 'best_known' | 'as_known_then';
  onSelectEntity: (id: string) => void;
  onClose: () => void;
}

/**
 * EXHAUSTIVE OVER SupplyStage, deliberately.
 *
 * Typed `Record<string, string>` this map took any key and fell back to
 * grey, so extending the stage vocabulary would have shipped a new stage
 * that rendered as an unlabelled grey dot with nothing failing — the
 * silent-default shape this codebase keeps finding. `Record<SupplyStage,
 * string>` makes adding a stage a COMPILE ERROR here, which is the
 * cheapest possible place to be told.
 *
 * The `?? fallback` at the call site stays: it handles a null stage on a
 * record, which is a different question from an unhandled stage value.
 */
const STAGE_COLOR: Record<SupplyStage, string> = {
  production: '#D4AF37',
  concentrate: '#C9A227',
  smelting: '#FF7043',
  refining: '#4FC3F7',
  manufacturing: '#AB47BC',
  demand: '#8BC34A',
  logistics: '#78909C',
};

const FORM_COLOR: Record<string, string> = {
  concentrate: '#FFB300',
  blister: '#FF7043',
  anode: '#FF7043',
  cathode: '#4FC3F7',
  refined: '#4FC3F7',
};

const LEGEND: Array<[string, string]> = [
  ['PRODUCTION', '#D4AF37'], ['SMELTING', '#FF7043'], ['REFINING', '#4FC3F7'],
  ['LOGISTICS', '#78909C'], ['MANUFACTURING', '#AB47BC'],
];

/** The topology block the route now sends with the graph, same shape the
 *  map has carried since phase 13. */
interface TopologyValidity {
  status: 'within' | 'extrapolated' | 'predates';
  granularity?: string;
  topologyPeriod?: { start: string; end: string } | null;
  monthsBeyond?: number;
  note?: string;
}

const TOPOLOGY_BANNER: Record<TopologyValidity['status'], { label: string; color: string } | null> = {
  within: null,
  extrapolated: { label: 'TOPOLOGY EXTRAPOLATED', color: '#FF9500' },
  predates: { label: 'TOPOLOGY OUT OF PERIOD', color: '#FF3D3D' },
};

export default function EconGraphView({ selectedId, asOf, knowledge, onSelectEntity, onClose }: EconGraphViewProps) {
  const [data, setData] = useState<{
    nodes: GraphNode[]; links: GraphLink[]; topology?: TopologyValidity;
    representable?: { flowsInSelectedTopology: number; flowLinks: number; withheld: number; reason: string | null };
  } | null>(null);
  // Failure is keyed to the evaluation date it happened for — a later fetch
  // (new asOf) must not stay stuck behind an old error banner.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });

  useEffect(() => {
    let cancelled = false;
    const key = `${asOf ?? 'live'}|${knowledge}`;
    const qs = asOf ? `&asOf=${asOf}&knowledge=${knowledge}` : '';
    fetch(`/api/economy?commodity=copper&view=graph${qs}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) setData({ nodes: d.nodes, links: d.links, topology: d.topology, representable: d.representable }); })
      .catch(() => { if (!cancelled) setFailedKey(key); });
    return () => { cancelled = true; };
  }, [asOf, knowledge]);
  const failed = !data && failedKey === `${asOf ?? 'live'}|${knowledge}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // react-force-graph mutates node/link objects (layout coordinates,
  // resolved references) — hand it copies so the fetched data stays pristine.
  // Carry each node's previous position/velocity forward so a playback scrub
  // updates colors/flags without re-heating and re-scrambling the layout.
  // (A state-held mutable cache, not a ref: refs must not be read in render.)
  const [posCache] = useState(() => new Map<string, { x?: number; y?: number; vx?: number; vy?: number }>());
  const graphData = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const nodes = data.nodes.map(n => ({ ...n, ...(posCache.get(n.id) ?? {}) }));
    posCache.clear();
    for (const n of nodes) posCache.set(n.id, n);
    return { nodes, links: data.links.map(l => ({ ...l })) };
  }, [data, posCache]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[500] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(4, 4, 8, 0.72)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="glass-panel border border-[#D4AF37]/30 flex flex-col overflow-hidden"
        style={{ width: '80vw', height: '78vh', maxWidth: 1280, background: 'rgba(10, 10, 14, 0.92)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Network className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
            <span className="hud-text text-[11px] text-[var(--text-primary)]">FLOW GRAPH — COPPER</span>
            {asOf && <span className="text-[9px] font-mono text-[#D4AF37] border border-[#D4AF37]/40 rounded px-1">{knowledge === 'as_known_then' ? 'AS KNOWN' : 'AS OF'} {asOf}</span>}
            {/* The AS OF chip asserts a knowledge state; before the route
                selected its topology the network beneath it did not honour
                one. The banner states what the drawn structure IS. */}
            {data?.topology && TOPOLOGY_BANNER[data.topology.status] && (
              <span
                data-testid="graph-topology-banner"
                className="text-[9px] font-mono rounded px-1"
                style={{ color: TOPOLOGY_BANNER[data.topology.status]!.color, border: `1px solid ${TOPOLOGY_BANNER[data.topology.status]!.color}66` }}
                title={data.topology.note ?? ''}
              >
                {TOPOLOGY_BANNER[data.topology.status]!.label}
                {data.topology.status === 'extrapolated' && data.topology.monthsBeyond ? ` +${data.topology.monthsBeyond}mo` : ''}
              </span>
            )}
            {data?.topology?.granularity && (
              <span className="text-[8px] font-mono text-[var(--text-muted)]">{data.topology.granularity.toUpperCase()}-GRANULARITY</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {LEGEND.map(([label, color]) => (
              <span key={label} className="hidden md:flex items-center gap-1 text-[8px] font-mono text-[var(--text-muted)]">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: color }} />{label}
              </span>
            ))}
            <button onClick={onClose} className="hover:bg-white/10 rounded p-0.5" aria-label="Close graph">
              <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
          </div>
        </div>

        <div ref={containerRef} className="flex-1 min-h-0 relative">
          {failed ? (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-[#FF3D3D]">GRAPH PROJECTION UNAVAILABLE</div>
          ) : !data ? (
            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-[var(--text-muted)]">ASSEMBLING GRAPH…</div>
          ) : data.representable && data.representable.flowLinks === 0 && data.representable.flowsInSelectedTopology > 0 ? (
            // THE THIRD ZERO. The topology covers this date and holds flows;
            // this view cannot draw them, because they are stated between
            // countries and it renders sited structure. Naming that is the
            // whole point — the previous behaviour drew today's facility
            // network here instead, under an "AS OF <past date>" chip.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center" data-testid="graph-not-representable">
              <div className="text-[11px] font-mono text-[#FF9500]">TOPOLOGY NOT REPRESENTABLE IN THIS VIEW</div>
              <div className="text-[9px] font-mono text-[var(--text-muted)] max-w-[46rem] leading-relaxed">{data.representable.reason}</div>
              <div className="text-[9px] font-mono" style={{ color: 'var(--gold-primary)' }}>
                ↳ The MAP draws these corridors at country centroids. This view is facility-level structure.
              </div>
            </div>
          ) : data.topology?.status === 'predates' ? (
            // A REFUSAL, not an empty picture. Drawing the dependency
            // skeleton alone here would read as "this is the network then",
            // which is the claim the date cannot support.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center" data-testid="graph-out-of-period">
              <div className="text-[11px] font-mono text-[#FF3D3D]">NO FLOW TOPOLOGY DESCRIBES {asOf}</div>
              <div className="text-[9px] font-mono text-[var(--text-muted)] max-w-[46rem] leading-relaxed">
                {data.topology.note ?? 'The evaluation date precedes the earliest flow vintage the corpus holds. A network drawn here would be today\'s structure wearing a historical date.'}
              </div>
              <div className="text-[9px] font-mono" style={{ color: 'var(--gold-primary)' }}>
                ↳ Scrub to a date the corpus covers, or search `vintage` to see which editions it holds.
              </div>
            </div>
          ) : (
            <ForceGraph2D
              width={size.w}
              height={size.h}
              graphData={graphData}
              backgroundColor="rgba(0,0,0,0)"
              nodeId="id"
              nodeLabel={() => ''}
              cooldownTicks={120}
              nodeCanvasObject={(node, ctx, globalScale) => {
                const n = node as GraphNode;
                const r = 2.5 + Math.sqrt(Math.max(0, n.throughputKt)) / 9;
                const color = STAGE_COLOR[n.stage as SupplyStage] ?? '#B0BEC5';
                // Bottleneck halo under the node fill.
                if ((n.bottleneckScore ?? 0) >= 0.45) {
                  ctx.beginPath();
                  ctx.arc(n.x!, n.y!, r + 2.5, 0, 2 * Math.PI);
                  ctx.strokeStyle = 'rgba(255, 61, 61, 0.9)';
                  ctx.lineWidth = 1;
                  ctx.stroke();
                }
                ctx.beginPath();
                ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
                ctx.fillStyle = n.disrupted ? 'rgba(255, 61, 61, 0.85)' : color;
                ctx.fill();
                if (n.id === selectedId) {
                  ctx.strokeStyle = '#FFFFFF';
                  ctx.lineWidth = 1.2;
                  ctx.stroke();
                }
                if (globalScale > 1.1) {
                  ctx.font = `${Math.max(3, 9 / globalScale)}px monospace`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'top';
                  ctx.fillStyle = 'rgba(232, 230, 224, 0.85)';
                  ctx.fillText(n.name, n.x!, n.y! + r + 1.5);
                }
              }}
              nodePointerAreaPaint={(node, color, ctx) => {
                const n = node as GraphNode;
                const r = 4 + Math.sqrt(Math.max(0, n.throughputKt)) / 9;
                ctx.beginPath();
                ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
                ctx.fillStyle = color;
                ctx.fill();
              }}
              onNodeClick={node => onSelectEntity((node as GraphNode).id)}
              linkColor={link => {
                const l = link as GraphLink;
                if (l.kind === 'dependency') return 'rgba(255,255,255,0.22)';
                if (l.disrupted) return 'rgba(255,61,61,0.55)';
                const c = FORM_COLOR[l.form ?? ''] ?? '#90A4AE';
                return c + '66';
              }}
              // Treatment comes from the ONE place it is computed
              // (mapStyle.ts), so the graph cannot drift from the map's
              // rule — and so the rule is testable without a renderer.
              linkLineDash={link => graphLinkTreatment(link as GraphLink).dash}
              linkWidth={link => graphLinkTreatment(link as GraphLink).width}
              linkDirectionalParticles={link => graphLinkTreatment(link as GraphLink).particles}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleSpeed={0.0045}
              linkDirectionalParticleColor={link => FORM_COLOR[(link as GraphLink).form ?? ''] ?? '#90A4AE'}
            />
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-white/10 text-[9px] font-mono text-[var(--text-muted)]">
          Node size = material throughput · red ring = bottleneck candidate · red fill = active disruption · dashed = declared dependency · particles travel with the material. Click a node to open it in the research panel.
        </div>
      </div>
    </motion.div>
  );
}
