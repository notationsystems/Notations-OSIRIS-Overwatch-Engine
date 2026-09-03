<div align="center">

# ⬡ Payload Terminal V0

### Payload — physical-economy intelligence, built by PayloadOS

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![MapLibre](https://img.shields.io/badge/MapLibre_GL-GPU_Rendered-396CB2?style=for-the-badge)](https://maplibre.org)
[![License](https://img.shields.io/badge/License-GPLv3-D4AF37?style=for-the-badge)](LICENSE)

**A high-integrity computational corpus of the physical economy: organizations,
facilities, materials, processes, networks and markets, with every answer
carrying where it came from, when it was known, and what it refuses to say.**

**Payload Earth** is the visual query surface. **Payload Terminal** is the human
evidence and domain-workflow surface.

</div>

---

## Overview

Notation Systems uses its internal **PayloadOS** corpus machinery to build
**Payload**, a high-integrity computational corpus of the physical economy.
Payload exposes evidence-bearing spatial queries, APIs, intelligence products
and agent context. Its core is a canonical world state in which **every claim
carries its provenance, basis and knowledge time**, and in which a question the
data cannot answer returns a typed refusal with a remedy instead of a zero.

That discipline is the product. A mean computed over a partition that does
not exist, a residual that silently drops the half of the book with no
settlement, an index whose coverage is unstated — each is a wrong number
that looks exactly like a right one. Payload is built so those cannot be
produced silently.

The Payload corpus spans `companies → facilities → commodities → suppliers →
trade → logistics → ports → vessels → infrastructure → markets → flows →
events`. The freight, procurement, commercial and project-logistics
systems remain maintained domain capability over the same epistemic discipline:

- **Commodities** — copper and aluminium: live acquisition from USGS, UN
  Comtrade, COMEX and CFTC behind a snapshot degradation ladder, a directed
  flow-dependency graph, concentration and bottleneck analytics, and temporal
  playback that re-evaluates the world at any past knowledge state.
- **Freight** — loads, lanes, carriers, commitments and outcomes: an
  append-only book, lane residuals with a minimum-trials floor, three-state
  carrier vetting, and an exception queue where two claims about one movement
  disagree.
- **Procurement and physical positions** — requirements, evidenced supplier
  quotes, five-check qualification, frozen feasible sets, purchase contracts,
  logistics requirements, receipt condition, landed cost and margin. Operate
  the workflow at `/procurement`.
- **Inventory and commercial positions** — procurement-origin lots, customer
  commitments, reservation without oversell, sale contracts, freight-bound
  fulfillment, delivery, settlement and margin exposure. Operate the workflow
  at `/commercial`.
- **Specialized project logistics** — canonical high-value assets, multimodal
  journeys, permits, custody, condition telemetry, exception remedies, delivery
  verification, and project profitability. Operate the workflow at `/projects`.

See the [`Notation Systems product boundaries`](docs/PRODUCT_BOUNDARIES.md),
[`PayloadOS architecture contract`](docs/PAYLOADOS.md),
[`Physical-Economy Corpus V0`](docs/PHYSICAL_ECONOMY_CORPUS.md),
[`data-platform contract`](docs/DATA_PLATFORM.md),
[`docs/PHYSICAL_ECONOMY.md`](docs/PHYSICAL_ECONOMY.md), and
[`docs/ARCHITECTURE_LEDGER.md`](docs/ARCHITECTURE_LEDGER.md).

### Key Capabilities

| Domain | What it holds | Sources |
|--------|---------------|---------|
| **Physical-economy corpus** | Evidence, identities, aliases, relationships, observations, classification, temporal revisions, compiled read models | Public research + customer-authorized private records |
| **Physical economy** | Entities, observations, flows, capacities, dependencies | USGS MCS, UN Comtrade, curated topology |
| **Markets** | Benchmark price, positioning, warehouse stocks | COMEX (Yahoo), CFTC COT, LME via Westmetall |
| **Freight book** | Loads, quotes, invoices, transit, appointments | Operator entry, append-only ledger |
| **Commercial book** | Inventory lots, customer commitments, allocations, sales, fulfillment | Procurement outcomes, operator entry, append-only ledger |
| **Project cargo** | Constrained assets, journeys, permits, custody, telemetry, remedies, project margin | Operator actions, OTLP sensors, provider adapters, append-only ledger |
| **Lane memory** | Residuals by carrier, lane and season, with a trials floor | Derived, admissibility-stamped |
| **Carrier vetting** | Three-state verdicts: cleared, blocked, undetermined | Regulator records, insurer confirmation |
| **Routing** | Truck-legal mileage, geocoding, basemap | Valhalla / OSRM profiles, Nominatim |
| **Maritime** | Ports, chokepoints, the ocean leg | Static naval reference |
| **Weather & air quality** | Transit risk, seasonal detention | NASA EONET, open air-quality feeds |
| **Infrastructure attribution** | Whose domain, whose network, whose ASN | RDAP, DoH, RIPE Stat, crt.sh |
| **Sanctions screening** | Counterparty organisations, vessels, aircraft | OpenSanctions (US OFAC SDN mirror) |
| **Disruption events** | News and wire signals against lanes | Broadcast and wire feeds |

---

<!-- collection-policy:begin -->
## Collection policy

Payload is being built for a firm that will hold carrier, driver and customer
personal information. What the application is allowed to collect is therefore
part of its design, not a footnote to it.

**Prohibited, and removed from this tree:** username enumeration across
platforms, breach-corpus lookup by email address, infostealer credential
corpora, phone-number research, and host or port scanning. These were present
in the upstream project this fork began from. They are deleted — code, routes,
UI and client libraries — rather than disabled or feature-flagged, because a
feature-flagged breach lookup is still a breach lookup in the tree and still
in the image.

**Conditional, and permitted only with the condition written down:** WHOIS,
DNS, IP intelligence, certificate transparency, BGP/ASN and MAC-prefix
lookup. Each states the same constraint in its own source —
*organisational infrastructure attribution only; never used to profile a
person*. A conditional permission with the condition left implicit is an
unconditional permission.

**Permitted:** sanctions screening of counterparty **organisations, vessels
and aircraft**. The person path is not served, and is filtered out of every
result set rather than merely omitted from the schema allowlist.

Three checks hold this in place, and they run in CI:

- the **source registry** refuses to register a source that yields
  natural-person data;
- the **route-surface gate**
  ([`routeSurfacePolicy.test.ts`](src/lib/economy/routeSurfacePolicy.test.ts))
  classifies every route under `src/app/api/**`, fails on an unclassified
  one, and scans every route's source for a prohibited capability regardless
  of how it is labelled;
- the **shipped-description gate** fails if this README advertises a
  prohibited capability — the description is an artifact and drifts from
  policy like any other.

Registration was never the only door.
<!-- collection-policy:end -->

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    PAYLOADOS                    │
│      INTERNAL CORPUS / MINING / VERIFICATION    │
│        DOMAIN SPECIFICATION → PRODUCT BUILD     │
├─────────────────────────────────────────────────┤
│             PAYLOAD — PRODUCT CORPUS            │
│  Evidence · Identity · Ontology · Classification│
│          CANONICAL STATE — ONE AUTHORITY        │
│ Structured · Artifacts · Analytics · Spatial    │
├─────────────────────────────────────────────────┤
│      CORPUS COMPILER → REBUILDABLE READ MODELS  │
│  Relational · Graph · Spatial · Vector · Search │
├─────────────────────────────────────────────────┤
│      PAYLOADOS MINER → CANDIDATE KNOWLEDGE      │
│ Dependencies · Patterns · Provenance · Registry │
├─────────────────────────────────────────────────┤
│   IDENTITY · POLICY · RETRIEVAL · CONTEXT · PROOF│
├─────────────────────────────────────────────────┤
│          PAYLOAD EARTH / API / TERMINAL          │
│  /api/corpus/* query + compile + linear replay  │
│  /api/economy/*   state, search, table, guards, │
│                   refusals, scenario, validate  │
│  /api/directions  /api/geo      /api/geosearch  │
│  /api/maritime    /api/weather  /api/markets    │
│  /api/infrastructure            /api/news       │
│  /api/osint/*  (whois, dns, ip, certs, bgp,     │
│                 mac, threats, sanctions)        │
│                 — organisational attribution     │
├─────────────────────────────────────────────────┤
│       DOMAIN LENSES + EXTERNAL DATA SOURCES      │
│  USGS · UN Comtrade · CFTC · COMEX · LME        │
│  NASA EONET · OpenSanctions · RDAP · RIPE Stat  │
└─────────────────────────────────────────────────┘
```

---

## Features

### The record, not the dashboard
- **Provenance on every claim** — source, method, and `knownAt` distinct from
  the period the figure describes
- **Typed refusals with remedies** — an unanswerable question returns what is
  missing and who would know, never a zero
- **Null, not zero** — in every cell, every colour ramp, every empty collection
- **Coverage annotation travels with every index** — an unstated population is
  an unusable number
- **Temporal playback** — re-evaluate the world at any past knowledge state:
  *what did we know when we priced it* is the bid post-mortem

### Freight operations
- **Append-only book** — a mistake is superseded by a later entry naming what
  it replaces; both stay readable
- **Lane residuals** with a minimum-trials floor — below it, `n` is reported
  and no estimate is offered
- **Seasonal partition** — a lane running long in winter and on time in summer
  has an annual mean that describes neither mode
- **Three-state carrier vetting** — cleared, blocked, and *undetermined*,
  which is not a pass and not a failure
- **Exception queue** — loads where the tender and the bill of lading name
  different carriers, with uncaptured bills of lading surfaced rather than
  counted clean
- **Persistent operating loop** — opportunity intake, carrier alternatives,
  authorization, assignment, dispatch delivery, acknowledgement, tracking,
  settlement, and outcome capture remain replayable after restart
- **Control-tower workspace** — `/operations` joins those durable records into
  an exception-first desk queue with exact load/carrier/lane identity,
  deadlines, evidence counts, and explicit operator remedies
- **Typed operator cockpit** — every straight-through load step in
  `/operations` is a guided action. The server derives journal identities and
  exact load/carrier/message bindings; the browser never constructs a raw
  workflow command
- **Procurement cockpit** — source, qualify, select, buy, move, receive, and
  settle a physical position without hand-building event-store commands

### Commodity analytics
- Concentration (HHI with remainder and effective groups), flow centrality,
  candidate bottlenecks, anomaly signals and event propagation
- Divergence records where two sources disagree about one quantity
- A degradation ladder from live acquisition down to committed snapshots,
  visible in provenance and never silent

### Infrastructure attribution
- **DNS** (DoH), **WHOIS/RDAP**, **certificate transparency**, **IP + ASN**,
  **BGP**, **MAC OUI** — all scoped to organisational attribution
- WHOIS and IP-intel cross-check registrant and ASN-owner names against the
  OFAC SDN list and surface an inline alert

---

## Quick Start

```bash
git clone https://github.com/notationsystems/notations-osiris-overwatch-engine.git
cd notations-osiris-overwatch-engine
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

Run the checks:

```bash
npm test          # vitest, including the policy gates
npx tsc --noEmit  # types
```

### Docker / Self-Hosting

```bash
cp .env.example .env     # optional — configure keys / port
docker compose up -d
```

The image is a multi-stage `node:22-alpine` standalone build (non-root). See
**[DOCKER.md](DOCKER.md)** for the full guide.

**Custom port** — the container always listens on `3000`; set `PAYLOAD_PORT`
in `.env` to change the published host port.

### Environment Variables

Payload works **partially without any API keys** — the core feeds use public,
keyless sources. Copy [`.env.example`](.env.example) to `.env` and set only
what you need:

```env
# Published host port (container always listens on 3000). Default: 3000
PAYLOAD_PORT=3000

# Force every source to its snapshot rung (visible in provenance, never silent)
PAYLOAD_DISABLE_LIVE=

# Authorize persistent freight-operation commands; leave empty to disable the API
PAYLOAD_OPERATIONS_TOKEN=
PAYLOAD_OPERATIONS_LOG=
PAYLOAD_DATABASE_PATH=

# Physical-economy corpus; falls back to PAYLOAD_DATABASE_PATH when omitted
PAYLOAD_CORPUS_DATABASE_PATH=
# Disposable policy-filtered read model used by public corpus queries
PAYLOAD_CORPUS_READ_MODEL_PATH=
# Dedicated research-worker authority for append and replay
PAYLOAD_CORPUS_INGEST_TOKEN=
# Separate compiler-service authority for read-model publication
PAYLOAD_CORPUS_COMPILER_TOKEN=
# Context Compiler and projection-worker authorities
PAYLOAD_CORPUS_QUERY_TOKEN=
PAYLOAD_CORPUS_PROJECTOR_TOKEN=
# Append-only Pattern Registry and separate miner-service authority
PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH=
PAYLOAD_CORPUS_MINER_TOKEN=

# Optional central PostgreSQL/PostGIS repository (SQLite remains the edge fallback)
PAYLOAD_CORPUS_QUERY_DATABASE_URL=
PAYLOAD_CORPUS_INGEST_DATABASE_URL=
PAYLOAD_CORPUS_PROJECTOR_DATABASE_URL=
PAYLOAD_CORPUS_COMPILER_DATABASE_URL=
PAYLOAD_CORPUS_TENANT_ID=
PAYLOAD_CORPUS_ALLOW_GLOBAL_WRITE=false
PAYLOAD_CORPUS_POSTGRES_SSL=require

# Pull carrier authority/status and the weekly diesel benchmark
FMCSA_WEB_KEY=
EIA_API_KEY=
PAYLOAD_FREIGHT_SOURCE_TIMEOUT_MS=10000

# Outbound carrier adapter and authenticated inbound carrier events
PAYLOAD_CARRIER_DISPATCH_URL=
PAYLOAD_CARRIER_DISPATCH_TOKEN=
PAYLOAD_CARRIER_DISPATCH_PROVIDER=carrier-webhook
PAYLOAD_CARRIER_DISPATCH_TIMEOUT_MS=10000
PAYLOAD_CARRIER_WEBHOOK_SECRET=
PAYLOAD_CARRIER_COMMUNICATIONS_LOG=

# Optional, for higher rate limits (see DOCKER.md for signup links)
FIRMS_API_KEY=                # NASA FIRMS
OPENSKY_CLIENT_ID=            # OpenSky OAuth2
OPENSKY_CLIENT_SECRET=
N2YO_API_KEY=                 # N2YO satellites
AIS_API_KEY=                  # aisstream.io maritime
```

`GET /api/freight/operations` reads the current load-operation projections;
`POST /api/freight/operations` advances opportunity intake, alternatives,
authorization, assignment, dispatch evidence, and settlement outcome capture.
`GET /api/freight/control-tower` joins those projections to tender delivery,
carrier acknowledgements, tracking freshness, delivery windows, and settlement
state. The `/operations` workspace refreshes that private view every 30 seconds
and keeps its bearer credential only in the active browser tab's memory.

`GET /api/freight/operator-actions?operationId=...` resolves the actions that
are safe in the load's current durable phase. `POST /api/freight/operator-actions`
accepts only the cockpit's discriminated business intents: create opportunity,
add quote, authorize, freeze the decision set, assign, dispatch, send tender,
record carrier response/tracking, and capture settlement. Event IDs, evidence
IDs, episode IDs, selected load IDs, and carrier-message bindings are derived
server-side. Extra raw journal fields are rejected. This route uses the same
operations bearer token.

`GET /api/corpus/facilities?q=polypropylene%20production` is the first public,
read-only computational corpus endpoint. It reads only the separate,
policy-filtered `public:global` read model—never canonical write tables—resolves
canonical material IDs or explicit aliases, returns evidence-linked producing
facilities, and carries a proof-shaped answer warrant. The warrant binds
canonical identities, evidence hashes, computation digests, uncertainty,
joined information-flow policy, and a privacy-safe corpus-build identity. It
also carries a `payload.verification-envelope.v1` and a score-free
`payload.corpus.warrant-graph.v1`. Every basis record has a deterministic
Merkle inclusion proof against the exact public CorpusBuild; the envelope says
`REPRODUCIBLE`, not `ATTESTED` or `ZK_VERIFIED`, until an independent signature
or SP1 proof actually exists. The result becomes a dedicated facility layer on
Payload Earth, where operators can open the Warrant Graph and walk from answer
to computation, records, evidence, named source, build, and commitment.
`GET /api/corpus/warrants?entityId=...` provides the same bounded graph under
`PAYLOAD_CORPUS_QUERY_TOKEN` for any entity or exact record in the current
public projection. Supporting, qualifying, and contradictory evidence remain
separate edges; no composite trust score is calculated.
`POST /api/corpus/projections` deterministically rebuilds that read model;
stale projections are refused. Every build is version-bound to canonical
state, schema, ontology, policy, compiler, embedding and representation spec.
Compilation requires `PAYLOAD_CORPUS_COMPILER_TOKEN`; append and cursor replay
require `PAYLOAD_CORPUS_INGEST_TOKEN`. The credentials are intentionally not
interchangeable. Exact replay/recompilation is idempotent and changed immutable
record IDs are refused. See
[`docs/PHYSICAL_ECONOMY_CORPUS.md`](docs/PHYSICAL_ECONOMY_CORPUS.md).

The canonical corpus now preserves the full evidence-to-state boundary:
immutable artifact evidence → source-bounded Evidence IR unit → observation →
canonical assertion. Evidence units carry typed document/record/telemetry/GIS/
image/email/EDI locators plus extractor identity, version, confidence and
content hash. Assertions are separately versioned interpretations and must cite
compatible observations with `supports`, `contradicts`, or `qualifies` roles.
`POST /api/corpus/retrieval` uses `PAYLOAD_CORPUS_QUERY_TOKEN` to return a
deterministic retrieval plan and an evidence-complete, projection-bound
`payload.corpus.context-package.v1`; models never receive direct database or
vector-store access. With `mode: "agent"`, the same endpoint compiles a
`notation.agent-context.v1` under a typed evidence budget: `FAST` returns
compact canonical state, `GROUNDED` adds source references, `AUDIT` adds exact
observations, disagreements, Evidence IR and retrieval trace, and `VERIFIED`
adds the Warrant Graph plus locally checked CorpusBuild inclusion proofs. These
tiers change disclosure, never the underlying assertion identity. A verified
budget still reports the actual assurance level. Agent responses are now
appended to one persistent, hash-chained artifact journal and return a stable
`resultId`; `GET /api/corpus/retrieval?resultId=...` retrieves the exact saved
plan, context, and spatial result. The spatial result carries OGC:CRS84 GeoJSON
plus deterministic `fields`/`rows` datasets ready for kepler.gl's
`addDataToMap` action. Renderer edits never mutate canonical state.

`POST /api/corpus/attestations` signs the exact current CorpusBuild commitment
with a protected Ed25519 key and stores the signature in the same linearized
journal. A matching signature elevates `VERIFIED` from `REPRODUCIBLE` to
`ATTESTED`; the response still states that signer-clock time is not an
independent timestamp and that the signature does not establish source truth.
The ceremonially pinned SP1 `payload_event_batch_v1` program remains the first
production zkVM boundary and proves authorized operational event batches only.
It is explicitly marked as not applicable to corpus-build attestations, so
corpus answers remain `zkProof: NOT_GENERATED`.

`npm run mcp` now serves eight agent-native corpus tools alongside the twelve
legacy analytical tools: query and persist a context, retrieve a result, walk
its warrant, inspect its build attestation, search the exact build-bound index,
inspect typed index coverage, inspect Payload's own physical-economy control
state, and inspect the durable Notation destination. `GET/POST /api/corpus/index` atomically builds and queries a
disposable SQLite/WAL index with lexical, entity, relation, source, temporal,
and spatial facets. Search rank is not a trust score; coverage gaps are typed
as unobserved. `GET /api/corpus/control-plane` derives a live
topology, capability/approval state, immutable event timeline, current Kepler
dock input, index/federation state, and operator healthy/stale/blocked/unobserved
queues from the real corpus stack. Destination ingestion and acknowledgement
lag are observed from its journal; other latency and cost remain typed
`UNOBSERVED` until instrumented;
artifact events explicitly report that nothing was dispatched. `GET/POST
/api/corpus/projectors` exposes the transactional
projection outbox and monotonic checkpoints under the non-interchangeable
`PAYLOAD_CORPUS_PROJECTOR_TOKEN` worker identity.

`GET/POST /api/corpus/federation` is the Payload → Notation Data Substrate
sync seam. It emits ordered, build-bound public records as content-addressed
`notation://` envelopes and records monotonic per-consumer checkpoints. This
creates one logical identity space across systems without turning the Notation
substrate or Nodes into a second mutable source of Payload truth. Private and
internal channels now have explicit, separately entitled contracts and remain
refused until their governed projection compilers exist. The substrate worker
verifies each envelope, enforces global identity collision rules, persists a
hash-chained destination acknowledgement and lag sample, and builds a
deterministic semantic document. `/api/corpus/substrate` supports exact
model/version vector projection and cosine search without presenting similarity
as confidence or truth.

Successful corpus writes now include a deterministic Corpus Builder manifest
bound to the Payload product ID, physical-economy CorpusDefinition fingerprint,
and committed record hashes. Its scope is deliberately
`CANONICAL_WRITE_ONLY`: upstream discovery, acquisition, extraction, and review
remain separate attestations. `POST /api/corpus/mining/dependencies` runs the
first deterministic PayloadOS Miner algorithm over a current public Payload
CorpusBuild.
It detects shared fan-in only among explicit depth-1 `depends_on` records and
stores evidence- and policy-linked `CANDIDATE` objects in a separate append-only
Pattern Registry. It never promotes a pattern into canonical state. The route
requires `PAYLOAD_CORPUS_MINER_TOKEN`; neither ingestion nor compiler authority
can invoke it.

See [`docs/AGENT_CONTEXT_PRODUCTION.md`](docs/AGENT_CONTEXT_PRODUCTION.md) for
the artifact journal, signing ceremony, MCP package, and kepler.gl integration,
and [`docs/KNOWLEDGE_SUBSTRATE.md`](docs/KNOWLEDGE_SUBSTRATE.md) for the adopted
knowledge-substrate contract and SQLite-edge → PostgreSQL/PostGIS-central
migration boundary.

The central boundary is implemented. Apply the checksum-pinned PostGIS/RLS
migration with a privileged CLI-only URL, dry-run exact replay, apply it only
to an empty target, and rebuild the disposable v3 public projection:

```bash
PAYLOAD_CORPUS_MIGRATION_DATABASE_URL=postgresql://... npm run migrate:corpus-postgres
PAYLOAD_CORPUS_REPLAY_DATABASE_URL=postgresql://... npm run replay:corpus-postgres -- --knowledge-cutoff=2026-09-02T00:00:00.000Z
PAYLOAD_CORPUS_REPLAY_DATABASE_URL=postgresql://... npm run replay:corpus-postgres -- --apply --knowledge-cutoff=2026-09-02T00:00:00.000Z
npm run rebuild:corpus-projection -- --knowledge-cutoff=2026-09-02T00:00:00.000Z
```

Replay preserves the original global sequence, per-scope hash chains, record
hashes and transactional outbox identities. Cutover is refused unless exact
canonical and per-scope projection digests agree. A v2 read model is moved to
a timestamped sibling archive before v3 is built; canonical state is never
deleted by the rebuild tool. Use a CLI-only replay login granted
`payload_corpus_owner`; never expose the migration or replay URL to the web
process.

For a single retrievable operational timeline, configure
`PAYLOAD_DATABASE_PATH`. All domain streams then use one SQLite database in
WAL mode: operation, carrier-communication, procurement, commercial, and project-cargo hash chains remain independently
verifiable, while every committed event also receives one global sequence.
`GET /api/freight/event-ledger` pages that sequence by cursor and may filter by
operation or stream. Existing JSONL deployments migrate once, before enabling
the database:

```bash
PAYLOAD_DATABASE_PATH=/app/runtime-data/payload.sqlite npm run migrate:operations-db
```

The migration validates every source chain, including `PAYLOAD_PROCUREMENT_LOG`, `PAYLOAD_COMMERCIAL_LOG`, and `PAYLOAD_PROJECT_CARGO_LOG`, refuses a non-empty divergent
destination, and is safe to rerun against an exact completed migration.
`POST /api/freight/proof-batches` freezes the next unbatched sequence range as
a deterministic Merkle root for the asynchronous SP1 `payload_event_batch_v1`
program; it does not put proving on the dispatch path.

`/projects` is the specialized-logistics action cockpit. It registers canonical
cargo and constraint profiles, plans dependent multimodal legs and permits,
records custody/evidence/condition timelines, detects excursions, authorizes
typed remedies, verifies delivery, and reconciles project economics. Sensor
gateways post OTLP/HTTP JSON logs to `/api/projects/telemetry/v1/logs` using the
separate `PAYLOAD_TELEMETRY_TOKEN`. Carrier, EDI, accounting, and payment calls
cross a provider-neutral, idempotent adapter at `/api/projects/integrations`.
See [`docs/PROJECT_CARGO.md`](docs/PROJECT_CARGO.md).
`GET /api/freight/sources?usdot=<number>&carrierId=<internal-id>&includeDiesel=1`
pulls current FMCSA identity/authority/out-of-service evidence and the fixed EIA
weekly U.S. diesel benchmark. It returns a gate-ready `authorizationCarrier`
object, but deliberately leaves cargo insurance expiry and limit null: the
public registry is not a certificate of insurance, and missing coverage never
becomes clearance.
`POST /api/freight/communications` delivers the journal-derived tender to the
configured carrier adapter with a stable `Idempotency-Key`; its corresponding
`GET` exposes delivery and carrier-event projections. These routes require
`Authorization: Bearer <PAYLOAD_OPERATIONS_TOKEN>`.

The carrier adapter must return JSON containing `receiptId` and optionally
`acceptedAt`. It receives only the selected carrier rate and sanitized load
facts—not the shipper target rate or source-message identity. Carriers post
acknowledgements and tracking updates to `/api/freight/carrier-events`, signed
as `HMAC-SHA256(timestamp + "." + rawBody)` using
`PAYLOAD_CARRIER_WEBHOOK_SECRET` (at least 32 random bytes). Run both journals
on persistent, backed-up storage with one application writer; Compose
provisions that volume by default.

FMCSA and EIA keys stay server-side and are never returned, logged in source
errors, or included in evidence identifiers. A partial upstream failure is
reported as a typed source refusal; the API never substitutes a zero, a stale
snapshot, or an inferred compliance pass.

> **Renamed from `OSIRIS_*`.** The old spellings are still read for one
> release and log a deprecation warning naming the replacement, so a running
> deployment does not break on the rename. They stop being read after
> `v0.2.0`.

> `SCANNER_URL` / `SCANNER_KEY` are **gone**. They configured a port-scanning
> backend that has been removed; if they are set in your `.env`, delete them.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5 |
| Map Engine | MapLibre GL JS (WebGL) |
| Animations | Framer Motion |
| Icons | Lucide React |
| Testing | Vitest |

---

## Provenance

This project began as a fork of
[simplifaisoul/osiris](https://github.com/simplifaisoul/osiris), an
open-source situational-awareness dashboard, and retains its map and
rendering foundation. It has since been rebuilt around a
provenance-preserving physical-economy substrate, and the reconnaissance
capabilities that defined the upstream project have been removed under the
collection policy above.

The upstream project is MIT-licensed; that permissive grant remains on the
code inherited from it, and its notice is retained. This project as a whole
is distributed under the GNU GPL v3 — see [LICENSE](LICENSE).

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
