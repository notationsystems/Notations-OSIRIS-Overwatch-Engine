# PayloadOS Knowledge Substrate

## Decision

PayloadOS adopts the Payload SCM Knowledge Substrate as a semantic contract,
not as a second runtime or source of truth. The existing hash-chained corpus
ledger remains the edge authority. PostgreSQL/PostGIS is the central production
target behind the same repository semantics; object storage, vector search and
graph materializations remain disposable projections.

```text
Sources / APIs / EDI / OCR / telemetry
  -> immutable artifact evidence
  -> source-bounded EvidenceUnit
  -> source-reported Observation
  -> reviewed CanonicalAssertion
  -> policy-filtered CorpusBuild
  -> graph / spatial / search / ContextPackage projections
  -> analytics, agents and authorized decisions
```

## Implemented edge contract

The canonical `payload.corpus.record.v1` envelope now admits two additive record
types while retaining all previous records:

- `evidence_unit` identifies a region, structured path, EDI segment, sensor
  interval or other bounded part of an immutable artifact. It records modality,
  typed locator, extraction kind/version/adapter/model/confidence and a content
  digest.
- `assertion` stores Payload's time-scoped interpretation separately from the
  underlying observations. Every assertion has an explicit status, selection
  policy, confidence, valid interval, knowledge interval and typed observation
  links (`supports`, `contradicts`, `qualifies`).

The append boundary enforces reference availability, scope compatibility,
knowledge ordering, subject/property compatibility, immutable identity and
strict supersession. A source report therefore cannot become accepted state
merely because it parsed successfully.

Every accepted corpus record and its projection event are committed in the same
SQLite transaction. Events reuse the canonical global sequence, contain the
record hash, and can be consumed by public, customer, spatial, graph, vector or
analytics projectors. Checkpoints are durable and monotonic. Legacy ledgers are
upgraded in place and receive one marked outbox backfill; subsequent gaps are
treated as corruption. Workers authenticate with the dedicated
`PAYLOAD_CORPUS_PROJECTOR_TOKEN`, not an ingestion, compiler, mining, or query
credential.

## Retrieval boundary

`POST /api/corpus/retrieval` accepts only a bounded semantic request. It plans
and executes these operations over a verified, policy-filtered CorpusBuild:

1. `resolve_entities`
2. `get_entity_state`
3. `traverse_graph`
4. `search_evidence`
5. `get_claim_support`

The resulting `payload.corpus.context-package.v1` contains entities,
relationships, accepted assertions, source observations, Evidence IR units,
artifact identities, contradictions, missing evidence and a retrieval trace.
The plan ID, context ID and trace ID are deterministic content identities bound
to the exact CorpusBuild, projection digest, policy lineage and output record
IDs. Direct model access to SQLite, PostgreSQL, Qdrant or future graph storage is
outside the contract.

The active V0 read model represents one exact knowledge cutoff. Requests for a
different historic knowledge time fail closed until a separately addressed
historical projection exists. This prevents a current projection from being
misrepresented as what Payload knew earlier.

## Counterfactual unobserved states

Scenario responses keep `unobservedStates[]` beside, never inside,
`ScenarioEntityDelta`. An active impact that cannot be quantified retains
`delta.disruptedKtPerYear: null` and emits a typed state with its entity and
metric scope, reason code, missing fields, observed lineage, required evidence,
acquisition remedy, and a violet `ScenarioUnobservedStateCard` presentation
contract. The supported queues distinguish topology, facility allocation,
material-basis conversion, reporter-vintage coverage, regulatory scope, and
otherwise-unclassified impact evidence. No baseline value is synthesized.

## Central deployment target

The central implementation will map, without changing domain behavior, to:

| Edge | Central |
| --- | --- |
| SQLite/WAL canonical ledger | PostgreSQL canonical tables with RLS |
| Coordinates in entity records | PostGIS geometries and spatial indexes |
| Artifact SHA-256 and governed locator | Encrypted, versioned S3-compatible vault |
| `corpus_outbox_events` | Transactional PostgreSQL outbox |
| SQLite compiled read model | Versioned relational, graph and vector projections |
| bounded corpus retrieval | authenticated Context Compiler service |

The PostgreSQL transition is a replay migration, not dual truth. Cutover is
permitted only after the central adapter reproduces canonical sequences, record
hashes, scope visibility, active revisions, projection digests, policy lineage
and answer/context warrants from the edge ledger.

## Next production increments

1. Extract the SQLite corpus behind a repository interface and add equivalence
   fixtures.
2. Create PostgreSQL/PostGIS migrations, service roles and RLS policies.
3. Add encrypted artifact storage and short-lived, authorization-checked access.
4. Add durable retrieval/audit traces without persisting unnecessary raw query
   text.
5. Implement idempotent spatial and vector workers with lag monitoring.
6. Add version-addressed historical projections and state comparison tools.
7. Extend assertion review into validation queues for mined candidate knowledge.
