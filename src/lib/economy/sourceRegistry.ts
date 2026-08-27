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

/**
 * REDISTRIBUTION POSTURE (deployment order D-13) — distinct from
 * `accessClass`, which says how WE may acquire the data. This says
 * whether we may serve it ONWARD to an external machine consumer, which
 * is a different act from reading it internally.
 *
 *   public_domain  US federal work or equivalent — onward serving is
 *                  unrestricted (USGS, CFTC).
 *   attributed     Onward serving permitted with attribution; the source
 *                  id already travels on every record and claim sentence.
 *   internal_only  Acquired under terms that cover internal research and
 *                  do NOT clearly cover machine redistribution.
 *   unresolved     Nobody has established the posture. THIS IS NOT
 *                  PERMISSIVE: a source whose posture is unresolved is
 *                  REFUSED to external clients rather than served on the
 *                  assumption that silence means yes.
 */
export type RedistributionPosture = 'public_domain' | 'attributed' | 'internal_only' | 'unresolved';

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
  /** Who keeps this source true (shipping order S-5). REQUIRED for every
   *  entry with a built adapter — an unowned source is stale before anyone
   *  notices. 'operator' is a role: the program has exactly one human, and
   *  naming further humans is an operator decision, not a default. */
  owner?: string;
  /** The MAINTENANCE cadence — what keeping it true means and how often;
   *  distinct from `cadence`, which is the source's own publication rhythm. */
  maintenance?: string;
  /** D-13: may this source's data be served onward to an external machine
   *  consumer? Absent is treated as `unresolved`, and unresolved REFUSES —
   *  defaulting to permissive is how a licensing question becomes a
   *  licensing incident. */
  redistribution?: RedistributionPosture;
  /** Why the posture is what it is — the reasoning a lawyer would want. */
  redistributionNote?: string;
}

/** The posture of a source, with absent meaning UNRESOLVED — never
 *  permissive. */
export function redistributionPostureOf(source: RegisteredSource): RedistributionPosture {
  return source.redistribution ?? 'unresolved';
}

/** May this source's data be served to an external machine consumer?
 *  Only an affirmatively-recorded posture permits it. */
export function mayRedistributeToMachines(source: RegisteredSource): boolean {
  const p = redistributionPostureOf(source);
  return p === 'public_domain' || p === 'attributed';
}

export const SOURCE_REGISTRY: RegisteredSource[] = [
  /* ── Built ── */
  { sourceId: 'usgs-mcs', name: 'USGS Mineral Commodity Summaries (ScienceBase)', category: 'production', yields: ['observation'], cadence: 'annual', accessClass: 'open', adapter: 'usgs-mcs-live', keywords: ['production', 'reserves', 'usgs', 'mine'], note: 'Multi-vintage (2024+2025), supersedes chains.', owner: 'operator', maintenance: 'Ingest each MCS edition when it lands (annual, ~late January); the new edition supersedes-chains onto the held vintages.', redistribution: 'public_domain', redistributionNote: 'USGS is a US federal agency; Mineral Commodity Summaries are US Government works in the public domain. Onward serving to machine consumers is unrestricted.' },
  { sourceId: 'un-comtrade', name: 'UN Comtrade public preview', category: 'trade', yields: ['observation'], cadence: 'annual', accessClass: 'open', adapter: 'comtrade-trade', keywords: ['trade', 'export', 'import', 'bilateral', 'mirror'], note: 'Single-version source; every retrieval archived (the only vintage archive there will ever be).', owner: 'operator', maintenance: 'Archival continues on every live retrieval (archive-before-parse, sealed against test writes); commit new day-directories and regenerate the manifest; refresh the archive mirror.', redistribution: 'attributed', redistributionNote: "UN Comtrade's public preview permits reuse with attribution to UN Comtrade; the source id travels on every record and in every claim sentence, which is the attribution the terms ask for. Bulk redistribution of the whole dataset is NOT what this serves — per-query rows with provenance are." },
  { sourceId: 'yahoo-hg', name: 'COMEX HG=F via Yahoo Finance', category: 'price', yields: ['observation'], cadence: 'continuous', accessClass: 'open', adapter: 'yahoo-copper-price', keywords: ['price', 'comex', 'futures'], note: 'Benchmark only; roll-bearing, excluded from physical analytics.', owner: 'operator', maintenance: 'Monitor only — corpus health flags staleness; benchmark, never load-bearing.', redistribution: 'internal_only', redistributionNote: "Yahoo Finance's terms cover personal, non-commercial use and do not clearly permit onward machine redistribution. Benchmark series only — never load-bearing for a physical figure — so refusing it to external clients costs nothing analytically." },
  { sourceId: 'cftc-cot', name: 'CFTC Commitments of Traders', category: 'positioning', yields: ['observation'], cadence: 'weekly', accessClass: 'open', adapter: 'cftc-positioning', keywords: ['positioning', 'cot', 'managed money'], note: 'Reflexive market context; never wakes anyone.', owner: 'operator', maintenance: 'Monitor only — corpus health flags staleness; context, never load-bearing.', redistribution: 'public_domain', redistributionNote: 'CFTC Commitments of Traders is a US federal publication in the public domain.' },
  { sourceId: 'westmetall-lme', name: 'LME daily stocks via Westmetall', category: 'stocks', yields: ['observation'], cadence: 'daily', accessClass: 'open', adapter: 'westmetall-lme-stocks', keywords: ['stocks', 'inventory', 'warehouse', 'lme'], note: 'Republisher scrape; plausibility-gated; licensed feed is the recorded remedy.', owner: 'operator', maintenance: 'Watch the plausibility gate (source_suspect in corpus health): a markup change degrades the ONLY daily physical stream. The licensed LME feed is the standing remedy.', redistribution: 'internal_only', redistributionNote: "A republisher scrape of LME data carried for internal research; onward machine redistribution is a different act from internal reading and is NOT covered. The licensed LME feed is the standing remedy and would change this posture. This is the source the shipping order's access decision already flagged." },
  { sourceId: 'curated-flow-snapshot', name: 'Curated facility flow snapshot (annual topology)', category: 'trade', yields: ['flow', 'dependency'], cadence: 'annual', accessClass: 'open', adapter: 'curated-copper-v1', keywords: ['flow', 'topology', 'corridor', 'snapshot', 'structure'], note: 'The facility-granularity flow topology, curated annually. Corpus health reports its age against the annual cadence (curated-flow-snapshot signal, 365d + 90d grace); the extrapolation guard holds the 730d hard ceiling. The two are different questions: the cadence asks \"is it due\", the ceiling asks \"is it still admissible\".', owner: 'operator', maintenance: 'Refresh the facility flow snapshot annually against current trade patterns; re-measure the corridor grades; the STRUCTURE HAS MOVED evidence list is the refresh worklist.', redistribution: 'attributed', redistributionNote: 'Curated in-house from public sources; ours to serve, with the representative attestation already on every record.' },
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
  { sourceId: 'sec-edgar', name: 'SEC EDGAR filings (facility structure)', category: 'production', yields: ['entity', 'observation', 'capacity'], cadence: 'annual', accessClass: 'open', adapter: null, keywords: ['edgar', 'filings', '10-k', '20-f', 'operator', 'facility', 'mine', 'production', 'reported'], note: 'The structure-class source: listed operators disclose production and capacity BY FACILITY in their own filings (Freeport: Grasberg, Morenci, Cerro Verde; Southern Copper; BHP/Rio via 20-F), attributed to the operator by construction. The ordering it forces, not chooses: filings move QUANTITY AND STRUCTURE TOGETHER from the same documents — any path that reports quantities while leaving structure curated leaves every index representative regardless, because the operator indices count their attribution edges as inputs. That ordering holds for quantity-and-attribution and DOES NOT EXTEND TO FLOWS — a prediction recorded before ingest, not a post-hoc explanation: a filing yields facility, production, operator and often capacity, but no filer discloses where the concentrate goes (Freeport reports Grasberg\'s output, never that it feeds Guixi), so structuralClassProfile\'s components will move at different rates — entities/capacities first, attribution edges with them, FLOW EDGES STAYING AT 0% indefinitely, structural to the source rather than a gap it closes. Epistemics (decided pre-ingest, phase 20): a filer\'s disclosure is reported by source class and SELF-INTERESTED by nature — handled by measurement, not a new label: per-country filer rollups meet the compiled USGS figure in the coverage system (ratio >1 is already a contradiction), and coinciding quantities are Divergence claims with the residual as watched baseline; a filer persistently one side of the compiled statistic is a FINDING. Coverage bound: filers only — state operators (Codelco) sit outside it, so the first ingest produces a mixed layer (measured by structuralClassProfile), not a converted one. RECON (phase 21, snapshot sec-edgar-recon.json): two-tier access — submissions/XBRL/full-text open with a plain declared UA; the DOCUMENT tier (where production tables live: XBRL verified production-free) requires a declared automated-tool identity incl. contact email, operator-supplied. Vintages fully recoverable (13y of 10-Ks + amendments in the index; filingDate = knownAt, ~45d after period end) — first ingest targets the decade, not the latest filing. Filer vocabulary is "Grasberg minerals district", NOT the mine: reporting units need a curated unit→entity mapping or district entities, never a silent forcing. BUILD REQUIREMENTS (pre-registered, phase 22): document-tier UA is operator-supplied config in the form "OrgName role@org" (firm role address over personal — survives turnover; generic UAs are the documented 403 cause); rate 10 req/s cap, space at 0.12s, NEVER immediate-retry a 403 (it lengthens the block); throttle-and-cache — the archive rung IS the cache, a decade of filings is a few hundred documents, not a bulk download. Parse: observations attach to the filing\'s ACTUAL reporting unit (district entities + contains edges; facility split is an explicit derived step that can refuse — attaching a district figure to a mine is fabricated precision at the SUBJECT level); units captured from the table header, never assumed (FCX reports recovered copper in MILLIONS OF POUNDS — Mlb read as kt overstates 2.2046×, arithmetically valid and semantically wrong); the plausibility gate generalizes to this adapter on DAY ONE, not retrofitted, anchored on the country ceiling (a facility cannot exceed its country\'s compiled figure) — with the ceiling\'s soft edge diagnosed, not collapsed: a SINGLE parsed figure over the ceiling is a unit/parse error and the gate rejects it; MULTIPLE filers legitimately summing past the compiled figure is the coverage system\'s ratio>1 contradiction, a FINDING routed to the existing path — same numbers, two diagnoses, only one means the parser is wrong; every comparative column parses with the filing\'s own knownAt (a 10-K carries 2–3 years, so revision chains arrive densely on first ingest — the opposite of Comtrade). RENAME (work order 3.6): the instrument is Sea Dog Terminal as of 2026-08-27 — when the operator supplies the contact identity, the document-tier UA is "SeaDogTerminal/<version> OrgName role@org"; it must not go to a regulator under the retired OSIRIS name.' },
  { sourceId: 'maritime-ais', name: 'Maritime AIS vessel movement', category: 'movement', yields: ['flow', 'event'], cadence: 'continuous', accessClass: 'licensed', adapter: null, keywords: ['shipping', 'vessel', 'ais', 'port', 'maritime', 'cargo'], note: 'Physical observation of movement — would make logistics events detectable. Part of the modality programme.' },
  /* ── Ownership (two purposes, two costs) ── */
  { sourceId: 'opencorporates', name: 'OpenCorporates company register', category: 'ownership', yields: ['entity', 'dependency'], cadence: 'irregular', accessClass: 'registered', adapter: null, keywords: ['company', 'operator', 'ownership', 'register', 'subsidiary'], note: 'Company identity resolution. Operator-of-record attribution is CLOSED by curation; this serves scale-out beyond copper.' },
  { sourceId: 'openownership', name: 'OpenOwnership beneficial-ownership register', category: 'ownership', yields: ['dependency'], cadence: 'irregular', accessClass: 'open', adapter: null, keywords: ['ownership', 'parent', 'beneficial', 'holding', 'shareholder'], note: 'Parent chains — who stands behind each JV vehicle. RECON 2026-08-27 (work order 3.4, captures in data-archive/openownership/2026-08-27): the Register app is RETIRED (register.openownership.org redirects to a www topic page behind a Cloudflare challenge; bulk-data host does not resolve); the BODS statement exports remain public on S3, FROZEN at 2023-07-19. A full scan of the frozen export (32,813,462 statements; Glencore positive control 53 hits) finds NEITHER Compañía Minera Antamina S.A. NOR Compañía Minera Doña Inés de Collahuasi SCM — the only substring hit is FANTAMINA LTD, an unrelated Bristol company (the name-collision species the resolution gate refuses). Structural cause, not a data gap: the source registers (UK PSC, DK CVR, SK RPVS, UA EDR) record who CONTROLS domestic companies — the direction is inbound; a Peruvian S.A. or Chilean SCM can never appear as a subject. This source cannot serve the two vehicles; parents stay curated or wait for a jurisdiction-appropriate register. The finding is about the source CLASS, not this export: any BO register of this shape records inbound control of its own domestic companies, so no foreign-held operating vehicle is ever a subject — re-attempting with a fresher OpenOwnership export cannot change that, and a re-attempt should target a register in the vehicle\'s own jurisdiction instead.' },
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
