# PayloadOS data-platform contract

## Architectural rule

```text
Canonical Core -> Rebuildable Projections -> Controlled APIs
```

PayloadOS has one canonical identity/evidence model and multiple specialized
storage or compute representations. PostgreSQL, PostGIS, object storage,
Parquet/Iceberg, graph stores, and vector indexes may each serve a workload;
none becomes an independent source of truth.

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
|- redistributionClass
|- retentionClass
|- allowedUses[]
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

## Corpus Compiler

The compiler performs the expensive identity/evidence work once and publishes
rebuildable representations:

```text
Canonical records
  -> select active revisions at knowledge cutoff
  -> apply actor/object/allowed-use policy
  -> prune denied evidence and dangling endpoints
  -> build typed read model
  -> compute projection digest and source warrant
  -> atomically publish
```

The implemented `public:global` projection is stored in a separate SQLite/WAL
database. Public APIs query it exclusively. If canonical global state advances,
the API returns `CORPUS_PROJECTION_STALE` until the compiler runs again. The
read-model file can be deleted and rebuilt; canonical state cannot.

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

Planned API families:

- Data API: canonical entities, facilities, materials, suppliers, ports, and
  evidence-bearing observations.
- Intelligence API: supplier search, dependency traces, concentration,
  bottlenecks, substitutes, network exposure, landed cost, and spatial queries.
- Agent API: bounded research requests returning claims, entities, evidence,
  confidence, and missing information.

Every response preserves basis, value kind, confidence, knowledge cutoff,
evidence identifiers, and projection/source warrants. The contract never
collapses an evidenced assertion into an unwarranted scalar.

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
7. Add graph, spatial, vector, and search projections through the compiler.
8. Add the authorization-before-retrieval and authorization-before-emission
   Context Compiler boundary for model/agent access.

No step permits dual truth. A migration is complete only when the new backend
replays the canonical contract and produces equivalent projection warrants.
