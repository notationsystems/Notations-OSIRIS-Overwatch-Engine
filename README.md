<div align="center">

# ⬡ Payload Terminal V0

### Payload Supply Chain Management — the physical-commerce operating system

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![MapLibre](https://img.shields.io/badge/MapLibre_GL-GPU_Rendered-396CB2?style=for-the-badge)](https://maplibre.org)
[![License](https://img.shields.io/badge/License-GPLv3-D4AF37?style=for-the-badge)](LICENSE)

**A freight and physical-commerce instrument: a provenance-preserving world
state for loads, lanes, carriers and commitments, with every claim carrying
where it came from, when it was known, and what it refuses to say.**

**Payload Terminal** is the operator surface.

</div>

---

## Overview

Payload holds the physical economy as a record rather than a dashboard. Its
core is a canonical world state — entities, observations, flows, capacities,
dependencies, events — in which **every figure carries its provenance, its
basis, and the date it became knowable**, and in which a question the data
cannot answer returns a typed refusal with a remedy instead of a zero.

That discipline is the product. A mean computed over a partition that does
not exist, a residual that silently drops the half of the book with no
settlement, an index whose coverage is unstated — each is a wrong number
that looks exactly like a right one. Payload is built so those cannot be
produced silently.

Two verticals run on the same substrate:

- **Commodities** — copper and aluminium: live acquisition from USGS, UN
  Comtrade, COMEX and CFTC behind a snapshot degradation ladder, a directed
  flow-dependency graph, concentration and bottleneck analytics, and temporal
  playback that re-evaluates the world at any past knowledge state.
- **Freight** — loads, lanes, carriers, commitments and outcomes: an
  append-only book, lane residuals with a minimum-trials floor, three-state
  carrier vetting, and an exception queue where two claims about one movement
  disagree.

See [`docs/PHYSICAL_ECONOMY.md`](docs/PHYSICAL_ECONOMY.md) and
[`docs/ARCHITECTURE_LEDGER.md`](docs/ARCHITECTURE_LEDGER.md).

### Key Capabilities

| Domain | What it holds | Sources |
|--------|---------------|---------|
| **Physical economy** | Entities, observations, flows, capacities, dependencies | USGS MCS, UN Comtrade, curated topology |
| **Markets** | Benchmark price, positioning, warehouse stocks | COMEX (Yahoo), CFTC COT, LME via Westmetall |
| **Freight book** | Loads, quotes, invoices, transit, appointments | Operator entry, append-only ledger |
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
│                 PAYLOAD TERMINAL                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ MapLibre  │  │ Evidence │  │ Operations    │ │
│  │  GL (GPU) │  │ Panels   │  │ Queue         │ │
│  │  WebGL    │  │ Refusals │  │ Exceptions    │ │
│  │  Render   │  │ Vintages │  │ Vetting       │ │
│  └──────────┘  └──────────┘  └───────────────┘ │
├─────────────────────────────────────────────────┤
│               NEXT.JS API ROUTES                 │
│  /api/economy/*   state, search, table, guards, │
│                   refusals, scenario, validate  │
│  /api/directions  /api/geo      /api/geosearch  │
│  /api/maritime    /api/weather  /api/markets    │
│  /api/infrastructure            /api/news       │
│  /api/osint/*  (whois, dns, ip, certs, bgp,     │
│                 mac, threats, sanctions)        │
│                 — organisational attribution     │
├─────────────────────────────────────────────────┤
│              EXTERNAL DATA SOURCES               │
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
cp .env.template .env     # optional — configure keys / port
docker compose up -d
```

The image is a multi-stage `node:22-alpine` standalone build (non-root). See
**[DOCKER.md](DOCKER.md)** for the full guide.

**Custom port** — the container always listens on `3000`; set `PAYLOAD_PORT`
in `.env` to change the published host port.

### Environment Variables

Payload works **partially without any API keys** — the core feeds use public,
keyless sources. Copy [`.env.template`](.env.template) to `.env` and set only
what you need:

```env
# Published host port (container always listens on 3000). Default: 3000
PAYLOAD_PORT=3000

# Force every source to its snapshot rung (visible in provenance, never silent)
PAYLOAD_DISABLE_LIVE=

# Authorize persistent freight-operation commands; leave empty to disable the API
PAYLOAD_OPERATIONS_TOKEN=
PAYLOAD_OPERATIONS_LOG=./data-archive/load-operations.jsonl

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
Both require `Authorization: Bearer <PAYLOAD_OPERATIONS_TOKEN>`. The dispatch
step records an authorized operational event; it does not contact a carrier.
Run the journal on persistent, backed-up storage with one application writer.

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
