# Agent context production boundary

PayloadOS records agent-facing information products as evidence-bearing outputs,
not ephemeral chat payloads. The production path is:

```text
CorpusBuild -> RetrievalPlan -> ContextPackage -> Evidence budget
     |                                                |
     +-> Merkle commitment -> Ed25519 attestation     +-> spatial projection
                                                      |
                                                      +-> immutable result
                                                               |
                                                    agent-artifact journal
```

## Linearized artifact journal

`agent_result` and `build_attestation` share one globally sequenced journal with
independent SHA-256 chains per visibility scope. Each row stores the exact
canonical JSON, prior hash, record time, corpus build, artifact hash and stable
content identity. Repeating the same result or signature is idempotent; changed
content under an existing identity is a conflict. Update and delete are blocked.

SQLite/WAL is the edge implementation. When a dedicated
`PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH` is absent, the runtime derives a sibling of
the canonical corpus database. PostgreSQL migration 2 creates
`payload_corpus.agent_artifacts`, enables and forces RLS, permits the query role
to append only agent results, permits the compiler role to append only build
attestations, and gives neither role update or delete authority.

## Agent MCP tools

`npm run mcp` exposes five corpus tools in addition to the existing analytical
surface:

- `query_payload_corpus`
- `get_payload_corpus_result`
- `get_payload_corpus_warrant`
- `get_payload_corpus_attestation`
- `get_payload_control_plane`

The MCP process needs `PAYLOAD_CORPUS_QUERY_TOKEN`; the token is sent only in the
Authorization header to the same HTTP routes used by Terminal. Every query names
valid time, knowledge mode and evidence budget. A historical `as_known_then`
request succeeds only against a projection compiled at that knowledge time.

## Payload ecosystem control view

`GET /api/corpus/control-plane` and `get_payload_control_plane` inspect one
real system deeply: Payload's physical-economy corpus. The topology is derived
from the configured canonical store, current public projection, retrieval API,
artifact journal, evidence source IDs, MCP package, Kepler adapter, Ed25519
signer state, operational-event ledger boundary, and pinned SP1 identity.

The result includes capability mode and approval state, projection freshness,
an artifact-derived event timeline, and an operator summary of healthy, stale,
blocked, unobserved, and attention states. Timeline events say why a context or
signature was produced, identify the authenticated role, and always carry an
explicit `dispatched: false`. Cost and latency remain `UNOBSERVED` until real
telemetry is persisted; configuration is not promoted into a fabricated health
measurement. `PAYLOAD_CORPUS_CONTROL_STALE_AFTER_MS` sets the projection
freshness window and defaults to 24 hours.

The latest durable spatial result is the dock input. When none exists, the
control view returns `PAYLOAD_SPATIAL_RESULT_UNOBSERVED` instead of drawing a
representative world. Timeline pagination uses the immutable artifact sequence
through `afterSequence` and `limit`.

## kepler.gl interoperability

Spatial output is intentionally renderer-neutral. The authoritative result
names OGC:CRS84, emits GeoJSON with longitude/latitude coordinate order, and
keeps missing coordinates as `SPATIAL_LOCATION_UNOBSERVED`.

The `keplerGl` member is an adapter for the official
[`addDataToMap`](https://docs.kepler.gl/docs/api-reference/actions/actions)
action. It supplies datasets with stable `info.id` values and tabular
`fields`/`rows`, plus `centerMap`, `readOnly`, and `keepExistingConfig` options.
This follows kepler.gl's documented
[`processRowObject`/`processGeojson`](https://docs.kepler.gl/docs/api-reference/processors/processors)
data boundary without making Redux state or a saved map configuration canonical.

Entity points and graph-adjacency lines are emitted today. Arc, trip, H3,
vector-tile, raster and WMS layers remain renderer choices described by the
official [kepler.gl layer ecosystem](https://github.com/keplergl/kepler.gl/blob/master/docs/user-guides/c-types-of-layers/README.md).
At scale, the compiler may publish MVT/PMTiles projections under a new version;
the result and corpus identities do not change merely because a renderer does.

## Build signing

Generate an Ed25519 private key outside the repository and container image.
Mount the PKCS#8 PEM read-only, configure
`PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH`, then call:

```http
POST /api/corpus/attestations
Authorization: Bearer <PAYLOAD_CORPUS_COMPILER_TOKEN>
Content-Type: application/json

{"corpusBuildId":"corpus-build:...","signedAt":"2026-09-02T12:00:00.000Z"}
```

The service rebuilds the commitment from the current projection, refuses stale
canonical state, signs the exact statement, verifies its own output, and appends
it immutably. The public key is embedded in the attestation; the private key is
never stored. `PAYLOAD_CORPUS_ATTESTATION_KEY_ID` can pin the public-key-derived
identity as a deployment guard.

This creates cryptographic authenticity, not source truth. It also does not
create an independent historical timestamp: `signedAt` is labeled
`SIGNER_CLOCK`. A future RFC 3161, transparency-log, or public-chain anchor must
be represented as a separate attestation.

## SP1 boundary

`payload_event_batch_v1` is already the first production SP1 program. Its
verification key is ceremonially pinned in
`zk/payload-event-batch/verification-key.json`; the Linux worker proves and
locally verifies exact authorized operational event batches. The corpus
attestation API exposes that public identity with:

```text
proofScope = authorized_operational_event_batches
appliesToCorpusBuildAttestation = false
```

Consequently, signed corpus contexts are `ATTESTED` and still report
`zkProof.status = NOT_GENERATED`. A future `payload_corpus_build_v1` guest may
recompute a commitment or deterministic metric, but it must undergo its own
Linux proof ceremony and verification-key pin before any API response uses
`ZK_VERIFIED`.
