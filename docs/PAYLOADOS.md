# PayloadOS architecture contract

## Thesis

PayloadOS is a provenance-first operating system for physical-economic state,
decision, execution, and verification. Payload Terminal is its human operating
instrument and an edge node; it is not a separate source of truth.

The common operating loop is:

```text
observe -> represent -> reason -> decide -> authorize -> execute
        -> capture outcome -> verify -> update state
```

The commercial business can activate procurement, physical trading, project
logistics, or freight brokerage without changing that substrate. Logistics is
therefore both a service and an internal execution capability that contributes
to landed cost, position risk, and outcome evidence.

## Non-negotiable invariants

1. There is one conceptual canonical state. Terminal, Earth, Tradewind, OCR,
   models, brokers, exchanges, routers, and optimizers are projections,
   observers, computational actors, or execution adapters—not truth owners.
2. Observation, derived result, inference, recommendation, decision,
   authorization, execution, outcome, and verification remain distinct types.
3. Every accepted fact has canonical identity, source/evidence references,
   occurrence and knowledge time, lineage, and an explicit attestation class.
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

## System topology

```text
                         PayloadOS
                            |
             +--------------+--------------+
             |                             |
         world state                    operations
             |                             |
   +---------+---------+          +--------+--------+
   |         |         |          |        |        |
 spatial   market   evidence      buy      move     sell
   |         |         |          |        |        |
   +---------+---------+----------+--------+--------+
                            |
                       decision engine
                            |
                       authorization
                            |
          +-----------------+-----------------+
          |                 |                 |
     procurement         trading          logistics
          |                 |                 |
       suppliers       exchange/broker      carriers
          +-----------------+-----------------+
                            |
                       physical world
                            |
                     outcome + evidence
                            |
                  replay / audit / zk proof
                            |
                       state update
```

## Four operating planes and one cross-cutting plane

### Truth plane

Owns evidence, identity, time, canonical state, provenance, and durable event
history. The edge implementation in this repository now persists load-operation,
carrier-communication, procurement, and commercial streams in a single SQLite/WAL database with one
global sequence. Additional domain streams must enter through versioned,
validated event contracts; the database is not a generic JSON dumping ground.

The long-term central deployment may use PostgreSQL/PostGIS, but it must retain
the same ordered event contract and replay semantics. SQLite remains a useful
offline-capable Terminal edge store and replication source.

### Compute plane

Owns deterministic transforms, optimization, graph computation, routing,
simulation, pricing, forecasting, scenario propagation, and risk. CPU, native,
GPU, or CUDA implementations are interchangeable only when fixtures establish
semantic equivalence.

### Intelligence plane

Tradewind, GraphRAG, analytics, and bounded model providers consume evidence
and canonical state. They return derived results, inferences, proposals, or tool
requests with their input state and knowledge cutoff preserved.

### Action plane

Owns procurement, contracts, orders, dispatch, custody transfer, tracking,
settlement, and other physical or financial execution. Every external adapter
accepts a narrow semantic command only after policy and human/role authorization.

### Verification plane

The systems harness, assertions, replay, audits, and zkVM programs cross all
other planes. Verification records what was checked and against which committed
inputs; it never silently upgrades reported evidence into observed truth.

## Canonical commercial objects

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
`event-ledger.sp1.md`. It proves an exact contiguous global range, every embedded
domain chains, and the committed Merkle root.

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

1. **Terminal operations:** typed opportunity-to-settlement cockpit, carrier
   communication, linear database, replay, migration, and proof commitments.
2. **Procurement and commercial positions (implemented through customer settlement):**
   requirement, supplier quote, specification, five-check qualification,
   decision, purchase contract, physical position, logistics, landed cost, and
   append-only settlement revisions; procurement-origin inventory lots,
   customer commitments, allocation, sale contracts, freight-bound fulfillment,
   delivery, margin exposure, and sell-side settlement revisions.
3. **Project cargo:** asset policies, multimodal plans, custody, condition,
   telemetry, compliance, and exception remedies.
4. **Corpus and spatial state:** canonical organization/facility/material IDs,
   temporal graph, PostGIS projection, and evidence-aware retrieval.
5. **Market and risk:** read-only market/reference feeds, exposure and hedge
   proposals, then separately authorized execution and reconciliation.
6. **Verification workers:** SP1 batch proving, specialized proof programs,
   verification-key governance, proof-result events, and selective anchoring.

Each stage must close the loop from proposal through verified outcome before the
next domain is allowed to expand the action surface.
