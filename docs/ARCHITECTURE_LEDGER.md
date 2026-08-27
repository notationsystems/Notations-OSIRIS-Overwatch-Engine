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

When the operator supplies the identity: first document fetch answers
consolidated-vs-attributable, attribution scope rides ON the
observation, and the parse is built against the actual table under
these four requirements.

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

Every subsystem above ships with executable tests (170+ economy tests; 542
total passing). Build, lint (new modules clean; substrate baseline unchanged),
and a Playwright smoke run against the production server verified the
end-to-end research workflow, including screenshots of the map layers,
research panel and entity inspector.
