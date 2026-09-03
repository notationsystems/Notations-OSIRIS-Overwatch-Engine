# PayloadOS data-platform contract

## Architectural rule

```text
Canonical Core -> Rebuildable Representations -> Controlled Retrieval -> Products/APIs
```

PayloadOS supplies one canonical identity/evidence contract and multiple
specialized storage or compute representations for each domain product.
Payload is the first such product, covering the physical economy. PostgreSQL,
PostGIS, object storage,
Parquet/Iceberg, graph stores, and vector indexes may each serve a workload;
none becomes an independent source of truth.

This topology is locked. Infrastructure changes require measured workload or
reliability evidence; they do not change the information model.

The product hierarchy is also locked:

```text
Notation Systems -> PayloadOS machinery -> Payload product corpus -> APIs
```

See [`PRODUCT_BOUNDARIES.md`](PRODUCT_BOUNDARIES.md).

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
                    Corpus Builder / DAF
                              ^
                    Raw objects / lakehouse
```

The Data Miner consumes verified CorpusBuilds beside the retrieval path and
emits candidate knowledge into a separate Pattern Registry. Mining is not an
inverse compiler and cannot write canonical truth:

```text
CorpusBuild -> PayloadOS Miner -> PatternCandidate -> validation -> governed write
                                  |
                                  +-> Pattern Registry + MiningRun provenance
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

Canonical knowledge is deliberately layered rather than collapsed:

```text
Artifact evidence
  -> EvidenceUnit (locator + modality + extraction provenance)
  -> Observation (what one source reported)
  -> CanonicalAssertion (Payload's governed interpretation)
  -> disposable graph / spatial / search / context projections
```

An accepted assertion requires at least one compatible supporting observation.
Other linked observations are preserved as contradictions or qualifications.
`knownAt`/`knownTo` and valid-time bounds remain separate; a model-generated
statement cannot enter through the observation write path.

The edge API already separates the research-worker ingestion identity
(`PAYLOAD_CORPUS_INGEST_TOKEN`) from the compiler identity
(`PAYLOAD_CORPUS_COMPILER_TOKEN`). Possession of one credential grants no
authority at the other service boundary. The miner has a third credential,
`PAYLOAD_CORPUS_MINER_TOKEN`, which can read the current public build and append
candidate runs but cannot ingest records or publish projections.
Context compilation has a fourth non-interchangeable credential,
`PAYLOAD_CORPUS_QUERY_TOKEN`; it reads only the current policy-filtered build.
Projection workers use a fifth credential, `PAYLOAD_CORPUS_PROJECTOR_TOKEN`,
which can consume and checkpoint the outbox but grants no compilation or write
authority.

Every canonical append also writes `corpus_outbox_events` in the same SQLite
transaction. Projectors consume the global sequence and persist a monotonic
checkpoint. The one-time legacy backfill is marked; after that point a missing
or contradictory event is corruption, not something startup silently repairs.

## Corpus Builder

The implemented V0 Corpus Builder is the typed canonical-write stage of the
larger acquisition pipeline:

```text
Acquire -> Extract -> Normalize -> Resolve -> Warrant -> Persist
                                                   implemented ^
```

`POST /api/corpus/records` delegates accepted batches to the builder and emits
a deterministic `payload.corpus.builder-manifest.v1`. The manifest binds the
scope, record/evidence/claim identities, sequence range, record times, builder
version, and a fingerprint of the exact canonical commit. Its coverage is
`CANONICAL_WRITE_ONLY` and `upstreamAcquisitionAttested` is false. PayloadOS
therefore records what this service actually did without claiming that source
discovery, artifact acquisition, extraction, or analyst validation occurred
inside it.

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
corpusEngineId + corpusEngineVersion
productId
corpusDefinitionId + corpusDefinitionFingerprint
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

## Proof-carrying outputs and Warrant Graph

The implemented answer boundary exposes more than a key and value:

```text
identity + value + time + basis + evidence + lineage + verification
```

`payload.verification-envelope.v1` binds each deterministic answer to its
program/version, inputs, parameters, output digest, CorpusBuild, and exact basis
record IDs. Each basis record carries a domain-separated SHA-256 Merkle
inclusion proof against the compiled projection. This establishes reproducible
membership in that build commitment; it does not establish source truth or an
independent historical timestamp.

`payload.corpus.warrant-graph.v1` turns the same contract into a walkable graph:
answer, computation, record, evidence, source, CorpusBuild, and commitment.
Support, contradiction, and qualification are distinct edges. The graph has an
explicit `NO_COMPOSITE_TRUST_SCORE` policy because disagreement is evidence to
inspect, not a scalar to average away.

The vocabulary is `PROVENANCE`, `REPRODUCIBLE`, `ATTESTED`, and `ZK_VERIFIED`.
A `VERIFIED` context returns `REPRODUCIBLE` until its exact build commitment has
a valid stored Ed25519 signature. A matching signature raises it to `ATTESTED`
and names the immutable attestation artifact. The signed time remains explicitly
`SIGNER_CLOCK`, not an independent timestamp. The production, ceremonially
pinned SP1 `payload_event_batch_v1` program proves the operational event ledger,
not corpus compilation, so corpus answers continue to report zk proof absent.
A future corpus-specific guest must prove its own declared transformation before
the same answer can become `ZK_VERIFIED`. No proof can establish empirical truth.

## Data Miner and Pattern Registry

PayloadOS Miner V0 implements one deliberately narrow graph algorithm authorized
by the Payload CorpusDefinition:
`shared_dependency_fan_in` version `1.0.0`. It reads the current verified
`public:global` CorpusBuild, selects explicit active `depends_on` relationships,
and emits a `SHARED_DEPENDENCY` candidate when at least the configured number of
distinct entities name the same upstream entity. Depth is fixed at one.

Each `payload.corpus.pattern-candidate.v1` carries entity, relationship and
evidence IDs; algorithm and CorpusBuild identities; score; generation time;
joined policy lineage; and an explicit limitation. Fan-in does not establish
exclusivity, materiality, causality, or completeness. Every result is linked to
a reproducible `payload.corpus.mining-run.v1` containing parameters, feature
set, knowledge cutoff, exact input IDs and fingerprint, output IDs, policy
lineage, and timestamps.

The separate SQLite/WAL Pattern Registry assigns mining runs a linear sequence
and SHA-256 chain and verifies run/candidate content on open and replay. Exact
replay is idempotent; collisions and changed immutable content are refused.
Only `CANDIDATE` writes exist in V0. `VALIDATED`, `REJECTED`, and `SUPERSEDED`
are lifecycle types, not implemented transitions. No miner result mutates a
canonical relationship. Later validation must acquire evidence and pass through
the governed Corpus Builder boundary before canonical state can change.

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
- `/v1/mining/*`: candidate dependencies, anomalies, clusters, relationships,
  analogues and leading signals with mining-run provenance.
- `/v1/research`: authorization-bounded context compilation for people and agents.

The implemented V0 counterparts are `POST /api/corpus/retrieval` for a
deterministic plan, complete ContextPackage, or persistent agent result; `GET
/api/corpus/retrieval?resultId=...` for exact result recovery; `GET/POST
/api/corpus/attestations` for build signatures; `GET
/api/corpus/control-plane` for the Payload physical-economy topology,
capability state, artifact timeline, Kepler dock, and operator attention; and `GET/POST
/api/corpus/projectors` for ordered projection events and checkpoints. The
implemented representation layer also exposes `GET/POST /api/corpus/index`
for an exact build-bound lexical/faceted index and `GET/POST
/api/corpus/federation` for public `notation://` sync envelopes plus monotonic
Notation Data Substrate consumer checkpoints. The substrate is a federation
target and identity plane, not a second mutable canonical authority. The
retrieval boundary caps identities, predicates, hops, evidence results and
query size; binds every trace to the CorpusBuild and projection digest; refuses
unavailable historical knowledge times; and returns exact output record IDs for
each semantic tool step.

The same retrieval endpoint supports `mode: agent` and compiles a reusable
`notation.agent-context.v1`. Its assertion primitive carries canonical subject,
predicate, typed value, valid and knowledge time, epistemic class, a confidence
label explicitly marked non-probabilistic, contradiction/missing-evidence
state, observation/evidence/source IDs, CorpusBuild identity, and an explicit
statement that source truth is not claimed.

Evidence disclosure is monotonic:

| Budget | Added material |
|---|---|
| `FAST` | Compact canonical state and stable provenance IDs |
| `GROUNDED` | Artifact/source citation metadata |
| `AUDIT` | Observations, contradictions, Evidence IR, missing data, retrieval trace |
| `VERIFIED` | VerificationEnvelope, checked Merkle membership proofs, Warrant Graph |

`VERIFIED` is a request for available proof material, not permission to upgrade
assurance language. An unsigned build remains `REPRODUCIBLE` and
`NOT_ATTESTED`. A valid stored Ed25519 build signature becomes `ATTESTED`, while
retaining `independentTimestamp: false`; zk remains `NOT_GENERATED` because the
existing production SP1 program has a different, operational-event scope.
Agents receive exact `get_provenance` and `get_evidence` warrant paths so they
can hand stable identifiers between procurement, risk, research, and validator
workflows instead of copying prose.

Every agent result is immutable and content-addressed, then assigned one global
sequence in a per-scope SHA-256 chain shared with build attestations. The
SQLite/WAL edge implementation verifies the journal on restart. PostgreSQL
migration 2 creates the equivalent RLS-protected journal: query-role connections
may append only `agent_result`, compiler-role connections may append only
`build_attestation`, and neither receives update or delete authority.

Spatial output remains a representation, not an authority. Each saved result
contains OGC:CRS84 GeoJSON and a kepler.gl `addDataToMap` payload with stable
dataset IDs and tabular `fields`/`rows`. Missing entity coordinates produce an
explicit `SPATIAL_LOCATION_UNOBSERVED` state. Relationship lines express graph
adjacency, never a surveyed route.

This product-neutral wire contract is the first reusable Notation Systems
corpus-engine surface. Payload remains the only real corpus registered here.
Future Code, Materials, Science, Built, Spatial, or private-corpus worlds should
not appear as empty UI or API shells; each must first have a governed
CorpusDefinition, source registry, canonical model, compiler, and real build.

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
4. Operate the implemented PostgreSQL/PostGIS adapter through its
   capability-specific roles; cut over only after exact replay equivalence.
5. Replicate authorized read workloads away from the write authority and
   monitor projector lag from the transactional outbox.
6. Move high-volume observations into partitioned columnar history only after
   measured query and lifecycle requirements justify it.
7. Operate the deterministic build-bound lexical/faceted index and public
   Notation federation feed; add graph and vector projections through the
   compiler only when measured workloads justify them.
8. Extend the implemented authorization-before-emission policy join into the
   authorization-before-retrieval Context Compiler for model/agent access.
9. Add validation decisions and evidence-acquisition tasks for mined candidates;
   only validated, warranted records may re-enter the canonical write path.

No step permits dual truth. A migration is complete only when the new backend
replays the canonical contract and produces equivalent projection warrants.
