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
  -> read a compiled public projection, never canonical write tables
  -> resolve canonical material identity or explicit alias
  -> apply object classification and allowed-use policy
  -> select active produces relationships at asOf
  -> retrieve facility and operator identities
  -> join the policy of every answer input
  -> authorize emission and return exact supporting evidence
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
`supersedes`, optional V0-compatible `access` classification, and canonical
JSON. New publishable records must classify visibility, licence class and
source-licence identity, redistribution, retention, permitted/prohibited uses, derivation policy and—
where applicable—tenant, owner, entitlements, and jurisdiction. Missing
classification is accepted only so old ledgers can replay; it is denied from
every public projection.

Derived answers carry `payload.corpus.policy-lineage.v1`. The join intersects
permitted uses, unions prohibitions and obligations, inherits the most
restrictive release constraints, and refuses cross-tenant composition. Being
authorized for two inputs separately does not authorize their combination.

Evidence records may include `artifactId`, `storageUri`, `mediaType`, and
`parserVersion`. The database holds this metadata and the content hash, never
the raw document/image/archive bytes. Supersession preserves the stable domain
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
PAYLOAD_CORPUS_READ_MODEL_PATH=/app/runtime-data/corpus-public-read-model.sqlite
PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH=/app/runtime-data/corpus-pattern-registry.sqlite
```

or only `PAYLOAD_DATABASE_PATH` to place the corpus tables beside the existing
operational event tables in one backed-up SQLite file. On Podman/Docker, the
path must live on the named runtime volume, not a host-synchronized OneDrive
folder; SQLite WAL requires ordinary filesystem locking.

The read-model database is deliberately separate and disposable. The Corpus
Compiler can delete and reconstruct it from canonical state. Raw artifacts
belong in an object store or filesystem hierarchy addressed by content hash;
high-volume historical observations belong in a future columnar/lakehouse tier.

Co-location does not collapse the two semantic clocks: `corpus_records.sequence`
orders accepted knowledge records, while `payload_events.sequence` orders
operational events. A later cross-ledger manifest may commit both ranges, but
the system does not currently pretend that two independent sequences are one.

## Scope isolation

- `global` is reusable, non-tenant corpus knowledge (`K_G`); only its explicitly
  public/redistributable subset enters the public projection.
- `customer:<id>` is private customer knowledge (`K_C`).
- Global reads see only global records.
- An authorized customer read composes global plus that exact customer.
- No read path composes two customer scopes.
- `GET /api/corpus/facilities` is public/read-only, hard-coded to a compiled
  `global` projection, and cannot query canonical write tables;
- only explicitly `PUBLIC`, redistributable objects whose dependencies are
  independently authorized can enter that projection;
- stale projections fail closed after canonical global state advances;
- Raw append/replay requires the dedicated `PAYLOAD_CORPUS_INGEST_TOKEN`.
- Projection compilation/inspection requires the separate
  `PAYLOAD_CORPUS_COMPILER_TOKEN`; the two service identities are not
  interchangeable.
- Dependency mining and Pattern Registry replay require
  `PAYLOAD_CORPUS_MINER_TOKEN`; miner, compiler, and ingestion identities are
  not interchangeable.

## API surfaces

### Visual facility discovery

```http
GET /api/corpus/facilities?q=polypropylene%20production
GET /api/corpus/facilities?q=pe:material:polypropylene&asOf=2026-09-01
```

The small intent grammar removes only an explicit suffix such as `production`,
`producer`, `manufacturing`, or `facilities`; identity is still resolved by
canonical ID or an explicit alias. The response includes facility coordinates,
operator, relationship identity, confidence, and exact evidence records. It is
rendered by the Search surface as a dedicated query layer on Payload Earth.
Every successful response carries a `payload.corpus.answer-warrant.v1` with
canonical identities, knowledge time, evidence artifact hashes, deterministic
computation input/output digests, explicit uncertainty, policy lineage, and a
privacy-safe corpus-build reference. Canonical source sequence and fingerprint
stay inside the authenticated compiler manifest so restricted-record cadence is
not leaked through a public warrant. The active V0 read model has one pinned
knowledge cutoff; arbitrary historical cutoffs require versioned projections
and are refused rather than reconstructed from incomplete state.

### Corpus Compiler

```http
POST /api/corpus/projections
Authorization: Bearer <PAYLOAD_CORPUS_COMPILER_TOKEN>
Content-Type: application/json

{"audience":"public","scope":"global","knowledgeCutoff":"2026-09-02T12:00:00.000Z"}
```

The compiler reads active canonical global records, applies object policy,
prunes claims with denied evidence or endpoints, joins admitted input policies,
computes deterministic corpus-build and projection identities, and atomically
replaces the disposable read model. Its manifest binds the canonical state,
record schema, ontology, policy, compiler, embedding and representation
versions. Exact
recompilation is idempotent. `GET /api/corpus/projections` returns its manifest
to an authenticated administrator; it never returns the database path.

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
update. A successful write includes a deterministic
`payload.corpus.builder-manifest.v1` for the exact committed scope, records,
sequence range and hashes. The manifest explicitly covers only the canonical
write and does not attest that upstream discovery, acquisition or extraction
occurred in this service.

```http
GET /api/corpus/records?scope=global&afterSequence=0&limit=100
GET /api/corpus/records?view=summary
Authorization: Bearer <PAYLOAD_CORPUS_INGEST_TOKEN>
```

Pages are globally ordered and cursor-based. Customer-scope administrative
pages include global plus that exact customer scope, never any other customer.
The summary does not expose the server filesystem path.

### Shared-dependency mining

```http
POST /api/corpus/mining/dependencies
Authorization: Bearer <PAYLOAD_CORPUS_MINER_TOKEN>
Content-Type: application/json

{"entityId":"pe:facility:gulf-coast-ethylene","depth":1,"minimumDependents":2}
```

The miner refuses absent or stale public projections. It examines only explicit
active `depends_on` records in the current public CorpusBuild and emits typed
`SHARED_DEPENDENCY` candidates. Every candidate preserves exact entity,
relationship, evidence, algorithm, build, uncertainty and policy lineage. The
associated MiningRun preserves parameters, knowledge cutoff, inputs, outputs,
fingerprints and execution times.

Results are appended to a separate hash-chained SQLite/WAL Pattern Registry:

```http
GET /api/corpus/mining/dependencies?afterSequence=0&limit=100
GET /api/corpus/mining/dependencies?view=summary
Authorization: Bearer <PAYLOAD_CORPUS_MINER_TOKEN>
```

The epistemic boundary is enforced in storage: every V0 mined object has
`validationStatus: CANDIDATE`. It does not become an observed relationship and
does not modify canonical state. The lifecycle vocabulary includes validated,
rejected and superseded states, but transition/analyst-review authority is not
implemented yet.

## What is implemented and what is not

Implemented now: the durable corpus contract, validation, Corpus Builder
canonical-write manifests, append/replay API,
scope isolation, temporal revisions, tamper detection, object classification,
actor/purpose policy, deterministic information-flow joins and policy lineage,
a version-bound Corpus Compiler, a separate public read model, stale-model
refusal, typed facility discovery, proof-carrying Earth answers, deterministic
depth-1 shared-dependency mining, MiningRun provenance, and an append-only
Pattern Registry for candidate knowledge.

Not yet implemented: automated API/document acquisition, raw artifact object
storage, append-only security-audit export, OAuth/OIDC, database RLS,
PostgreSQL/PostGIS authority, Parquet/Iceberg history, analyst review queues,
probabilistic entity-resolution proposals, candidate validation/promotion,
recursive dependency propagation, link prediction, temporal/spatial/statistical/
anomaly mining, graph/vector projections, GraphRAG, Context Compiler,
additional computational endpoints, and SP1 proofs over corpus builds. These
are the next layers; the UI must continue to refuse rather than imply they
already exist.
