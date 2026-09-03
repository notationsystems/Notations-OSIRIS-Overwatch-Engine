'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { ExternalLink, GitBranch, ShieldCheck, X } from 'lucide-react';
import type {
  CorpusWarrantGraph,
  CorpusWarrantGraphEdge,
  CorpusWarrantGraphNode,
  WarrantEpistemicClass,
} from '@/lib/economy/corpusWarrantGraph';
import type { VerificationEnvelope } from '@/lib/economy/corpusVerification';

type LayoutNode = CorpusWarrantGraphNode & { x?: number; y?: number };
type LayoutEdge = Omit<CorpusWarrantGraphEdge, 'source' | 'target'> & { source: string | LayoutNode; target: string | LayoutNode };

const CLASS_STYLE: Record<WarrantEpistemicClass, { color: string; hollow: boolean }> = {
  observed: { color: '#22C55E', hollow: false },
  declared: { color: '#38BDF8', hollow: true },
  derived: { color: '#D4AF37', hollow: false },
  mined: { color: '#F59E0B', hollow: false },
  hypothetical: { color: '#A855F7', hollow: false },
  representative: { color: '#94A3B8', hollow: false },
  system: { color: '#E5E7EB', hollow: true },
};

const EDGE_COLOR: Partial<Record<CorpusWarrantGraphEdge['kind'], string>> = {
  supported_by: 'rgba(34,197,94,0.62)',
  contradicted_by: 'rgba(255,61,61,0.78)',
  qualified_by: 'rgba(245,158,11,0.72)',
  unresolved: 'rgba(255,61,61,0.9)',
};

interface Props {
  graph: CorpusWarrantGraph;
  verification: VerificationEnvelope;
  initialCanonicalId?: string;
  onClose: () => void;
}

export default function WarrantGraphOverlay({ graph, verification, initialCanonicalId, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 560 });
  const [selectedId, setSelectedId] = useState<string>(() => graph.nodes.find(node => node.canonicalId === initialCanonicalId)?.id ?? graph.rootNodeId);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(() => ({
    nodes: graph.nodes.map(node => ({ ...node } as LayoutNode)),
    links: graph.edges.map(edge => ({ ...edge } as LayoutEdge)),
  }), [graph]);
  const selected = graph.nodes.find(node => node.id === selectedId) ?? graph.nodes[0];

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[620] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="glass-panel flex h-[82vh] w-[92vw] max-w-[1420px] flex-col overflow-hidden border border-[var(--gold-primary)]/35 bg-[#08090d]/95" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><GitBranch size={14} className="text-[var(--gold-primary)]" /><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--gold-primary)]">Warrant Graph</p></div>
            <h2 className="mt-1 truncate text-sm font-semibold text-white">{graph.statement}</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded border border-[var(--alert-green)]/35 px-2 py-1 font-mono text-[8px] text-[var(--alert-green)]">{verification.verificationLevel}</span>
            <button type="button" onClick={onClose} className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close warrant graph"><X size={16} /></button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_310px]">
          <div ref={containerRef} className="relative min-h-[360px] overflow-hidden border-b border-white/10 lg:border-b-0 lg:border-r">
            <ForceGraph2D
              width={size.width}
              height={size.height}
              graphData={graphData}
              nodeId="id"
              backgroundColor="rgba(0,0,0,0)"
              cooldownTicks={100}
              nodeLabel={node => (node as LayoutNode).label}
              linkLabel={link => (link as LayoutEdge).label}
              onNodeClick={node => setSelectedId((node as LayoutNode).id)}
              nodeCanvasObject={(node, context, globalScale) => {
                const item = node as LayoutNode;
                const style = CLASS_STYLE[item.epistemicClass];
                const radius = item.kind === 'answer' ? 6 : item.kind === 'computation' || item.kind === 'corpus_build' ? 5 : 4;
                context.beginPath();
                context.arc(item.x!, item.y!, radius, 0, Math.PI * 2);
                context.fillStyle = style.hollow ? 'rgba(8,9,13,0.94)' : style.color;
                context.fill();
                context.strokeStyle = style.color;
                context.lineWidth = item.id === selectedId ? 2.2 : 1.1;
                context.stroke();
                if (item.id === selectedId) {
                  context.beginPath();
                  context.arc(item.x!, item.y!, radius + 3, 0, Math.PI * 2);
                  context.strokeStyle = 'rgba(255,255,255,0.8)';
                  context.lineWidth = 0.8;
                  context.stroke();
                }
                if (globalScale > 1.25 || item.kind === 'answer') {
                  context.font = `${Math.max(3, 9 / globalScale)}px monospace`;
                  context.textAlign = 'center';
                  context.textBaseline = 'top';
                  context.fillStyle = 'rgba(232,230,224,0.82)';
                  context.fillText(item.label.slice(0, 48), item.x!, item.y! + radius + 2);
                }
              }}
              nodePointerAreaPaint={(node, color, context) => {
                const item = node as LayoutNode;
                context.beginPath();
                context.arc(item.x!, item.y!, 7, 0, Math.PI * 2);
                context.fillStyle = color;
                context.fill();
              }}
              linkColor={link => EDGE_COLOR[(link as LayoutEdge).kind] ?? 'rgba(255,255,255,0.24)'}
              linkWidth={link => (link as LayoutEdge).kind === 'contradicted_by' ? 1.5 : 0.9}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkDirectionalArrowColor={link => EDGE_COLOR[(link as LayoutEdge).kind] ?? 'rgba(255,255,255,0.35)'}
            />
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap gap-1.5">
              {graph.legend.map(item => (
                <span key={item.epistemicClass} title={item.meaning} className="flex items-center gap-1 rounded border border-white/10 bg-black/70 px-1.5 py-1 font-mono text-[7px] uppercase text-white/55">
                  <span className="h-2 w-2 rounded-full" style={{ background: CLASS_STYLE[item.epistemicClass].hollow ? 'transparent' : CLASS_STYLE[item.epistemicClass].color, border: `1px solid ${CLASS_STYLE[item.epistemicClass].color}` }} />
                  {item.epistemicClass}
                </span>
              ))}
            </div>
          </div>

          <aside className="styled-scrollbar min-h-0 overflow-y-auto p-4">
            {selected && (
              <section>
                <p className="font-mono text-[8px] uppercase tracking-widest text-white/35">Selected {selected.kind.replaceAll('_', ' ')}</p>
                <h3 className="mt-1 break-words text-xs font-semibold text-white">{selected.label}</h3>
                <p className="mt-2 text-[9px] leading-4 text-white/55">{selected.description}</p>
                <dl className="mt-3 space-y-2 font-mono text-[8px]">
                  <div><dt className="text-white/30">Epistemic class</dt><dd style={{ color: CLASS_STYLE[selected.epistemicClass].color }}>{selected.epistemicClass.toUpperCase()}</dd></div>
                  {selected.canonicalId && <div><dt className="text-white/30">Canonical identity</dt><dd className="break-all text-white/65">{selected.canonicalId}</dd></div>}
                  {selected.recordId && <div><dt className="text-white/30">Record</dt><dd className="break-all text-white/65">{selected.recordId}</dd></div>}
                  {selected.knownAt && <div><dt className="text-white/30">Known at</dt><dd className="text-white/65">{selected.knownAt}</dd></div>}
                  {selected.contentHash && <div><dt className="text-white/30">Content commitment</dt><dd className="break-all text-white/50">{selected.contentHash}</dd></div>}
                </dl>
                {selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[9px] text-[var(--cyan-primary)] hover:underline"><ExternalLink size={10} /> Open source</a>}
              </section>
            )}

            <section className="mt-5 border-t border-white/10 pt-4">
              <p className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-widest text-[var(--alert-green)]"><ShieldCheck size={11} /> Verification envelope</p>
              <dl className="mt-2 space-y-2 font-mono text-[8px]">
                <div><dt className="text-white/30">Provenance</dt><dd className="text-white/65">{verification.provenanceStatus}</dd></div>
                <div><dt className="text-white/30">Build commitment</dt><dd className="break-all text-white/50">{verification.commitment.root}</dd></div>
                <div><dt className="text-white/30">External attestation</dt><dd className="text-white/65">{verification.attestation.status}</dd></div>
                <div><dt className="text-white/30">zk proof</dt><dd className="text-white/65">{verification.zkProof.status}</dd></div>
              </dl>
              <div className="mt-3 space-y-1.5 border-l border-[var(--gold-primary)]/35 pl-2">
                {verification.limitations.map(limitation => <p key={limitation} className="text-[8px] leading-3 text-[var(--gold-light)]/75">{limitation}</p>)}
              </div>
            </section>
          </aside>
        </div>

        <footer className="border-t border-white/10 px-4 py-2 font-mono text-[8px] text-white/35">
          No trust score is calculated. Edge structure shows support, qualification, contradiction, computation, and commitment directly.
        </footer>
      </div>
    </motion.div>
  );
}
