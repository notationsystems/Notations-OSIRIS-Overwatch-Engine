# PayloadOS data-platform contract

## Architectural rule

```text
Canonical Core -> Rebuildable Representations -> Controlled Retrieval -> Products/APIs
```

PayloadOS has one canonical identity/evidence model and multiple specialized
storage or compute representations. PostgreSQL, PostGIS, object storage,
Parquet/Iceberg, graph stores, and vector indexes may each serve a workload;
none becomes an independent source of truth.

This topology is locked. Infrastructure changes require measured workload or
reliability evidence; they do not change the information model.

## Five planes

```text
Ingestion -> Truth -> Storage -> Representation -> Access
   DAF      identity   PostgreSQL    graph          retrieval
 OCR/API    evidence   object vault  spatial        context compilation
 files/GIS  time/state lakehouse     vector/search  API / GraphRAG / MCP
```

Security and information-flow control cut vertically through all five planes.
They are not a perimeter-only service.

## Target topology

```text
                           INTERNET
                              |
                         API GATEWAY
                              |
                  Identity / Quota / Policy
                              |
                         PAYLOAD API
                              |
                        Query Planner
                  +-----------+-----------+
                  |           |           |
                Graph      Spatial     Semantic
                  +-----------+-----------+
                              |
                       Context Compiler
                              |
                          Read Models
               +--------------+--------------+
               |              |              |
         PostgreSQL/PostGIS  Graph          Vector
               +--------------+--------------+
                              ^
                       Corpus Compiler
                              ^
                       Canonical State
                              ^
                          Evidence/DAF
                              ^
                    Raw objects / lakehouse
```

Identity, authorization, encryption, audit, tenancy, licensing, classification,
and resource control wrap every boundary.

## Storage responsibilities

| Tier | Responsibility | Initial implementation | Central target |
| --- | --- | --- | --- |
| Canonical structured state | identities, aliases, relationships, observations, evidence metadata, temporal revisions | SQLite/WAL append-first ledger | PostgreSQL with RLS |
| Spatial state | facilities, ports, geometry, corridors, proximity and containment | coordinates in canonical entities; map projection | PostGIS/GiST read model |
| Raw artifacts | PDFs, imagery, GIS, OCR inputs/outputs, source snapshots | external URI + SHA-256 metadata only | S3-compatible object store |
| Analytical history | AIS, prices, weather, telemetry, trade and other high-volume observations | operational/domain ledgers | partitioned Parquet with Iceberg-style catalogue |
| Graph/vector/search | relationship traversal and semantic retrieval | compiler boundary and public relational read model | disposable, versioned projections |

Do not store credentials in any tier. Canonical state may hold a
`credential_reference`; secret material belongs in a dedicated secrets manager.

## Canonical record governance

Every newly publishable `payload.corpus.record.v1` object carries:

```text
access
|- visibility
|- licenseClass
|- sourceLicenseId?
|- redistributionClass
|- retentionClass
|- allowedUses[]
|- prohibitedUses[]?
|- derivationPolicy?
|- tenantId?
|- ownerId?
|- entitlements[]?
`- jurisdiction?
```

Visibility is one of `PUBLIC`, `PAYLOAD_INTERNAL`, `LICENSE_RESTRICTED`,
`CUSTOMER_PRIVATE`, `CUSTOMER_SHARED`, or `CONFIDENTIAL`. Missing classification
is retained only for V0 ledger compatibility and is denied from publication.

Each requesting principal is an explicit `CorpusActorIdentity`: anonymous,
user, service, agent, source, or execution. An agent identity has no ambient
privilege. Policy evaluates actor permission, tenant, entitlement, object
classification, and declared purpose for every object.

The edge API already separates the research-worker ingestion identity
(`PAYLOAD_CORPUS_INGEST_TOKEN`) from the compiler identity
(`PAYLOAD_CORPUS_COMPILER_TOKEN`). Possession of one credential grants no
authority at the other service boundary.

### Information-flow control

Authorization to read two inputs does not imply permission to combine and
export them. Every derived result therefore carries a deterministic
`payload.corpus.policy-lineage.v1` object. Its effective policy is the join of
all input policies:

```text
Policy(output) = Join(Policy(input 1), ..., Policy(input n))
```

The join intersects permitted uses; unions explicit prohibitions,
jurisdictions, retention duties and entitlements; inherits the most restrictive
classification, redistribution and derivation controls; and refuses implicit
cross-tenant composition. A missing label or derivation prohibition fails the
computation closed. Input order does not change the lineage identifier.

## Corpus Compiler

The compiler performs the expensive identity/evidence work once and publishes
rebuildable representations:

```text
Canonical records
  -> select active revisions at knowledge cutoff
  -> apply actor/object/allowed-use policy
  -> prune denied evidence and dangling endpoints
  -> build typed read model
  -> join input policy lineage
  -> compute corpus-build, projection and source fingerprints
  -> atomically publish
```

The implemented `public:global` projection is stored in a separate SQLite/WAL
database. Public APIs query it exclusively. If canonical global state advances,
the API returns `CORPUS_PROJECTION_STALE` until the compiler runs again. The
read-model file can be deleted and rebuilt; canonical state cannot.

Every manifest now carries the strict build identity needed to answer “which
corpus produced this answer?”:

```text
corpusBuildId
canonicalStateFingerprint
recordSchemaVersion
ontologyVersion
policyVersion
compilerVersion
embeddingVersion
representationSpecification
policyLineageId
generatedAt
```

The current representation specification truthfully declares spatial, search
and statistics outputs as built, and graph, semantic and summary outputs as
omitted. Identical canonical state, cutoff and versions produce the same
content-addressed build ID regardless of compile time.

Graph, spatial, vector, search, entity-summary, and relationship-summary
projectors must follow the same rule: carry canonical IDs and representation
versions, remain reproducible, and never acquire identity authority.

## Tenant model

```text
authorized customer knowledge = global corpus + that customer overlay
```

No query may compose two customer overlays. Customer-scoped classification must
name the same tenant encoded by `customer:<tenant>`. Customer records cannot be
made public in place; publication requires an explicitly governed global record.

Application policy remains the first authorization boundary. PostgreSQL RLS is
the required defense-in-depth layer for the central deployment. Highly
sensitive customers may later receive a dedicated schema, database, key, or
deployment without changing canonical IDs.

## API product boundary

Customers never connect to storage directly. Terminal is the first client of
the same controlled API surface sold externally.

Target versioned API families (the implemented routes remain
`/api/corpus/*` V0):

- `/v1/entities/*`: canonical entities, facilities, materials and organizations.
- `/v1/evidence/*`: warrants, source artifacts and explanation.
- `/v1/spatial/*`: nearby, within, route and exposure computation.
- `/v1/intelligence/*`: dependencies, suppliers, substitutes and concentration.
- `/v1/research`: authorization-bounded context compilation for people and agents.

The V0 facility endpoint now returns a
`payload.corpus.answer-warrant.v1`: canonical identities, knowledge time,
evidence hashes, deterministic computation input/output digests, explicit
uncertainty, joined policy lineage and a privacy-safe corpus-build reference.
The public reference does not expose the private canonical fingerprint or
sequence. The contract never collapses an evidenced assertion into an
unwarranted scalar.

## Temporal and graph doctrine

Temporal semantics remain canonical rather than moving to a separate database.
`knownAt`, `recordedAt`, relationship validity and observation periods are
preserved through projections; the PostgreSQL target will index event,
knowledge and validity time directly. A dedicated time-series engine is added
only if measured AIS, telemetry or market workloads require one.

The logical graph exists in canonical relationships now. A dedicated graph
database remains disposable infrastructure and will be introduced only when
the compiler-backed relational representation fails demonstrated traversal
requirements.

## Evidence vault doctrine

Raw evidence bytes remain physically separate from canonical knowledge.
Canonical records hold content identity and governed locators. The target vault
is content-addressed, encrypted, object-versioned where practical, independently
backed up, and more tightly permissioned than derived representations.

Before broad external access, the gateway must add OAuth/OIDC, scoped service
keys, quotas, pagination and response caps, timeouts, query-complexity limits,
maximum graph depth, immutable access audits, and upstream-source isolation.

## Migration path

1. Keep SQLite/WAL as the working edge canonical ledger and compiler source.
2. Add an artifact service and content-addressed object-store layout.
3. Add source/actor registries and an append-only security audit sink.
4. Implement PostgreSQL/PostGIS behind the same canonical repository contract;
   validate replay and digest equivalence before cutover.
5. Add RLS and service roles, then replicate authorized read workloads away
   from the write authority.
6. Move high-volume observations into partitioned columnar history only after
   measured query and lifecycle requirements justify it.
7. Add graph and vector projections through the compiler; spatial and search
   already have an initial deterministic public representation.
8. Extend the implemented authorization-before-emission policy join into the
   authorization-before-retrieval Context Compiler for model/agent access.

No step permits dual truth. A migration is complete only when the new backend
replays the canonical contract and produces equivalent projection warrants.
