# OSIRIS — Physical Economy Engine

This document describes the physical-economy subsystem as it actually exists and runs.
It covers only executable reality; planned work lives in **Known Limitations**.

## What it is

An engine-shaped analytical subsystem that turns sourced observations about the
physical economy into a canonical world state, runs analytical *systems* over that
state, and serves *projections* of the result to the OSIRIS map and research panel.

```
External evidence (providers)
        ↓  adapters                      src/lib/economy/adapters.ts
Canonical EconomyState                   src/lib/economy/types.ts, store.ts
        ↓  index
Flow / dependency graph                  src/lib/economy/graph.ts
        ↓  systems pass
Analytical results                       src/lib/economy/analytics.ts, propagation.ts
        ↓  projections
API routes → map + research panel        src/app/api/economy/*, src/components/CommodityPanel.tsx
```

The engine lifecycle (`src/lib/economy/engine.ts`) is deliberately adapted from
game-engine architecture (core → entity manager → layered system passes →
render/projection), applied to an *observed* world rather than a simulated one:
an event arrives → entity state changes → consequences propagate through the flow
graph → analytics evaluate exposure → projections re-render.

The UI is never the source of truth. `CommodityPanel` and the map layers hold no
economics; they render what `/api/economy` serves.

## Canonical state — identity discipline

Six identities plus one derived record, never blurred (all in `src/lib/economy/types.ts`):

| Identity     | Meaning                                   | Id prefix |
|--------------|-------------------------------------------|-----------|
| `Entity`     | Persistent real-world object (mine, smelter, refinery, port, country, region, manufacturer, commodity, infrastructure) | `ent:` |
| `Observation`| A sourced measurement about an entity     | `obs:`  |
| `Flow`       | A directed material movement A → B        | `flow:` |
| `Capacity`   | A throughput constraint on an entity      | `cap:`  |
| `Dependency` | A typed relationship (`depends_on`, `feeds`, `located_in`, …) | `dep:` |
| `EconEvent`  | A temporally bounded change (outage, strike, closure, …) | `evt:` |

Every quantitative record carries:

- **provenance** — sourceId, source name/URL, retrieval timestamp, source ref, note
- **valueKind** — `reported` / `estimated` / `derived` / `representative`
- **confidence** — `high` / `medium` / `low`
- **knownAt** — when the value became knowable (vs. `period`, what it describes)
- **measurementClass** (derived from metric) — `physical_flow` / `physical_stock` /
  `market_price` / `financial_positioning`. Only physical measurements may feed
  physical analytics; `concentration()` throws on price/positioning, and
  reserves (a stock compiled under differing standards) never read as throughput.
- **partnerEntityId** — bilateral mirror scope; partner-scoped observations feed
  only divergence analysis, never aggregates
- **basis** — `cu_content` / `gross_weight` / `unspecified`. A kt without a
  basis is underspecified everywhere it appears (~4× apart for concentrate).
  The graph refuses gross-weight flows as throughput, so mixed bases can never
  skew inbound shares or propagation impairment; declared basis is a claim,
  and the divergence grade-band gate is the check on reporters who deviate.
- **geoPrecision** on entities — `exact` / `site` / `city` / `region` / `country`

`Divergence` is the seventh, explicitly derived record: emitted when
resolution discards a claim or a mirror pair disagrees, with claims,
resolvedTo, spread, direction, persistence and class.

**Entities are the one identity that deliberately carries no provenance of
its own.** An entity is an identity record — a name for a real-world object
— and evidence about it lives on the records that reference it (every
observation, flow, capacity, dependency and event carries provenance;
`validateState()` refuses a state where one doesn't). Provenance totality
therefore has a second half, enforced by test: **every entity must be
attested by at least one provenance-bearing record** — an entity nothing
references would be an unattested identity, the one shape the per-record
check would silently miss. This is the same attestation rule search's
knowledge coherence already applies (an entity is knowable at a date via
its referencing records, never by bare existence). Attestation also
carries its **class** (`strongestAttestingClass`): the strongest evidence
class among an entity's attesting records — strongest, not weakest, because
one reported record proves an identity is more than curation however many
representative records also touch it — with `event_only` and
`structural_only` (dependency edges alone) below the valueKind ladder.
Its sibling runs the OPPOSITE lattice direction: `weakestInputClass` on
derived indices, where contamination propagates and one representative
input taints the result. Two questions, opposite directions, both correct —
the names carry the direction so nobody "fixes" the asymmetry, and neither
is ever a bare `sourceClass`.
An entity whose class is representative-or-below exists, within OSIRIS,
purely on curation: the real-name/synthetic-number concern at identity
level, now labeled on search hits, the entity API and the inspector.
Measured: countries are reported-attested (live USGS); **every facility,
Escondida included, is representative-attested**; the JV operating
vehicles are structural_only.

Raw evidence and inference never share an identity: analytics return
`AnalyticalResult<T>` wrappers that separate **operation** (what was requested),
**execution** (which run produced it), and **evidence inputs** (the exact
observation/flow/capacity ids used). Derived relationships (e.g. `located_in`
from `countryCode`) carry `sourceId: "osiris-derived"` so they are visibly
inference, not sources. **Verification** identity is the test suite
(`src/lib/economy/*.test.ts`, `src/app/api/economy/route.test.ts`).

`validateState()` enforces referential integrity (unknown entity refs, duplicate
ids, self-loop flows, negative quantities, missing provenance, bad coordinates);
the store refuses to serve a state that fails it.

## Acquisition

Adapter-oriented (`src/lib/economy/adapters.ts`):

```
Provider → EconomyAdapter.load(commodity) → AdapterPayload → store assembly → validated EconomyState
```

**Row accounting (standing doctrine, round 26): filtering is never free.**
An adapter accounts for every row it fetched — accepted, rejected with a
reason, or filtered with the predicate NAMED and COUNTED (`RowAccounting`,
carried on the assembly and served on the state/analytics views).
Rejection was always reported; a filtered row never became a candidate
record and so was invisible — the world-file commodity filter discarded
aluminium's data for twenty rounds, and unmapped M49/MCS identifiers
vanished at resolution. Both now count what they exclude, with names, and
a conservation test asserts every fetched row lands in exactly one bucket.
Wired: MCS (both commodities + vintage), Comtrade (unmapped
reporter/partner M49, netWgt noise floor); Yahoo/CFTC/Westmetall parses
carry no filtering predicates (whole-series accept-or-fail) and adopt the
doctrine when one appears.

Adapters are registered, not hard-coded. Six serve copper (two more serve
aluminium — the curated register and the same MCS world file under its
commodity spec):

- **`curated-copper-v1`** — the curated dataset (`src/data/economy/copper.ts` +
  `copper-series.ts`): 49 geolocated entities, a decade of annual production
  series (2015–2024) plus monthly stock series, 39 flows, 20 capacities,
  dependencies, and 5 real-world events. All `valueKind: "representative"`.
- **`usgs-mcs-live`** — USGS Mineral Commodity Summaries World Data CSV fetched
  from ScienceBase: **reported** 2023 and **estimated** 2024 mine production,
  refinery production and reserves for 17 countries. TTL 30 days.
- **`comtrade-trade`** — UN Comtrade public preview: reported physical trade
  weights (HS 2603 concentrate — *gross* weight; HS 7403 refined). Requests are
  throttled; on a 429 each remaining request degrades individually to its
  snapshot slice. TTL 30 days. `knownAt` is stamped from the getDA
  data-availability API (real release dates, committed as
  `snapshots/comtrade-da.json`) — and stamped with the **held version's**
  release date, because Comtrade keeps one version of a dataset and revises
  in place (both Chilean years have already been revised): the vintage that
  was knowable earlier no longer exists upstream. For the same reason every
  successful live retrieval is archived to `data-archive/comtrade/` before
  parsing — the snapshot rung is not a fallback for Comtrade, it is the only
  vintage archive of Comtrade that will ever exist.
- **`yahoo-copper-price`** — COMEX HG=F monthly closes (USD/lb, 10 years) on the
  commodity entity; the in-progress month is flagged partial. TTL 12 h.
- **`cftc-positioning`** — CFTC COT managed-money net positioning, weekly, on
  the commodity entity. TTL 12 h.
- **`westmetall-lme-stocks`** — daily LME copper closing stock (year-to-date
  depth), republished as a public HTML table by Westmetall. The only
  daily-cadence physical series in the corpus, added because the information
  horizon table showed nothing else could ever produce a non-negative alert
  lead. Recon verdict: LME's own pages and CME delivery reports are
  bot-blocked (403) and LME data is commercially licensed at feed level —
  this republished headline figure serves internal research; a production
  deployment wants a licensed feed. TTL 6 h.

Every live adapter (`src/lib/economy/liveAdapters.ts`) sits behind the same
**degradation ladder**:

```
live fetch → TTL cache + in-flight dedup (sourceCache) → last-good → bundled snapshot
```

The bundled snapshots (`src/data/economy/snapshots/`) are verbatim captures of
the real endpoints, committed to the repo; the parse functions run against them
in tests, so the parsers cannot drift from the real response shapes unnoticed.
Observations served from a snapshot say so in their provenance note. A failing
adapter degrades to a store warning — one dead provider never takes down the
state (`store.test.ts` enforces this). Live fetches are disabled under vitest
(`RUN_LIVE_TESTS=1` re-enables) and via `OSIRIS_DISABLE_LIVE=1`.

**Evidence ranking:** when two providers cover the same (entity, metric,
period), read-time selection (`observationsAt`) prefers `reported` >
`estimated` > `representative` > `derived`, then higher confidence — so
analytics automatically run on the hardest available evidence, and the curated
numbers remain as corroborating context rather than being deleted.

**Data honesty:** curated magnitudes stay `representative` (enforced by tests);
only live providers produce `reported`/`estimated`. Concentrate trade weights
use the distinct metrics `concentrate_exports/imports` with unit `kt gross/y`
so gross shipping weight can never be summed with contained-copper figures.
Facility coordinates remain approximate and say so via `geoPrecision`.

## Flow graph

`buildGraph()` produces a directed graph: flow edges (quantified, normalized to
kt/y) plus dependency edges (`located_in` excluded — geography is not material
structure). Traversal:

- **upstream(entity)** — who ships material toward this node + what it `depends_on`
- **downstream(entity)** — who receives material from it + who depends on it

Both are cycle-safe breadth-first walks returning depth-tagged steps with the edge
that reached each node.

**Basis handling.** A gross-weight flow must never enter throughput at face
value (mixed bases skew inbound shares ~4× toward the fat-basis supplier) —
but it must not enter as zero either: zero is a value, the claim that the
flow carries *nothing*, and it inverts supplier counts and redundancy while
making disruptions at gross-reported suppliers propagate nothing. The
resolution is conversion (`basis.ts`): the divergence system's mirror
analysis already implies a per-corridor grade (content-declared ÷
gross-declared where the ratio sits in the 3.0–5.0× band), and `buildGraph`
applies it as the conversion factor, carrying the 20–33% grade band as a
`ktRange` uncertainty on the edge. Where no corridor grade exists, the
tonnage is **refused, visibly**: the node stays in the throughput map with
the unquantified flow ids attached, centrality returns `share: null` for it,
bottleneck scoring emits `score: null` sorted *first* with a SCORE REFUSED
explanation, and propagation states that disrupted tonnage is unknown rather
than zero. Refusal is visible; zero isn't.

## Analytical systems

Registered in `src/lib/economy/engine.ts`; each is a pure, independent computation
over (state, graph):

Systems receive a `SystemContext` with an optional `asOf` evaluation date and
a `knowledge` mode. `best_known` (default) is the current best reconstruction
of history; `as_known_then` restricts the run to evidence knowable at `asOf`
(observation `knownAt` ≤ asOf, event `firstReportedAt` ≤ asOf) — the mode
backtesting requires, since a detector scored under hindsight is being graded
on information it could not have had. Every observation carries `knownAt`
(publication/release date, or retrieval time as the conservative bound) and
optionally `supersedes` (revision chains: MCS 2025 figures supersede MCS 2024's
estimates for the same periods — both vintages are held, so the engine can
answer "what did the world believe in June 2024"). Events carry
`firstReportedAt`; detection latency (first report − occurrence) is served on
the timeline, because it is the number that says how much warning the system
could actually give (Grasberg: occurred 09-08, reported 09-10 — 2 days).

| System | What it derives |
|---|---|
| `concentration` | HHI of mine production (country/mine/**operator**), refined production, consumption, smelting/refining capacity — each from the latest observation per entity at `asOf`. DOJ bands (<1500 / 1500–2500 / >2500). Never mixes entity kinds in one calculation. **Every index carries its partition context** (`groupCount`, `effectiveGroups` = 10000/HHI, `partitionFloor` = 10000/n): HHI has a floor of 10000/n, so a finer partition yields a lower index whatever the structure, and raw HHIs over unequal partitions are never comparable. Operator concentration ships in **two attribution bases, stated on the number**: `control` (100% of an asset to its operator of record — who can stop it; JV-operated facilities with no modeled operator fall to the reported unattributed remainder) and `economic_interest` (ownership shares — who owns the loss). A FOURTH comparability axis, **attribution completeness**, travels with operator indices: a renormalized index over c of the universe inflates by ~1/c², so `hhiWithRemainder` (unattributed facilities enumerated as their own groups — unmodeled was never unknown) is the only figure comparable against a full-universe index. Measured, fully labeled: control-HHI **1391 at completeness 1.0** (the JV operating vehicles — Compañía Minera Antamina S.A., Compañía Minera Doña Inés de Collahuasi SCM — are curated company entities, so `hhi` and `hhiWithRemainder` coincide); economic-HHI 959 renormalized / **768 comparable** (completeness 0.885, minority residues enumerated); the same facility universe grouped by country gives 2135 — geography is substantially more concentrated than control on the modeled set, with the Chile-heavy coverage bias labeled on it; the world-reported country figure (1339, 19 reporters) is a different universe and is never compared raw. The index-free finding is unaffected by every correction: **Freeport-McMoRan controls 26.3% of modeled mine output across Indonesia, Peru and the US** — a single-operator exposure the country lens scores as three unrelated events. Traversal gates on EVENT CLASS, not edge role alone: operational events (strike, outage) traverse operator edges only — a Rio Tinto strike cannot reach Escondida through its 30% — while financial/legal events (sanction, insolvency) attach to owners and traverse shareholder edges too — a sanction touching MIND ID reaches Grasberg through the 51% no strike could use; regulatory events attach to territory and use neither — they propagate by jurisdiction + scope instead (see `propagation`). An operator index over **zero attributed tonnage is `null`, not 0**: 0 is a real value on the HHI scale ("perfectly unconcentrated"), and an index computed over an empty attributed set has no value at all (band `no-data`). **Every index now carries `weakestInputClass`** — the contamination-direction aggregate that finally lets admissibility reach the result instead of stopping at the observation layer. Measured: NO index in the system is reported-class end-to-end. The operator indices are representative-class (facility observations are curated, and the attribution edges — curated structural claims — cap the class even on the day facility observations become reported); the country index is representative-class too (Mongolia and Panama resolve to curated observations) and would cap at `estimated` even without them, since USGS labels latest-year MCS figures as estimates. **Cross-commodity comparison is the FIFTH venue of the same incommensurability species**: "aluminium (>2500) is more concentrated than copper (1339)" needs the same four qualifiers as every within-commodity claim — different partitions (compare effectiveGroups, never raw HHI), different universes, different bases per stage, different completeness; the machinery travels on every index, and the temptation is new, not the rule. The accurate statement is narrower than any numbers-vs-structure split: **no index in the system is reported-class end-to-end, and none can be until the structural layer changes class** — every index's `weakestInputClass` ultimately stands on it. The layer's class mix is a measured **proportion, not a flag**: `structuralClassProfile` (served in the coverage projection) reports the sourced share of flows, capacities and attribution edges by record and by tonnage — 0% across all three today, pinned as a number so the first reported structural ingest (`sec-edgar` in the registry) moves a figure instead of breaking a boolean that covers only filers (Codelco sits outside: a mixed layer, not a converted one). The ordering EDGAR forces rather than chooses: filings move quantity and structure together from the same documents; reporting quantities while leaving structure curated leaves every index representative regardless. That ordering has a stated boundary, recorded as a prediction before ingest: **it does not extend to flows** — no filer discloses where its concentrate goes, so the profile's components will move at different rates and the flow component stays 0% under EDGAR alone (structural to the source; flow class change waits on trade/movement data). Filer self-reporting is handled by measurement, not a new label (phase 20): per-country filer rollups meet the compiled figure in the coverage system, coinciding quantities become divergence claims, and a filer persistently one side of the compiled statistic is a finding. |
| `centrality` | Material throughput per node (in + out, kt/y) and network share. |
| `bottlenecks` | **Candidate** bottleneck score: 0.35·throughput share + 0.25·utilization (flow vs stated capacity) + 0.25·redundancy (alternatives at same stage) + 0.15·dependency load. Explicitly a triage signal, not validated risk; every score exposes its components, explanation and evidence ids. Countries/regions are excluded (aggregates are not chokepoints). |
| `anomalies` | Rolling z-score vs trailing window + period-over-period rate of change on every (entity, metric) series with enough points. Series resolve one observation per period by evidence rank before detection (provider disagreement is never a time step). The continuous front-month price series is excluded (roll discontinuities are contract artifacts, not moves); positioning signals are tagged `financial_positioning` and rendered as reflexive market context, never physical evidence. |
| `coverage` | Facility-model coverage per country: rolled-up facility observations ÷ the country's own observation. ≈1 complete, <1 the unmodelled share, >1 a contradiction. This is the standing integrity check that keeps facility- and country-level populations from ever being conflated — they meet only here, explicitly, as a ratio. The coverage range is also **attached to the facility-level HHI** (`coverageBias`), because differential coverage biases facility concentration toward better-modeled countries and the number must not travel without that caveat. |
| `divergence` | Observer disagreement kept as evidence: multi-provider conflicts and **Comtrade mirror pairs** — exporter- vs importer-declared weights of the same bilateral flow. Classification runs a **basis gate first**: a concentrate mirror ratio inside the 3.0–5.0× grade band (20–33% Cu) is the fingerprint of contained-metal-vs-gross-weight declarations and classes `definitional`, never `unexplained` — the Chile→China 3.97× gap (implied 25.2% Cu) is exactly this, a units artifact, not suppression. Classing definitional is **normalization, not dismissal**: the pair is converted at the fixed 25% reference grade and the residual recorded (`basisNormalization`) — Chile→China: 8,433 × 0.25 = 2,108 vs 2,125 declared, a **+0.8% residual: the basis explains the entire gap, no material suppression signal in this corridor**. The residual is the watched baseline — definitional pairs rank on it, never on raw spread — and reclassification keys on **drift** against the corridor's own history, never on level: the level is confounded by the corridor's unknown true grade (a genuine 30%-grade corridor shows +20% at the 25% reference with honest declarations — a stable offset is a grade), while grade moves slowly, so first-differencing removes it and a step beyond ±10 points reclasses the pair `unexplained`. `unexplained` is the hardest class to earn; what earns it (the −25% DRC→China refined gap, where basis cannot be the mechanism) ranks first. An anomaly says the world moved; a divergence says the observers disagree — the two never share a ranking. |
| `scenario` (via `POST /api/economy/scenario`) | Counterfactual event injection: hypothetical events run through the same engine on an explicit **EvaluationFrame** (`kind: counterfactual`, scenario id, asOf, knowledge) so a hypothetical can never be read as a reconstruction. Returns baseline + counterfactual frames and the structural delta (newly disrupted entities, newly affected downstream, disrupted kt/y). Combined with `as_known_then` it backtests the analytical layer itself: posing Grasberg's halt into the 2025-09-09 knowledge state recovers the same dependent-smelter conclusion the best-known reconstruction reaches — evidence the analytics' structural calls do not depend on hindsight. |
| `propagation` | Event → state change at `asOf`: disrupted flow volume, downstream entities within N hops, spare capacity at same-stage peers, declared dependents. Distinguishes events live at the evaluation date from historical context. Edge traversal is class-gated (`eventClassOf`): operational events walk operator edges, financial events walk shareholder edges too. **Regulatory events propagate by territory + scope, not graph adjacency**: a `RegulatoryScope { jurisdictionCountryCode, commodity?, stages?, direction }` on the event resolves membership through located_in edges and countryCode. `direction: 'all'` disrupts every in-scope entity and its downstream — Peru's 2020 COVID mining halt reaches Cerro Verde, Antamina, Las Bambas, Callao and Onsan, never Escondida (territory means territory). `direction: 'export'` halts only flows *crossing the border*, sparing domestic receivers — Grasberg's 2017 export halt stops outbound concentrate without stopping production (a scenario-posed Chilean export ban shows the full mechanism: Saganoseki, Shanghai and Guixi affected, Caletones spared). A regulatory event **without a scope is refused, not guessed** — its tonnage is `null`, never a 0 a reader could take as "no effect". **Topology validity is checked on every pass**: `asOf` filters what was *known*, but flows are a single-vintage claim about what *was* — an evaluation date that **predates** the flow period gets `null` for every flow-derived tonnage with the mismatch named (a 2017 evaluation against 2024 flows describes a world that did not yet exist; "no entity in scope" is 0, "cannot answer at this date" is null, and the two never render alike), while a date **after** the period uses the snapshot as latest-known structure, labeled **and quantified**: `extrapolationDays` carries the distance past the period (against a fixed snapshot, live evaluations are permanently extrapolated — the status stops carrying information and the distance is the number that moves), bounded on two axes: a clock ceiling (two annual cadences — "should a new vintage exist by now?", a question about the curator) and an **evidence trigger** ("is the old topology still true?", a question about the world — elapsed time is a proxy, the event register holds the thing itself): curated structural events postdating the snapshot (closure, expansion, scoped regulatory, sanction/insolvency, open-ended high-severity disruption — a disruption with a curated end is transience, not movement) surface as `structuralEvidence` with the note escalated to STRUCTURE HAS MOVED — and the escalated note claims only what is true: figures continue because **no other structure is modeled**, and the residual at affected entities is unquantified structural drift (the event mechanism carries the output loss along modeled edges; whether the edges still hold is a different, unhandled error). The trigger honours the knowledge state: postdating keys on occurrence (a fact about the world), visibility keys on `firstReportedAt` under as_known_then — in the occurrence→report window the contradiction exists but is not yet knowable, and best_known and as_known_then provably disagree there (pinned, with the vacuity assert that the two dates differ). Fired on real data at first evaluation: the Sep-2025 Grasberg force majeure contradicts extrapolation today, months ahead of the clock. |

### Alerts (engine layer only — deliberately no UI yet)

`alerts.ts` derives alerts as a *projection* of signals the engine already
computed — never a fresh computation. Trust discipline, in order:

1. **Derivation** — anomaly signals (physical classes only: reflexive
   positioning never wakes anyone) and newly-reported events. An
   **arrival-cadence gate** admits only series whose *information arrives*
   monthly or finer (measured from knownAt spacing, not period length): an
   annual aggregate is history at publication, an anomaly but never an
   alert. The one exception the axis change recovers: a **revision** to an
   annual series (a supersedes chain moving the best estimate ≥5%) is new
   information on a known date — "our best estimate of 2023 just moved
   −41.6%" (Zambia refined, MCS 2025) is knowable the day the edition
   publishes and alerts with that date, however old the described period.
   Revisions are a publisher's explicit act, not an inference from noise,
   and are scored separately everywhere (never against the disruption
   record). Event alerts carry their detection latency (`firstReportedAt −
   start`) so notification speed is never mistaken for detection skill.
   Series additionally partition by period cadence before anomaly windows —
   a daily stock point is never treated as the successor of a monthly one
   (the splice class again).
2. **Suppression memory** — an alert whose signal is already explained by the
   divergence system (`definitional` / `coverage` / `revision_lag`) must not
   fire; the withheld alert references the explaining divergence record.
   `unexplained` never suppresses.
3. **Retraction** — `reconcileAlerts` carries a ledger across evaluations: a
   fired alert whose signal is later reclassified (or is no longer derivable
   from revised evidence) is retracted with its reason and the divergence id.
   Retractions are records, not deletions; a re-firing signal names its prior
   retraction. A system that cannot withdraw a claim becomes one nobody reads.
**STATUS: the numeric detector is FROZEN** (not deleted). The measurement
programme answered its own question: where a numeric series can detect, it
cannot beat the price (leadVsPrice −31 and −13 days on the only detectable
event class); where lead would matter — labour, regulatory and logistics
events, five of six in the truth set, announced in language before they
occur in matter (Escondida's strike notice preceded its stoppage by two
days: a negative reporting delay no series can reproduce) — a numeric
series cannot detect at all. That bound is structural: closing it requires
a different acquisition modality (event extraction from language, AIS for
movement — both already registered with `adapter: null`), which is a
separate programme, not the next increment. The detector stays measured,
documented and honest, frozen with `precisionPreRegisteredOnly: null` and
the sensitivity table attached, and becomes useful the moment a faster
physical series or the missing modality exists. Corpus health (below) is
the one alert class that shipped.

4. **Backtest before wiring** (`alertBacktest.ts`) — the detector runs
   against a decade of knowledge states on a hybrid grid (month-ends
   everywhere, daily where daily evidence exists), strictly `as_known_then`,
   with the no-lookahead invariant *checked* per alert (violations counted;
   must be 0). The report leads with the **information horizon**
   (`horizon.ts`): per-source distributions of `knownAt − periodEnd`, and
   `firstReportedAt − occurredAt` across the event record — the ceiling on
   lead time as a property of the SOURCES, computable without a detector.
   No threshold tuning moves it, and it converts "we need better data" into
   a shopping list with numbers. On the current corpus: USGS annual
   best-case −30 days / typical −213; Comtrade first-release delays of 1–13
   months (real dates from the getDA availability API); CFTC −3 days but
   reflexive; the daily Westmetall stream best-case −1 day — the only
   physical series capable of non-negative lead.

   Results are reported through the **scorecard**, which splits populations
   a single precision number pools together. The truth set is divided into
   pre-registered events (curated from the public record, independent of
   detector output) and post-hoc events (curated after observing firings,
   or written around a series the detector runs on) — a truth set assembled
   by looking at what the detector fired on cannot score that detector, and
   both currently-detectable exchange-stock events are post-hoc. **The
   headline is `precisionPreRegisteredOnly`, and on the current corpus it
   is `null`: no measurement of detector precision is possible on the clean
   truth set**, because no independent event is detectable and no alert
   went unmatched. `precisionAll` (currently 1.0 over 19 alerts) exists as
   context and is never quotable alone — an earlier revision of the suite
   pinned 0.438, and completing one missing event record moved it to 1.0
   with the detector untouched, which is why the tests pin the procedure
   and the horizon, never the values. Alerts are also counted as episodes
   (a contiguous run on one subject; many firings on one drawdown are one
   success, not many), the attribution window is published as the free
   parameter it is (`attributionSensitivity`: at 0 pre-window days
   precision 0.947 / median lead −5; at 30+ days 1.0 / +7 — the knob moves
   both), and the axis precision cannot see is reported: the quiet-period
   alert rate (currently 0 across 54 event-free months). Lead is
   benchmarked twice: against journalism (`firstReportedAt`) and against
   the market (`leadVsPrice`, monthly COMEX closes as a benchmark, never an
   input — the reflexivity firewall stands; price may grade physical
   analytics, never feed them). On exchange-stock events the market moved
   first both times (−31 and −13 days at monthly resolution): the positive
   lead over journalism is not a lead over the market, and the genuinely
   valuable target remains the mine/logistics events where recall is zero
   pending daily/weekly series near them.

5. **Corpus health** (`corpusHealthSignals`) — the system watching its own
   blindness, as a first-class alert kind alongside anomaly, event and
   revision. Exactly one series is capable of positive lead and it is a
   scrape of a third-party republisher; if its markup changes, the ladder
   degrades *gracefully* to snapshot — correct behaviour and also the
   failure mode, because recall silently returns to zero. These signals
   fire when the **lead ceiling degrades**, not merely when a fetch fails:
   a source whose newest knowable value is older than 3× its own arrival
   cadence raises `source_stale` (or `ladder_rung_pinned` when serving from
   snapshot), with the consequence computed, not asserted — "best
   achievable warning fell from −1d to −16d" — and load-bearing sources
   (the corpus's best lead ceiling) marked and sorted first at high
   severity. A cleared condition resolves in the ledger as "condition
   cleared", distinct from a retracted claim: the staleness was real while
   it held.

## API projections

All views accept `&asOf=YYYY-MM-DD` and `&knowledge=best_known|as_known_then`.

- `GET /api/economy?commodity=copper&view=map` — geolocated entities (with
  production, capacity, bottleneck score, event count, disruption flag at the
  evaluation date) + coordinate-resolved flows with disruption flags.
- `GET /api/economy?commodity=copper&view=analytics` — all system outputs + events + sources.
- `GET /api/economy?commodity=copper&view=timeline` — playback range + dated
  events for the time scrubber.
- `GET /api/economy?commodity=copper&view=graph` — force-graph projection:
  structural nodes (throughput, bottleneck score, disruption) + typed links
  (flows with kt/y and form; declared dependencies).
- `GET /api/economy?commodity=copper&view=state` — the full canonical state (research/debug).
- `GET /api/economy/entity?commodity=copper&id=…` — entity detail: observations,
  capacities, flows in/out, events, and resolved upstream/downstream chains.
- `GET /api/economy/search?q=escondida[&asOf=…&knowledge=…]` — entity search
  over the canonical register (name, operator, country, kind — companies
  included) with a one-line evidence headline per hit (latest resolved
  observation, labeled with its valueKind — a search result never presents a
  number without its epistemic status). The search index IS the entity
  register; there is no parallel list to drift. Search honours the knowledge
  state like every other surface: under `as_known_then`, entities with no
  knowable record at `asOf` are withheld and counted ("N further entities
  match but were not knowable then"), and headlines resolve from knowable
  evidence only — search must never be the way around the AS KNOWN badge.
  A TRUE miss (no hits, nothing withheld) is a **demand signal**: the
  response names the registered-but-unbuilt sources whose declared coverage
  could have answered (`registryGaps`, from `SOURCE_REGISTRY` in
  `sourceRegistry.ts` — 17 real entries whose `adapter: null` rows ARE the
  gap list), and the miss is appended best-effort to
  `data-archive/search-misses.jsonl` so dormant sources accumulate demand
  evidence instead of opinions. A withheld miss returns no gaps — the state
  CAN answer, the knowledge state withholds it, and offering sources there
  would misdiagnose coherence as absence. Policy, pinned by test at all
  three layers: registry `yields` name canonical identity kinds only (no
  source may be registered for natural-person data); `SearchHit` projects
  register fields only; and the miss log retains a query string only when
  it contains register vocabulary (registry keywords + state-derived kinds,
  countries, operators, commodity) — a person-directed query that misses is
  counted (`queryWithheld`) but its string is never persisted, because the
  policy's real property is that the system does not accumulate
  person-directed queries, not merely that it declines to answer them.
  **Evidence-layer kinds** (the last item of the search arc): queries whose
  first token names an epistemic state search the state itself instead of
  the register — `refused[:type]`, `stale[:type]`, `contested[:class]`,
  `vintage` — with remaining tokens as free filters. The states are TYPED
  because they accumulated as distinct conditions with distinct remedies,
  and the shared fix is what a type is for: `refused:basis` (gross-weight
  flow, no corridor grade → curate a grade), `refused:component`
  (bottleneck score null), `refused:topology` (evaluation predates the
  flow topology → flow vintages), `refused:scope` (regulatory event with
  no jurisdiction → curate regulatoryScope), `refused:attribution` (null
  operator index → curate operated_by edges); `stale:source` /
  `stale:ladder` / `stale:suspect` (the three corpus-health conditions) /
  `stale:topology` (extrapolation under structural contradiction);
  `contested` typed by divergence class; `vintage` inventories the source
  editions actually held with their knowability ranges. Every hit carries
  its mechanism's own explanation and the type's remedy. Evidence queries
  honour the knowledge state end-to-end: under `as_known_then` the
  evidence is computed from the knowledge-filtered state, so a
  contradiction in the occurrence→report window surfaces under best_known
  and not under AS KNOWN (pinned).

## Spatial + research interface

- **LayerPanel** — `PHYSICAL ECONOMY` group: Cu Production, Smelting/Refining,
  Ports & Logistics, Material Flows, Bottleneck Candidates (on by default).
- **Map** (`OsirisMap.tsx`) — entity dots colored by stage and sized by output/capacity;
  material flows as great-circle arcs colored by form (concentrate amber,
  blister/anode orange, cathode/refined cyan) and weighted by quantity; red rings
  on bottleneck candidates ≥ 0.45 (kept visible even when their stage layer is
  toggled off). Entities/flows under a live disruptive event render with red
  strokes / dashed red lines. Clicking an entity opens a popup and the research panel.
- **EconTimeBar** — temporal playback scrubber (month granularity) with event
  severity markers on the track, play/pause stepping, and a LIVE reset. Scrubbing
  re-fetches the map projection at the evaluation date, so disruptions appear
  and disappear as history replays.
- **EconGraphView** — force-directed flow-graph explorer: node size = throughput,
  stage colors matching the map, red halos on bottleneck candidates, red fill on
  disrupted entities, directional particles traveling with the material (density
  scaled by tonnage), dashed dependency links. Click-through to the research
  panel; honors the playback date.
- **CommodityPanel** — overview (concentration trajectory sparkline, HHI cards
  with expandable evidence, bottleneck list with score bars, anomaly signals,
  events, sources) and an entity inspector (observation series rendered as
  sparklines with expandable point lists, provenance/valueKind/confidence on
  every record, capacities, flows, events, clickable upstream/downstream
  dependency trees). Shows an `AS OF` badge and re-evaluates during playback.

- **SearchBar** — physical-economy entities resolve from the canonical
  register and appear above geographic hits (a researcher typing "escondida"
  wants the mine's state, not the Chilean locality): each hit shows kind,
  operator, country and its evidence headline; selecting one flies the map to
  the entity and opens it in the research panel. Ctrl+F, arrow keys, Enter.

Research workflow this supports end-to-end: open OSIRIS → type a name →
land on the entity (or: copper layers → producing regions →
processing/refining structure → flows → select a node) → inspect state →
traverse dependencies → concentration → candidate bottlenecks → inspect
supporting evidence.

## Testing

120+ economy tests among the repo's 476 (`npm test`):

- schema/validation (`types.test.ts`), store assembly + provenance discipline +
  adapter-failure degradation (`store.test.ts`), flow direction/traversal/cycles
  (`graph.test.ts`), hand-computable HHI + as-of selection + trajectory +
  centrality + deterministic bottlenecks + anomaly detection (`analytics.test.ts`),
  event propagation + engine lifecycle (`propagation.test.ts`), live-adapter
  parsers against committed real captures + evidence-ranking integration
  (`liveAdapters.test.ts`), API data contracts incl. temporal/timeline/graph
  views (`route.test.ts`), divergence classification incl. residual
  normalization and reclassification (`divergence.test.ts`), scenario
  injection + the as-known-then replay with its vacuity guard
  (`scenario.test.ts`), and alert derivation / suppression / retraction plus
  the decade backtest with its measured precision pinned (`alerts.test.ts`).
- Synthetic fixture (`fixtures.ts`): a 2-mine → port → smelter → demand chain with
  hand-computable numbers (80/20 split → HHI 6800, etc.).
- Tests are hermetic: live fetches are disabled under vitest; parsers run on the
  committed snapshots.

## Deferred decisions are guarded (`ledgerGuards.ts`)

A deferred decision is safe only while the condition that made it safe
still holds — and the condition is executable, not remembered. Six ledger
entries carry `validWhile` predicates evaluated by the test suite against
the real state: attribution basis unbuilt (while no sanctions-class event
is curated), flow vintages deferred (while exactly one flow period exists),
the person-name policy's three pins (while every register kind is in the
canonical identity set), the modality freeze (while no built adapter yields
events), the Westmetall singularity note (while it is the only daily
physical stream), and forward extrapolation (while the distance stays under
two annual cadences, 730 days — measured 604 today; its second axis, the
evidence trigger, FIRED on first evaluation against the Grasberg force
majeure and was re-taken into the product: the contradiction is carried on
every projection rather than remembered here). A failing guard does
not re-decide: it raises the decision with the original reason attached.
Each predicate is also vacuity-tested — shown to fire against the planted
condition it exists to catch.

## Known limitations

- Two commodities: copper (deep) and aluminium (the round-25 substrate
  test — the full research path serves `commodity=aluminium` from the same
  routes, with live MCS bauxite/alumina/metal figures from the same world
  file). The substrate claim is now tested, not assumed (ledger phase 24);
  remaining copper-shape: the UI defaults (panel fetches, layer labels)
  and two recorded scope gaps — gross bauxite/alumina flow conversion
  (form-level stage-conversion constants, unbuilt; aluminium flows are
  curated in contained metal meanwhile) and facility-scoped regulatory
  acts (RegulatoryScope is jurisdiction-shaped; the Alunorte embargo is
  modeled as disruption with the limitation stated on the event).
- Comtrade bilateral rows are not yet materialized as Flow edges (world totals
  only) — facility-level flows would double-count against country-level trade
  edges without an allocation model. When they land, the basis machinery is
  ready: gross-weight edges convert via mirror-implied corridor grades (with
  the grade band as uncertainty), and corridors without a grade refuse shares
  visibly instead of entering as zero.
- The reference concentrate grade (25%) and the 20–33% band are industry-typical
  constants, not per-corridor assays; the residual level inherits that
  uncertainty (which is why reclassification keys on drift, and where a
  documented assay exists it should replace the reference for that corridor).
- Alerting remains engine-only. The horizon table says the corpus now has
  exactly one stream capable of non-negative lead (daily LME stocks via
  Westmetall, republished headline data — licensing noted in the adapter);
  recall is bounded at the exchange-stock event class until mine-adjacent
  daily/weekly series exist. The backtest evaluation grid is monthly, which
  bounds measurable lead now that a daily source exists.
- Comtrade `as_known_then` is blind before the release date of the held
  version of each dataset (the source revises in place with no upstream
  archive), and pre-revision vintages that predate OSIRIS's own archive
  (begun 2026-08) are permanently unrecoverable — labeled in the backtest
  caveats, never silently interpolated.
- Flow records are 2024 annual snapshots; playback re-evaluates events,
  propagation and observation selection over time, but flow tonnage itself is
  not yet time-resolved. The topology-validity guard makes the mismatch an
  enforced invariant rather than a silent error: evaluations predating the
  flow period return null tonnage with the mismatch named, later evaluations
  use the snapshot as labeled, quantified latest-known structure, and the
  playback panel banners both. The capability consequence, stated plainly:
  **five of the six backtest truth-set disruption events (Escondida 2017,
  Grasberg halt 2017, Chuquicamata 2019, Peru 2020, Las Bambas 2022)
  predate the topology — historical propagation over the curated record is
  structural reach only, with null tonnage, until flow vintages land.** The
  structural fix is **flow vintages** (several flow periods coexisting, asOf
  selecting among them — the MCS-vintage shape); part of the material
  already exists (Comtrade country-level annual trade, archived and
  knownAt-stamped) and the true blocker is the deferred country↔facility
  allocation model. Backlog slot 4 under the phase-18 ranking
  (evidence-layer search kinds → sec-edgar structural ingest →
  OpenOwnership → flow vintages); the deferral itself is guarded.
- A sanctions-class event traverses both operator and shareholder edges,
  but its exposure number has no declared attribution basis yet — the
  sanctioned party's reach is operator-of-record ∪ material shareholding,
  which is neither pure control nor pure economic interest. Recorded
  UNBUILT in the architecture ledger (Phase 12 §3, Glencore as the named
  test case) behind the ranked instrument backlog.
- The Chinese import gateway is folded into one Shanghai node and several real
  export terminals are folded into nearby major ports (noted in provenance).
- Bottleneck scoring is unvalidated triage; weights are transparent constants.
- The propagation system reports structural exposure; it does not rebalance
  flows or estimate price response.
- Comtrade's public preview rate-limits per IP; the ladder absorbs this but
  fresh trade data may lag until the limiter resets.
