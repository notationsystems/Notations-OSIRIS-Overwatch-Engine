/**
 * OSIRIS — Source registry: every source this programme has built, reconned,
 * or deliberately deferred, with what it would yield and why it isn't built.
 *
 * The registry exists so that a search MISS becomes a demand signal: a query
 * the canonical state cannot answer names the registered sources that could
 * have answered it — turning dormant entries into a list the instrument's
 * own use ranks. Every entry here is a real source with real recon or
 * public-record standing; nothing is aspirational filler.
 *
 * Policy note: `yields` may only name canonical identity kinds. No source
 * may be registered to yield natural-person data; the search policy test
 * pins this.
 */

export type SourceYield = 'entity' | 'observation' | 'flow' | 'event' | 'dependency' | 'capacity';
export type AccessClass = 'open' | 'registered' | 'licensed' | 'blocked';

export interface RegisteredSource {
  sourceId: string;
  name: string;
  category: 'production' | 'trade' | 'stocks' | 'price' | 'positioning' | 'events' | 'ownership' | 'movement';
  yields: SourceYield[];
  cadence: 'daily' | 'weekly' | 'monthly' | 'annual' | 'continuous' | 'irregular';
  accessClass: AccessClass;
  /** providerId of the built adapter, or null — null entries ARE the gap list. */
  adapter: string | null;
  /** Query terms a miss is matched against. */
  keywords: string[];
  note: string;
}

export const SOURCE_REGISTRY: RegisteredSource[] = [
  /* ── Built ── */
  { sourceId: 'usgs-mcs', name: 'USGS Mineral Commodity Summaries (ScienceBase)', category: 'production', yields: ['observation'], cadence: 'annual', accessClass: 'open', adapter: 'usgs-mcs-live', keywords: ['production', 'reserves', 'usgs', 'mine'], note: 'Multi-vintage (2024+2025), supersedes chains.' },
  { sourceId: 'un-comtrade', name: 'UN Comtrade public preview', category: 'trade', yields: ['observation'], cadence: 'annual', accessClass: 'open', adapter: 'comtrade-trade', keywords: ['trade', 'export', 'import', 'bilateral', 'mirror'], note: 'Single-version source; every retrieval archived (the only vintage archive there will ever be).' },
  { sourceId: 'yahoo-hg', name: 'COMEX HG=F via Yahoo Finance', category: 'price', yields: ['observation'], cadence: 'continuous', accessClass: 'open', adapter: 'yahoo-copper-price', keywords: ['price', 'comex', 'futures'], note: 'Benchmark only; roll-bearing, excluded from physical analytics.' },
  { sourceId: 'cftc-cot', name: 'CFTC Commitments of Traders', category: 'positioning', yields: ['observation'], cadence: 'weekly', accessClass: 'open', adapter: 'cftc-positioning', keywords: ['positioning', 'cot', 'managed money'], note: 'Reflexive market context; never wakes anyone.' },
  { sourceId: 'westmetall-lme', name: 'LME daily stocks via Westmetall', category: 'stocks', yields: ['observation'], cadence: 'daily', accessClass: 'open', adapter: 'westmetall-lme-stocks', keywords: ['stocks', 'inventory', 'warehouse', 'lme'], note: 'Republisher scrape; plausibility-gated; licensed feed is the recorded remedy.' },
  /* ── Reconned, deferred ── */
  { sourceId: 'wb-pink-sheet', name: 'World Bank Pink Sheet (commodity prices)', category: 'price', yields: ['observation'], cadence: 'monthly', accessClass: 'open', adapter: null, keywords: ['price', 'monthly', 'historical'], note: 'Reconned phase 2: works ($/mt since 1960) but xlsx parsing + hash discovery; Yahoo covers price.' },
  { sourceId: 'lme-licensed', name: 'LME licensed data feed', category: 'stocks', yields: ['observation'], cadence: 'daily', accessClass: 'licensed', adapter: null, keywords: ['stocks', 'inventory', 'warehouse', 'lme', 'warrant'], note: 'The remedy for the single-scrape fragility: converts Westmetall into a divergence check.' },
  { sourceId: 'shfe-stocks', name: 'SHFE weekly warehouse stocks', category: 'stocks', yields: ['observation'], cadence: 'weekly', accessClass: 'open', adapter: null, keywords: ['stocks', 'inventory', 'shanghai', 'shfe', 'china'], note: 'Phase-6 recon: known .dat paths 404; needs endpoint rediscovery.' },
  { sourceId: 'cme-copper-stocks', name: 'CME/COMEX copper warehouse stocks', category: 'stocks', yields: ['observation'], cadence: 'daily', accessClass: 'blocked', adapter: null, keywords: ['stocks', 'inventory', 'comex', 'warehouse', 'us'], note: 'Phase-6 recon: delivery reports bot-blocked (403).' },
  { sourceId: 'icsg-bulletin', name: 'ICSG monthly copper bulletin', category: 'production', yields: ['observation'], cadence: 'monthly', accessClass: 'registered', adapter: null, keywords: ['production', 'refined', 'balance', 'monthly', 'icsg'], note: 'Monthly world balance — would close the annual-cadence gap on production; registration required.' },
  { sourceId: 'cochilco', name: 'Cochilco (Chilean copper statistics)', category: 'production', yields: ['observation'], cadence: 'monthly', accessClass: 'open', adapter: null, keywords: ['chile', 'production', 'monthly', 'cochilco'], note: 'Monthly Chilean production by mine — facility-cadence data for the largest producer.' },
  { sourceId: 'minem-peru', name: 'MINEM Peru mining statistics', category: 'production', yields: ['observation'], cadence: 'monthly', accessClass: 'open', adapter: null, keywords: ['peru', 'production', 'monthly', 'minem'], note: 'Monthly Peruvian production by company/mine.' },
  /* ── Missing modality (the recall bound) ── */
  { sourceId: 'news-events', name: 'News / wire event extraction', category: 'events', yields: ['event'], cadence: 'continuous', accessClass: 'open', adapter: null, keywords: ['news', 'strike', 'announcement', 'accident', 'event', 'disruption'], note: 'The missing modality: labour/regulatory/logistics events are announced in language before they occur in matter. Separately funded programme, deliberately not started.' },
  { sourceId: 'company-filings', name: 'Company disclosures & filings (event stream)', category: 'events', yields: ['event', 'observation'], cadence: 'irregular', accessClass: 'open', adapter: null, keywords: ['filings', 'guidance', 'disclosure', 'force majeure', 'company'], note: 'Guidance cuts and force-majeure declarations — the authoritative event stream. Part of the modality programme. Distinct purpose from sec-edgar (structure): same documents, different yield.' },
  { sourceId: 'sec-edgar', name: 'SEC EDGAR filings (facility structure)', category: 'production', yields: ['entity', 'observation', 'capacity'], cadence: 'annual', accessClass: 'open', adapter: null, keywords: ['edgar', 'filings', '10-k', '20-f', 'operator', 'facility', 'mine', 'production', 'reported'], note: 'The structure-class source: listed operators disclose production and capacity BY FACILITY in their own filings (Freeport: Grasberg, Morenci, Cerro Verde; Southern Copper; BHP/Rio via 20-F), attributed to the operator by construction — the source that would move the structural layer (and every index standing on it) from representative to reported. Coverage bound: filers only — state operators (Codelco) sit outside it.' },
  { sourceId: 'maritime-ais', name: 'Maritime AIS vessel movement', category: 'movement', yields: ['flow', 'event'], cadence: 'continuous', accessClass: 'licensed', adapter: null, keywords: ['shipping', 'vessel', 'ais', 'port', 'maritime', 'cargo'], note: 'Physical observation of movement — would make logistics events detectable. Part of the modality programme.' },
  /* ── Ownership (two purposes, two costs) ── */
  { sourceId: 'opencorporates', name: 'OpenCorporates company register', category: 'ownership', yields: ['entity', 'dependency'], cadence: 'irregular', accessClass: 'registered', adapter: null, keywords: ['company', 'operator', 'ownership', 'register', 'subsidiary'], note: 'Company identity resolution. Operator-of-record attribution is CLOSED by curation; this serves scale-out beyond copper.' },
  { sourceId: 'openownership', name: 'OpenOwnership beneficial-ownership register', category: 'ownership', yields: ['dependency'], cadence: 'irregular', accessClass: 'open', adapter: null, keywords: ['ownership', 'parent', 'beneficial', 'holding', 'shareholder'], note: 'Parent chains — who stands behind each JV vehicle (Southern Copper → Grupo México). The remaining ownership purpose after operator curation closed.' },
];

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);

/** Vocabulary the registry itself declares (categories + keyword tokens);
 *  callers extend it with state-derived tokens via `extraVocabulary`. */
const REGISTRY_VOCABULARY: ReadonlySet<string> = new Set(
  SOURCE_REGISTRY.flatMap(s => [s.category as string, ...s.keywords.flatMap(tokenize)]),
);

/**
 * Whether a missed query is admissible to the persistent miss log.
 *
 * The person-name policy is only real if it holds at every layer: the index
 * refuses to MATCH person names, the registry refuses to YIELD person data —
 * and the miss log must refuse to RETAIN person-directed queries, or the
 * policy is "refused at the surface, persisted at the back". The gate: a
 * query string is logged only when it contains register vocabulary (registry
 * categories/keywords plus caller-supplied tokens — kinds, countries,
 * operators, commodity). Free text with no register vocabulary is not a
 * demand signal for any adapter, so discarding it costs nothing
 * analytically; such misses are counted without their strings.
 */
export function missLoggable(query: string, extraVocabulary: Iterable<string> = []): boolean {
  const vocab = new Set(REGISTRY_VOCABULARY);
  for (const term of extraVocabulary) for (const t of tokenize(term)) vocab.add(t);
  return tokenize(query).some(t => vocab.has(t));
}

export type SearchMissRecord = {
  commodity: string; asOf: string | null; knowledge: string; gapIds: string[];
} & ({ q: string } | { queryWithheld: true });

/** The record a search miss persists — the query string only when the
 *  vocabulary gate admits it (a gap match admits by construction). */
export function missRecord(input: {
  q: string; commodity: string; asOf: string | null; knowledge: string;
  gapIds: string[]; extraVocabulary?: Iterable<string>;
}): SearchMissRecord {
  const base = { commodity: input.commodity, asOf: input.asOf, knowledge: input.knowledge, gapIds: input.gapIds };
  return input.gapIds.length > 0 || missLoggable(input.q, input.extraVocabulary ?? [])
    ? { ...base, q: input.q }
    : { ...base, queryWithheld: true };
}

/** Registered sources with no adapter whose declared coverage matches the
 *  query — the demand signal a miss generates. */
export function matchRegistryGaps(query: string): RegisteredSource[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(t => t.length >= 3);
  return SOURCE_REGISTRY
    .filter(s => s.adapter === null)
    .map(s => {
      const haystack = [s.name.toLowerCase(), s.category, ...s.keywords].join(' ');
      const score = terms.filter(t => haystack.includes(t)).length
        + (s.keywords.some(k => q.includes(k)) ? 1 : 0);
      return { s, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(x => x.s);
}
