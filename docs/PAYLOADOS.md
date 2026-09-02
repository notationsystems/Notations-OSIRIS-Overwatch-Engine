# PayloadOS architecture contract

## Thesis

PayloadOS is a provenance-first **information operating system for the physical
economy**. Its primary asset is a high-integrity computational corpus. Payload
Earth is the spatial query surface, Tradewind is the analytical surface,
Payload API is the machine surface, agents consume compiled context, and
Payload Terminal remains the human evidence and domain-workflow instrument.
None is a separate source of truth.

The critical corpus loop is:

```text
Acquire -> Extract -> Normalize -> Resolve -> Structure -> Relate
        -> Index -> Compress -> Retrieve -> Compute -> Prove
```

The operational loop—observe, represent, reason, decide, authorize, execute,
capture outcome, verify, update state—remains implemented domain capability.
Freight, procurement, physical positions, and project logistics now inform what
the corpus must understand; operating those businesses is not on the critical
path to building the information company.

## Non-negotiable invariants

1. There is one conceptual canonical state. Terminal, Earth, Tradewind, OCR,
   models, brokers, exchanges, routers, and optimizers are projections,
   observers, computational actors, or execution adapters—not truth owners.
2. Observation, derived result, inference, recommendation, decision,
   authorization, execution, outcome, and verification remain distinct types.
3. Every accepted fact has canonical identity, source/evidence references,
   occurrence and knowledge time, lineage, attestation, and explicit access,
   licence, redistribution, retention, and allowed-use classification before it
   can enter a published projection.
4. Models propose. They do not directly mutate canonical state or execute a
   commercial action.
5. Execution is bound to the exact authorized object, actor, counterparty, and
   decision. A changed payload requires a new identity.
6. Missing data is typed as missing. It is not converted to zero, false, or an
   invented estimate.
7. Durable events are append-only, replayable, and linearly retrievable. Domain
   hash chains and database integrity checks fail closed on contradiction.
8. A commitment prepared for a zkVM is not described as a proof. Only a result
   verified against the approved program and verification key is a proof.
9. Canonical state is the only authority. Graph, vector, spatial, search, and
   API read models are versioned, disposable projections built by the Corpus
   Compiler. Customers and agents never query database tables directly.
10. Derived information inherits the joined policy of every input. Permission
    to read inputs separately never implies permission to combine or emit them.

## System topology

```text
                         PAYLOADOS
                             |
        +--------------------+--------------------+
        |                    |                    |
     INGESTION             TRUTH                STORAGE
  DAF/OCR/APIs/GIS   Identity/Evidence/Time   SQL/Objects/Lake
        +--------------------+--------------------+
                             |
                   REPRESENTATION PLANE
             Graph / Spatial / Search / Vector
                             |
                        ACCESS PLANE
          Retrieval / Context Compiler / Policy Join
                             |
                 API / GraphRAG / MCP contracts
                             |
                  Earth / Tradewind / Terminal

 Security, tenancy, information-flow control and verification are vertical.
```

## Five data-platform planes and vertical security

### Ingestion plane

Owns DAF, OCR, source APIs, files, GIS and telemetry intake. It produces typed
source artifacts and candidate records; it cannot silently grant canonical
identity or publication authority.

### Truth plane

Owns evidence, identity, time, canonical state, provenance, and durable event
history. The corpus implementation persists evidence, entities, explicit
aliases, typed relationships, and observations as immutable records in
SQLite/WAL. Every record receives a global sequence and a scope-local hash
chain. Public knowledge composes with exactly one authorized customer scope;
private customer scopes can never compose with one another.

Canonical records may carry object-level visibility, licence, redistribution,
retention, permitted/prohibited use, derivation, tenant, owner, entitlement,
and jurisdiction metadata.
The public Corpus Compiler admits only explicitly public and redistributable
records, removes claims whose evidence or endpoints are denied, and writes a
separate digest-bound read model. The public API refuses a stale projection
rather than querying the canonical write database as a fallback.

The existing edge event database persists load-operation,
carrier-communication, procurement, commercial, and project-cargo streams with
the same ordered/replayable discipline. Additional domain streams enter through
versioned, validated contracts; neither database is a generic JSON dumping
ground.

The long-term central deployment may use PostgreSQL/PostGIS, but it must retain
the same ordered event contract and replay semantics. SQLite remains a useful
offline-capable Terminal edge store and replication source.

### Storage plane

Owns PostgreSQL/PostGIS structured state, the raw Evidence Vault, and analytical
history. SQLite/WAL is the implemented edge authority. Object storage,
PostgreSQL/PostGIS and Parquet/Iceberg remain workload-specific production
targets, never alternate truth owners.

### Representation plane

Owns deterministic graph, spatial, vector, search, statistics and summary
builds. The Corpus Compiler creates a content-addressed build bound to
canonical, schema, ontology, policy, compiler and representation versions.
Every derived build carries joined input-policy lineage and is disposable.

### Access plane

Owns authorization-aware retrieval, context compilation, APIs, GraphRAG and MCP
contracts. Payload Earth, Terminal, Tradewind, customers and agents all consume
this semantic boundary. Facility answers now carry canonical identities,
evidence hashes, computation digests, uncertainty, policy lineage and their
corpus-build identity.

### Vertical security and verification

Identity, least privilege, classification, tenancy, information-flow control,
encryption, audit, quotas, assertions, replay and zkVM programs cross all five
planes. Verification records what was checked and against which committed
inputs; it never silently upgrades reported evidence into observed truth.

## Canonical corpus objects

Corpus V0 generalizes the existing commodity state into six related physical-
economy identities plus geography:

```text
Organization <-> Facility <-> Material <-> Process <-> Network <-> Market
```

Its immutable record types are `evidence`, `entity`, `alias`, `relationship`,
and `observation`. A stable domain identity can change only through a new record
that explicitly supersedes the prior record, with a strictly later `knownAt`.
Similarity never creates identity and an answer cannot be knowable before its
supporting evidence.

The global corpus (`K_G`) contains generally reusable knowledge. A customer
scope (`K_C`) contains that customer's internal state. Authorized retrieval may
compute `K_G + K_C`; the public Earth query surface is structurally restricted
to a policy-filtered, redistributable projection of `K_G`. Missing
classification never defaults to public. See [`DATA_PLATFORM.md`](DATA_PLATFORM.md)
for the storage, compiler, identity, authorization, and central-deployment
contract.

## Preserved domain capability

The freight `LoadOperation` is the first production aggregate, not the final
universal object. PayloadOS grows around these related roots:

```text
CommercialRequirement
  -> SourcingOpportunity
  -> SupplierAlternative[]
  -> DecisionEpisode
  -> Authorization
  -> Purchase / Sale / ServiceContract
  -> PhysicalPosition
  -> LogisticsRequirement
  -> ProjectCargo / LoadOperation
  -> Custody + Telemetry + Exceptions
  -> Delivery
  -> Settlement
  -> OutcomeVerification
```

A `PhysicalPosition` represents material, grade/specification, quantity,
location, ownership, acquisition cost, market value, counterparty, quality,
logistics, hedge state, and commitments. It lets the system connect procurement
economics to execution rather than treating freight as an isolated transaction.

A `ProjectCargo` represents an asset or material plus value, geometry,
environmental constraints, handling constraints, security, regulation, custody,
insurance, documentation, origin/destination, modes, route, service providers,
telemetry, exceptions, evidence, and verification.

## Specialized logistics practices

One project-cargo engine supports asset-specific policies:

| Practice | Initial domains | Constraints that become first-class |
| --- | --- | --- |
| Luxury & Collectibles | yachts, automobiles, art, furniture | custody, condition, security, discretion, white-glove handling |
| Industrial & Heavy | machinery, manufacturing equipment | geometry, centre of gravity, rigging, permits, multimodal route |
| Technology & Electronics | semiconductor, lab, data-centre, electronics | shock, vibration, humidity, orientation, serial/lot identity, security |
| Medical & Life Sciences | medical equipment, pharmaceutical cold chain | compliance, temperature, packaging qualification, chain of custody |

Cold-chain telemetry is a reference case because it joins time, spatial state,
custody, constraints, evidence, execution, and verification. Temperature is an
observation from an identified sensor; an excursion is a typed event; a remedy
is proposed and authorized; delivery evidence determines the outcome.

## Provider boundaries

- OCR and document models are perception providers. They create candidate
  observations for review; they do not become canonical records by extraction
  alone.
- Payload Earth and other renderers are spatial projections over canonical
  state. They do not own facility, route, position, or shipment state.
- A market venue feed creates `MarketObservation` records.
- A broker creates `ExecutionObservation` records for accounts, orders, fills,
  positions, and margin. Broker state is reconciled with, but does not replace,
  internal position state.
- An agent receives state, evidence, constraints, tools, and a task. It returns
  a proposal, inference, and bounded tool requests.

For an eventual listed-hedging adapter, keep this separation:

```text
authoritative market feed -> MarketObservation -> MarketState
broker/execution adapter  -> ExecutionObservation -> PositionState
Payload policy + risk     -> DecisionProposal -> Authorization -> Order
```

Financial execution stays disabled until instrument identity, account/risk
limits, approvals, kill switches, reconciliation, and regulatory controls are
implemented and tested. No model receives direct broker credentials.

## Ordered event substrate

Every domain event admitted to the durable substrate must expose:

```text
global sequence assigned by storage
domain stream + schema version
event identity + aggregate identity
occurredAt + knownAt + recordedAt, as applicable
actor / source / evidence identities
canonical typed payload
domain previous hash + record hash
authorization / decision references, when executable
```

The global sequence answers “what did Payload accept, and in what order?” The
independent domain hash chains answer “is this domain history complete and
unchanged?” Neither substitutes for occurrence time, knowledge time, or an
external timestamp.

## SP1 / zkVM program family

The first generic program is `payload_event_batch_v1`, specified in
`event-ledger.sp1.md`. Its checked-in Rust guest proves an exact contiguous
global range, every embedded domain chain, and the committed Merkle root. The
leased host worker separately verifies against a pinned verification key before
the database can mark a batch proved.

Specialized programs should disclose only the statement a counterparty needs:

- dispatch used a previously authorized carrier/load binding;
- tender receipt matches the immutable dispatch envelope;
- custody transitions and disclosed condition constraints are complete;
- cold-chain readings stayed within a disclosed band, or disclose excursions;
- material specification requirements were satisfied by committed evidence;
- landed-cost or settlement margin was calculated from committed inputs;
- procurement policy and knowledge cutoff were respected;
- a hedge calculation corresponds to a committed exposure and policy.

Proof generation is asynchronous. Dispatch, custody intervention, or safety
actions do not wait for a prover.

## Repository consolidation map

- `Payload-Terminal-V0`: operator cockpit, edge persistence, control tower,
  evidence inspection, and command surface.
- `Payload-Render-Engine`: Payload Earth and other read-only state projections.
- `PayLoad-OCR-Agent`: perception adapter producing reviewed candidate
  observations and evidence references.
- Tradewind services: market/physical-economy analytical projections.

These components converge through shared canonical identities, event schemas,
and APIs. Copying each repository into a monolith without those contracts would
only create a larger silo.

## Delivery sequence

1. **Corpus V0 + public compiler (implemented substrate):** immutable evidence/entity/alias/
   relationship/observation records, global linear retrieval, independent scope
   chains, public/private composition boundary, temporal revisions, object
   classification, actor/purpose policy, a deterministic disposable read model,
   and the first `find_facilities(material)` computation.
2. **Corpus Factory + artifact tier:** API and document acquisition, content-
   addressed object storage, artifact preservation,
   OCR/perception candidates, review queues, resolution, and continuous
   evidence-linked publication.
3. **Central structured and analytical tiers:** replay-equivalent PostgreSQL,
   PostGIS, RLS, service identities, audit, read replication, and measured
   Parquet/Iceberg partitioning for high-volume observations.
4. **Spatial and graph projections:** PostGIS, typed graph traversal, historical
   state, and Payload Earth query composition over facilities, ports, flows,
   dependencies, disruptions, and customer-authorized overlays.
5. **Hybrid retrieval:** relational + graph + spatial + temporal + semantic
   indexes with an evidence-preserving Context Compiler for GraphRAG and agents.
6. **Computational products:** supplier discovery, substitution, dependency,
   landed-cost, physical-risk, historical-state, and relationship-explanation
   APIs; Tradewind packages these into intelligence products.
7. **Verification:** extend the implemented SP1 event proof boundary to selected
   corpus builds, transformations, retrieval manifests, and disclosed
   calculations with ceremonially pinned program identities.

Freight, procurement, commercial-book, and project-cargo implementations remain
maintained capability and test data for the corpus. Their action surfaces expand
only when an operating use case justifies the execution risk.
