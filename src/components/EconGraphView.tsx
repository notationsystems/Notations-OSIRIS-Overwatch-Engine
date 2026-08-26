'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { X, Network } from 'lucide-react';

/**
 * OSIRIS — Flow graph explorer.
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
  form?: string;
  confidence?: string;
  disrupted?: boolean;
  strength?: number | null;
}

interface EconGraphViewProps {
  selectedId: string | null;
  asOf: string | null;
  onSelectEntity: (id: string) => void;
  onClose: () => void;
}

const STAGE_COLOR: Record<string, string> = {
  production: '#D4AF37',
  smelting: '#FF7043',
  refining: '#4FC3F7',
  logistics: '#78909C',
  manufacturing: '#AB47BC',
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

export default function EconGraphView({ selectedId, asOf, onSelectEntity, onClose }: EconGraphViewProps) {
  const [data, setData] = useState<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });

  useEffect(() => {
    let cancelled = false;
    const qs = asOf ? `&asOf=${asOf}` : '';
    fetch(`/api/economy?commodity=copper&view=graph${qs}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (!cancelled) setData({ nodes: d.nodes, links: d.links }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [asOf]);

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
  // resolved references) — hand it a copy so the fetched data stays pristine
  // across re-renders.
  const graphData = useMemo(() => (data ? {
    nodes: data.nodes.map(n => ({ ...n })),
    links: data.links.map(l => ({ ...l })),
  } : { nodes: [], links: [] }), [data]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex items-center justify-center pointer-events-auto"
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
            {asOf && <span className="text-[9px] font-mono text-[#D4AF37] border border-[#D4AF37]/40 rounded px-1">AS OF {asOf}</span>}
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
                const color = STAGE_COLOR[n.stage ?? ''] ?? '#B0BEC5';
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
              linkLineDash={link => ((link as GraphLink).kind === 'dependency' ? [2, 2] : null)}
              linkWidth={link => {
                const l = link as GraphLink;
                return l.kind === 'dependency' ? 0.6 : 0.6 + Math.min(3.5, (l.ktPerYear ?? 0) / 500);
              }}
              linkDirectionalParticles={link => {
                const l = link as GraphLink;
                return l.kind === 'flow' ? Math.max(1, Math.min(4, Math.round((l.ktPerYear ?? 0) / 350))) : 0;
              }}
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
