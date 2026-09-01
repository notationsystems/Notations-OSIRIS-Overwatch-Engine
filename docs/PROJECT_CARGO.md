# Project Cargo Execution

Payload's project-cargo layer operates constrained physical assets from
registration through verified delivery and reconciled economics. Open
`/projects` with `PAYLOAD_OPERATIONS_TOKEN`; the credential stays in the active
tab's memory.

## Execution model

The canonical aggregate holds:

1. asset identity, value, geometry, serial/lot identity, and a typed condition,
   handling, security, regulatory, documentation, telemetry, and custody policy;
2. a versioned multimodal journey of facilities, permits, legs, dependencies,
   providers, and optional freight-operation bindings;
3. append-only custody, condition, evidence, integration, exception, and
   economic timelines;
4. deterministic condition breaches and operator-authorized remedies;
5. verified delivery plus explicitly closed project profitability.

The supported starting practices are yacht, technology equipment, medical
equipment, heavy machinery, fine art/collectibles, luxury automobile, luxury
furniture, pharmaceutical cold chain, and international electronics transport.
They share one schema but retain cargo-specific constraint profiles.

`GET /api/projects/actions` returns the portfolio. Add `projectId` to inspect
one complete replayed aggregate and its currently valid operator actions.
`POST /api/projects/actions` accepts only discriminated business intents. The
server derives event, journey, observation, evidence, transfer, exception, and
economic identities; callers cannot write journal records directly.

Important gates are fail-closed:

- a leg cannot start until its dependencies are complete and its permits are
  approved and valid at movement time;
- custody must form an exact chain for every affected cargo item;
- observed condition breaches are re-derived from the registered constraint
  profile, not trusted from the caller;
- delivery requires completed legs, destination custody, every required
  telemetry signal and document, and no open or failed remedy;
- contained cargo may only be delivered as quarantined or rejected;
- margin remains incomplete until the operator explicitly closes reconciled
  economics. A missing cost is never inferred to be zero.

## OpenTelemetry sensor intake

Sensors and gateways send OTLP/HTTP JSON log records to:

```text
POST /api/projects/telemetry/v1/logs
Authorization: Bearer <PAYLOAD_TELEMETRY_TOKEN>
Content-Type: application/json
X-Payload-Source-Id: <gateway identity>
```

This token is deliberately distinct from the human operator token. The receiver
accepts up to 500 records and 2 MB per request. Its mapping follows the
OpenTelemetry Logs Data Model: sensor occurrence time becomes `Timestamp`,
gateway receipt becomes `ObservedTimestamp`, identity is held in `Resource`,
the producer is held in `InstrumentationScope`, and project facts remain
attributes. Payload semantics use the `payload.*` namespace; `otel.*` is never
repurposed.

Required resource attributes are `payload.project.id`,
`payload.cargo.item.id`, and `device.id`. `eventName` must be
`payload.cargo.condition.observed`. Required log attributes are
`payload.telemetry.signal`, `payload.telemetry.unit`, and
`payload.telemetry.value` (number or string).

The endpoint implements OTLP partial-success responses for business records
that are rejected. Retries are safe: observation identity is deterministic and
duplicate delivery does not create a second physical observation. A Collector
can therefore use the conventional receiver -> processor -> exporter pipeline
and target this endpoint with its OTLP/HTTP JSON exporter.

References:

- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [OTLP specification](https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md)
- [Collector configuration](https://opentelemetry.io/docs/collector/configuration/)
- [Semantic convention naming](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/naming.md)

## External execution adapters

`POST /api/projects/integrations` is the authenticated carrier, EDI,
accounting, and payment egress boundary. Each provider is configured with a
URL, bearer credential, and provider name using the environment variables in
`.env.example`. Requests use an `Idempotency-Key`, have a bounded timeout, and
are HTTPS-only in production. Credentials and contact fields are rejected from
durable metadata. An integration event is committed only after the provider
has returned a typed delivery result.

Sensor ingestion is inbound through OTLP; carrier, EDI, accounting, and payment
are outbound through the provider-neutral adapter. Provider-specific mapping
belongs behind that boundary rather than in the project state machine.

## Persistence and recovery

For production set `PAYLOAD_DATABASE_PATH`. Project events then occupy the
`project_cargo` stream in the same SQLite/WAL database as load operations,
carrier communication, procurement, and commercial positions. Each stream
retains its own hash chain and all accepted events receive one global sequence.

Without the database, `PAYLOAD_PROJECT_CARGO_LOG` selects the compatibility
JSONL journal. It is append-only and hash-chained but should be used only by one
application writer. The one-time migration accepts
`--project-cargo=<project-cargo.jsonl>` and verifies source chains, exact counts,
and replay safety before completion.

Back up the SQLite database, WAL/shm files according to SQLite's online-backup
rules, and the SP1 proof directory. A proof file without its event database and
pinned verification key is not sufficient recovery evidence.
