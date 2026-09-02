# Physical-Economy Corpus V0

## Product boundary

The corpus is PayloadOS's authoritative information substrate for organizations,
facilities, materials, processes, networks, markets, and geography. It is not a
supplier directory and it is not the legacy copper state copied into a broader
table. It is a durable record of claims, their identities, their evidence, and
when Payload could first have known them.

The first computation is:

```text
find_facilities(material)
  -> resolve canonical material identity or explicit alias
  -> select active produces relationships at asOf
  -> retrieve facility and operator identities
  -> return exact supporting evidence
  -> project resolved coordinates onto Payload Earth
```

If any required link is absent or ambiguous, the computation returns a typed
refusal and a remedy. An empty database is never interpreted as evidence that no
facility exists.

## Immutable records

`payload.corpus.record.v1` has five record types:

| Type | Stable domain identity | Purpose |
| --- | --- | --- |
| `evidence` | `evidenceId` | Archived-artifact digest, source, URL, publication/retrieval time, licence and locator |
| `entity` | `entityId` | Canonical organization, facility, material, process, network, market or geography |
| `alias` | `aliasId` | Explicit, evidenced mapping from a scheme/value to one canonical entity |
| `relationship` | `relationshipId` | Typed, time-bounded edge such as `produces`, `operated_by`, `supplies`, or `depends_on` |
| `observation` | `observationId` | Evidenced metric/value/basis/period attached to one canonical entity |

Every record also has an immutable `recordId`, `knownAt`, optional
`supersedes`, and canonical JSON. Supersession preserves the stable domain
identity, stays inside one visibility scope, names one active prior record, and
must have a strictly later `knownAt`.

## Storage and ordering

`PhysicalEconomyCorpus` uses SQLite in WAL mode with full synchronous writes.
Storage assigns one monotonically increasing `sequence` across all scopes and
maintains an independent SHA-256 chain inside each scope. Opening or reading the
database recomputes canonical record hashes and refuses structural or semantic
tampering.

Configure either:

```env
PAYLOAD_CORPUS_DATABASE_PATH=/app/runtime-data/payload-corpus.sqlite
```

or only `PAYLOAD_DATABASE_PATH` to place the corpus tables beside the existing
operational event tables in one backed-up SQLite file. On Podman/Docker, the
path must live on the named runtime volume, not a host-synchronized OneDrive
folder; SQLite WAL requires ordinary filesystem locking.

Co-location does not collapse the two semantic clocks: `corpus_records.sequence`
orders accepted knowledge records, while `payload_events.sequence` orders
operational events. A later cross-ledger manifest may commit both ranges, but
the system does not currently pretend that two independent sequences are one.

## Scope isolation

- `global` is reusable public-corpus knowledge (`K_G`).
- `customer:<id>` is private customer knowledge (`K_C`).
- Global reads see only global records.
- An authorized customer read composes global plus that exact customer.
- No read path composes two customer scopes.
- `GET /api/corpus/facilities` is public/read-only and hard-coded to `global`;
  supplying a `scope` query parameter cannot expand it.
- Raw append/replay requires the dedicated `PAYLOAD_CORPUS_INGEST_TOKEN`.

## API surfaces

### Visual facility discovery

```http
GET /api/corpus/facilities?q=polypropylene%20production
GET /api/corpus/facilities?q=pe:material:polypropylene&asOf=2026-09-01&knowledgeCutoff=2026-09-01
```

The small intent grammar removes only an explicit suffix such as `production`,
`producer`, `manufacturing`, or `facilities`; identity is still resolved by
canonical ID or an explicit alias. The response includes facility coordinates,
operator, relationship identity, confidence, and exact evidence records. It is
rendered by the Search surface as a dedicated query layer on Payload Earth.

### Administrative ingestion and replay

```http
POST /api/corpus/records
Authorization: Bearer <PAYLOAD_CORPUS_INGEST_TOKEN>
Content-Type: application/json

{"scope":"global","records":[...],"recordedAt":"2026-09-02T12:00:00.000Z"}
```

Records in a batch are ordered: evidence precedes the claims it supports and
entities precede aliases, relationships, and observations. Exact replay is
idempotent. A changed body under an existing record ID is a conflict, not an
update.

```http
GET /api/corpus/records?scope=global&afterSequence=0&limit=100
GET /api/corpus/records?view=summary
Authorization: Bearer <PAYLOAD_CORPUS_INGEST_TOKEN>
```

Pages are globally ordered and cursor-based. Customer-scope administrative
pages include global plus that exact customer scope, never any other customer.
The summary does not expose the server filesystem path.

## What is implemented and what is not

Implemented now: the durable corpus contract, validation, append/replay API,
scope isolation, temporal revisions, tamper detection, typed facility discovery,
and evidence-bearing Earth projection.

Not yet implemented: automated API/document acquisition, raw artifact object
storage, analyst review queues, probabilistic entity-resolution proposals,
PostGIS projection, vector embeddings, GraphRAG, Context Compiler, additional
computational endpoints, and SP1 proofs over corpus builds. These are the next
layers; the UI must continue to refuse rather than imply they already exist.
