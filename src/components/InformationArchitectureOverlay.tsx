'use client';

import { X } from 'lucide-react';

const PIPELINE = ['Acquire', 'Extract', 'Normalize', 'Resolve', 'Structure', 'Relate', 'Index', 'Compress', 'Retrieve', 'Compute', 'Prove'];

function Node({ children, accent = false, planned = false }: { children: React.ReactNode; accent?: boolean; planned?: boolean }) {
  return <div className={`rounded-lg border px-3 py-2 text-center text-[9px] font-mono uppercase tracking-[0.12em] ${planned ? 'border-dashed border-white/15 bg-transparent text-white/35' : accent ? 'border-[var(--cyan-primary)]/40 bg-[var(--cyan-primary)]/8 text-[var(--cyan-primary)]' : 'border-white/10 bg-white/[0.025] text-white/65'}`}>{children}{planned && <span className="ml-1 text-[7px] text-white/20">NEXT</span>}</div>;
}

export default function InformationArchitectureOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center bg-black/75 p-3 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="information-os-title">
      <section className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-white/10 bg-[#080A10]/95 p-5 shadow-2xl styled-scrollbar">
        <header className="flex items-start justify-between gap-4">
          <div><p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--gold-primary)]">PayloadOS self-portrait</p><h2 id="information-os-title" className="mt-1 text-xl font-semibold">Physical-Economy Information OS</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[var(--text-secondary)]">Build high-integrity computational corpora, then deliver evidence-bearing spatial queries, APIs, intelligence, and agent context.</p></div>
          <button onClick={onClose} className="rounded-lg border border-white/10 p-2 text-white/55 hover:text-white" aria-label="Close architecture"><X size={17} /></button>
        </header>

        <div className="mt-5 flex flex-nowrap items-center gap-1 overflow-x-auto pb-1 styled-scrollbar" aria-label="Corpus construction pipeline">
          {PIPELINE.map((step, index) => <div key={step} className="flex shrink-0 items-center gap-1"><span className="rounded border border-[var(--gold-primary)]/25 bg-[var(--gold-primary)]/5 px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-[var(--gold-light)]">{step}</span>{index < PIPELINE.length - 1 && <span className="text-white/20">→</span>}</div>)}
        </div>

        <div className="mx-auto mt-6 grid max-w-3xl gap-2">
          <Node accent>Physical-Economy Corpus</Node>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Node>Evidence</Node><Node>Identity</Node><Node>Ontology</Node><Node>Classification</Node></div>
          <div className="text-center text-white/20">↓</div>
          <Node accent>Canonical State · one authority</Node>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Node>SQLite / WAL V0</Node><Node planned>PostgreSQL + PostGIS</Node><Node planned>Object artifacts</Node><Node planned>Parquet / Iceberg</Node></div>
          <div className="text-center text-white/20">↓</div>
          <Node>Corpus Compiler</Node>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Node>Public read model</Node><Node planned>Graph projection</Node><Node planned>Spatial projection</Node><Node planned>Vector projection</Node></div>
          <div className="text-center text-white/20">↓</div>
          <Node>Retrieval Engine</Node>
          <Node>Identity · Policy · Allowed use</Node>
          <Node planned>GraphRAG</Node>
          <Node planned>Context Compiler</Node>
          <div className="grid grid-cols-3 gap-2"><Node>APIs</Node><Node planned>Intelligence products</Node><Node planned>Corpus agents</Node></div>
          <div className="text-center text-white/20">↓</div>
          <div className="grid grid-cols-3 gap-2"><Node accent>Payload Earth</Node><Node planned>Tradewind</Node><Node>Terminal</Node></div>
        </div>

        <p className="mx-auto mt-5 max-w-2xl text-center text-[10px] leading-5 text-white/40">Canonical state remains the only authority. Solid projections are policy-filtered and rebuildable; dashed NEXT nodes are the declared build path, not capabilities claimed today. APIs—not databases—are the product boundary. Freight, procurement, project cargo, and logistics remain preserved domain lenses over the corpus.</p>
      </section>
    </div>
  );
}
