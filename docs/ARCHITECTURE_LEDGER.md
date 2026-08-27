# OSIRIS — Architecture Ledger & Repository Intelligence

Running record of what was studied, what was decided, and why. Every adaptation
answers: *why does this belong in OSIRIS, and what existing capability does it extend?*

## Substrate reconnaissance (osiris-palantir-dashboard)

**What OSIRIS already provided:** Next.js 16 + React 19 + Tailwind 4; MapLibre GL
globe (`OsirisMap.tsx`) with a fixed set of GeoJSON sources updated via `setGeo()`
per-layer effects; `LayerPanel` with grouped, capability-gated toggles; a dashboard
shell (`page.tsx`) polling ~70 API routes into a `dataRef`; panel chrome conventions
(glass panels, mono type, HUD tags); vitest with colocated tests; Docker/deploy.

**Directly extended (not forked):** the economy subsystem reuses the exact map
pattern (new sources + layers + `setGeo` effect + delegated click handlers), the
LayerPanel group format, the layer-aware fetch pattern, panel chrome, and the
route-per-capability API convention. Zero existing behavior changed; `page.tsx`
baseline lint error count unchanged.

**Genuine gaps filled:** no canonical state, no provenance discipline, no graph,
no analytics, no commodity data. All added under `src/lib/economy/*` — see
`docs/PHYSICAL_ECONOMY.md`.

## Curated repository studies

### OSINT-War-Room (FastAPI + Leaflet overwatch dashboard)
- **Strongest ideas:** per-domain thin proxy/normalizers with a uniform
  `{status, data}` envelope; request coalescing (`_cache` + `_pending` events);
  graceful source-degradation ladders (GDELT 15-min feed → daily CSV fallbacks);
  sequenced map boot with a real progress overlay; layout persistence with
  validation; layer-cardinality-derived threat meter; single-timer relative
  timestamps; bbox-scoped fetching from map bounds.
- **Decision:** *Adapt (later)* — the coalescing + degradation-ladder patterns fit
  OSIRIS's route layer when live providers arrive. *Rejected:* global mutable
  singletons, client-side API keys, unescaped `innerHTML` for scraped text,
  JSON-file-as-database, and above all its fictional elements (scripted "radio
  transcripts", casualty counters derived from article-count proxies) — simulated
  and sourced data must never share a surface. That rejection is enforced in
  OSIRIS by valueKind/provenance discipline.

### commodity-market-simulator (C++ order-book toy)
- **Strongest ideas:** parse/execute split (fully validated command before any
  state mutation); command-table registry; per-item partial-failure batching.
- **Decision:** *Reference only.* Its core inversion lesson — results as
  machine-readable state, not display text — is baked into the engine
  (`AnalyticalResult` objects, never strings). *Rejected:* closed int-enum
  commodity registry, unit-less quantities, float money.

### storm-engine (Sea Dogs C++ DX9 engine)
- **What it is:** Core façade singleton; generational entity manager with 32
  layered execute/realize passes; string-keyed attribute trees with change
  events; bespoke script VM; quadtree-LOD sea renderer; weather as a parameter
  block driving all renderers; baked coarse lookup rasters.
- **Decision:** *Adapt the architecture, not the code.* Direct reuse is
  impossible (DX9/Win32, no WASM path, no shared language) and its per-subsystem
  equivalents are superseded in the web stack (MapLibre tiling ≈ LOD; typed
  state ≈ attribute trees). What OSIRIS took is the **engine shape**: a core
  lifecycle (acquire → index → systems pass → project) with registered,
  independent systems — implemented in `src/lib/economy/engine.ts` — and the
  event-driven loop (event → state change → propagation → projection) in
  `propagation.ts`. The one pattern held in reserve: Storm's weather/time
  parameter block as a future shared "scenario clock" driving map atmosphere and
  temporal playback coherently. A native Storm-based 3D world view could one day
  *consume* OSIRIS projections over HTTP, but it is a separate client, not a
  substrate for this codebase.

## Phase 2 — live acquisition, temporal state, graph exploration (delivered)

Source reconnaissance ran as a parallel probe workflow from inside this
sandbox; every adapter below was built against endpoints proven reachable and
parseable here, with verbatim response captures committed as snapshots:

| Source | Verdict | Adapter |
|---|---|---|
| UN Comtrade public preview | works, no key; physical kg incl. bilateral rows; strict per-IP rate limits | `comtrade-trade` (world totals; per-request snapshot degradation on 429) |
| USGS MCS World Data CSV (ScienceBase) | works; REPORTED production/reserves by country | `usgs-mcs-live` |
| Yahoo HG=F chart API | works with browser UA; monthly USD/lb 10y | `yahoo-copper-price` |
| CFTC COT (Socrata) | works, no key; weekly positioning (dataset ids inverted vs docs: 72hh-3qpy = disaggregated) | `cftc-positioning` |
| WB Pink Sheet xlsx | works ($/mt monthly since 1960) but xlsx parsing + hash discovery | deferred (Yahoo covers price) |
| LME/SHFE stocks | no free API confirmed (phase 2); phase 6 recon: LME pages + CME delivery reports bot-blocked (403), SHFE .dat paths 404, but Westmetall republishes LME daily headline stocks as public HTML | `westmetall-lme-stocks` (daily, year-to-date; licensing noted). **Known fragility:** the corpus's only positive-lead series is this single scraped republisher — corpus-health alerts watch its cadence, and the stated remedy is the licensed LME feed at the top of the acquisition shopping list, at which point the scrape becomes a divergence check against the feed rather than a silent dependency (provenance already names LME as originating and Westmetall as republishing). |

Patterns adapted from the OSINT-War-Room study now live in code: the
degradation ladder and in-flight coalescing wrap every live adapter (reusing
the substrate's own `sourceCache`), and "never mix simulated and sourced data"
became the reported>estimated>representative evidence ranking in
`observationsAt`.

## Phase 3 — external review findings (all shipped)

An external review of the phase-2 branch produced four findings; disposition:

1. **Granularity overlap** — flagged as urgent double-counting. Verified NOT
   live: `concentration()` restricts each calculation to one entity kind, so
   facility and country populations never mix (now pinned by a regression
   test). The review's by-product shipped as the `coverage` system: rolled-up
   facilities ÷ direct country observation — the coverage denominator (Chile
   45%, DRC 22%, Indonesia 73% modeled).
2. **Divergence as evidence** — shipped as the `divergence` system + the
   `Divergence` derived record + bilateral (partner-scoped) observations from
   Comtrade partner rows. First run surfaced the Chilean concentrate
   reporter-suppression mirror gap (~4x) and the DRC→China −25% gap.
3. **Point-in-time correctness** — shipped before any alerting work: `knownAt`
   + `supersedes` on observations, `firstReportedAt` + detection latency on
   events, the MCS2024 vintage ingested alongside MCS2025, and
   `knowledge=as_known_then` through engine, API and UI (HINDSIGHT/AS KNOWN
   toggle on the scrubber). Verified live: mid-2024 as-known-then serves
   MCS2024's Chile estimate (5,000 kt), best-known serves MCS2025's reported
   revision (5,250 kt).
4. **Epistemic classes** — `measurementClass` with enforced invariants:
   concentration refuses price/positioning; the roll-bearing HG=F series is
   excluded from anomaly detection; positioning anomalies are tagged reflexive
   market context; reserves stay a stock, never throughput.

## Phase 4 — basis correctness + scenario (external review round 2)

The round-2 review caught that phase 3's top-ranked divergence (Chile→China
"suppression", 75%) was a units artifact: the 3.97× ratio implies 25.2% Cu —
dead center of the concentrate grade band — i.e. contained metal on one side,
gross weight on the other. Shipped in response:

- **QuantityBasis** (`cu_content`/`gross_weight`/`unspecified`) on
  observations and flows; the graph refuses gross-weight flows as throughput
  (pinned by test), so mixed bases can never skew propagation shares.
- **Grade-band basis gate** in divergence classification: ratios in 3.0–5.0×
  on concentrate mirrors class `definitional` with the implied grade named;
  `unexplained` is now the hardest class to earn. The DRC→China refined gap
  (basis cannot be the mechanism at 99.99% Cu) correctly retains it and now
  ranks first.
- **coverageBias** attached to the facility-level HHI: modeled-coverage range
  (currently 22–100% by country) travels with the number.
- **Scenario system**: counterfactual event injection through the same engine
  on an explicit EvaluationFrame (kind/scenario/asOf/knowledge — knowledge in
  the run fingerprint, so a disagreeing replay can distinguish "the baseline
  moved" from "we know more now"). POST /api/economy/scenario returns
  baseline + counterfactual + structural delta. The as-known-then replay test
  demonstrates the backtest: Grasberg's dependent-smelter conclusion is
  reachable with contemporaneous knowledge, and posing the event two days
  earlier recovers the same conclusion.

## Phase 5 — conversion over discard, residuals over dismissal, measurement before wiring

Round-3 review caught two errors in *how* phase 4 landed its right things,
one of which would have silenced part of the graph the moment bilateral
trade edges arrive:

1. **The graph firewall's zero was a claim.** Discarding a gross-weight flow
   from throughput asserts the flow carries nothing: supplier counts drop,
   redundancy inverts (0.0 → 1.0), disruptions at gross-reported suppliers
   propagate nothing, and an all-gross node drops out of the throughput map
   entirely — an error running opposite to the skew it fixed. (Verified: no
   flow in the current graph is gross-declared — all curated edges carry
   `cu_content` and Comtrade rows enter as observations, so nothing was dark
   *yet*; the mechanism was wrong for what comes next.) Fix shipped:
   **conversion, not discard** — the divergence system's mirror-implied
   corridor grade feeds back as the conversion factor (`basis.ts`), with the
   20–33% band as `ktRange` uncertainty on the edge; where no grade exists,
   shares are **refused visibly** (centrality `share: null`, bottleneck
   `score: null` sorted first with SCORE REFUSED, propagation says "unknown,
   not zero"; nodes stay present). Pinned by tests for the dual-source case,
   the converted case, and the all-gross dark-node case.
2. **Classing definitional and dropping swapped a false positive for a blind
   spot.** The Chile→China pair is now normalized at the 25% reference grade:
   8,433 × 0.25 = 2,108 vs 2,125 declared → **+0.8% residual — the basis
   explains the entire gap; no material suppression signal in this
   corridor**, a stronger statement than "dismissed", and a baseline:
   definitional pairs rank on residual (never raw spread, which measures the
   ore grade), and a residual beyond ±10% reclasses `unexplained` so a
   drifting corridor climbs back into view instead of staying permanently
   filed.
3. **Backtest vacuity guard.** "Identical conclusion under both knowledge
   modes" also passes if both modes read the same records. The replay test
   now asserts the observation sets actually differed, and pins as
   *by-construction* what is (curated dependencies/flows carry no revision
   history) so the test never overclaims what it establishes.
4. **LiveAlerts, trust-first, UI last.** The system had already produced two
   would-be alerts that were wrong (the 10.3σ splice, the CL→CN phantom), so
   alerting shipped as: derivation (cadence-gated to monthly-or-finer series;
   reflexive positioning never fires) → **suppression memory** (a signal the
   divergence system already explains must not fire; the explaining record is
   referenced) → **retraction** (a fired alert later reclassified is
   withdrawn with its reason; withdrawals are records, not deletions) →
   **measured backtest** over 128 month-end knowledge states 2016–2026,
   strictly as_known_then with the no-lookahead invariant checked per alert.
   Measured: precision 0.438, recall 0.2, first-detection lead −30 days.
   That is below the bar for waking anyone, so **no alert panel exists** —
   the verdict and its reasons are encoded in the test suite, and the report
   names what would change the answer (weekly stocks feed, facility-cadence
   series, richer curated event record).

## Phase 6 — the horizon is the headline (external review round 4)

The round-4 review read the 0.438 backtest and found the wrong number in the
headline: **the verdict was the lead time, not the precision** — no threshold
tuning fixes −30 days, and monthly period-end series cannot in principle fire
before an event inside the period they describe. Shipped in response, in the
review's order:

1. **Information horizon** (`horizon.ts`, published inside the backtest
   report): per-source `knownAt − periodEnd` distributions, arrival cadence
   from knownAt spacing, event `firstReportedAt − occurredAt`, and the lead
   ceiling per source (best-case and typical). The review's expectation held
   almost exactly: USGS −30/−213 days, CFTC −3 (reflexive), price ~0 (roll-
   bearing, excluded), the monthly stock series 0 at best — not one
   originally-ingested physical series capable of positive lead. The 0.438
   was never the binding constraint. (Measured bonus: Comtrade's knownAt is
   unstamped, so its true ~2–3-month delay is invisible to the corpus —
   logged as a gap.)
2. **Event-record curation**: 9 of 9 false positives traced to one missing
   event. Six public-record events added (2017 Escondida strike + Grasberg
   export halt, 2019 Chuquicamata strike, 2020 Peru COVID curtailments, 2022
   Las Bambas blockade, 2025 US-tariff LME drawdown), each with occurrence,
   first report, and estimated magnitude+basis; `magnitude` added to the
   event schema. Precision moved 0.438 → 1.0 with the detector untouched —
   confirming it had been measuring curation completeness. The test suite no
   longer pins the value: it pins the procedure (no-lookahead, revision
   separation, undetected-events-reported) and the horizon's structural
   facts, and lets the number move.
3. **Residual drift** replaces the level threshold: a fixed 25% reference
   makes a genuine 30%-grade corridor read +20%, so the ±10% level trigger
   sat inside its own noise floor. Grade is a slowly-moving per-corridor
   offset; first-differencing removes it. A stable +20% corridor stays
   definitional (pinned by test); a step from +0.8% to +15% reclasses on
   drift. Level and band remain for display.
4. **Revision channel + arrival-cadence gate**: the alert gate now keys on
   how often information ARRIVES (knownAt spacing), not how long a period it
   describes — recovering the one class of annual-series alerting with a
   defensible lead: supersedes-chain revisions ≥5%, news on publication day.
   Twelve fire on current data (MCS 2025 revising 2023: Zambia refined
   −41.6%, Kazakhstan +23.3%, DRC +17.2%…), scored separately from
   disruption detection (a publisher's act, not an inference).
5. **Daily stocks adapter** after recon (see the phase-2 table update):
   `westmetall-lme-stocks`, the corpus's first daily physical series
   (best-case lead −1 day). Anomaly series now partition by period cadence
   so the daily stream can never splice against the monthly one. Re-measured:
   the 2026 drawdown detected at **+1 day lead** — the system's first
   non-negative lead, delivered by acquisition, exactly as the horizon table
   predicted. Next binding constraint, per the report's own caveat: the
   monthly evaluation grid.

## Phase 7 — what the 1.0 does and does not mean (external review round 5)

Round-5 review named the hazard in phase 6's own success: precision moving
0.438 → 1.0 with the detector untouched proves the number measures curation
— and a flattering artifact gets quoted far more readily than an
unflattering one. Shipped, in the review's order:

1. **Scorecard restructuring** before the number could propagate. Events now
   carry `curation: independent | post_hoc` (a truth set assembled by
   looking at what the detector fired on cannot score that detector; both
   detectable exchange-stock events are post-hoc — one was curated after
   the phase-6 false positives, the other was written around the very
   series the detector runs on). The headline is
   `precisionPreRegisteredOnly`, and on the current corpus it is **null: no
   measurement of detector precision is possible on the clean truth set** —
   which is the finding, not a defect. Also reported: episodes (2 matched,
   0 unmatched — 19 alerts on two drawdowns are two successes, not
   nineteen), the attribution window as an explicit sensitivity table (0
   pre-window days → precision 0.947 / lead −5; 30+ days → 1.0 / +7: the
   knob raises both together, so it is published, not buried), and the
   quiet-period alert rate (0 across 54 event-free months) — the volume
   axis precision cannot see.
2. **leadVsPrice**: lead is now benchmarked against the market, not only
   journalism, using monthly COMEX closes as a benchmark — never an input,
   so the round-4 reflexivity firewall stands (price may grade physical
   analytics; it may not feed them). Measured: the market moved first on
   BOTH exchange-stock events (−31 and −13 days at monthly resolution),
   confirming the review's stated expectation. A positive lead over a press
   report on a series every desk watches is not an information edge; the
   valuable target remains mine/logistics events, where recall is zero
   pending closer-cadence sources.
3. **Corpus health as an alert kind**: after phase 6 exactly one series
   could produce positive lead — a scraped third-party republisher — and
   graceful degradation on the only load-bearing source is indistinguishable
   from working. `corpusHealthSignals` fires when the lead ceiling degrades
   (staleness > 3× the source's own arrival cadence), names the serving
   rung, computes ceiling-before vs ceiling-now, and marks load-bearing
   sources; cleared conditions resolve as "condition cleared", distinct
   from retraction. The one alert class ready to wake someone today.
4. **Comtrade, fillable and now-or-never**: the getDA availability API
   supplies real release dates (committed snapshot), so `knownAt` is no
   longer a retrieval-time fallback — and it is stamped with the HELD
   version's release date, because Comtrade keeps one version and revises
   in place (both Chilean years already revised). The committed-snapshot
   rung is therefore not a fallback but the only Comtrade vintage archive
   that will ever exist: every successful live retrieval is archived to
   `data-archive/comtrade/` before parsing, and as_known_then blindness
   before the archive began is labeled in the backtest caveats.
5. **Hybrid evaluation grid** (month-ends + daily dates where daily
   evidence exists, 312 states): with the daily source in the corpus, the
   evaluation grid had become the binding constraint on measurable lead.

## Phase 8 — the bound, the freeze, and the return to the instrument

Round-6 review closed the alerting thread it had opened, reading the null
and the two negative price-leads as one finding from two directions:
**where a numeric series can detect, it cannot beat the price; where lead
would matter, a numeric series cannot detect at all.** Five of six truth
events are labour/regulatory/logistics — announced in language before they
occur in matter (Escondida's strike notice preceded the stoppage by two
days, a negative reporting delay no series can reproduce). The gap is a
missing acquisition modality (news/filings event extraction, AIS), already
named in the phase-2 source registry with `adapter: null` — a second
programme with a harder provenance story, to be funded deliberately, not
drifted into. Decisions taken, per the review:

- **Detector frozen** (not deleted): measured, documented, honest, with
  `precisionPreRegisteredOnly: null` and the attribution-sensitivity table
  attached. It becomes useful when a faster physical series or the missing
  modality exists. The attribution window default is now set by mechanism,
  not outcome: no anticipation mechanism is argued for current signal
  classes, so it is 0 days (precisionAll 0.947 / median lead −5d are the
  conservative in-prose figures); the null can only stop being null via a
  pre-registered external chronology or a holdout — never retrospective
  relabeling.
- **Corpus health shipped**: surfaced in the analytics view and the research
  panel (renders only when signals exist), and hardened from liveness to
  SAFETY: a plausibility gate on the Westmetall parse (sanity range,
  day-over-day ratio, monotonic dates, row count) rejects fresh-but-wrong
  data — the wrong-column-latch failure that staleness checks cannot see —
  deliberately degrading the ladder and firing the new `source_suspect`
  signal at high severity.
- **Returned to the instrument**: entity search shipped — canonical-register
  search (name/operator/country/kind) with an evidence headline per hit
  (value + valueKind, never a bare number), econ hits above geographic hits
  in the search bar, selection flying the map and opening the research
  panel. Verified end-to-end in the running app: "escondida" → mine →
  strike event, resolved observations, flows, dependency tree.

## Phase 9 — symmetric honesty, observable windows, and the operator dimension

Round-7 review, in its order:

1. **The 0 suppressed for the same reason as the 1.0.** The min-trials
   argument has no direction: "precision 0" over one unmatched alert reads
   as "wrong every time it fires", which one trial supports no better than
   sixteen matched alerts supported 1.0 — and publishing unflattering
   artifacts while suppressing flattering ones is its own bias, subtler
   because it looks like rigour. Below MIN_TRIALS (5) the headline is null
   with `insufficientTrials` alongside.
2. **Anticipation windows became data.** `announcedAt` on events: where
   announcement structurally precedes occurrence (Escondida's strike notice,
   the 2025 tariff probe order), the pre-window is announcedAt → start —
   observable, never chosen; events without an announcement have no
   anticipation story and keep zero. Honest re-run of the January-2026
   signal: no announced antecedent exists in the curated record for the
   2026 drawdown, so it remains quiet-period volume — if curation later
   surfaces a policy announcement behind that drawdown, the match (and the
   "detector saw forward-buying" reading) follows from the event's own
   structure, not from tuning.
3. **Search honours the knowledge state.** Under as_known_then, entities
   with no knowable record at asOf are withheld and counted, headlines
   resolve from knowable evidence only, and the playback state threads from
   the scrubber through the search bar — search is not the way around the
   AS KNOWN badge. (Pinned: Canada, carried only for live sources, is
   withheld at 2019.)
4. **The operator dimension.** Company entities + `operated_by` edges with
   attribution shares (public JV disclosures, representative; minorities
   <~20% and multi-operator aggregates fall to a REPORTED unattributed
   remainder). Operator-HHI ships beside country-HHI; measured on the
   current facility model the pair is country 1339 / operator 959 at 88.5%
   attribution — operator concentration is currently the lower number, and
   the dimension's value is the correlation structure it makes computable:
   Freeport's 944 kt spans three countries, BHP's 749 kt spans two, and a
   company-level scenario now propagates to every operated asset across
   borders (pinned by test: Freeport distress reaches Grasberg, Cerro Verde
   and Morenci simultaneously). "What does BHP operate?" is now a traversal.
   This is also the stated purpose the round-2 ownership sources
   (opencorporates / openownership, yields: entity+dependency) have been
   waiting for: parent chains (Southern Copper → Grupo México) are their
   job, and attribution stops at the operating company until they land.

Remaining search increments, recorded as next: query misses mapped to the
source-registry gap list (the highest-quality demand signal the system can
generate), evidence-layer search kinds (`refused`, `contested`, vintage
ids), and the policy test that no indexed field can hold a natural-person
name.

## Phase 10 — commensurability, applied to our own headline

Round-8 review caught round 9's headline comparing two incommensurable
indices — the same defect species the system exists to refuse, in our own
reporting. Country-HHI 1339 vs operator-HHI 959 differed in **partition**
(HHI floors at 10000/n: a finer partition reads lower regardless of
structure), in **attribution basis** (JV ownership shares are economic
interest; disruption propagates through operational control — Escondida
stops when BHP's workforce strikes, not 57.5% of Escondida), and — found
while correcting — in **universe** (reported country totals vs the modeled
facility subset). Shipped:

- `Dependency.role: operator | shareholder` on every operated_by edge;
  **only operator edges traverse** (a shareholding is a claim on output,
  not a lever over operations — pinned: a Rio Tinto event cannot reach
  Escondida through its 30%). JV-operated facilities whose operator of
  record is an unmodeled JV vehicle (Antamina, Collahuasi) are control-
  unattributed rather than force-assigned to a shareholder.
- `AttributionBasis` on operatorConcentration, never defaulted; both bases
  ship in the engine and the panel ("who can stop it" / "who owns the
  loss"). Grasberg is the pinned sharp case: majority state-held,
  Freeport-operated — 800 kt to Freeport under control, 390 under economic.
- `groupCount` / `effectiveGroups` / `partitionFloor` on **every** HHI
  (country, capacity, operator), so no consumer reconstructs comparability
  from outside.
- The corrected measurement, fully labeled and pinned as an executable
  test: control **1778** (9 groups, effective 5.6, 84.5% attribution) vs
  economic 959 (15 groups, effective 10.4); same-universe country 2135
  (9 groups, effective 4.7 — the only strictly comparable geographic
  figure, itself carrying the Chile-heavy facility coverage bias); the
  world-reported 1339 sits in a different universe and is labeled as such.
  The review's expectation held: control came out materially above 959 and
  above the reported country figure. The index-free finding survives every
  correction: Freeport controls 31.2% of modeled mine output across three
  countries.

The through-line the round-8 status named is adopted as doctrine: every
serious defect across ten rounds has been a quantity compared against
something it was not commensurable with, and the defence is always the
same — make the basis explicit, carry it with the number, refuse rather
than default when it is unknown. That discipline, now in the types
(QuantityBasis, AttributionBasis, MeasurementClass, curation, roles), the
graph (firewalls and refusals), the analytics (partition context, coverage
annotations) and the scorecard (population splits, floors), is the most
valuable thing in the repository.

## Phase 11 — the fourth axis, and the class-gated traversal

Round-9 review found the fourth comparability axis inside round 10's own
corrected numbers: **attribution completeness**. The country index covered
100% of its universe; the control index covered 84.5% of the same universe,
renormalized — inflating every share by 1/0.845 and the HHI by ~1.40. The
reviewer's back-of-envelope said the enumerated correction would land near
1391; the measured value, with the remainder restored, is **exactly 1391**.
Shipped:

1. **hhiWithRemainder** on operator indices: the renormalized `hhi` stays
   (labeled as inflated by 1/completeness²), and only the remainder-
   restored figure — unattributed facilities enumerated as their own
   groups, per-facility minority residues lumped one group each with the
   slight concentration bias said — is comparable against a full-universe
   index. `attributionCompleteness` and `remainderTreatment` travel with
   both. The synthetic pin: a fully-unattributed universe reads hhi 0 /
   hhiWithRemainder 10000 — the renormalized figure has nothing to say,
   the comparable one says "monopoly of the unmodeled".
2. **The remainder was never anonymous**: Compañía Minera Antamina S.A. and
   Compañía Minera Doña Inés de Collahuasi SCM are named legal entities of
   public record — unmodeled, not unknown. Curated as company entities with
   operator edges (strength 0: pass-through vehicles whose economic
   interest sits with their shareholders), control completeness reached
   1.0 by curation alone. The ownership-adapter ledger line splits into its
   two very different costs: operator-of-record (CLOSED, curation) vs
   parent chains — who stands behind each vehicle (still the adapter's
   job).
3. **Corrected conclusions**, measured and pinned: control 1391 vs economic
   959 renormalized / 768 comparable — the basis reversal survives
   comfortably; control vs the world-reported 1339 is retired in both
   directions (different universe, and now effectively equal anyway); the
   like-for-like facility pair WIDENS to 2135 vs 1391 — geography is
   substantially, not somewhat, more concentrated than control on the
   modeled set. Freeport at 26.3% control across three countries stands
   through every correction.
4. **Traversal gates on event class, not edge role alone.** The round-10
   rule (shareholder edges inert) was correct for the event class that
   motivated it and too strong globally: sanctions and insolvency attach to
   owners, not managers. `eventClassOf` — operational → operator edges
   only; financial (new `sanction`/`insolvency` types) → operator AND
   shareholder; regulatory → neither (attaches to territory; jurisdiction
   propagation via located_in is future work, noted). The Rio Tinto pin
   gained its sibling: a strike at the holder still reaches nothing, and a
   sanctions-class event DOES reach Escondida through the 30% — and the
   Grasberg case is pinned end-to-end: a MIND ID operational event touches
   nothing, a MIND ID sanction reaches Grasberg, Manyar and Amamapare
   through the 51% no strike could use.

## Phase 12 — null over zero, regulatory territory, and the registry as code

1. **An index over zero attributed tonnage is null, not 0.** The synthetic
   pin in phase 11 read the renormalized figure of a fully-unattributed
   universe as `hhi 0` — but 0 is a real value on the HHI scale ("perfectly
   unconcentrated"), and an index computed over an empty attributed set has
   no value at all. `OperatorConcentration.hhi` is now `number | null`,
   null when allocated tonnage is zero, band `no-data`. The distinction is
   the ledger's oldest rule resurfacing at the type level: absence of
   evidence must be unrepresentable as evidence of absence.
2. **Regulatory events propagate by territory + scope.** Phase 11 left
   regulatory traversal at "neither edge role; jurisdiction propagation is
   future work" — which made a third of the truth-set events typed but
   inert. `RegulatoryScope { jurisdictionCountryCode, commodity?, stages?,
   direction: 'export' | 'all' }` now rides on the event, and
   `regulatoryImpact` resolves scope membership through the machinery that
   already existed (located_in edges, countryCode): a `direction: 'all'`
   halt disrupts in-scope entities and walks their downstream (Peru 2020
   reaches Cerro Verde, Antamina, Las Bambas, Callao and Onsan — never
   Escondida: territory means territory); a `direction: 'export'` halt
   stops only flows crossing the border, sparing domestic receivers
   (Grasberg 2017 halts outbound concentrate without stopping production).
   The Grasberg pin is deliberately honest about a recorded limitation:
   modeled flows are 2024 annual snapshots, so the post-2023 domestic-
   processing topology (Amamapare → Gresik + Manyar, both ID) contains zero
   crossing flows for a 2017 halt to stop — the test asserts the mechanism's
   shape (production continues, domestic spared, explanation says what it
   found) rather than inventing 2017 exports. A scenario-posed Chilean
   export ban shows the full mechanism against present topology: Saganoseki,
   Shanghai and Guixi feel it; Caletones does not. An unscoped regulatory
   event is **refused, not guessed** — propagation says so in the
   explanation instead of defaulting to a graph walk that would be wrong
   in both directions.
3. **Event-class attribution basis — recorded UNBUILT.** The class gate
   decides which edges an event traverses; it does not yet decide which
   *basis* the exposure number is quoted in. A sanctions-class event
   reaches entities through operator AND shareholder edges, but the
   exposure it creates is neither pure control nor pure economic interest:
   the sanctioned party's reach is operator-of-record ∪ material
   shareholding. The named test case is **Glencore**: operator of
   Antapaccay (control), 44% shareholder of Collahuasi and 33.75% of
   Antamina (economic interest via named JV vehicles) — a sanction on
   Glencore touches all three, and today no single figure states that
   combined exposure in a declared basis. This is the next analytical
   dimension in the queue and it is deliberately not built: the instrument
   backlog (this phase's §4) was three rounds old and analytics kept
   jumping it. If another analytical dimension arrives before that backlog
   clears, the right response is to point at this entry.
4. **The source registry is code now, and a search miss is a demand
   signal.** Every review round computed a gap list; the repository had no
   code counterpart — the gap analysis lived in prose that nothing could
   execute. `SOURCE_REGISTRY` reifies it: 17 real entries (5 built, 7
   reconned-and-deferred with the recon findings preserved, 3 modality-
   programme, 2 ownership with the two purposes split), each carrying
   yields, cadence, access class and the adapter id or **null — the null
   entries ARE the gap list**. The search route closes the loop: a TRUE
   miss (no hits, nothing withheld) returns `registryGaps` — the
   registered-but-unbuilt sources whose declared coverage could have
   answered — and appends the miss to `data-archive/search-misses.jsonl`,
   so dormant sources accumulate demand evidence instead of opinions. A
   withheld miss under as_known_then returns no gaps: the state CAN
   answer, the knowledge state withholds it, and offering sources there
   would misdiagnose coherence as absence. The person-name policy is
   pinned by test at both ends: `yields` may name only canonical identity
   kinds (no source registered for natural-person data), and `SearchHit`
   projects register fields only.

## Phase 13 — what WAS vs what was KNOWN

Round-12 review generalized the Grasberg pin: `asOf` filters what was
*known* (observation knownAt, event firstReportedAt) — but the flow
topology is a single-vintage claim about what *was*, presenting as valid at
every tick. Scrub to 2017 under AS KNOWN and the map drew 2024 arcs under a
2017 badge: the same coherence failure search closed in round 8, one layer
down, and it reached further — every historical propagation ran against
present topology; the regulatory class is merely where it surfaced, because
export routes are what changed.

1. **Topology validity is an enforced invariant, not a documented special
   case.** `topologyValidity(state, asOf)` classifies the evaluation date
   against the union of flow periods, following the same selection rule as
   every other quantity ("latest claim at or before asOf") — which makes
   the guard deliberately asymmetric. `predates` (asOf before any flow
   period): no admissible vintage exists and the world demonstrably
   differed — every flow-derived tonnage is **null, never zero**, with the
   mismatch named in the explanation, because "no entity in scope" is an
   answer and "topology out of period" is not, and the two must not render
   alike. `extrapolated` (asOf after the period): the snapshot serves as
   latest-known structure, labeled — nulling forward would null the live
   instrument and contradict the latest-observation convention used
   everywhere else. Round 12's honest zero (Grasberg 2017 "finds no
   crossing flows") is retired: it was the middle row of the ambiguity
   table wearing the right answer's clothes; the pin now asserts null. The
   unscoped-regulatory refusal moved from 0 to null for the same reason,
   and the scenario delta refuses to sum a null impact into a smaller
   known total. Guard shown general in tests: the 2017 Escondida strike's
   tonnage nulls alongside the 2017 export halt's.
2. **The playback surface says so.** Both playback projections (map +
   analytics) carry `topology`; the panel renders a banner beside the
   AS OF / AS KNOWN badge when the scrub date falls outside the topology
   period — red for predates ("out of period"), gold for extrapolated
   ("latest-known structure") — the same shape as search's withheld-entity
   note. The scrubber is now honest about arcs the way it has been about
   observations.
3. **The structural fix is flow vintages** — several flow periods
   coexisting with asOf selecting among them, the MCS-vintage shape. Real
   work; joins the instrument backlog RANKED BELOW evidence-layer search
   kinds and the OpenOwnership parent-chain adapter (see backlog).
4. **The person-name policy now holds at the miss log.** Round 12 pinned
   it at the index (SearchHit fields) and the registry (yields), but a
   person-directed query that truly missed was still written verbatim to
   `search-misses.jsonl` — refused at the surface, persisted at the back.
   `missRecord` gates the string on register vocabulary (registry
   categories/keywords + state-derived tokens: kinds, countries,
   operators, commodity, entity names); free text with no register
   vocabulary is not a demand signal for any adapter, so it is counted
   (`queryWithheld: true`) and its string discarded, at zero analytical
   cost. The property the policy asserts is that the system does not
   ACCUMULATE person-directed queries, not merely that it declines to
   answer them; the third policy pin tests exactly that.

## Phase 14 — the ledger becomes a set of conditions the test suite maintains

A deferred decision is safe only while the condition that made it safe still
holds — and that condition should be executable rather than remembered. Not
a new capability and not a backlog item: guard work on decisions already
recorded, the same category as the topology-validity guard, which converted
one documented assumption into an enforced invariant and immediately
exposed the class.

1. **validWhile predicates** (`ledgerGuards.ts`): six deferred decisions
   now carry the condition under which each remains the right one, and one
   test evaluates all of them against the real state. A failure names the
   entry, the original reason, and the condition that stopped holding —
   "a decision needs re-taking, and here is why it was taken", which is a
   different and more useful thing than a broken build. The entries:
   Phase 12 §3 (attribution basis unbuilt — valid while no sanction/
   insolvency event is curated); flow vintages deferred (valid while
   exactly one distinct flow period exists); the person-name policy's
   three pins (valid while every register kind stays in the canonical
   identity set); the modality freeze (valid while no built adapter
   yields events); the Westmetall singularity note (valid while exactly
   one daily physical stream is built); forward extrapolation (valid
   while the distance stays under the bound). Guards do not re-decide —
   a failing predicate raises the decision, a human takes it — and do
   not cover built work, which has its own tests.
2. **Vacuity discipline applies to the guards themselves**: a check
   designed never to fire in its shipping state must be shown able to
   fire. Each predicate has a planted-condition test — a curated sanction,
   a second flow vintage, a person-shaped kind, an event-yielding adapter,
   a second daily stream, an out-of-bound date — asserting it fails
   exactly there.
3. **Extrapolation is quantified, not just flagged.** Against a fixed
   snapshot, live evaluations are permanently 'extrapolated' — the status
   stops carrying information and the DISTANCE is the number that moves.
   `TopologyValidity.extrapolationDays` now carries it (in the note and
   the panel banner), and the guard's bound is stated with its basis:
   **two annual snapshot cadences (730 days)** — one cadence to produce
   the next vintage plus one grace cadence; beyond that, an expected
   vintage has been skipped and "latest-known structure" must be
   re-argued or the vintage refreshed. Measured today: 604 days — the
   bound forces the re-take in roughly four months.
4. **Two consequences of the guard, recorded**: (a) five of the six
   backtest truth-set disruption events (Escondida 2017, Grasberg halt
   2017, Chuquicamata 2019, Peru 2020, Las Bambas 2022) predate the 2024
   flow topology — their propagated tonnage is now null and historical
   propagation over the curated record is structural-reach-only until
   flow vintages land; the capability statement says so. (b) The
   flow-vintage material partially EXISTS already: Comtrade holds
   country-level annual trade by period (archived, knownAt-stamped) —
   what defers flow vintages is the same allocation model that defers
   bilateral rows as graph edges (country↔facility double-counting), not
   acquisition. Recorded on the backlog line.

## Phase 15 — the evidence trigger fires, and identity is never self-standing

1. **The extrapolation bound gets its second axis — and the basis
   correction that motivated it.** Phase 14's two-cadence ceiling answers
   "should a new vintage exist by now?" — a question about the CURATOR.
   The guard needs to answer "is the old topology still true?" — a
   question about the WORLD, and the two coincide only if vintage cadence
   tracked structural churn, which it doesn't (it is annual because
   curation is annual). Churn-derived bounds don't survive contact with
   the data (six events over a decade support no rate estimate); what
   survives is the doctrine one level deeper — check the condition, don't
   remember a proxy for it. Elapsed time is a proxy for "something
   probably changed"; **the event register holds the thing itself**.
   `structuralTopologyEvidence`: curated events postdating the snapshot
   period whose shape implies structural movement — closure, expansion,
   scoped regulatory, sanction/insolvency, or an OPEN-ENDED high-severity
   disruption (a disruption with a curated end is transience: the
   structure came back). Occurrence-filtered by asOf, so a scrub before
   the event stays uncontradicted — no future leak.
2. **The trigger fired on its first evaluation, as predicted:**
   `evt:grasberg-mud-rush-2025` — open-ended force majeure on Indonesian
   concentrate, ~400 kt of deferred output — postdates the 2024 snapshot
   and contradicts extrapolation today, roughly four months ahead of the
   clock ceiling. That firing is the argument for the trigger. The
   decision was re-taken, and the re-take is recorded here: extrapolation
   CONTINUES (there is no other modeled structure) with the contradiction
   **carried on every projection** — `TopologyValidity.structuralEvidence`
   plus a note escalated to STRUCTURE HAS MOVED, pinned in propagation and
   API tests — rather than nulled. [Reason corrected in phase 16 — the
   original "nulling would double-count the event mechanism" conflated two
   different quantities. The event mechanism carries the MAGNITUDE: output
   falls, impairment propagates along the modeled edges. Structural
   evidence says the EDGES THEMSELVES may be wrong — force majeure
   redirects contracts, buyers re-source, routes change shape. Those are
   two different errors and only the first is handled. Figures continue
   because NO OTHER STRUCTURE IS MODELED — not because the residual is
   bounded; the residual at the affected entities is unquantified
   structural drift, and the banner says so.] The evidence axis thereby
   graduates from a remembered assumption to a product invariant; the
   clock ceiling remains the guard's condition, now protecting even
   evidence-carried extrapolation from outliving a skipped vintage.
3. **Entity provenance: the divergence resolved toward the code.** Round-1
   prose said each identity record carries provenance; the types say
   `Entity` deliberately does not — an entity is an IDENTITY record, and
   evidence lives on the five record kinds that reference it (all
   provenance-checked by `validateState`). The docs now state the model
   precisely, and provenance totality gained its missing second half,
   enforced by test: **every entity is attested by at least one
   provenance-bearing record** (no orphan identities; verified with no
   carve-outs — the commodity node included). This is the same attestation
   rule search's knowledge coherence already applied.

## Phase 16 — the trigger honours the badge, and identity gets its evidence class

1. **The evidence trigger is knowledge-filtered.** Round-15 review caught a
   genuine inconsistency with the system's own invariant: the trigger was
   occurrence-filtered, and in the window between occurrence and first
   report (the mud rush occurred 09-08, entered the evidence base 09-10) an
   as_known_then evaluation would have fired on an event nobody could yet
   know — hindsight leakage in the mode built to exclude it. The engine's
   asKnownThen filter did block this on every current path (unreported
   events never reach the function), but that protection was POSITIONAL —
   correctness remembered at the call sites, not checked in the function,
   which is exactly the shape this project keeps converting. The fix is the
   observation distinction applied to events: the postdating condition
   stays on occurrence (a fact about the world); the VISIBILITY condition
   keys on firstReportedAt under as_known_then and occurrence under
   best_known, both dates already on the record from the detection-latency
   work. The sibling pin asserts the two modes disagree at 2025-09-09 and
   re-agree at 09-10 — and first asserts the mud rush's two dates differ,
   the vacuity condition without which the pin proves nothing.
2. **The Phase 15 reason was corrected in place** (see the bracketed
   amendment there): "nulling would double-count" conflated magnitude
   impairment with edge-shape wrongness. The banner now claims only what
   is true — "figures continue because no other structure is modeled" —
   and names the residual as unquantified structural drift, because that
   reason is what a future reader will re-decide against.
3. **Entity attestation carries its class.** The phase-15 orphan test
   proved every entity is attested but not BY WHAT. `entityAttestation`
   reports the strongest evidence class attesting each identity (strongest,
   not weakest: one reported record defeats any number of representative
   ones as proof the entity is more than curation), with two tiers below
   the valueKind ladder: `event_only` and `structural_only` (dependency
   edges alone). Surfaced on search hits (SearchHit.attestation, added to
   the pinned register fields), the entity API, and the inspector header.
   The measured finding it immediately produced: country identities are
   reported-attested via the live USGS series, but **even the corpus's
   best-known facility (Escondida) is representative-attested — every
   facility-level quantity is curation-class** — and the JV operating
   vehicles are structural_only, existing on a curated relationship claim
   alone. The round-3 real-name/synthetic-number concern, one level up:
   now labeled wherever the identity appears instead of implied by
   drilling into its records.

## Phase 17 — admissibility reaches the result, and the split is priced

1. **Two lattice directions, named so they survive.** The codebase now
   aggregates evidence class in both directions and both are correct:
   `weakestInputClass` for derived quantities (contamination propagates —
   one representative input taints the result) and
   `strongestAttestingClass` for entity existence (one good witness is
   enough — no quantity of representative records subtracts from it;
   `entityAttestation` renamed to carry the direction). Different
   questions, opposite directions. Someone will eventually notice the
   asymmetry and be tempted to "fix" it; the asymmetry is the point, the
   names now say so, and neither is ever a bare `sourceClass`.
2. **Verified: admissibility stopped at the observation layer.** The
   round-16 review asked whether any admissibility flag reaches analytical
   results. Answer: none existed — no aggregate of input classes was
   computed anywhere above the observation. `weakestInputClass` now rides
   on the concentration family (country/facility/operator/capacity), with
   the operator indices including the attribution edges as inputs
   (curated structural claims, representative-class by construction — so
   the operator index cannot read stronger than the structure it stands
   on, even after facility observations become reported). And the first
   measurement bit harder than the review's own framing: **no index in
   the system is reported-class end-to-end** — even the country index
   reads `representative` (Mongolia's static entry, Panama's curated 0)
   and would cap at `estimated` regardless, USGS's own label for
   latest-year figures. The structural layer is pinned entirely
   representative — a pin that breaks deliberately the day a reported
   structural source lands.
3. **The round-10 trade, priced.** Curating the two JV operating vehicles
   bought control-attribution completeness 1.0 — and the attestation label
   now shows what it cost: both vehicles are `structural_only`, the lowest
   tier, existing on a curated relationship claim alone. The cleanest
   index in the system (completeness 1.0, hhi = hhiWithRemainder) is
   clean in completeness and weakest in attestation. Recorded because the
   recommendation was made without pricing it; the label surfacing the
   price is the system working.
4. **The registry correction and the ranking fact.** The round-16 review
   cited an EDGAR registry entry that did not exist (`company-filings` is
   registered under the EVENT purpose; `artifact` is not a canonical
   yield). The substantive point survives the correction — filings as
   structure-source is a different purpose from filings as event-stream,
   the same two-purposes split as ownership — so `sec-edgar` is now its
   own entry (yields entity/observation/capacity; SourceYield gained
   `capacity`): listed operators disclose production and capacity BY
   FACILITY, attributed to the operator by construction — the source that
   would move the structural layer, and every index standing on it, from
   representative to reported (bound: filers only; Codelco sits outside).
   The attestation measure now gives the backlog a self-consistent
   ranking criterion — how much of the corpus does each item move from
   curation-class to reported: OpenOwnership layers structural claims on
   a structural layer; sec-edgar changes the class of the layer
   everything else stands on. Recorded as a fact FOR the ranking
   decision, per the review — the backlog order itself is unchanged.

## Phase 18 — the proportion pin, the forced ordering, and the ranking decision

1. **The split line is retired for the narrower true statement.** "The
   numbers are reported, the structure is curated" was too clean — the
   country index is representative too, and would cap at `estimated`
   regardless (USGS's own label for latest-year figures). The docs now
   carry only what measurement supports: **no index in the system is
   reported-class end-to-end, and none can be until the structural layer
   changes class.**
2. **The structural pin is a proportion, not a flag.**
   `structuralClassProfile` measures the sourced share of flows,
   capacities and attribution edges by record and by tonnage (served in
   the coverage projection; 0% across all three today, pinned as
   numbers). A boolean pin would have broken PARTIALLY at the first
   filings ingest — filers only, Codelco outside, a mixed layer — and
   the pressure at that moment would be to relax the flag rather than
   measure the mix. The proportion survives the event it was written
   for: the first ingest moves a number from 0 to something. Same shape
   as coverage annotation and attribution completeness.
3. **The ordering EDGAR forces, written on its entry:** filings move
   quantity and structure together from the same documents. Any path
   that reports quantities while leaving structure curated leaves every
   index representative regardless, because the operator indices count
   their attribution edges as inputs. This is a property of the class
   algebra, not a preference.
4. **The ranking decision — taken here, once.** Two defensible criteria
   were on the table: instrument value (the round-7/8 mission) and
   attestation (how much of the corpus an item moves from curation-class
   to reported). Decision: **evidence-layer search kinds stay first** —
   the instrument mission was chosen deliberately, the item is small,
   and it completes the search arc in flight. **sec-edgar takes the
   second slot, ahead of OpenOwnership and flow vintages**, on
   attestation dominance — and the dominance compounds rather than
   competes: it is the only registered source that changes the class of
   the layer BOTH remaining items stand on. OpenOwnership parent chains
   layered on a wholly-curated layer are more curated structure; parent
   chains over operators attested from filings are worth strictly more.
   Flow vintages versioning curated flows stay representative; vintages
   over a reported layer inherit its class. So the order is: 1)
   evidence-layer search kinds, 2) sec-edgar structural ingest, 3)
   OpenOwnership parent chains, 4) flow vintages (deferral guarded).
   The two criteria disagree only about the top slot, and there the
   mission decides; below it they agree.

## Phase 19 — the epistemic state becomes searchable (backlog slot 1 closes)

Evidence-layer search kinds, the last item of the search arc
(`evidenceSearch.ts`, wired through `/api/economy/search` and the search
bar). Search found entities; it now also finds the system's own epistemic
state. The round-18 review's refinement shaped the design: since the
original spec, "refused" had become at least five distinct conditions and
"stale" four, each with a different remedy — a single bucket would have
been less useful than the machinery deserves, and TYPED states let an
analyst find the ones with a shared fix, which is the actual research move.

- **Typed refusals** — `refused:basis` (unconverted gross-weight flow →
  curate a corridor grade), `refused:component` (bottleneck score null),
  `refused:topology` (evaluation predates the topology → flow vintages),
  `refused:scope` (unscoped regulatory event → curate regulatoryScope),
  `refused:attribution` (null operator index → curate operated_by edges).
  Each type maps to exactly one mechanism in code and carries that
  mechanism's own explanation verbatim plus the type's shared remedy. The
  throw-based refusals (concentration on market metrics) produce no state
  and so cannot be search hits — by design, not omission.
- **Typed staleness** — `stale:source` / `stale:ladder` / `stale:suspect`
  from corpus health, `stale:topology` from the extrapolation
  contradiction. Four conditions, four responses, stated on the hit.
- **`contested`** typed by divergence class (`contested:unexplained` ranks
  the hardest-earned class first); **`vintage`** inventories the source
  editions actually held with knowability ranges — what as-known-then can
  and cannot reconstruct, as a search result.
- **Coherence, end-to-end**: evidence queries under `as_known_then`
  compute from the knowledge-filtered state (`asKnownThen` exported from
  the engine rather than re-implemented). Pinned through the full stack:
  `stale:topology` at 2025-09-09 fires under best_known and returns empty
  under AS KNOWN — the mud rush's occurrence→report window again, now at
  the search surface.
- Per-type vacuity tests plant each condition (a dark gross-weight flow,
  an unscoped decree, a predating evaluation, a post-period force
  majeure, the fixture's unattributed operators) and assert the typed hit
  appears with its remedy.

Backlog after this round: 1) ~~evidence-layer search kinds~~ CLOSED,
2) sec-edgar structural ingest, 3) OpenOwnership parent chains, 4) flow
vintages.

## Phase 20 — two decisions taken before the EDGAR ingest, while they are predictions

Doc-and-registry round; nothing built. Both decisions are recorded on the
`sec-edgar` entry so the ingest is judged against what was said beforehand.

1. **The forced ordering has a stated boundary: it does not extend to
   flows.** A filing yields facility, production figure, operator, and
   often capacity — but no filer discloses where the concentrate goes
   (Freeport reports Grasberg's output, never that it feeds Guixi). So
   `structuralClassProfile`'s components are predicted to move at
   different rates: entities and capacities first, attribution edges with
   them (operator is on the face of the filing), and **flow edges staying
   at 0% indefinitely** — structural to the source, not a gap it closes.
   Recorded now precisely so the flat flow component reads as a
   confirmed prediction rather than needing a post-hoc explanation, and
   so nobody mistakes a completed EDGAR ingest for a reported flow layer.
   Flow class change waits on a different source shape entirely
   (trade/movement data, e.g. the AIS modality or allocation-modeled
   Comtrade).
2. **Self-reporting: measured, not labeled.** A filer's disclosed
   production is `reported` by source class and self-interested by
   nature — the document establishing the figure is published by the
   party it reflects on, a materially different epistemic position from
   USGS compiling third-party statistics, and one the class vocabulary
   cannot express. Decision: NO new `attribution: self_reported |
   third_party` axis. The interest question is answered by machinery
   that exists, with one precision: filer facility figures and compiled
   country figures are not the same quantity (no third-party
   per-facility figure exists — that is why EDGAR is worth ingesting),
   so the check runs at two levels — per-country filer rollups meet the
   compiled figure in the COVERAGE system, where ratio >1 is already
   classed a contradiction; genuinely coinciding quantities become
   DIVERGENCE claims with the residual as the watched baseline. Self-
   interest thereby becomes a finding (a filer persistently one side of
   the compiled statistic — the corridor-residual shape), not an
   assertion. Contamination-direction class and interest-direction are
   different questions; the second is measured. Provenance continues to
   name the discloser, which is where "who published this" belongs.

## Phase 21 — EDGAR recon: three questions probed, two answered, one gated

Recon-only round against live endpoints from this sandbox; verbatim
captures in `snapshots/sec-edgar-recon.json`. The three shape questions
from the round-20 review, in their probe order:

1. **Vintage depth — answered, and it is the pleasant surprise
   confirmed.** The submissions API serves Freeport's complete filing
   index: annual reports 2013→2026 in the recent window alone, an older-
   files continuation beyond it, and the FY2021 **10-K/A amendment
   sitting beside its original** — supersedes chains pre-exist in the
   source. `filingDate` is knownAt (~45 days after the Dec-31 period
   end: knowledge lag measured, not assumed). Unlike Comtrade this
   source keeps everything, so vintages are recoverable retrospectively
   rather than now-or-never. **Ingest-shape decision: the first ingest
   targets the decade, not the latest filing** — backfill is one index
   call plus N documents, and it is the only structural source whose
   revision history can be reconstructed after the fact.
2. **Reporting-unit alignment — direction answered, table shape gated.**
   Full-text search returns 36 filings for the exact phrase "Grasberg
   minerals district" — FCX's own vocabulary is the DISTRICT, not the
   mine the register holds. So EDGAR observations require a curated
   reporting-unit → entity mapping (or district-level entities); forcing
   a district or share-weighted figure into a facility observation would
   be the round-4 basis error in a new place, exactly as the review
   warned. Whether Morenci is share-weighted and how the
   consolidated/attributable columns sit needs the document itself.
3. **Consolidated vs attributable — gated at the document tier.** XBRL
   company facts verified production-free (800 tags across four
   namespaces, all financial statements), so production tables live ONLY
   in the narrative HTML — and the Archives host rejected two truthful
   non-email UAs: SEC fair-access requires a declared automated-tool
   identity **including a contact email**. That identity is the
   operator's to supply (env-var config on the adapter), never
   defaulted and never borrowed — the recon deliberately did not send
   one. The block page is captured verbatim as the evidence.

Consequence for the adapter build: everything except the table parse is
ready (index → knownAt → vintage backfill plan); the parse itself and
the consolidated/attributable decision resolve on the first document
fetch once a contact identity is configured. When the answer lands, the
attribution scope belongs ON the observation, not inferred at read time,
per the review.

## Phase 22 — EDGAR build requirements, pre-registered against the gate

The document tier waits on the human operator's contact identity (their
decision; neither borrowed nor invented). Building the parser without a
document would mean building against imagined tables — against the
recon-first doctrine — so this round pre-registers the requirements the
build will be judged against, the phase-20 move applied to the parse.

1. **Operational**: the UA is operator-supplied config in SEC's
   documented form "OrgName role@org" (a firm role address over a
   personal one — survives turnover, and reaches whoever owns the
   pipeline); generic UAs are the documented 403 cause, matching the
   recon's two rejections. Rate cap 10 req/s — space at 0.12s rather
   than sitting on the boundary; NEVER immediate-retry a 403 (it
   lengthens the block). A decade × several operators is a few hundred
   documents: a throttle-and-cache problem, and the archive rung is
   already the cache.
2. **The district finding is a subject-precision invariant, not a
   mapping chore.** Attaching a district figure to a mine entity is
   fabricated precision at the SUBJECT level — the same invariant as
   coordinates on a country-precision claim, one axis over. Decision:
   districts become entities in their own right with `contains` edges to
   facilities; the observation attaches to what the filing actually
   describes, and any facility-level split is an explicit derived step
   that CAN REFUSE. (The `contains` dependency type and its graph
   semantics land with the ingest, designed against real reporting
   units, not guessed ones.)
3. **Comparatives make the backfill dense, not just deep.** Each 10-K
   carries 2–3 years of comparatives, so FY2020 production appears in
   the FY2020, FY2021 and FY2022 filings with three distinct knownAt
   stamps and occasional restatement between them. The ingest parses
   every comparative column, each stamped with its filing's own
   knownAt — revision chains arrive densely on first ingest rather than
   accumulating over years, the opposite of Comtrade, and the
   supersedes machinery gets real material immediately.
4. **The unit hazard is the round-4 error in its purest form.** FCX
   reports recovered copper in millions of pounds; 1,260 read as kt
   instead of Mlb is out by 2.2046× — arithmetically valid,
   semantically wrong, the Westmetall failure mode with more surface.
   Units are captured from the table header, never assumed, and the
   plausibility gate generalizes to this adapter on day one (anchor
   available by construction: a facility figure cannot exceed its
   country's compiled figure), not retrofitted after a bad parse ships.
   The ceiling's soft edge is diagnosed, never collapsed (round-22
   refinement): a SINGLE parsed figure breaching the country ceiling is
   a unit/parse error — the gate rejects it, and it catches the Mlb/kt
   error specifically, since a 2.2×-high district figure breaches its
   ceiling wherever the district is a material share of national output
   (Grasberg against Indonesia's compiled total is exactly that case).
   MULTIPLE filers legitimately summing past the compiled figure is the
   coverage system's ratio>1 contradiction — a finding, routed to the
   existing path. Same numbers, two diagnoses; only one means the
   parser is wrong.

When the operator supplies the identity: first document fetch answers
consolidated-vs-attributable, attribution scope rides ON the
observation, and the parse is built against the actual table under
these four requirements.

**Standing instruction for the build round (round-23 review):** if the
identity arrives months rather than days after this was written, re-read
the four requirements against the register AS IT STANDS THEN, not as it
stood here — a pre-registration that has aged into archaeology must be
re-taken, not obeyed. While the gate holds, the branch degrades visibly
rather than sitting still: the extrapolation clock advances against its
730-day ceiling on every test pass (the Grasberg evidence trigger
already firing beneath it), and the structural profile stays pinned at
0% until this ingest is the thing that moves it — which is the property
the guard exercise was for.

## Phase 23 — the completion assessment, and the usage finding

Against the founding directive's Phase-1 definition of done, the system is
complete: the full research path runs, with much alongside it that was
never asked for. Against the mission it is not, and the review's ranked
gaps are recorded: one commodity (the untested central claim — resolved in
phase 24); the structural layer 0% reported (EDGAR, gated); recall 0.18
structurally (the modality gap, deliberately deferred); historical
structure absent (flow vintages, slot 4); and **entity resolution has a
contract and no gate** — verified this round: an unmapped external
identifier (a Comtrade M49 code outside M49_TO_ENTITY, an MCS country
outside the map) is silently dropped (`return null` / `continue`), the
round-5 "zero is a claim" shape at the resolution layer, outstanding since
round 1 and now on the record.

**The usage finding, sharpened by where it was measured**: the review
asked whether anyone has used the instrument, pointing at the one gauge
built for it. `search-misses.jsonl` does not exist — zero misses ever
recorded; the only archive write is the Comtrade vintage the build's own
acquisition made. In production that emptiness would be ambiguous (unused
vs perfectly served — two states one file renders alike, the exact
ambiguity this project refuses elsewhere, and the system has no instrument
for use itself). In THIS sandbox it is unambiguous: every interaction on
record is the builder's own validation. Twenty-three rounds of verified
instrument; zero researcher-hours. The mission was an instrument someone
keeps open all day — one commodity is a demonstration, two is an
instrument someone might keep open, which is what phase 24 is for.

## Phase 24 — aluminium: the substrate survives its falsification test

The founding directive claimed the architecture extends to new commodities
without conceptual rewrite; nothing had ever tested it. Aluminium was
chosen as the SHARPEST test, not the easiest — bauxite → alumina → primary
metal breaks copper's shape deliberately: chemical refining BEFORE
electrolytic smelting (inverting copper's device order), a different basis
per stage, electricity as a first-class input.

**Verdict: the substrate survived — no conceptual rewrite.** Every engine
system, the graph, knowledge machinery, topology guard, attestation,
structural profile, weakestInputClass, evidence search and the guards ran
over the aluminium state UNCHANGED, and the second commodity is served
live end-to-end (map, analytics, search) from the same routes. What the
experiment found, in the review's predicted category of "secretly
copper-shaped", was VOCABULARY, not architecture:

1. `cu_content` → `metal_content` (the basis was copper-named; 26 refs,
   mechanical rename).
2. The metric vocabulary had no intermediate slot, and its
   equipment-derived name inverts for aluminium — USGS's own row types
   confirm it ("Smelter production, aluminum" is the FINAL metal;
   "Refinery production, alumina" the intermediate). Added
   `intermediate_production`, named by CHAIN POSITION; copper's
   `smelter_production` stands as recorded legacy naming for its
   intermediate, not silently renamed.
3. `MaterialForm` gained `alumina` (bauxite moves as `ore`, metal as
   `refined`); `SupplyStage` survived untouched — it is order-free, and
   no code assumed copper's ordering.
4. The MCS parser hardcoded `!== 'Copper'` against a file that was
   ALL-COMMODITY all along — the copper adapter had been fetching
   aluminium's world data for twenty rounds and throwing it away.
   `McsCommoditySpec` parameterizes commodity rows, type→metric mapping
   and per-row basis; the aluminium chain arrives live (reported 2023 +
   estimated 2024, bauxite gross dry tons / alumina gross calcined /
   metal content) from the same fetch, same ladder, new snapshot rung.
   `observationOnlyPayload` had `commodity: 'copper'` hardcoded too.
5. Electricity as a declared constraint needed NO new machinery —
   `depends_on` edges to infrastructure entities (Kitimat→Kemano at
   strength 1.0 is the real case: a smelter that exists because of its
   dam) — the dependency type existed; aluminium is the first commodity
   to need it as a real constraint.

**Two scope gaps recorded unbuilt, both real findings:**
- The corridor-grade machinery assumes mirror-implied CONCENTRATE grades;
  aluminium's gross bauxite/alumina flows need form-level stage-conversion
  constants (bauxite ~25% Al, calcined alumina 52.9%). V1 curates flows in
  contained metal (the copper convention for curated flows), and the
  gross-flow conversion generalization is on the record, unbuilt.
- `RegulatoryScope` is jurisdiction-shaped and cannot express a
  FACILITY-scoped regulatory act: the real Alunorte court embargo
  (2018–19, half production by court order) is modeled as an operational
  disruption with the limitation stated on the event. The scope schema is
  copper-shaped in exactly this respect — copper's regulatory truth set
  happened to be jurisdiction-wide.
- (Also: the UI defaults remain copper-shaped — panel fetches and layer
  labels; the API and engine are commodity-clean.)

Measured on first run, all class gates exercised on a commodity they were
never written against: primary-aluminium country HHI is CHINA-CONCENTRATED
(>2500, band high — a different landscape from copper's 1339); the
intermediate index exists for aluminium and reads no-data for copper (an
absent index is not a claim; the panel renders nothing); the OFAC-Rusal
sanction (real, 2018-04-06 → 2019-01-27) reaches Bratsk and Krasnoyarsk
through the owner exactly as the MIND ID pin promised; a 2018 evaluation
predates the 2024 aluminium topology and nulls its tonnage — the guard is
commodity-agnostic; countries attest reported/estimated while every
facility attests representative — the copper split reproduces; the
structural layer is 0% sourced here too.

## Phase 25 — filtering is never free, and two guards were already breached

1. **Silent filtering named as a defect class, and closed at its boundary.**
   `!== 'Copper'` and unmapped-identifier drops were the same shape at two
   layers: data arrives, a predicate excludes it, nothing reports the
   exclusion. It survived twenty rounds structurally — every refusal
   discipline in the system sits DOWNSTREAM of ingest, and a filtered row
   never becomes a candidate record, so it is never rejected; rejection was
   reported, filtering was free. `RowAccounting` closes it: every fetched
   row is accepted, rejected with a reason, or filtered with the predicate
   named and counted (with examples), attached to adapter payloads,
   carried on `AssembledState`, served on the state and analytics views.
   Wired for MCS (both commodities, both vintages) and Comtrade (unmapped
   reporter/partner M49 — the round-25 resolution gap, now counted with
   codes — plus the netWgt noise floor). The counterfactual is pinned as a
   test: parsing the multi-commodity snapshot under the copper spec prints
   `filtered: 56 (COMMODITY not in [Copper])` — the line that would have
   raised the question on day two. Conservation asserted: every fetched
   row lands in exactly one bucket. Standing adapter doctrine from here:
   an adapter accounts for every row it fetched.
2. **Two deferrals were breached by round 25's own register, and the
   guards never noticed — because they only ran on copper.** A third
   instance of the same blindness: the condition was checked, but not
   everywhere it held. Guards now evaluate EVERY commodity. The breaches,
   re-taken under the review's rule (acknowledge-and-hold or extend the
   schema; silent failure is the one indefensible option):
   - `event-class-attribution-basis-unbuilt`: the Rusal sanction is a
     curated sanctions-class event — the original condition is gone. Held
     against the acknowledged counterexample: the sanction propagates
     reach, but no combined-basis exposure figure is quoted anywhere, so
     the missing basis is still not load-bearing. The predicate now pins
     the acknowledged list; the NEXT sanctions-class curation forces the
     build, never a third acknowledgment.
   - `facility-scoped-regulation-unbuilt` (new): RegulatoryScope cannot
     express the Alunorte court embargo. The acknowledgment moved from
     prose to a TYPED field (`EconEvent.schemaLimitation`) so the guard
     can count counterexamples; a second one is accumulated demand and
     forces the scope schema to gain an entity dimension.
3. **Cross-commodity comparison is the fifth venue of the same
   incommensurability species.** "Aluminium (>2500) is more concentrated
   than copper (1339)" is a sentence someone will say, and it needs the
   same four qualifiers as every within-commodity comparison — different
   partitions (compare effectiveGroups, never raw HHI), different
   universes (world-reported vs modeled sets), different bases per stage,
   different completeness. The machinery already travels on every index;
   what is new is the temptation, and it is now named where the numbers
   are documented.
4. **The next decisive step is not a build.** The usage finding stands:
   twenty-five rounds, zero non-self-generated evidence. The cheapest
   decisive experiment is one researcher, one real question, one
   afternoon, no guidance — the miss log records what the corpus could
   not answer, the refused:* queue records where it declined, and both
   produce the one kind of evidence this project has never had. The
   session's outcome re-ranks the backlog with data: aluminium-heavy
   misses demote EDGAR; misses no registered source could answer convert
   the modality programme from deferred-on-principle to deferred-against-
   measured-demand; and a researcher who does not come back is the most
   important finding twenty-five rounds could produce. Running that
   session is the operator's move; the instrument is ready for it.

## Phase 26 — work order 3.1: the guard evaluation scope is certified, not listed

Report per the standing order (2026-08-27, `docs/WORK_ORDER_2026-08-27.md`):
one report per item — built, measured, criteria, unanticipated, guards moved.

**Built.** `guardEvaluationScope()` derives the partition set from the
adapter register (`listAdapters().flatMap(a => a.commodities)`, deduplicated,
sorted) — never a literal, because a literal partition list is subject to
the exact defect the certification exists to catch (three instances of
"checked correctly somewhere, silent everywhere else the condition holds"
were each found by a human, one twenty rounds late).
`evaluateAllDeferredDecisions(now)` is THE runner: it walks every
partition in the derived scope, records every (partition × predicate)
cell it actually evaluated, and tags every failure with the partition it
failed in (`ScopedGuardFailure.commodity`) — evaluation scope travels
with the failure message.

**Measured.** Scope today: `['aluminium', 'copper']`; 7 deferred-decision
predicates × 2 partitions = 14 cells evaluated by the standing suite,
which now uses the derived runner (a hand-listed subset elsewhere is the
named defect).

**Criteria.** All three pre-registered criteria passed: (1) scope derived
from the register, no literal — pinned by the certification test naming
the full cross-product; (2) planted-partition test — registering a
`test-planted-commodity` adapter puts `testium-planted` into the scope
and the evaluated cells with NO change to the guard module (unregistered
in `finally`); (3) failures carry their partition.

**Unanticipated — a boundary worth recording.** The certification covers
the COMMODITY axis because that is the partition the register exposes.
Item 3.2 promptly demonstrated a different axis of the same species:
graph-frame vs state-frame (a graph built for one date evaluated under
another date's validity). The scope certification did not and could not
catch that one — no register enumerates evaluation frames. The general
lesson stands as a lesson, not a theorem: each new partition axis needs
its own derivation source, and the 3.2 fix (the graph carries its own
selection) is that pattern applied structurally rather than by scope
enumeration.

**Guards moved.** None in this item.

## Phase 27 — work order 3.2: country flow vintages — historical propagation restored at the granularity the evidence carries

**Built.** Five reporter-years of HS 2603 reporter-declared exports
captured live 2026-08-27 (CL 2017/2019, PE 2020/2022, ID 2017), archived
under the now-or-never rule (`data-archive/comtrade/2026-08-27/` + the
committed snapshot — Comtrade revises in place, so the capture IS the
vintage). `flowVintages.ts` builds country→country Flow records with full
RowAccounting (world-aggregate rows, unmapped partners with codes, the
50 kt noise floor — all named and counted); Chile's rows carry
`metal_content` (the round-4/5 mirror finding: CL declares contained
metal, CL→CN ratio 3.97), every other reporter `gross_weight`.
`selectTopology` serves exactly ONE granularity per graph: the facility
snapshot for dates it covers, else the latest country vintage at or
before the date; the graph CARRIES its selection (`graph.selection`) and
`topologyValidity` classifies against it, so the figure and its label
provably share one frame. At country granularity: a staged regulatory
scope binds corridors through the flow FORM (ore/concentrate are
production-stage output in every modeled chain — no commodity-shaped
constant; every other pairing is scope-UNDECIDABLE and excluded visibly),
facility events refuse tonnage with the ALLOCATION MODEL named, an
uncaptured jurisdiction refuses via VINTAGE COVERAGE (absence of capture
is not absence of flow), all-refused gross corridors are null with the
corridor grade as remedy, partial sums are labeled LOWER BOUND. The map
scrubber draws vintage arcs labeled by granularity and year.

**Measured.** The 2017 Grasberg export halt finds its real crossing
corridors — JP 445 / KR 204 / CN 185 / IN 287 kt gross (PH 418 dropped:
partner 608 unmapped, counted in the accounting) — receivers named,
domestic smelters spared, tonnage basis-REFUSED (gross, no mirror grade
for ID). Peru 2020 reaches its mines and its receivers (CN/JP/KR/DE),
tonnage basis-REFUSED likewise. Where the basis resolves the vintage
QUANTIFIES: a scenario-posed 2019 Chilean export ban states 2,723 kt
contained metal (CN 1694 + JP 599 + KR 280 + IN 150) from the vintage.
`structuralClassProfile.flows` now aggregates PER BASIS (summing gross
and contained metal would be the incommensurability species inside the
watching instrument): copper metal_content 0 → **0.202** sourced-by-kt,
gross_weight **1.0** (all vintage, no curated gross flows); capacities
and attribution edges still 0. India's Comtrade PARTNER code is 699 (not
ISO 356) — found when Indonesia's third-largest 2017 receiver dropped
unmapped; exactly the gap class item 3.3's resolution gate exists to
surface.

**Criteria vs the pre-registration — one disagreement, reported, not
adjusted.** (1) A 2017 evaluation produces non-null propagation: PASSED
for reach and corridors; tonnage is basis-refused where the reporter
declares gross — the number states only what the basis carries. (2)
'predates' fires only before the earliest vintage: PASSED (2015
predates; 2017 is served, within, country granularity). (3) **At least
three of the five nulling events propagate: FAILED at 2 of 5.** Only
Grasberg-halt 2017 and Peru 2020 are country-shaped events; Escondida
2017, Chuquicamata 2019 and Las Bambas 2022 are facility events, and
criterion (4) — facility events still refuse with the allocation model
named: PASSED — caps them there. Criteria (3) and (4) are jointly
unsatisfiable over this register: the pre-registration assumed more of
the truth-set was country-shaped than it is. Per the round-6 rule the
criteria stand as written and the measurement disagrees with them. (5)
The flow-vintages guard fires and is re-taken: PASSED — the predicate
("exactly one distinct flow period exists") fired the day the vintages
landed, exactly as designed, and was re-taken as
`allocation-model-deferred` (valid while no flow record mixes
granularities — a facility-attributed country corridor is the arrival
that forces the re-take), with its planted vacuity pin.

**Unanticipated.** Four findings, three of them defects this item's own
wiring exposed or created:
1. **Graph/frame incoherence (created, then made impossible).** The first
   wiring re-selected the topology from state inside `propagateEvents`
   while summing whatever graph it was handed: the old Peru pin returned
   1,130 facility-kt under a country-vintage label — number and label
   from different frames, the defect species this system exists to
   refuse, produced by the feature built to prevent it. Fixed
   structurally: the graph carries its selection; validity classifies
   against the graph's own frame; a no-asOf facility graph evaluated at
   2020 is honestly `predates` with the rebuild remedy named (pinned).
2. **Hindsight through the structural loophole.** The vintage flows made
   Canada "knowable" at 2019 via a Peru-2022 corridor: search's
   `knowableEntities` and the engine's `asKnownThen` treated ALL flows as
   knowable by construction — true for curated structure, false for
   sourced records. Sourced flows are now knowledge-gated by capture
   date. Consequence, stated rather than hidden: under `as_known_then`
   the vintages are invisible before 2026-08-27 — the capture is the only
   publication bound the corpus can honestly claim (Comtrade revises in
   place), so the earlier date is refused, not defaulted.
3. **The completeness axis at the new boundary.** A jurisdiction absent
   from the captured reporter-set (Peru at a 2017 evaluation — only CL
   and ID were captured for 2017) would have rendered 0: absence of
   capture read as absence of flow. VINTAGE COVERAGE refusal added;
   and the operational branch's all-refused-basis case (previously an
   inconsistent 0 against the regulatory branch's null) aligned to null.
4. **The proportion pin moved exactly as designed — via the source
   round 18 did not predict.** The 0%-structural pin was written so "the
   first reported ingest moves a number, not a flag", with EDGAR as the
   expected mover. The mover was Comtrade country vintages: metal_content
   0 → 0.202 while EDGAR stays operator-blocked. The design survived its
   event; the prediction did not — recorded as the deviation it is.

**Guards moved.** `flow-vintages-deferred` fired and was re-taken as
`allocation-model-deferred` (above). The extrapolation clock still
grounds on the facility snapshot for live evaluations (604 days today);
the selection rule's known limit is recorded: one vintage YEAR serves a
whole graph (a 2020 evaluation serves Peru's reporter-year and does not
carry Chile's 2019 corridors — per-reporter selection would mix vintage
periods inside one graph, and is deferred with that reason, not blended
silently).

## Phase 28 — work order 3.3: the resolution gate — counted drops become records

**Built.** `resolution.ts`: `UnresolvedIdentifier` (scheme, raw identifier
verbatim, source, occurrences, context, candidates, remedy) +
`buildUnresolvedRecords` (deterministic: sorted by scheme then
identifier, no clock, no randomness) + `nameCandidates` (case/diacritic
fold + containment — CANDIDATE detection only, never resolution). Wired
at all three resolution drop sites, built from the SAME tallies that
feed row accounting so reconciliation is structural: the flow-vintage
builder (partner M49), the Comtrade bilateral accounting (reporter +
partner M49), and the MCS world-CSV parse (country names). Records ride
`AdapterPayload.unresolved` → merged at assembly per (source, scheme,
identifier) with occurrences summed and contexts joined → `state.unresolved`,
deterministically ordered, with candidates enriched at assembly against
the actual register (adapters do not hold it). Searchable as
`refused:resolution` with identifier + source + row count + remedy in
the hit.

**The gate's two rules, held by construction.** Resolution happens ONLY
through curated scheme maps. A near match in the register — the planted
'Perú' against the register's 'Peru', or 'ANTAMINA' colliding with both
the mine and its operating company — surfaces as candidates carrying a
never-merge note and stays unresolved; both colliding entities survive,
the register is untouched. Exact name equality is still a name match and
still refuses (the 'Georgia' problem: a US-state string and a country
share a spelling; only a curated mapping knows which).

**Measured.** Copper: 30 records, 74 dropped rows — 25 distinct unmapped
M49 partner codes + 5 MCS country strings; code 608 (the Philippines —
Indonesia's largest 2017 receiver, 418 kt) merges from both drop sites
into one record naming both contexts. Aluminium: 5 records, 12 rows —
Germany, Ireland, Spain (the alumina reporters round 25 left as a
countryMap comment) plus the two aggregates, now typed records. The MCS
editions even disagree on capitalization ('Other countries' 2025 vs
'Other Countries' 2024) — kept verbatim as distinct identifiers, which
is what "raw" means.

**Criteria.** All four pre-registered criteria passed: (1) an unmapped
identifier produces a searchable `refused:resolution` hit carrying the
raw identifier, source, and remedy — pinned against the real 608 record;
(2) no code path merges on name similarity; the planted near-collision
keeps both candidates — pinned; (3) deterministic — same proposals +
same register produce identical records regardless of tally insertion
order — pinned; (4) row accounting reconciles: at every drop site the
filtered count equals the sum of unresolved occurrences, with a vacuity
assert that each site is live — pinned.

**Unanticipated.** Nothing that changed the design; two small findings.
The two Comtrade ingest paths (bilateral observations, flow vintages)
emit the same scheme under the same sourceId, so assembly-level merge
was needed to avoid presenting one identifier as two records — the
per-site reconciliation stays pinned at the sites, the merged record is
the researcher's view. And an empty-string COUNTRY cell in the MCS CSV
produces an `""` record (1 row) — kept: the gate records what the source
sent, and an empty identifier is a source oddity worth seeing.

**Guards moved.** None. The `person-name-policy-surface` guard's ground
is unchanged: unresolved records carry source identifiers (M49 codes,
country names), not person-shaped data, and the vocabulary gate on the
miss log is untouched.

## Phase 29 — work order 3.4: OpenOwnership cannot answer the question — recorded with evidence, not assumed

**Recon (2026-08-27, captures in `data-archive/openownership/2026-08-27/`).**
The Register application is RETIRED: `register.openownership.org`
redirects to a www.openownership.org topic page behind a Cloudflare JS
challenge (403, "Just a moment…" page captured); the documented
`bulk-data.openownership.org` host does not resolve (CONNECT 502). What
remains reachable is the register's S3 bucket: full BODS statement
exports, public, no auth — FROZEN at 2023-07-19, with per-source files
naming the coverage set: UK PSC, Denmark CVR, Slovakia RPVS, Ukraine
EDR. Reachability class: open-but-frozen; the live product this backlog
slot was written against no longer exists.

**The coverage measurement.** One full streaming pass over the frozen
combined export — 32,813,462 statements, nothing stored but matches:
- `Compañía Minera Doña Inés de Collahuasi SCM`: **zero** hits.
- `Compañía Minera Antamina S.A.`: **zero** hits. The single substring
  match is FANTAMINA LTD — a Bristol company incorporated 2022 whose
  name happens to contain 'antamina' (captured verbatim): the exact
  name-collision species item 3.3's gate exists to refuse, met in the
  wild one item later.
- Positive control: 53 Glencore statements — the stream and the match
  machinery demonstrably work; the zeros are absence, not a broken scan.

**Why the absence is structural, not a gap that patience fixes.** The
four source registers record who CONTROLS their own domestic companies —
the direction is inbound. UK PSC can say who stands behind a UK company;
it cannot say what a UK-listed group owns abroad. A Peruvian S.A. or a
Chilean SCM can never be a SUBJECT in any of the four, so the two JV
vehicles are out of the source's expressible universe — a universe
mismatch (the incommensurability species' universe axis), not sparse
data. Recorded on the `openownership` registry entry so the next reader
of a miss-suggested source sees the boundary, not just the category.

**Criteria (pre-registered), each measured.** (1) Parents-or-recorded-
inability: the inability branch, with the full-corpus evidence above.
(2) `strongestAttestingClass` on the two vehicles: measured
`structural_only`, both — unchanged, as the existing pin states. (3)
`structuralClassProfile` re-measured: attributionEdges 44 records,
sourcedRecords **0**; capacities 20 records, 0% sourced by tonnage. It
stayed at 0% — that is the finding, and per the pre-registration it is
reported as such: the structural-attribution layer still has NO
publisher-sourced record, and the one open source ranked for it cannot
reach the entities that matter here. (4) Two-purposes split: holds — no
operator-of-record data was touched; nothing crossed into the purpose
EDGAR owns (which remains operator-blocked).

**Unanticipated.** Two things. The register's retirement (the phase-18
ranking assumed a live product; the frozen 2023 vintage would have made
even a hit a staleness-labeled import). And the direction finding: the
recon question was "does the source COVER Peru/Chile" — the sharper
truth is that BO registers of this shape cannot cover any foreign-held
subsidiary as a subject, which re-scopes what "OpenOwnership coverage"
can ever mean for a facility-ownership instrument: it serves parent
chains only where the OPERATING vehicle itself is registered in a
BO-register jurisdiction.

**Guards moved.** None. The ownership purpose stays curated
(`structural_only` vehicles with declared shareholder edges); no
deferral's ground changed — the backlog slot is retired with evidence
rather than left open as an assumption.

## Phase 30 — work order 3.5: the aluminium chain's gross forms convert — with variance, or not at all

**Built.** `stageConversion.ts`: form-level constants in the corridor
grade's epistemic shape — factor + uncertainty band + documented source
on every converted edge. `aluminium/ore` (bauxite): 0.222, band
[0.20, 0.25] — the published 4–5 t bauxite per t primary Al ratio,
spread driven by deposit grade. `aluminium/alumina`: 0.520, band
[0.515, 0.529] — stoichiometry (Al share of Al2O3 = 0.529) is the hard
ceiling, smelter practice (1.91–1.94 t alumina per t Al) the floor.
`buildGraph`'s gross branch now tries most-specific-first: a
mirror-implied corridor grade, then the (commodity, form) constant, then
visible refusal. `BasisConversion` distinguishes the two provenances —
`derivedFrom` (mirror observation ids) XOR `source` (documented ratio).

**The never-cross-commodity property is structural, not tested-only.**
The table has NO copper sub-table at all: copper's one gross form
(concentrate) converts per-corridor via mirror grades because
concentrate grade genuinely varies by corridor — a form-level
concentrate constant would erase exactly the variance the mirror system
exists to measure. The planted cross-commodity lookups (copper/ore,
copper/alumina, copper/concentrate, aluminium/concentrate) all miss, and
a planted gross copper flow in bauxite's form refuses through
`refused:basis` — pinned.

**Criteria.** All three passed: (1) a gross bauxite flow converts with
stated factor/band/source (1000 kt gross → 222 kt contained Al, range
[200, 250]); a gross alumina flow converts under the stoichiometric
ceiling; a constant-less pairing refuses through the existing
`refused:basis` path. (2) The cross-commodity plant fails — pinned as
above. (3) Aluminium's curated contained-metal flows are untouched
(every metal_content edge: no conversion record, tonnage non-null —
pinned with a vacuity assert that the curated chain is present).

**Unanticipated — a hidden double-refusal removed.** `toKtPerYear` did
not recognize the `'kt gross/y'` unit string, so gross vintage corridors
were refusing on UNIT PARSE before the grade lookup ever ran — the right
outcome for the wrong reason (had a corridor grade existed, the edge
would still have refused). The unit now parses (the magnitude is
kilotonnes; gross-ness is the `basis` dimension the conversion firewall
governs — encoding it in the unit string double-encoded basis). Measured
outcomes did not move — no vintage corridor holds a grade today — but
every gross refusal now states its true mechanism, which is what the
refusal taxonomy is for.

**Guards moved.** None. The `facility-scoped-regulation-unbuilt`
deferral is now the aluminium vertical's ONE remaining recorded scope
gap; round 25's other gap is closed by this item.

## Phase 31 — work order 3.6: the instrument is Sea Dog Terminal

**Recorded 2026-08-27.** The physical-economy instrument is renamed from
OSIRIS (Notations OSIRIS Overwatch Engine) to **Sea Dog Terminal**. The
rename is ADDITIVE, per the order's own reasoning: historical phase
entries are historical statements and stay as written — rewriting them
to match the present is the archaeology problem inverted, the same
reason the 2024 MCS vintage is not rewritten when 2025 lands. Module
headers and provenance records naming OSIRIS were true when written and
remain; files created from this order forward carry the new name.

**The one outbound touch.** The SEC EDGAR document-tier User-Agent —
still operator-blocked on the contact identity — is now specified as
`SeaDogTerminal/<version> OrgName role@org` (recorded on the `sec-edgar`
registry entry beside the phase-22 build requirements): the instrument
must not introduce itself to a regulator under a retired name. The
substrate's existing outbound UA strings (USGS/Comtrade/Yahoo fetches
under `OSIRIS-Overwatch/0.1`, and the wider OSIRIS platform's) are NOT
rewritten by this entry: the order names the SEC UA as the one place the
rename touches something outbound, and widening that unasked would be
scope creep in an identity string. If the operator wants the running
system's generic UA renamed, that is a one-constant change
(`liveAdapters.ts` `UA`) taken on request, not silently.

**Criteria.** The item pre-registers none beyond its shape (additive; new
name forward; SEC UA clause) — all three hold: no historical entry was
edited, the living doc's title and this entry carry the name forward,
and the UA form is recorded where the EDGAR build will read it.

**Guards moved.** None.

## Phase 32 — work order 3.7: the instrument is armed for the afternoon

**Built.** Three pieces, all in service of the one experiment no build
can replace. (1) The miss log verified in the RUNNING configuration —
not in principle: a production `next start`, two real HTTP queries, and
`data-archive/search-misses.jsonl` written by the real path — the
vocabulary miss with its string and gap id
(`"q":"vessel shipping movements","gapIds":["maritime-ais"]`), the
person-shaped query as `"queryWithheld":true` with NO string. Then the
file was DELETED: those two lines were builder validation, and the
round-23 finding ("if search-misses.jsonl is empty, that's the finding")
only stays measurable if the afternoon starts at zero — what accumulates
from here is demand. (2) `GET /api/economy/refusals` — the `refused:*`
queue as an exportable digest, grouped by type with the type's shared
remedy, most-blocking first, UNCAPPED (the interactive search's 20-hit
cap became an explicit `limit` option; a silently truncated work queue
would read as "covered"). (3) `sessionTelemetry.ts` + `?view=session` —
queries, misses, withheld, person-shaped-counted, evidence queries by
kind, digests exported, canonical entity ids inspected. Counters and
canonical ids only; query strings are never held in telemetry.

**Measured.** Today's copper refusal queue: 30 refusals, ALL type
`resolution` — the standing work queue at the present date IS item 3.3's
unresolved-identifier list (every date-scoped refusal mechanism only
binds under a historical evaluation). At 2017-02-15 the queue is 45:
resolution 30, topology 8 (allocation refusals), basis 5 (the Grasberg
halt's gross corridors among them), attribution 2. The digest is the
work-order backlog, ranked by what actually blocks answers.

**Criteria.** Both pre-registered criteria passed, in the SIMULATED
session (env seams force the real write path into a scratch directory
under vitest) and in the live server: (1) a session produces a non-empty
miss log and a non-empty refusal digest — pinned end-to-end through the
real route handlers (hit → inspect → vocabulary miss → person-shaped
miss → evidence query → digest → session digest); (2) the vocabulary
gate holds — the person-shaped query is counted (`personShapedCounted:
1`, `queryWithheld: true`) and its string appears NOWHERE: not in the
log, not in the telemetry, asserted against the full serialized digest.

**Unanticipated.** Nothing structural. One measurement worth keeping:
the present-date refusal queue being 100% resolution-type is itself a
statement about the instrument's current shape — at today's date, with
the facility topology serving and curated basis discipline holding, the
only thing the system currently refuses is identity resolution; every
other refusal mechanism is date-conditional.

**Guards moved.** None.

**The order's definition of done, checked.** All seven items are
complete or recorded blocked-with-evidence: 3.1 ✓ (phase 26), 3.2 ✓
with one pre-registered criterion failed and REPORTED, not adjusted
(phase 27), 3.3 ✓ (phase 28), 3.4 recorded-inability-with-evidence
(phase 29), 3.5 ✓ (phase 30), 3.6 ✓ (phase 31), 3.7 ✓ (this entry).
Suite green (571 passing). `structuralClassProfile`, reported whatever
it says: flows per basis — copper metal_content 0.202 sourced-by-kt,
gross_weight 1.0 (mover: Comtrade vintages, not the EDGAR round 18
predicted); capacities 0%; attribution edges 0 of 44 sourced. Guards
that fired during the work: one — `flow-vintages-deferred`, re-taken as
`allocation-model-deferred` (phase 27). The two operator blocks stand
as the order left them: the EDGAR contact identity (procurement-shaped;
UA now specified under the Sea Dog Terminal name) and the researcher
afternoon — which this item leaves armed.

## Phase 33 — the response round: wrong-attribution audit, and phases 18/20 reconciled

Three items from the operator's reading of the order report, each
executed rather than acknowledged.

**1. The wrong-attribution audit — the 'kt gross/y' species, hunted.**
The operator's observation: a refusal correct in outcome and wrong in
attribution is invisible to any test asserting only that a refusal
occurred, and every refusal here carries a remedy — a wrong attribution
sends work to the wrong place. Audited the refusal machinery for the
shape. Found twice:
- **The regulatory basis-honesty notes fired regardless of `predates`.**
  In the mixed-call shape (a graph built for a later world evaluated at
  a predating date), an unquantified gross crossing corridor pushed the
  corridor-grade remedy — and the partial case pushed "LOWER BOUND"
  while the returned figure was null. Compounding it, the evidence
  search's refusal classifier keys on that text, so the predates refusal
  would be TYPED `basis`: wrong remedy on the explanation, wrong type on
  the queue. Fixed by guarding both notes on `!predates` (at a
  predating date the mechanism is the topology, and the topology note
  with its rebuild remedy is what remains). The discriminating case is
  named and mutation-verified: a planted gross crossing corridor under a
  facility graph at a 2015 evaluation — green under the guard, red under
  the un-guarded mutation exactly on the `corridor grade` assertion,
  mutation asserted-applied.
- **`refused:basis` remedy text predated item 3.5.** It named only
  corridor grades; a form-level stage constant is now the remedy for an
  aluminium gross flow. Both the type remedy and the edge detail now
  name both conversion paths.
Plus the property pin the finding deserved: every flow unit in every
assembled state parses through `toKtPerYear` (vacuity-asserted
non-empty, both commodities) — so no tonnage refusal can ever again fire
on unit parse while claiming basis. The property, not the enumeration:
the pin holds for units that do not exist yet.

**2. The OpenOwnership registry entry now states the CLASS.** The entry
already carried the structural cause (inbound direction; a Peruvian S.A.
can never be a subject); it now also says explicitly that this is a
property of the source class — a fresher export cannot change it, and a
re-attempt should target a register in the vehicle's own jurisdiction.
Written so the person who rediscovers the entry in a year reads the
boundary, not just the category.

**3. Phases 18 and 20, reconciled — additively, as the rename rule
requires.** Phase 18's forced-ordering claim ("filings move quantity and
structure together; the first reported structural source is EDGAR") and
phase 20's flow-boundary prediction ("filings yield facility/production/
operator/capacity but never flows — flow edges stay at 0% under EDGAR,
structural to the source") were both written before any structural
source landed. The measurement (phase 27): flows moved FIRST, from trade
data — metal_content 0 → 0.202, gross_weight 1.0 — while attribution
and capacity stayed at 0% awaiting the blocked EDGAR ingest. The
reconciliation: phase 18's ordering claim holds for the components it
scoped — quantity-and-attribution move together, from filings, and have
not moved — and did not extend to flows, which is exactly the boundary
phase 20 drew. Phase 18 was not wrong within its scope; it was silent on
the component that moved first, and phase 20 had already named the
source class (trade declarations) that would have to move it. Both
entries stand as written; this entry is the join. The residual
prediction now on record: when EDGAR unblocks, attribution edges and
capacities move together and flows stay where Comtrade put them.

**Also recorded, per the operator's framing.** The 3.2 criteria
conflict ("≥3 of 5 propagate" vs "facility events refuse") is a defect
in the ORDER's pre-registration, not a shortfall of the build — two
jointly unsatisfiable criteria over this register, surfaced only by
executing both. The round-6 rule (report the disagreement, never adjust
the number) applied symmetrically to the operator's own artifact — which
is what the rule was always for.

**Guards moved.** None. Suite green after the audit fixes.

## Phase 34 — the wrong-attribution class named, and its structural fix deferred under guard

**The class, named.** Alongside silent filtering (round 26), the
scoped-check blindness (3.1's three instances), and the vacuous-example
species: **a refusal correct in outcome and wrong in attribution.** The
figure is honestly null, every test asserting "a refusal occurred"
passes, and the diagnosis — the remedy on the explanation, the type on
the queue — points at the wrong mechanism. Three confirmed instances,
each found by audit rather than by a failing test, which is the class's
signature: (1) the 'kt gross/y' unit shadow — gross corridors refused on
unit parse before the grade lookup ran; (2) the regulatory basis-honesty
notes firing at predating dates — the corridor-grade remedy pushed when
the mechanism was topology; (3) the compounding path — the evidence
classifier keys on that prose, so the mistyped explanation propagated
into the QUEUE type: wrong remedy, wrong bucket, wrong specialist, on
the exact artifact the researcher afternoon exports. Every refusal in
this system carries a remedy; that is what makes the class expensive
here, and what makes "expect a refusal" never a sufficient assertion.
The next instance will not look like the class either.

**The structural fix, deferred under guard rather than remembered.** The
classifier (`classifyRefusalExplanation`, now a single exported site)
couples diagnosis to prose: any wording change in propagation's
explanations silently retypes the queue. The durable fix — each
mechanism emits its refusal type and the text is rendered FROM it, so
the failure mode disappears rather than being guarded per site — is a
build item, not this round's. Recorded as
`typed-refusal-emission-unbuilt` with an EXECUTABLE validWhile: a
planted instance of every refusal mechanism (unscoped → scope; all-gross
export ban → basis; facility event under a country vintage → topology;
everything at a predating date → topology, the export ban's gross
corridors included — the phase-33 fix held as a condition) runs through
the real `propagateEvents` pipeline and the real classifier on every
guard evaluation. A rewording that would retype the queue now fails a
named guard with the deferral's reason attached, instead of shipping.
Vacuity shown both coarse (a classifier that types everything
'topology') and subtle (one that gets basis right and scope wrong).

**Guards moved.** One added: `typed-refusal-emission-unbuilt`.

> **Correction (deployment order, D-1):** this line originally called it
> "the seventh deferred decision under validWhile". It was the EIGHTH —
> the register already held seven. The miscount propagated from here into
> the docs and then into two operator orders, both of which state "seven
> guards". Counted against the register: 8. The runtime guard endpoint
> now pins the count to `DEFERRED_DECISIONS.length` in a test, so a
> literal can never drift from the tree again — the same reason
> `guardEvaluationScope()` is derived rather than listed.

## Phase 35 — the shipping order: from a green branch to an instrument that is deployed, owned, backed up and measured

One report per item against the criteria pre-registered in
`docs/WORK_ORDER_SHIPPING_2026-08-27.md` (committed verbatim before
execution). Failed criteria are reported, not adjusted. The order's
INSPECT posture held: every infrastructure assumption was measured
first, and two were corrected.

**S-1 — Release.** Inspection corrected the order's premise: the
repository had never had a `main` or `master` — the working branch was
its only ref. `main` was created from the branch head; CI (typecheck,
full suite, build) runs on every push to `main` and `claude/**`, and
green was verified by log CONTENT (the pass count visible in the CI
output), not by the badge. The planted guard breach fails the pipeline
at the test step with the guard's own message (`[copper]
[allocation-model-deferred] condition no longer holds`) plus the
structural-profile pin honestly noticing the planted tonnage — per-
failure attribution, exactly what the criterion asked. A fresh clone
at the released revision installs, builds and serves with no
undocumented step. **FAILED criterion, reported:** "at a named tag" —
the execution environment's git proxy refuses `refs/tags` pushes
(HTTP 403, four retries) and branch deletions likewise, so the named
version ships as branch `release/v0.1.0` plus a local annotated tag;
creating `v0.1.0` on the remote and deleting `ci-verify/guard-breach`
(never merge it) are recorded operator one-liners.

**S-2 — Archive durability.** The unreconstructable set is labelled
and counted: 29 archive files — 14 unreconstructable (the Comtrade
vintages), 8 refetchable-at-risk, 6 refetchable, 1 documentation —
indexed in `data-archive/MANIFEST.json` with sha256, verified in both
directions by a suite test that also refuses unclassified files, green
in CI. The off-repository copy lives in the Information-Systems-Archive
repository under `sea-dog-terminal/` with its own verifier, and the
restore drill was EXECUTED, not assumed — and earned its place on day
one: its verify step caught the MANIFEST missing from the mirrored
tree (see self-corrections). One genuine defect found and fixed by
this item's own verifier: the degradation-ladder tests were writing
stub-served bytes into the real unreconstructable archive on every
suite run — fabricated bytes in the exact store the item exists to
protect, arriving through the instrument's own tests.
`archiveComtradeVintage` now refuses under VITEST; the pre-seal CI run
is red with the interference, the sealed run green — the fix confirmed
where it matters. **Caveat, reported:** the off-repository copy is
same-provider (GitHub to GitHub) — it survives repository loss, not
provider loss; provider-diverse backup is an operator decision.
Archive-before-parse confirmed in program order and empirically (the
session's own live retrievals archived).

**S-3 — Deployment and access.** Inspection: nothing was deployed; the
path is the ghcr image (docker-publish now succeeds on mainline pushes
— the image exists) plus one documented docker command. Configuration
seams fail loudly at startup with every missing key NAMED, verified in
the running configuration, with a measured nuance recorded rather than
papered over: Next 16 holds the refused process serving 500s instead
of exiting, so the refusal is loud in the log and on every request but
invisible to an exit-code supervisor. The access decision is recorded
in `docs/DEPLOYMENT.md`: internal, operator-controlled — an evidence
hazard (demand instruments assume researcher users) and a licensing
posture (Westmetall), not a privacy one. Addendum B appended the open
external-client exposure question to that decision with its undecided
parts named (authentication, telemetry segregation, machine-consumer
licensing), to be resolved at S-9. **Criterion honestly scoped:** "a
running instance a researcher can reach" is operator-shaped from this
environment — image, command, seams and decision are delivered; the
hosting itself is the operator's hand.

**S-4 — Runbook.** Written (`docs/RUNBOOK.md`): the refusal queue as a
work queue, the two knowledge modes, the banner vocabulary, the search
grammar, limitations unsoftened, the export surface, and an operator
section with session mechanics. **Criterion pending by construction:**
"a non-builder reaches a documented conclusion in ten minutes" can
only be discharged by a non-builder; the builder cannot self-certify
it and does not.

**S-5 — Ownership and cadence.** Every built-adapter source carries
`owner` + `maintenance`, enforced by a property test over the registry
(not a list that can drift); 'operator' is a role because the program
has exactly one human. The facility flow snapshot is now a registered,
maintained, AGING source: past its annual cadence it emits a
corpus-health signal, and the signal is real today (~604 days) — a
standing signal, not a simulation, with the discriminating absent
cases pinned (fresh snapshot; country-vintage-only state). The digest
a human receives is delivered end to end: the weekly workflow's
dispatch run succeeded and filed issue #1 ("Corpus health digest:
1 signal(s)") through the real path on the real signal. Silence on a
healthy corpus is the workflow's design and was not simulated away.

**Addendum A — the corpus as a table (operator, mid-execution, placed
before S-6).** `GET /api/economy/table`: rows carry every axis or the
row flags what it cannot state; refusals export as null-valued rows
with remedies; the header carries knowledge state, fingerprint,
withheld count and row accounting; `view=grid` is the period × edition
form. All seven pre-registered criteria discharged in
`src/app/api/economy/table/route.test.ts`, each against its planted
failing state: the basis-less record exports null AND flagged; md and
JSON render the same objects verbatim (and CSV is refused with its
reason); the planted late vintage is withheld under `as_known_then`
and COUNTED (+1 in the header, present under best-known); the
fingerprint matches the producing state and moves when a value moves;
the uncovered grid cell is a typed null rendered as a dash, never a
zero, with the legend shipped; the export log writes through the real
env-seam path and `exportsServed` counts in the session digest; the
route module structurally exports GET and only GET, and a free-text
subject is refused at the boundary BEFORE any log write. Identifier
reconciliation with the operator's spec is recorded in the order doc's
Addendum A (metric names; `vintage`≡`source_id`; the unverified Zambia
magnitude not repeated).

**S-7 — the continue criterion**, pre-registered and committed
(`docs/CONTINUE_CRITERION.md`) before any researcher session: a
90-day window from S-6; CONTINUE on any of three unprompted return
days, one finding in someone's own work product, or ten distinct
non-builder miss queries with named gaps; FREEZE (keep, don't
maintain) below that; a no-show retires the question early without
starting the window. The operator decides at day 90 against the
document as written; the builder computes the readings without
recommendation.

**S-6 is the operator's; S-8 and S-9 are conditions.** S-6 (the
researcher afternoon) is not builder-executable and everything it
needs is armed. S-8 (EDGAR) unblocks on the SEC identity and its
phase-22 pre-registration is to be RE-TAKEN then, not obeyed as
archaeology. S-9 (the evidence-led re-rank, now carrying the MCP
exposure item) waits on S-6's evidence and supersedes every prior
ordering when it runs.

**Self-corrections (this order's own defects, named).** (1) The first
two planted breaches were MALFORMED — a syntax error, then a missing
gitignored module — and failed CI at typecheck, not at the guard; a
mutation that does not reach executable semantics has not survived
anything. The third plant was asserted-applied locally (tsc clean,
exactly one failing test, the guard's own message) before pushing.
(2) A `git add -A` on the breach branch swept then-untracked S-2
artifacts into the plant commit, so commit cd17729's message claimed
content it did not carry — corrected in a follow-up commit that says
so. (3) Worse: a later checkout left HEAD on the breach branch and an
S-2 commit was pushed to MAIN carrying the plant; repaired minutes
later by cherry-pick onto the clean parent and a force-with-lease of
my own refs. Plants now get isolated worktrees — applied for the final
verification. (4) The S-3 commit was red in CI at typecheck for four
minutes: its test file used `{}` literals against a parameter typed
`NodeJS.ProcessEnv`, and the retype that fixed it lived in the working
tree, landing with the NEXT commit — local validation ran against the
working tree, not the committed tree. Split commits get per-commit
validation or no split. (5) The archive test-write defect above —
found by this order's own verifier, which is the argument for the
verifier.

**Exactly one next executable frontier:** the researcher afternoon
(S-6) — the operator schedules it, hands over `docs/RUNBOOK.md`, and
runs the protocol in its operator section. Every other open item is a
recorded condition (tag + branch deletion one-liners, hosting, S-8's
identity, S-9's evidence), not work anyone can do today.

**Operator response, ratified as standing rules.** Three items from
the response round carry forward permanently rather than staying
phase-local. (1) The split-commit hazard is the project's own defect
species one level up — a check correct about the thing it examined and
silent about the thing that shipped: local green and CI green were
verdicts on DIFFERENT ARTIFACTS. Standing rule: CI's verdict on the
pushed commit is the only one that counts; a local green is a
hypothesis until the pushed tree agrees. (2) The off-repository copy
is GitHub-to-GitHub: a provider-level incident takes the archive and
its backup together. The caveat stays open until a provider-diverse
copy exists — an operator decision, on record here so pruning either
repository is never mistaken for redundancy. (3) The S-4 ten-minute
criterion, structurally undischargeable by a builder, discharges
itself during the afternoon if watched for: the time from handover to
the researcher's first self-directed query is the measurement (now in
the runbook's operator section). And the sentence the operator most
wanted on the record, kept verbatim in spirit: after the session runs,
amending the continue criterion is not legitimate — the freeze is what
makes the result mean anything either way.

## Phase 36 — the final order: external models attach, and the interface carries the discipline

One report per item against the criteria pre-registered in
`docs/WORK_ORDER_FINAL_2026-08-27.md`. The order's INSPECT posture held
and corrected one of its own numbers (below).

**F-1 — the operator's steps, one command each.**
`docs/OPERATOR_STEPS.md`: the tag (with the exact SHA to use and the
statement that the proxy's `refs/tags` 403 is ENVIRONMENTAL, not the
operator's error), the `ci-verify/guard-breach` deletion with its
never-merge warning, the deployment as a single `docker run`, and the
afternoon. **Criterion partially met, reported honestly:** "verify from a
clean state" was executed for the fresh-clone path (install → build →
serve, no undocumented step) but NOT for the published image — pulling
and running a ghcr image is the one step this environment cannot perform,
so the doc says the image path is verified only as far as CI publishing
it. The runbook gained the three concrete moves the S-4 criterion names
(reach a bottleneck candidate, switch knowledge modes, read a
`refused:basis` hit): it never told a researcher how to reach a
bottleneck at all, which would have failed the criterion on a gap the
builder could fix but not discharge.

**F-2 — the MCP server.** Eleven tools (`src/lib/economy/mcpTools.ts`)
over a stdio server (`src/mcp/server.ts`), calling the terminal's OWN
HTTP routes so the machine surface cannot drift from what the browser
gets. All five pre-registered criteria discharged, and verified twice:
in-process against the real route handlers, and in the RUNNING
CONFIGURATION through a real MCP client over stdio against a real
`next start`.

- Knowledge state required, never defaulted: enforced at two layers, and
  the live client's error names the parameter (`expected string, received
  undefined at asOf`).
- Every quantitative return carries record ids, the five axes and a
  server-rendered claim sentence at top level. Live sample: *"Chile 26% of
  production — HHI 1339 across 19 groups (effective 7.5, floor 526),
  weakest input representative [20,240 kt/y total]. Not comparable raw
  against a different partition; compare effectiveGroups."* The unknown
  axis (index-level mass basis) exports null AND FLAGGED. A planted
  incomplete record surfaces its gap in the claim rather than as an
  omission.
- Refusals return successfully with type and remedy, across all four
  standing mechanisms (resolution, topology, basis, attribution — the
  2017 evaluation date makes them all live), verified live: 84 refusals,
  `isError: false`.
- No tool mutates state: a sweep of all eleven leaves the canonical state
  fingerprint unchanged.
- `as_known_then` leaks nothing: 154 rows served at 2024-06-30, 57
  withheld and COUNTED, zero rows with a later `knownAt`.

Tool descriptions are written as contract, not label, and a test asserts
every one of them carries the refusal conduct, the knowledge bound and
the paste-the-claim instruction.

**Corrected assumption (INSPECT, the tree wins):** the order states
facility coverage as "22% to 73% by country". Measured today it is
**21.8%–100%** across 9 countries — Panama is 100% because its single
modeled facility accounts for its entire compiled figure. The 22–73%
range is the interval EXCLUDING Panama. The claim sentences render the
measured range, not the remembered one.

**F-3 — the validator, as a service.** The round-1 contract, unbuilt for
thirty-five phases, built here because the pivot makes cross-model
validation the arrangement rather than a contrivance
(`src/lib/economy/validator.ts`, `GET /api/economy/validate`). All four
criteria discharged: a planted overstated claim returns `overstated` with
the precision mismatch named; a planted facility-level claim returns
`inadmissible` today with the reason stated unsoftened (admissibility is
evaluated BEFORE numeric support, so an exact-match number does not
rescue a representative-class chain); a claim its citations contradict
returns `unsupported` with the contradicting ids; and the no-recompute
rule is pinned STRUCTURALLY — the module's entire import list is
`["./types"]`, asserted by test. An empty evidence chain is `unsupported`,
never an error. The operator's two predictions are on record and will be
judged against use: `overstated` as the most common real verdict, and
`inadmissible` on every facility-level claim.

**F-4 — route-around telemetry.** `mcpSession.ts` logs per session the
tools called and refusals surfaced, and computes the refuse-then-quiet
rate. The signal is a PROXY and carries that in its own payload text:
going quiet after a refusal is equally consistent with routing around it,
with the remedy having answered the question, and with the session simply
ending. A simulated three-session set produces 0.5 with the refusal-free
session correctly outside the denominator, and a rate over zero sessions
is `null`, not 0. Verified in the running configuration: the live MCP
smoke session wrote four records through the real path, carrying tool
names and refusal counts only — no parameter value can reach the log
because none is ever passed to it.

**F-5 — visual refusal discipline.** `src/lib/economy/mapStyle.ts` is now
the single place the econ layers compute treatment, and the tests run on
that logic rather than on a designer's assurance. Both criteria
discharged, and the first one found a REAL DEFECT: the map's radius ramp
read `['coalesce', production, capacity, 100]` — an entity with no stated
tonnage rendered at exactly the size of a 100 kt/y producer. Unknown was
literally drawing as a small quantity. Now an unquantified node takes a
non-scale treatment (fixed radius off the ramp, grey, heavy stroke) that
cannot be read as a position on the size ramp, while ZERO stays on the
ramp because zero is a value. Coverage rides in the ink (opacity), with
unknown coverage rendered distinguishably from full coverage and zero
coverage keeping a visible floor — invisible ink would be an omission.
And a planted mixed-basis layer REFUSES to render, naming the conflict:
one width-scaled layer cannot carry gross-weight and metal-content
together, so callers split by basis and non-metal-content bases render
dashed.

**F-6 — exposure options prepared, not taken.**
`docs/EXPOSURE_OPTIONS.md` lays out authentication, telemetry
segregation and machine-consumer licensing with their consequences, and
takes none of them. One default IS applied and is labelled as
engineering rather than decision: machine traffic is segregated from the
human demand instruments now, because the S-7 criterion is frozen and its
thresholds describe researchers — a model can generate ten miss-log
entries in a second, which would make a frozen threshold trivially
satisfiable by a script, and the criterion cannot be amended afterwards
to repair it. What remains the operator's is whether machine use should
count at all, and toward what.

**F-7 — holds observed.** No chat interface, no allocation model, no
OpenOwnership re-attempt, no typed refusal emission, no new analytical
dimensions, and the continue criterion untouched. This order did not
supersede the afternoon and does not claim to: whether any of F-2 through
F-5 was worth building is a question only the miss log answers.

**Self-corrections and findings (this order's own).**

1. **The MCP server would not have started.** `src/mcp/server.ts` used
   top-level await; this repository declares no `"type": "module"`, so
   tsx transpiles to CJS and top-level await is a hard transform error —
   `npm run mcp` would have failed at the first line for anyone who tried
   it. Found by running a real client against it, not by reading it.
   Wrapped in an async `main()` with an explicit failure path.
2. **The archive overwrote an unreconstructable capture, and it happened
   during this order.** `archiveComtradeVintage` keyed by DAY and wrote
   unconditionally, so the 18:17 live run replaced the 01:06 capture of
   `152-2603-X-2023` — a 4-partner response overwritten by an 18-partner
   superset for the identical query. Comtrade revises in place and keeps
   no prior version: that is a knowledge state destroyed, by the archive's
   own writer, in the store the archive exists to protect. Only git
   history held the earlier bytes. Both captures are now placed where the
   corrected scheme puts them (canonical name + sequenced sibling), the
   writer never overwrites (identical bytes are a no-op; differing bytes
   get the next free slot), and the vacuity guard is explicit — the test
   demonstrates that the naive implementation loses the first capture.
   The intra-day divergence is itself evidence now rather than a
   casualty.
3. **The manifest would have failed on any used instrument.** The running
   instrument appends `search-misses.jsonl`, `export-log.jsonl` and
   `mcp-sessions.jsonl` into `data-archive/`; an unruled path throws in
   `buildManifest`, so the first production run to log a miss would have
   broken the verifier — the archive check punishing the instrument for
   being used. Excluded BY NAME (`LIVE_LOGS`, an accounted-for drop, not
   a silent one) with a test that plants a live log and asserts the
   manifest still builds.

Manifest after this order: 34 files — 19 unreconstructable, 8
refetchable-at-risk, 6 refetchable, 1 documentation. Suite: 619 passing.

**Exactly one next executable frontier:** unchanged — the researcher
afternoon. Everything in this order was built to be judged by it, not
instead of it.

## Phase 37 — deployment hardening: the gap between an image exists and an instrument runs

One report per item against `docs/WORK_ORDER_DEPLOY_2026-08-27.md`. The
order's INSPECT posture earned its place four times over: the most
valuable findings in this phase came from RUNNING the thing, and none of
them were visible by reading it.

**D-1 — guards evaluate against deployed state.** `/api/economy/guards`
runs all eight `validWhile` guards against the state the instance is
actually serving, per commodity, and reports the state fingerprint it
judged against. It declares itself the RUNTIME verdict and never infers
CI's: two greens about two different artifacts is the hazard, and it is
the same species as phase 35's split-commit rule one layer over. A
firing guard returns 200 — a lapsed condition on a live instance is a
condition to act on, not a test failure. Summary on `/api/health`,
detail at the endpoint. Vacuity discharged: evaluated at 2032 the
topology condition lapses and the failures carry commodity, ledger ref
and lapsed condition; evaluated today they hold, so the passing case is
not vacuously true of every date.

**Correction, and it is mine.** There are **EIGHT** guards, not the seven
this ledger, the docs, and both operator orders said. Phase 34 added
`typed-refusal-emission-unbuilt` and its entry called it "the seventh
deferred decision under validWhile" — the register already held seven,
so it was the eighth. The miscount originated in my own ledger line and
propagated outward into two orders written by the operator on the basis
of it. Corrected at the source in phase 34's entry, and the count is now
pinned against `DEFERRED_DECISIONS.length` in a test so a literal can
never drift from the register again — the same reason
`guardEvaluationScope()` is derived rather than listed.

**D-2 — boot behaviour.** Two of the order's assumptions were wrong and
inspection corrected both. (1) A cold start built NO state: `register()`
asserted configuration and stopped, and the canonical state assembled
lazily on the first request — so the researcher's first click paid the
entire assembly, live fetches included, with nothing on screen. Worse
than a slow boot: a boot that deferred its work into the first user's
lap. (2) "A missing archive path fails at startup" has no referent —
snapshots are ES-module imports bundled into the build, so the snapshot
rungs cannot go missing at runtime. What an unwritable archive actually
breaks is the WRITE path (miss log, export log, MCP session log, Comtrade
vintages), and every writer there is deliberately best-effort, so the
loss would be silent. The check is therefore WRITABILITY, reported with
its path. Boot now warms state, bounded, never fatal, degradations named.

**D-3 / D-4 — attribution and degradation.** Every response carries the
build, the state fingerprint (the same function the export stamps, so a
screen number and an exported number are comparable) and the knowledge
mode. Build identity is never fabricated: an unstamped image reports
`commit: null, commit_source: unstamped-build` rather than a guess. D-4
found a real gap: adapter failures were recorded as assembly `issues`
and reached NO response, so a state served from snapshot rungs because a
provider was unreachable looked identical to a fully live one — the
fresh-but-wrong failure wearing a healthy face. Every response now names
its degradation and lists the providers that answered.

**D-5 — bounded returns.** The corpus table takes a limit (default 500,
`limit=0` for unbounded, asked for explicitly) and the header carries
`limit`, `total_rows` and `truncated`, with the truncation stated in the
caveats. Row accounting conservation still holds:
`row_count + truncated = total_rows`.

**D-6 — post-deploy smoke check.** `npm run smoke` runs nine checks
against a running instance. Verified in BOTH directions live: 9/9 and
exit 0 against the real instance; exit 1 against nothing listening, and
exit 1 with every check named against a server that answers HTTP 200 but
is not the instrument — the discriminating case, because "something
responds" is what a liveness probe already tells you.

**D-7 / D-8 / D-10 — Tier 2.** Process observability (counters, bounded
event ring, per-host outbound stats) sits beside corpus health and says
plainly that it does NOT survive a restart. Restart semantics are
documented and verified in `docs/OPERATIONS.md`, including the one that
matters in a container: an unmounted `data-archive` discards the
unreconstructable captures on every restart, and boot can report the
path but cannot know the volume is ephemeral. D-10 found that the only
throttle in the codebase was a single in-loop sleep — a one-shot-script
discipline — and that **this order's own D-2 warming made it worse**, by
starting both commodities' Comtrade runs at the same instant. The
throttle is now a process-wide per-host gate: concurrent callers cannot
compound because they cannot run concurrently against one host.

**D-12 — the exposure decisions, TAKEN** (in `docs/OPERATIONS.md`).
Telemetry segregation: permanent, and the consequence is stated rather
than softened — a corpus used heavily by models and by no humans reads
as UNUSED against the frozen S-7 criterion, which is the intended
reading, because that criterion asks whether a researcher returns.
Authentication: stdio only, no port, nothing to authenticate. Inbound
rate limiting: not needed at a surface with no inbound, with the
condition named — if an HTTP surface is ever added, inbound limiting is
decided WITH it, not after.

**D-13 — machine-consumer licensing.** Every source carries a
`redistribution` posture with its reasoning, enforced at the MCP
boundary: `internal_only` (Westmetall, Yahoo) and `unresolved` (anything
unrecorded) are WITHHELD from machine clients and returned as typed
refusals with remedies, never omitted and never served on the assumption
that silence means permission. A source added tomorrow is refused until
someone decides — deliberate friction in the correct direction.

**FAILED / NOT DONE, reported not adjusted.** D-9: the off-provider
backup is **not done**. Moving the copy off GitHub needs a credential to
a second provider that this environment does not have and must not
invent, and the restore drill has the same blocker. The honest statement
stands: **the archive is replicated, not backed up** — one provider
incident still takes both copies, and the Comtrade vintages are the
unreconstructable set. D-11: the staging mechanism and the promotion
rule are documented; the target itself is the operator's.

**Four defects found by running it, none visible by reading it.**

1. **A health check that hangs.** Cold `/api/health` took **14.8s**,
   because the guard summary triggered the assembly it needed — a health
   endpoint that blocks for the one reason a health endpoint exists to
   survive, and long enough for an orchestrator to kill the instance
   mid-warm. It now reports `warming` without waiting; the blocking
   answer stays at `/api/economy/guards`, where waiting is correct.
2. **Next runs instrumentation in a different module context.** Module
   state is therefore NOT shared with route handlers, and this broke
   three things at once, silently: boot wrote a report no route could
   read (the log said `boot ready in 2805ms` while `/api/health`
   answered `booting` forever); the D-10 limiter kept TWO per-host
   chains, so a boot-time fetch and a request-time fetch to the same host
   never queued behind each other — the compounding it exists to prevent,
   reappearing through a door it could not see; and boot warmed a state
   cache no request would ever read, which silently voided all of D-2.
   Every process-wide singleton is now anchored on `globalThis`
   (`processSingleton.ts`) and the property is pinned by test. Measured
   after: first economy request **49ms**, guards `all_holding`, boot
   `ready` visible to the routes.
3. **The no-overwrite archive writer proliferated near-duplicates.** The
   fix shipped one phase earlier compared raw bytes — and Comtrade stamps
   every response with its own `elapsedTime`, so byte-identical NEVER
   matched and each re-fetch of unchanged data wrote another sibling.
   Seven copies of one knowledge state accumulated in an afternoon
   (`-2` through `-8`, identical payloads, seven timings). An archive
   that grows without bound on unchanged data loses the real revision in
   copies of itself — a second way to lose a vintage, created by the fix
   for the first. Comparison now ignores volatile response metadata; the
   STORED file is always the full unmodified response, because we never
   edit an archived capture, only ask a better question about whether it
   is new. The 18 timing-duplicates were removed after verifying their
   payloads were identical; both genuinely distinct captures survive.
4. **A shell that killed itself.** Twice, a `pkill -f "next start"` in the
   same command as the work matched the running shell and killed the
   edit mid-write, leaving files unchanged while the command reported
   nothing. Caught because the next `grep` found zero matches. Process
   management and file edits do not share a command.

Manifest after this phase: 36 files — 21 unreconstructable, 8
refetchable-at-risk, 6 refetchable, 1 documentation. Suite: 641 passing.

**Exactly one next executable frontier:** still the researcher afternoon.
Tier 1 is complete, which was the only prerequisite the order set for it.

## Phase 38 — the class named: a mechanism narrower than it appears, with nothing failing

The operator's reading of phase 37's `globalThis` finding, taken as the
directive it was: it is **larger than its fix**, and it belongs here as
an instance of a CLASS rather than as an infrastructure bug — because the
next instance will not be about modules either.

**The class.** *A mechanism whose EFFECTIVE SCOPE is narrower than its
APPARENT SCOPE, with nothing failing.* Its signature is that every part
reports success truthfully. No exception is thrown, no test goes red, and
the mechanism's own self-description is accurate — about an artifact that
is not the one in use. It is only ever found by someone asking "and does
that reach the thing I think it reaches?"

Three confirmed instances, arriving through three different doors:

| Instance | The door | What it looked like |
|---|---|---|
| The world-file commodity filter (round 26) | a PREDICATE | Ingest ran, accounted correctly, and silently dropped aluminium for twenty rounds |
| Guards evaluated on one partition (work order 3.1) | a SCOPE | Checks passed on copper and were silent about everywhere else their condition held |
| Module-context severance (phase 37) | a MODULE CONTEXT | Boot logged `ready` while health logged `booting` forever; the outbound limiter kept two per-host chains; state warming warmed a cache no request would read |

The third is the sharpest illustration because of the limiter: **a
throttle that exists to prevent compounding, defeated by a door it could
not see.** It spaced its requests perfectly — within each of the two
chains it did not know were two.

**Why the fix is not the finding.** Anchoring the state on `globalThis`
closes the module door. It says nothing about the next door. Every prior
instance was also closed at its own door — the filter now counts what it
drops, the guards now derive their scope from the register — and the
class still produced a new instance, through a mechanism none of those
fixes could have anticipated. What generalises is not the remedy but the
QUESTION: for any mechanism that reports success, does the thing it
affects and the thing in use have the same identity?

**What was built for it, at the door that is now visible.** Every
mutable module-level container in the economy instrument is now either
reached through `processSingleton` (shared across every module context by
construction) or listed in `CONTEXT_LOCAL_BY_DESIGN` with the argument
for why severance is harmless — accounting for every drop, applied to
state instead of rows. `contextSeverance.test.ts` enforces it, and
carries its own vacuity proof twice over: fixture-level (it must flag
severable state, must not flag an immutable lookup, must not flag state
already shared), and file-level (a planted severable module in the real
tree makes it fail, naming file and line; removing it makes it pass).

Three further instances were found and closed by that sweep, none of
which had failed anything: **`sessionTelemetry`** — the counters that ARE
the S-7 demand evidence, where a severed copy would have under-reported
an afternoon while every individual write looked correct, and the frozen
criterion cannot be amended afterwards to repair a reading taken through
half a session; **`mcpSession`** — the route-around log, which would have
computed its estimate over half its calls; and **`COMTRADE_DA`** — the
publication-date cache, where severance means duplicate outbound load
against a courtesy-limited source and a `knownAt` that could differ
between contexts for the same record.

**The check found a defect in itself, immediately.** Its by-name
assertion failed on `boot.ts`, which reaches the registry as
`processSingleton<T>(` — a literal `processSingleton(` match missed the
type parameter. A checker blind to one calling form is the class again,
one level up: a check correct about the files it examined and silent
about the file that mattered. Both patterns are now generic-tolerant, and
the generic form is in the vacuity fixture.

**The miscount, and how it moved.** Recorded because the propagation is
the point: "seven guards" was not a typo but a LEDGER SENTENCE (phase
34), and the operator's two subsequent work orders inherited it by
reading these documents rather than the register — which they had no way
to see. So an error in my own account of the system propagated outward
into instructions written on the basis of that account. It is the same
class stated in prose instead of code: **a literal that agreed with
itself and not with the world.** The count is now pinned against
`DEFERRED_DECISIONS.length`, and the general lesson is the one this
project already applies to scope — derive from the register, never
restate it.

Suite: 644 passing.

**The classes, collected.** The five named defect classes plus this one
were scattered across phases 26, 3.1, 33/34 and 37, recoverable only by
reading the narrative — and a doctrine you have to reconstruct from a
narrative gets restated slightly wrong, which is class 6 itself.
`docs/DEFECT_CLASSES.md` is now the register: signature, instances with
what each cost, the door each arrived through, what closed that door,
and — the part that matters — what does NOT generalise from each fix.
All six reduce to one question no test asks on its own: *does the thing
this mechanism affects, and the thing actually in use, have the same
identity?*

**A seventh instance, found by looking where the class said to look —
and it was in my own F-5 work.** The class says: does the thing this
mechanism affects, and the thing in use, have the same identity? So the
UI was rendered rather than reasoned about — the F-5 map changes had
only ever been unit-tested at the function level, and the afternoon runs
through that map.

The map builds all six econ layers, the new paint expressions are live
and valid, 48 entity features carry BOTH treatments (the non-scale
`unquantified` radius 3.5 is genuinely applied, off the ramp), and
coverage rides in the opacity as intended. Then the flows: **every one
of them arrived `basis: unspecified`, and every one rendered dashed.**

Cause: canonical state holds 48 metal_content and 14 gross_weight flows,
and the MAP PROJECTION dropped `basis` on the way out. So F-5's "one
basis per width-scaled layer" was correct, and operating on data whose
axis had been stripped upstream — a single bucket, one width ramp for
everything, and a mixed-basis refusal that could never fire because the
layer never saw two bases. Nothing failed. The unit tests passed because
they hand `basis` to the function directly. The mechanism, its tests and
its documentation all agreed with each other and not with the world.

Measured per topology rather than assumed: today's facility topology
serves 39 flows, ALL metal_content — so a test written against today
would have been vacuous, and the dashing correctly never fires there.
The **2017 country vintage serves both: 5 metal_content and 4
gross_weight.** Before the fix those nine rendered on one width ramp,
gross-weight beside contained-metal — the incommensurability F-5 exists
to prevent, rendered, at a date the researcher can scrub to. The
projection now carries the axis, and the pin lives at the SEAM (the
route's own payload) against that measured discriminating case, with
today's single-basis topology asserted separately so nothing is falsely
marked non-commensurate.

**An eighth, at the same seam class, in the OTHER magnitude surface —
and here the honest report is that it is LATENT.** Having found the map
projection stripping `basis`, the same question was put to every other
projection. The force-graph view builds its links directly from
`state.flows` and computes `ktPerYear: toKtPerYear(quantity, unit)` —
which normalises the UNIT and not the BASIS. The graph then scales link
WIDTH and PARTICLE COUNT on that number: two magnitude channels on one
ramp, under a field name asserting a commensurability the numbers would
not have.

But measured rather than assumed, and the measurement changes the claim:
the graph serves 39 flow links, **all `metal_content`**, because its node
set excludes countries as aggregates and this corpus's gross-weight
corridors are country-level. So unlike the map — which was ACTIVELY
mixing at the 2017 vintage — the graph's defect is latent: the code would
mix, the data does not currently ask it to. Reported that way rather than
as a second live defect, because the difference is the whole distinction
between a finding and an anecdote.

Closed anyway, while closing is cheap: the axis travels on the link, and
the treatment rule moved into `mapStyle.ts` — the ONE place treatment is
computed — so the graph cannot drift from the map's rule and the rule is
testable without a renderer. A non-metal-content magnitude sits off the
ramp on BOTH channels (width alone would leak the comparison back through
the particles), and unstated basis is treated as not-commensurate rather
than as metal. The corpus cannot produce the mixed case today, so the
rule is pinned on planted links; the "all metal_content" measurement is
itself pinned as a TRIPWIRE — when that assertion fails, the latent case
has become live, which is precisely what building the deferred allocation
model (facility-level flows on a non-metal basis) would do.

**The third surface, and the door the operator named: TEST PLACEMENT.**
The operator's reading of the seventh instance — "class 6 arriving
through test placement" — is a door in its own right: a test that
exercises a mechanism at the wrong ALTITUDE verifies the mechanism and
is silent about the wiring. F-5 was correct, unit-tested at the function
level, and fed inputs directly rather than through the path production
uses; the refusal it existed to fire therefore never could.

So the panel was rendered too — the other surface the afternoon runs
through, and one this programme had only ever tested through its API.
It works: the bottleneck list, the concentration indices with their
partitions, and the real 604-day corpus-health signal all reach the
screen, no JS errors.

But the runbook's FIRST move sends a researcher to that bottleneck list,
where the sentence read `2200 kt/y passes through`. Graph throughput is
contained metal BY CONSTRUCTION — `buildGraph` multiplies a gross-weight
edge by a corridor grade or a form-conversion constant and refuses where
neither exists — so the number was right and the sentence stated the
unit while omitting the one axis that makes it comparable to anything
else. On the surface a researcher is pointed at first, and in a system
whose export rows and MCP claims all carry the basis. Verified before
labelling rather than assumed: the conversion was read in the graph
builder, not inferred from the field name.

It now reads `2200 kt/y CONTAINED METAL passes through`. And a second
distinction the total was hiding: a CONVERTED tonne is not the same
epistemic object as a declared one — it carries the corridor grade's
band — so `nodeThroughput` counts converted contributions and the
sentence names them when they exist. Discriminating by test: the note
must be absent on a node with no converted input, or it would be as
uninformative as no note at all.

**Exactly one next executable frontier:** unchanged, and now unchanged
for three phases running — the researcher afternoon. That is not
avoidance; it is what "everything buildable is built" looks like when it
is true.

## Capability gap analysis (post-phase-2)

| Capability | Now | Gap | Path | Priority |
|---|---|---|---|---|
| Canonical state + provenance | ✅ copper | more commodities | new curated/live adapters; state model needs no change | high |
| Live acquisition | ✅ 4 providers | bilateral trade flows as graph edges; LME stocks | allocation model for country↔facility flow reconciliation; paid/licensed stock feeds | medium |
| Time-series state | ✅ (decade series, asOf engine, playback UI, topology-validity guard) | flow VINTAGES: several flow periods coexisting, asOf selecting among them (the MCS-vintage shape) — the structural fix behind phase 13's guard. The vintage material partially exists: Comtrade country-level annual trade by period is already archived and knownAt-stamped; the blocker is the deferred allocation model (country↔facility double-counting), not acquisition | per-period flow snapshots through the existing supersedes machinery + the allocation model | backlog slot 4 (phase 18 ranking: search kinds → sec-edgar → OpenOwnership → flow vintages); deferral guarded by `flow-vintages-deferred` (phase 14) |
| Graph UI | ✅ force-graph explorer | path analysis, community detection | operate on the existing `view=graph` payload | medium |
| Scenario analysis | seed (propagation system) | flow rebalancing, what-if | new engine system; registry makes this additive | high |
| Search over entities | ✅ (canonical-register search, evidence headlines, knowledge coherence, miss→registry-gap demand signal) | evidence-layer kinds (refused/contested/stale, vintage ids); fuzzy matching; cross-commodity when a second commodity lands | ranked instrument backlog (phase 12 §4) | high |
| Alerting | numeric detector FROZEN by measurement (structural bound: can't beat price where it detects; can't detect where lead matters); corpus health SHIPPED | missing acquisition modality: event-from-language, AIS | separate funded programme — see Phase 8 | deliberate decision, not next increment |

## Verification

Every subsystem above ships with executable tests (180+ economy tests; 555
total passing). Build, lint (new modules clean; substrate baseline unchanged),
and a Playwright smoke run against the production server verified the
end-to-end research workflow, including screenshots of the map layers,
research panel and entity inspector.
