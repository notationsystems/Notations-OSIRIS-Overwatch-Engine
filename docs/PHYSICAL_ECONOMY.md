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
- **geoPrecision** on entities — `exact` / `site` / `city` / `region` / `country`

`Divergence` is the seventh, explicitly derived record: emitted when
resolution discards a claim or a mirror pair disagrees, with claims,
resolvedTo, spread, direction, persistence and class.

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

Adapters are registered, not hard-coded. Five serve copper:

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
  snapshot slice. TTL 30 days.
- **`yahoo-copper-price`** — COMEX HG=F monthly closes (USD/lb, 10 years) on the
  commodity entity; the in-progress month is flagged partial. TTL 12 h.
- **`cftc-positioning`** — CFTC COT managed-money net positioning, weekly, on
  the commodity entity. TTL 12 h.

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
| `concentration` | HHI of mine production (country/mine), refined production, consumption, smelting/refining capacity — each from the latest observation per entity at `asOf`. DOJ bands (<1500 / 1500–2500 / >2500). Never mixes entity kinds in one calculation. Includes the **concentration trajectory**: HHI recomputed per year from that year's own observations (years with too few reporters are dropped, not fabricated). |
| `centrality` | Material throughput per node (in + out, kt/y) and network share. |
| `bottlenecks` | **Candidate** bottleneck score: 0.35·throughput share + 0.25·utilization (flow vs stated capacity) + 0.25·redundancy (alternatives at same stage) + 0.15·dependency load. Explicitly a triage signal, not validated risk; every score exposes its components, explanation and evidence ids. Countries/regions are excluded (aggregates are not chokepoints). |
| `anomalies` | Rolling z-score vs trailing window + period-over-period rate of change on every (entity, metric) series with enough points. Series resolve one observation per period by evidence rank before detection (provider disagreement is never a time step). The continuous front-month price series is excluded (roll discontinuities are contract artifacts, not moves); positioning signals are tagged `financial_positioning` and rendered as reflexive market context, never physical evidence. |
| `coverage` | Facility-model coverage per country: rolled-up facility observations ÷ the country's own observation. ≈1 complete, <1 the unmodelled share, >1 a contradiction. This is the standing integrity check that keeps facility- and country-level populations from ever being conflated — they meet only here, explicitly, as a ratio. |
| `divergence` | Observer disagreement kept as evidence: multi-provider conflicts (revision lag / coverage / unexplained) and **Comtrade mirror pairs** — exporter- vs importer-declared weights of the same bilateral flow. Persistent directional gaps are the standard route to transshipment and misreporting findings; the current data surfaces the well-known Chilean concentrate reporter-side suppression (Chile declares ~2.1 Mt gross to China; China records ~8.4 Mt from Chile) and a −25% DRC→China refined gap consistent with Dar/Durban re-attribution. An anomaly says the world moved; a divergence says the observers disagree — the two never share a ranking. |
| `propagation` | Event → state change at `asOf`: disrupted flow volume, downstream entities within N hops, spare capacity at same-stage peers, declared dependents. Distinguishes events live at the evaluation date from historical context. |

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

Research workflow this supports end-to-end: open OSIRIS → copper layers →
producing regions → processing/refining structure → flows → select a node →
inspect state → traverse dependencies → concentration → candidate bottlenecks →
inspect supporting evidence.

## Testing

70+ economy tests among the repo's 430 (`npm test`):

- schema/validation (`types.test.ts`), store assembly + provenance discipline +
  adapter-failure degradation (`store.test.ts`), flow direction/traversal/cycles
  (`graph.test.ts`), hand-computable HHI + as-of selection + trajectory +
  centrality + deterministic bottlenecks + anomaly detection (`analytics.test.ts`),
  event propagation + engine lifecycle (`propagation.test.ts`), live-adapter
  parsers against committed real captures + evidence-ranking integration
  (`liveAdapters.test.ts`), API data contracts incl. temporal/timeline/graph
  views (`route.test.ts`).
- Synthetic fixture (`fixtures.ts`): a 2-mine → port → smelter → demand chain with
  hand-computable numbers (80/20 split → HHI 6800, etc.).
- Tests are hermetic: live fetches are disabled under vitest; parsers run on the
  committed snapshots.

## Known limitations

- One commodity (copper). The adapter registry, engine and UI are
  commodity-agnostic; a second commodity needs only a dataset + adapter.
- Comtrade bilateral rows are not yet materialized as Flow edges (world totals
  only) — facility-level flows would double-count against country-level trade
  edges without an allocation model.
- Concentrate trade uses gross shipped weight (as reported); copper-content
  conversion would require grade assumptions we refuse to fabricate.
- Flow records are 2024 annual snapshots; playback re-evaluates events,
  propagation and observation selection over time, but flow tonnage itself is
  not yet time-resolved.
- The Chinese import gateway is folded into one Shanghai node and several real
  export terminals are folded into nearby major ports (noted in provenance).
- Bottleneck scoring is unvalidated triage; weights are transparent constants.
- The propagation system reports structural exposure; it does not rebalance
  flows or estimate price response.
- Comtrade's public preview rate-limits per IP; the ladder absorbs this but
  fresh trade data may lag until the limiter resets.
