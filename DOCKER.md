# Self-Hosting Payload Terminal with Docker

Payload Terminal ships as a self-contained Next.js standalone build. This guide covers
running it with Docker / Docker Compose, deploying it as a [CasaOS](https://casaos.io)
app, and configuring the optional API keys.

> **TL;DR:** Payload Terminal's public map feeds run **without API keys**. All core feeds
> (aviation, satellites, fires, earthquakes, weather, news, CVEs) use public
> keyless sources. Private operations and corpus administration intentionally
> fail closed until their dedicated credentials are configured.

---

## 1. Docker Compose (recommended)

```bash
git clone https://github.com/simplifaisoul/osiris.git
cd payload

# optional: configure freight authority, carrier integration, and feed keys
cp .env.example .env        # then edit .env

docker compose up -d
```

Open <http://localhost:3000>.

What the compose file does:

- **`build:`** — compose builds the image locally from the `Dockerfile`, so
  you always run the code you just cloned. To run the prebuilt registry image
  instead, add `image: ghcr.io/simplifaisoul/osiris:latest` to the `payload`
  service and drop the `build:` block.
- **`env_file: .env` (`required: false`)** — if a `.env` file exists its
  values are injected into the container; if it's missing, Payload Terminal still starts
  with the keyless feeds.
- **`ports: ${PAYLOAD_PORT:-3000}:3000`** — the web UI. The container always
  listens on 3000; the published **host** port is `PAYLOAD_PORT` (default
  `3000`). Set `PAYLOAD_PORT` in `.env` to remap it, e.g. `PAYLOAD_PORT=3005`
  when 3000 is already in use — no need to edit the compose file.
- **`payload-runtime` volume** — persists canonical corpus/operations state,
  the disposable corpus read model, and hash-chain journals across image
  rebuilds and container replacement. Back up canonical state and operating
  evidence; the read model can be rebuilt.
- **`restart: unless-stopped`** — survives reboots.

Common commands:

```bash
docker compose logs -f          # follow logs
docker compose up -d --build    # rebuild locally after pulling new code
docker compose down             # stop & remove
```

### Pull the prebuilt image from GHCR

A prebuilt image for `linux/amd64` and `linux/arm64` is published to the GitHub
Container Registry on every push to `master` and every `v*.*.*` tag, so you can
run Payload Terminal without building anything:

```bash
docker pull ghcr.io/simplifaisoul/osiris:latest   # or a pinned tag, e.g. :0.1.0
docker run -d --name payload \
  -p 3005:3000 --env-file .env --restart unless-stopped \
  -v payload-runtime:/app/runtime-data \
  -e PAYLOAD_OPERATIONS_LOG=/app/runtime-data/load-operations.jsonl \
  -e PAYLOAD_CARRIER_COMMUNICATIONS_LOG=/app/runtime-data/carrier-communications.jsonl \
  ghcr.io/simplifaisoul/osiris:latest
```

The package is public — no `docker login` is required to pull it.

### Plain `docker run`

```bash
docker build -t payload:latest .
docker run -d --name payload -p 3000:3000 --env-file .env --restart unless-stopped \
  -v payload-runtime:/app/runtime-data \
  -e PAYLOAD_OPERATIONS_LOG=/app/runtime-data/load-operations.jsonl \
  -e PAYLOAD_CARRIER_COMMUNICATIONS_LOG=/app/runtime-data/carrier-communications.jsonl \
  payload:latest
```

### Image details

Multi-stage build on `node:22-alpine`, runs as a non-root user (`nextjs`,
uid 1001), serves Next.js standalone via `node server.js` on port 3000.
Final image is ~220 MB. Build excludes `node_modules`, `.next`, `.git` and the
repo's large `*.diff` artifacts via `.dockerignore`.

---

## 2. CasaOS

The compose file includes an `x-casaos:` metadata block (title, description,
icon, port map, env descriptions) that plain Docker Compose ignores but CasaOS
reads.

**Install:**

1. On the CasaOS host, clone the repo somewhere persistent (e.g.
   `/DATA/AppData/payload`).
2. CasaOS dashboard → **`+`** → **Install a customized app** → paste the
   contents of `docker-compose.yml`.
   *(or simply run `docker compose up -d` from the cloned directory).*
3. Payload Terminal appears on the dashboard with its icon, reachable on host port
   `3000` (or whatever `OSIRIS_PORT` you set in `.env`).

The app icon is the gold Eye-of-Horus mark in
`public/casaos-icon.png` (512×512 PNG), referenced by the `icon:` URL in the
metadata.

> CasaOS stores imported compose files under `/var/lib/casaos/apps/`, so a
> relative `build:` context may not resolve there. If importing the YAML
> directly, either build/tag `payload:latest` first
> (`docker build -t payload:latest /path/to/payload`) or replace the `build:`
> block with `image: ghcr.io/simplifaisoul/osiris:latest`.

---

## 3. API keys & data sources

Copy `.env.example` to `.env` and fill in only what you need.

### What the code actually reads today

| Variable | Purpose | Required for |
|----------|---------|--------------|
| `SCANNER_URL` | RECON scanner backend base URL (e.g. `http://scanner:7700`) | RECON toolkit (quick/ssl/headers/rdns/subdomains/tech/whois/geoloc/vuln) |
| `SCANNER_KEY` | Shared secret; **must equal the backend's `OSIRIS_KEY`** | RECON toolkit |

Without `SCANNER_URL`/`SCANNER_KEY` the RECON endpoints return `503` and the
rest of Payload Terminal works normally. Generate a key with `openssl rand -hex 32`.

### Optional keys (reserved / for higher rate limits)

These are documented for completeness and forward-compatibility. The current
data routes use **keyless** public feeds, so these are not consumed yet — set
them only if you extend the relevant route or hit rate limits.

| Variable | Service | How to get it (all free) |
|----------|---------|--------------------------|
| `FIRMS_API_KEY` | NASA FIRMS active fires | Enter an email at <https://firms.modaps.eosdis.nasa.gov/api/map_key/> — the `MAP_KEY` is emailed instantly. Limit 5000 req / 10 min. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | OpenSky aviation | Create an account at <https://opensky-network.org/>, open **Account → API client**, create a client and copy id/secret. **OAuth2 only since March 2025** (username/password auth removed). |
| `N2YO_API_KEY` | N2YO satellites | Register at <https://www.n2yo.com/login/register/>, then **Profile → generate API key**. Limit 1000 req / hour; key can't be regenerated. |
| `AIS_API_KEY` | aisstream.io maritime | Sign up at <https://aisstream.io/>, create a key on the **API Keys** page. Used over `wss://stream.aisstream.io/v0/stream`. |

> Keep `.env` out of version control — it is already in `.gitignore`. Only
> `.env.example` (no secrets) is committed.

### Optional runtime overrides

| Variable | Purpose | Default |
|----------|---------|---------|
| `PAYLOAD_PORT` | Host port the compose file publishes (container itself always listens on 3000). `OSIRIS_PORT` is honoured for one release and warns. | `3000` |
| `PAYLOAD_OPERATIONS_TOKEN` | Bearer authority for private freight-operation and carrier-delivery routes. Empty disables them. | none |
| `PAYLOAD_DATABASE_PATH` | Shared SQLite/WAL file for ordered operational events and, by default, corpus records. Use the named runtime volume. | none |
| `PAYLOAD_CORPUS_DATABASE_PATH` | Canonical SQLite/WAL file for the physical-economy corpus. | `/app/runtime-data/physical-economy-corpus.sqlite` in Compose; otherwise `PAYLOAD_DATABASE_PATH` |
| `PAYLOAD_CORPUS_READ_MODEL_PATH` | Separate disposable SQLite/WAL file for the policy-filtered public query projection. | `/app/runtime-data/corpus-public-read-model.sqlite` in Compose |
| `PAYLOAD_CORPUS_INDEX_PATH` | Disposable, build-bound lexical/faceted index over the exact public CorpusBuild. | `/app/runtime-data/corpus-knowledge-index.sqlite` in Compose; otherwise derived beside the read model |
| `PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH` | Durable destination identities, federated record versions, semantic documents, vector projections, acknowledgements, and lag samples. | `/app/runtime-data/notation-substrate.sqlite` in Compose; otherwise derived beside the canonical corpus |
| `PAYLOAD_NOTATION_SOURCE_URL` | HTTP(S) base URL from which the substrate worker pulls authenticated federation pages. | `http://payload:3000` in the Compose worker profile |
| `PAYLOAD_NOTATION_SUBSTRATE_CONSUMER_ID` | Stable upstream checkpoint identity for this destination worker. | `primary-fabric` |
| `PAYLOAD_NOTATION_SUBSTRATE_PAGE_LIMIT` | Records per verified destination transaction, from 1 to 500. | `100` |
| `PAYLOAD_NOTATION_SUBSTRATE_POLL_MS` | Idle polling interval for the worker, from 1000 to 60000 ms. | `5000` |
| `PAYLOAD_CORPUS_INGEST_TOKEN` | Dedicated bearer authority for immutable corpus append and raw cursor replay. | none |
| `PAYLOAD_CORPUS_COMPILER_TOKEN` | Separate least-privilege bearer authority for read-model compilation and manifest inspection. | none |
| `PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH` | Separate append-only SQLite/WAL registry for mined candidate knowledge and mining-run provenance. | `/app/runtime-data/corpus-pattern-registry.sqlite` in Compose |
| `PAYLOAD_CORPUS_MINER_TOKEN` | Dedicated bearer authority for mining a current public CorpusBuild and replaying the Pattern Registry. | none |
| `PAYLOAD_CORPUS_QUERY_TOKEN` | Dedicated bearer authority for bounded ContextPackage compilation. | none |
| `PAYLOAD_CORPUS_PROJECTOR_TOKEN` | Dedicated bearer authority for outbox consumption and monotonic checkpoints. | none |
| `PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH` | Append-only SQLite/WAL journal for persistent agent results and CorpusBuild attestations. Derived beside `PAYLOAD_CORPUS_DATABASE_PATH` when omitted. | derived |
| `PAYLOAD_CORPUS_CONTROL_STALE_AFTER_MS` | Freshness window used by the Payload physical-economy control view before a projection is reported stale. | `86400000` (24 hours) |
| `PAYLOAD_CORPUS_AGENT_DATABASE_URL` | Optional PostgreSQL connection for the migration-2 RLS agent-artifact journal; otherwise the capability-specific corpus URL is reused. | none |
| `PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH` | Protected mounted Ed25519 PKCS#8 PEM used only by the compiler boundary to sign exact CorpusBuild commitments. | none/signing disabled |
| `PAYLOAD_CORPUS_ATTESTATION_KEY_ID` | Optional deployment guard; when set it must equal the public-key-derived `notation:ed25519:<sha256>` identity. | derived |
| `PAYLOAD_CORPUS_QUERY_DATABASE_URL` | PostgreSQL query-role connection; when set, replaces SQLite for canonical reads. | none |
| `PAYLOAD_CORPUS_INGEST_DATABASE_URL` | PostgreSQL ingest-role connection. | none |
| `PAYLOAD_CORPUS_PROJECTOR_DATABASE_URL` | PostgreSQL projector-role connection. | none |
| `PAYLOAD_CORPUS_COMPILER_DATABASE_URL` | PostgreSQL compiler-role connection. | none |
| `PAYLOAD_CORPUS_TENANT_ID` | Tenant bound into transaction-local PostgreSQL RLS context. | none/global-only |
| `PAYLOAD_CORPUS_ALLOW_GLOBAL_WRITE` | Explicitly permits global PostgreSQL ingest/checkpoint writes. | `false` |
| `PAYLOAD_CORPUS_POSTGRES_SSL` | PostgreSQL transport policy: `require` or `disable`. | driver/URL default |
| `PAYLOAD_OPERATIONS_LOG` | Append-only load-operation journal. Compose places it on `payload-runtime`. | `data-archive/load-operations.jsonl` outside Compose |
| `PAYLOAD_CARRIER_COMMUNICATIONS_LOG` | Append-only delivery, receipt, acknowledgement, and tracking journal. | `data-archive/carrier-communications.jsonl` outside Compose |
| `PAYLOAD_CARRIER_DISPATCH_URL` | Provider-neutral HTTPS endpoint that accepts carrier tenders. | none |
| `PAYLOAD_CARRIER_DISPATCH_TOKEN` | Bearer credential sent only to the configured carrier endpoint. | none |
| `PAYLOAD_CARRIER_DISPATCH_PROVIDER` | Stable identity recorded with delivery evidence. | `carrier-webhook` |
| `PAYLOAD_CARRIER_DISPATCH_TIMEOUT_MS` | Outbound request deadline, clamped to 1–30 seconds. | `10000` |
| `PAYLOAD_CARRIER_WEBHOOK_SECRET` | HMAC secret for inbound `/api/freight/carrier-events`; at least 32 random bytes. | none |

After classified corpus records are ingested, an administrator publishes the
read model explicitly:

```bash
curl -X POST http://localhost:3000/api/corpus/projections \
  -H "Authorization: Bearer $PAYLOAD_CORPUS_COMPILER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audience":"public","scope":"global"}'
```

Payload Earth refuses facility queries until this succeeds, and refuses again
if canonical global state advances without a rebuild. Do not back up the read-
model file as an authority; recreate it from the canonical corpus.

Build the matching retrieval index after each successful projection compile:

```bash
curl -X POST http://localhost:3000/api/corpus/index \
  -H "Authorization: Bearer $PAYLOAD_CORPUS_COMPILER_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

The index is also disposable. It persists on the runtime volume for restart
speed, but Payload refuses it whenever its CorpusBuild or projection digest is
stale. Notation Data Substrate workers use `GET/POST /api/corpus/federation`
with the projector token to consume `notation://` sync envelopes and commit
monotonic consumer checkpoints.

Start the separately packaged worker after configuring
`PAYLOAD_CORPUS_PROJECTOR_TOKEN`:

```bash
docker compose --profile substrate up -d --build
```

The worker and Payload API share only the named `payload-runtime` volume. The
worker writes the destination database; `/api/corpus/substrate` and the control
view inspect it. A failed upstream checkpoint never rolls back an already
committed destination page: the next cycle retries that exact checkpoint before
pulling again. Back up the substrate database; unlike the disposable public
read model and lexical index, it contains acknowledgement and lag history.

The derived agent-artifact SQLite file is authoritative operational evidence and
must remain on `payload-runtime` or another backed-up volume. For build signing,
mount the private PEM read-only outside the image and point
`PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH` at that mount. Never put the key in
`.env`, an image layer, the repository, or the public read-model database.

Corpus Compiler `1.2.0` binds the PayloadOS engine, Payload product and
`payload.corpus-definition.physical-economy.v1` fingerprint into representation
specification `payload.corpus.public-read-model.v3`. After upgrading from v2,
run `npm run rebuild:corpus-projection`; the tool archives the recognized old
read-model database and builds v3. Do not remove the canonical corpus database.

With the public build current, the miner can register explicit shared-dependency
candidates:

```bash
curl -X POST http://localhost:3000/api/corpus/mining/dependencies \
  -H "Authorization: Bearer $PAYLOAD_CORPUS_MINER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"depth":1,"minimumDependents":2}'
```

The Pattern Registry belongs on the persistent runtime volume. It is not a
canonical knowledge store: deleting it loses mining history, while deleting a
read model only requires recompilation. Back up the registry if candidate and
validation history matter operationally. V0 writes candidates only; validation
and canonical promotion remain separate future authorities.

### Keyless sources (no configuration needed)

Aviation → `adsb.lol` · Satellites → `celestrak.org` (TLE) · Fires →
NASA FIRMS open-data CSV · Earthquakes → USGS · Weather → NASA EONET · Space
weather → NOAA SWPC · CVEs → NVD · News → public RSS / HLS streams · CCTV →
public traffic-authority feeds · OFAC SDN sanctions → [OpenSanctions](https://www.opensanctions.org)
mirror (CC-BY 4.0) · infrastructure attribution (DNS, WHOIS, RDAP, RIPE Stat).
