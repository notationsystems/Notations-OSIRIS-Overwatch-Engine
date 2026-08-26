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

Six identities, never blurred (all in `src/lib/economy/types.ts`):

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
- **geoPrecision** on entities — `exact` / `site` / `city` / `region` / `country`

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

Adapters are registered, not hard-coded; `registerAdapter()` lets tests and future
live providers (trade statistics APIs, exchange stock feeds) plug in without
touching downstream code. Phase 1 ships one adapter:

- **`curated-copper-v1`** — a curated dataset (`src/data/economy/copper.ts`):
  48 geolocated entities (15 mines, 13 smelters, 6 refineries, 8 ports, 5 demand
  regions, infrastructure), 55+ observations, 39 flows, 20 capacities,
  dependencies, and 5 real-world events (Cobre Panamá closure, Kakula flooding,
  Grasberg mud rush, Panama Canal drought, stock drawdown).

**Data honesty:** magnitudes are assembled from public sources (USGS Mineral
Commodity Summaries 2025, ICSG World Copper Factbook, company disclosures) and are
order-of-magnitude faithful, but every record is marked
`valueKind: "representative"` — never `reported`. The store test suite enforces
this. Facility coordinates are approximate and say so via `geoPrecision`. The
exchange-stock series is LME-shaped, not a live feed, and its provenance says so.

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

| System | What it derives |
|---|---|
| `concentration` | HHI of mine production (country/mine), refined production, consumption, smelting/refining capacity. DOJ bands (<1500 / 1500–2500 / >2500). Never mixes entity kinds in one calculation. |
| `centrality` | Material throughput per node (in + out, kt/y) and network share. |
| `bottlenecks` | **Candidate** bottleneck score: 0.35·throughput share + 0.25·utilization (flow vs stated capacity) + 0.25·redundancy (alternatives at same stage) + 0.15·dependency load. Explicitly a triage signal, not validated risk; every score exposes its components, explanation and evidence ids. Countries/regions are excluded (aggregates are not chokepoints). |
| `anomalies` | Rolling z-score vs trailing window + period-over-period rate of change on every (entity, metric) series with enough points. No ML — hand-recomputable. |
| `propagation` | Event → state change: disrupted flow volume, downstream entities within N hops, spare capacity at same-stage peers, declared dependents. Distinguishes live events (window covers today) from historical context. |

## API projections

- `GET /api/economy?commodity=copper&view=map` — geolocated entities (with
  production, capacity, bottleneck score, event count) + coordinate-resolved flows.
- `GET /api/economy?commodity=copper&view=analytics` — all system outputs + events + sources.
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
  toggled off). Clicking an entity opens a popup and the research panel.
- **CommodityPanel** — overview (HHI cards with expandable evidence, bottleneck
  list with score bars, anomaly signals, events, sources) and an entity inspector
  (observations with provenance/valueKind/confidence, capacities, flows, events,
  clickable upstream/downstream dependency trees). Every navigation step keeps the
  evidence one click away.

Research workflow this supports end-to-end: open OSIRIS → copper layers →
producing regions → processing/refining structure → flows → select a node →
inspect state → traverse dependencies → concentration → candidate bottlenecks →
inspect supporting evidence.

## Testing

47 economy tests among the repo's 407 (`npm test`):

- schema/validation (`types.test.ts`), store assembly + provenance + representative-only
  enforcement (`store.test.ts`), flow direction/traversal/cycles (`graph.test.ts`),
  hand-computable HHI + centrality + deterministic bottlenecks + anomaly detection
  (`analytics.test.ts`), event propagation + engine lifecycle (`propagation.test.ts`),
  API data contracts (`route.test.ts`).
- Synthetic fixture (`fixtures.ts`): a 2-mine → port → smelter → demand chain with
  hand-computable numbers (80/20 split → HHI 6800, etc.).

## Known limitations

- One commodity (copper), one curated adapter; no live providers yet.
- Flows are 2024 annual snapshots; no time-series flows or scenario replay.
- The Chinese import gateway is folded into one Shanghai node and several real
  export terminals are folded into nearby major ports (each such fold is noted in
  the record's provenance).
- Bottleneck scoring is unvalidated triage; weights are transparent constants.
- The propagation system reports structural exposure; it does not rebalance flows
  or estimate price response.
- Country-level and facility-level observations coexist; analytics keep them apart
  by entity kind, but facility coverage is partial (majors only).
