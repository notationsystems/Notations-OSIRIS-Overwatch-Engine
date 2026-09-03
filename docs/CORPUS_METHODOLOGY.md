# Payload corpus methodology contract

Payload publishes information products as paired surfaces:

```text
human-readable answer <-> notation.result-manifest.v1
```

The result sidecar is part of the product contract. It binds the answer to the
exact methodology digest, CorpusBuild, projection, valid time, knowledge time,
canonical identities, evidence and source references, deterministic programs,
typed uncertainty, omitted evidence-budget sections, and actual verification
state. It explicitly says that computational verification does not establish
empirical source truth.

## Inspectable methodology

```http
GET /api/corpus/methodology?view=full
```

The public endpoint contains no corpus records or deployment secrets. It emits
`payload.corpus.methodology.v1`, including:

- separately versioned ontology, record schema, source policy, extraction,
  identity resolution, validation, compiler, index, mining, context compiler,
  and preflight components;
- process rules for ingestion, temporal semantics, evidence, contradictions,
  graph/spatial construction, licensing, and verification;
- uncertainty representations appropriate to reported facts, statistical
  estimates, identity resolution, mined patterns, and spatial estimates;
- deliberate non-claims and known limitations;
- a capability registry using `PRODUCTION`, `BETA`, `EXPERIMENTAL`, `RESEARCH`,
  and `PLANNED`, independently of `AVAILABLE`, `PARTIAL`, or `NOT_IMPLEMENTED`;
- a canonical SHA-256 methodology digest and version changelog.

Agents retrieve the same object through `get_payload_corpus_methodology`.
Planned and research entries are intentionally present so callers cannot infer
availability from a roadmap label.

## Fail-closed publication preflight

Both embedded and repository-backed public Corpus Compiler paths build a
candidate projection, run `payload.corpus.preflight.v1`, and only then write the
read model and advance the checkpoint. Blocking checks cover:

1. exact canonical-source/projection equivalence;
2. registered ontology terms;
3. stable identity collisions;
4. evidence and relationship endpoint closure;
5. knowledge-time leakage;
6. projection, search, derivation, and redistribution authorization.

Normalized aliases that map to multiple canonical entities are emitted as
`REVIEW_REQUIRED` identity risks. They degrade the build but do not merge or
block unrelated records. Live upstream source health is `UNOBSERVED` because a
valid historical build is not evidence that every source is currently online.

The compiler response includes the complete preflight report and its digest;
authenticated `GET /api/corpus/projections` deterministically reruns and returns
the same checks against the stored build.
The digest excludes the evaluation clock, so identical build checks reproduce
the same identity while retaining the observed evaluation time.

## Deliberate boundary

This increment does not claim to implement the future Challenge API, analyst
dispute workflow, generalized Divergence Miner, private no-egress workers,
internal/customer projection compilers, or corpus-build SP1 guest. Those remain
explicitly versioned future capabilities rather than implied behavior.
