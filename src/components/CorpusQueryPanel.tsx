'use client';

import { useState, type FormEvent } from 'react';
import { AlertTriangle, Building2, ExternalLink, Network, Search, ShieldCheck } from 'lucide-react';

export interface CorpusFacilityVisual {
  entityId: string;
  name: string;
  countryCode?: string;
  location?: { lat: number; lng: number; precision: 'exact' | 'site' | 'city' | 'region' | 'country' };
  operator?: { entityId: string; name: string };
  relationshipId: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: Array<{
    evidenceId: string;
    sourceId: string;
    title: string;
    sourceUrl: string;
    retrievedAt: string;
    publishedAt?: string;
  }>;
}

type Discovery = {
  kind: 'facility_discovery';
  query: string;
  interpretedAs: string;
  material: { entityId: string; name: string };
  scope: 'global';
  asOf: string;
  knowledgeCutoff: string;
  facilities: CorpusFacilityVisual[];
  warrant: {
    projectionId: string;
    projectionDigest: string;
    projectionRecordCount: number;
    compilerVersion: string;
    compiledAt: string;
  };
};

type Refusal = { kind: 'refusal'; code: string; detail: string; remedy: string };

interface Props {
  onFacilities: (facilities: CorpusFacilityVisual[]) => void;
  onLocate: (lat: number, lng: number) => void;
  onShowArchitecture: () => void;
}

export default function CorpusQueryPanel({ onFacilities, onLocate, onShowArchitecture }: Props) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Discovery | Refusal | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = query.trim();
    if (value.length < 2 || loading) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/corpus/facilities?q=${encodeURIComponent(value)}`, { cache: 'no-store' });
      const body = await response.json() as Discovery | Refusal;
      setResult(body);
      onFacilities(body.kind === 'facility_discovery' ? body.facilities : []);
    } catch {
      const refusal: Refusal = {
        kind: 'refusal', code: 'CORPUS_UNREACHABLE',
        detail: 'The corpus query surface could not be reached.',
        remedy: 'Check the server connection and retry; no empty-world claim was produced.',
      };
      setResult(refusal);
      onFacilities([]);
    } finally { setLoading(false); }
  }

  return (
    <section className="glass-panel overflow-hidden" aria-label="Physical-economy corpus query">
      <div className="border-b border-white/[0.07] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-[var(--cyan-primary)]">Payload Earth · Corpus query</p>
            <h2 className="mt-1 text-xs font-semibold text-[var(--text-heading)]">Find where a material is produced</h2>
          </div>
          <button type="button" onClick={onShowArchitecture} className="rounded-lg border border-white/10 p-2 text-white/45 transition hover:text-[var(--cyan-primary)]" title="View Information-OS architecture" aria-label="View Information-OS architecture">
            <Network size={15} />
          </button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--alert-green)]"><ShieldCheck size={11} /> Global corpus only · evidence required</p>
        <form onSubmit={submit} className="mt-3 flex gap-2">
          <label className="sr-only" htmlFor="corpus-material-query">Material query</label>
          <input id="corpus-material-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="polypropylene production" autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] font-mono text-white outline-none placeholder:text-white/25 focus:border-[var(--cyan-primary)]/45" />
          <button disabled={loading || query.trim().length < 2} className="flex items-center gap-1.5 rounded-lg border border-[var(--cyan-primary)]/30 bg-[var(--cyan-primary)]/8 px-3 text-[9px] font-semibold uppercase tracking-wider text-[var(--cyan-primary)] disabled:opacity-35">
            <Search size={12} />{loading ? 'Querying' : 'Find'}
          </button>
        </form>
      </div>

      {result?.kind === 'refusal' && (
        <div className="p-3" role="status">
          <div className="flex items-start gap-2 text-[var(--alert-red)]"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><div><p className="font-mono text-[9px] font-semibold">{result.code.replaceAll('_', ' ')}</p><p className="mt-1 text-[9px] leading-4 text-[var(--text-secondary)]">{result.detail}</p></div></div>
          <p className="mt-2 border-l border-[var(--gold-primary)]/40 pl-2 text-[9px] leading-4 text-[var(--gold-light)]">{result.remedy}</p>
        </div>
      )}

      {result?.kind === 'facility_discovery' && (
        <div className="max-h-[44vh] overflow-y-auto styled-scrollbar">
          <div className="border-b border-white/[0.07] bg-white/[0.018] px-3 py-2">
            <p className="text-[10px] font-semibold text-white">{result.material.name}</p>
            <p className="mt-0.5 font-mono text-[8px] text-white/35">{result.facilities.length} evidenced facilit{result.facilities.length === 1 ? 'y' : 'ies'} · {result.facilities.filter(item => item.location).length} mapped · known by {result.knowledgeCutoff.slice(0, 10)}</p>
            <p className="mt-1 font-mono text-[7px] uppercase tracking-wide text-[var(--alert-green)]">Policy-filtered projection · {result.warrant.projectionRecordCount} records · {result.warrant.projectionDigest.slice(0, 12)}</p>
          </div>
          {result.facilities.map(facility => (
            <article key={facility.entityId} className="border-b border-white/[0.06] p-3 last:border-0">
              <button type="button" disabled={!facility.location} onClick={() => facility.location && onLocate(facility.location.lat, facility.location.lng)} className="flex w-full items-start gap-2 text-left disabled:cursor-default">
                <Building2 size={14} className="mt-0.5 shrink-0 text-[var(--gold-primary)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-medium text-white">{facility.name}</span>
                  <span className="mt-0.5 block truncate font-mono text-[8px] text-white/40">{[facility.operator?.name, facility.countryCode, facility.location?.precision].filter(Boolean).join(' · ') || 'Location not resolved'}</span>
                </span>
                <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[7px] uppercase text-[var(--alert-green)]">{facility.confidence}</span>
              </button>
              <div className="mt-2 space-y-1.5 pl-[22px]">
                {facility.evidence.map(item => (
                  <a key={item.evidenceId} href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1.5 text-[8px] leading-3 text-[var(--cyan-primary)] hover:underline">
                    <ExternalLink size={9} className="mt-0.5 shrink-0" /><span>{item.title} · retrieved {item.retrievedAt.slice(0, 10)}</span>
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
