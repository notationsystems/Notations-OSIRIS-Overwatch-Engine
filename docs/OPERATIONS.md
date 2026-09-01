# Sea Dog Terminal — operations (deployment hardening order, Tier 2/3)

What the instance does between deploys: what survives a restart, where
the backup is, how a change gets checked before a researcher sees it, and
what postures have been taken about external clients.

## Freight-operation journals

The load-operation, carrier-communication, procurement, commercial, and project-cargo journals
are append-only, hash-chained commercial evidence. Docker Compose mounts
`payload-runtime` at `/app/runtime-data` and points all five journal variables there, so rebuilds and container replacement
preserve them. They are excluded from Git, Docker build
contexts, and the static archive manifest.

Use one application writer and back up the volume independently. Restoring only
one journal is not sufficient: carrier receipts and events bind to immutable
dispatch identities in the load journal, and the communications API refuses an
orphan or mismatched history. Outbound tender delivery is at-least-once across a
process crash and sends a stable attempt `Idempotency-Key`; the carrier adapter
must honor that key to make a retry side-effect safe.

### Canonical event database and migration

Set `PAYLOAD_DATABASE_PATH` to place load operations, carrier communication,
procurement, commercial positions, and project cargo in one SQLite/WAL database. Each stream retains its own
append-only hash chain and replay rules; the database adds a global `sequence`
across all accepted events. This makes the whole history linearly pageable
without pretending the domain state machines are one state machine.

For an existing deployment, stop application writers and migrate before setting
the variable on the application service:

```bash
PAYLOAD_DATABASE_PATH=/app/runtime-data/payload.sqlite npm run migrate:operations-db
```

Optional source overrides are
`--operations=<load-operations.jsonl>` and
`--communications=<carrier-communications.jsonl>` and
`--procurement=<procurement.jsonl>`, `--commercial=<commercial.jsonl>`, and
`--project-cargo=<project-cargo.jsonl>`. The migrator verifies every
legacy chain, orders records by recorded time while preserving each
stream's internal order, writes through the same SQLite append guards, checks
counts, and refuses a destination containing any divergent history. Keep the
legacy files until backup and restore have been tested.

Authenticated retrieval:

- `GET /api/freight/event-ledger?after=0&limit=100` returns the global sequence;
- add `operationId=...` for one load or `stream=load_operation` /
  `carrier_communication` / `procurement` / `commercial` / `project_cargo` for
  one domain journal;
- every page carries the next cursor and database totals.

SQLite structural health is checked at open. Reads then validate indexed
metadata, canonical event hashes, and all previous-hash chains. A database can
be structurally valid but semantically tampered; that second validation is why
`quick_check` alone is not treated as evidence of an intact journal.

### SP1 / zkVM proof batches

`POST /api/freight/proof-batches` commits the next exact, non-overlapping global
sequence range. Leaves bind `(sequence, stream, recordHash)` and the response
records a deterministic root with program `payload_event_batch_v1`, prover
system `sp1`, and status `pending`. `GET` retrieves all batch commitments.

This endpoint prepares public inputs; it does not accept a caller-supplied proof
or verification key. The checked-in leased worker consumes pending batches,
runs SP1, verifies locally against the pinned key, hashes the durable proof, and
marks the exact batch proved. Authorization remains a
microsecond blocking gate; proving remains asynchronous evidence about what
executed.

Build `zk/payload-event-batch` on Linux with the official SP1 toolchain, then set
absolute `PAYLOAD_SP1_EXECUTABLE` and `PAYLOAD_SP1_PROOF_DIR` paths plus the
pinned `PAYLOAD_SP1_VERIFICATION_KEY`. `PAYLOAD_SP1_PROOF_MODE` accepts `core`,
`compressed`, `groth16`, or `plonk`. Run `npm run prove:event-batch` under a
supervisor. The worker leases one batch for the prover timeout; an expired lease
is recoverable, and three verified failures stop for operator review. Native
Windows is not a supported SP1 host because current SDK/JIT dependencies require
Unix facilities. See `docs/event-ledger.sp1.md`.

---

## Brokerage control tower

Open `/operations` and supply the same `PAYLOAD_OPERATIONS_TOKEN` used by the
private freight APIs. The credential remains in the active tab's memory; it is
not written to local storage, session storage, URLs, or the server-rendered
page. Locking or closing the workspace clears it.

The workspace reads `GET /api/freight/control-tower` every 30 seconds. This is a
projection over the two journals, not a third mutable record. It joins:

- opportunity, route, equipment, load, carrier, lane, episode, and action IDs;
- authorization, assignment, dispatch, tender delivery, acknowledgement, and
  tracking state;
- pickup and delivery commitments plus tracking freshness;
- quoted carrier cost, captured invoice, gross margin, and outcome status.

The default queue is exception-first. Every queue item exposes a named issue,
severity, applicable deadline, evidence-reference count, and operator remedy.
There is no opaque composite score. Missing tracking is not treated as on time,
and journal corruption or unavailability makes the entire view refuse rather
than silently showing an empty desk.

### Typed action cockpit

Use **New load** to create a sanitized opportunity, or expand a load and choose
**Take typed action**. The side cockpit exposes only actions permitted by the
current durable phase:

1. create the opportunity;
2. add one or more evidenced carrier quotes;
3. run the exact carrier/load authorization gate;
4. freeze the candidate set, assign, and record dispatch;
5. send the immutable carrier tender;
6. record carrier acceptance and physical tracking;
7. close the load from settlement/POD evidence.

Operators enter business facts and source references. They do not enter event,
episode, evidence, dispatch-message, or carrier-event identities. The server
derives those identities, resolves carrier and load bindings from the two
journals, and delegates to the existing authorization and decision gates. A
request with extra internal command fields is refused before either journal is
touched. Each browser submission gets a stable request ID, so an exact retry is
append-only idempotent rather than a second physical action.

The first cockpit increment covers the straight-through lifecycle. Re-covering
a carrier rejection and amending blocked intake require explicit superseding
workflow events; they remain visible control-tower remedies and are not silently
treated as completed actions.

Operational policy is currently fixed in code: 30 minutes to acknowledge a
delivered tender, 120 minutes before in-motion tracking is stale, and 24 hours
after delivered evidence before settlement becomes high priority. Change those
values through a reviewed deployment until per-customer policies have their own
authenticated configuration ledger.

---

## Procurement and physical positions

Open `/procurement` with `PAYLOAD_OPERATIONS_TOKEN`. The authenticated
`/api/procurement/actions` route operates this replayable aggregate:

```text
requirement -> supplier alternatives -> five-check qualification
            -> frozen feasible set -> selection -> purchase / position
            -> logistics requirement -> receipt -> settlement
```

Supplier qualification covers counterparty eligibility, sanctions screening,
specification match, credit terms, and authority to buy. A supplier enters the
feasible set only when all five are satisfied. Purchase binds the selected
supplier action to the signed contract and a server-derived physical-position
identity. Receipts may be partial but cannot exceed purchased quantity.

Settlement records purchase invoice, freight, duty, insurance, storage,
financing, loss, and revenue as observed values or typed absences. Landed cost
remains unavailable until every cost is observed; enter an evidenced zero only
when the actual cost is zero. Later evidence appends a settlement revision
linked to the prior event rather than overwriting history.

---

## Inventory, customer commitments, and sales

Open `/commercial` with `PAYLOAD_OPERATIONS_TOKEN`. The authenticated
`/api/commercial/actions` route operates the sell-side physical position:

```text
accepted procurement position -> inventory lot
customer purchase order -> commitment -> compatible lot allocation
-> sale contract -> freight-bound dispatch -> delivery -> settlement
```

An inventory lot can only be opened from the exact fully accepted procurement
position snapshot. Material, specification, quantity, custody location, and
landed-cost evidence are imported server-side instead of retyped. A source
position can open only one lot.
If invoices were still pending when the lot opened, `refresh_inventory_cost`
appends the complete cost from a newer exact procurement snapshot and
supersedes the prior cost-basis source without rewriting the lot history.

Reservations use the current commercial-book fingerprint and refuse stale or
incompatible allocations, inventory oversell, and allocation beyond customer
demand. A sale contract is accepted only when the customer commitment is fully
allocated and the contract binds the exact allocation set. An evidenced minimum
revenue is enforced before contract acceptance.

Dispatch binds that allocation set to one identified freight load operation.
Deliveries are captured per allocation so partial delivery, quarantine, and
rejection remain visible. Expected margin uses a disclosed proportional
received-quantity cost basis. Realized margin remains typed as incomplete until
gross revenue, deductions, source landed cost, and one currency are evidenced.
Settlement corrections append and supersede the prior settlement event.

---

## Authoritative freight-source pulls

The private `/api/freight/sources` route pulls two fixed official APIs: FMCSA
QCMobile for USDOT carrier identity, operating status, authority and
out-of-service evidence; and EIA API v2 for the latest weekly U.S. retail
on-highway diesel benchmark. Configure `FMCSA_WEB_KEY` and `EIA_API_KEY` plus
the same `PAYLOAD_OPERATIONS_TOKEN` used by the operation journal.

The response is normalized and excludes carrier address and telephone data.
Every successful provider response receives an evidence id and a reported,
disinterested attestation. API credentials are excluded from URLs in errors
and from evidence hashes. The source route is pull-through rather than a raw
proxy: provider hosts, paths, and the EIA series are fixed in code.

FMCSA's public response is useful regulatory evidence but is not a current
cargo certificate. `authorizationCarrier.insuranceExpiresAt` and
`cargoCoverAmount` therefore remain null, with explicit remedies, until an
insurer/broker record supplies them. An active authority status without an
actual grant date is also surfaced as missing rather than backfilled with the
retrieval date. This means the deterministic gate can refuse or remain
undetermined without ever inventing a pass.

---

## Restart and persistence semantics (D-8)

Determined by inspection, then verified.

| State | Survives restart? | Why |
|---|---|---|
| `data-archive/` (Comtrade vintages, miss log, export log, MCP session log) | **MUST, and does** — it is on disk, and in git | The Comtrade captures are the unreconstructable set. In a container this requires a MOUNTED VOLUME: an unmounted `data-archive` means every restart discards the day's captures and the demand evidence. Boot names the path and reports whether it is writable, but it cannot tell you the volume is ephemeral — that is a deploy-time decision. |
| Assembly memo (`stateCache`, 10-minute TTL) | No, and need not | Rebuilt on demand; boot warms it so the first researcher does not pay for it. |
| Adapter fetch caches (per-adapter TTL behind `load()`) | No, and need not | Same. |
| Derived state (graph, indices, propagation) | No — recomputed per request | Never persisted; it is a projection of canonical state by construction. |
| Session telemetry, MCP route-around counters, process counters | No, deliberately | Per-process by design (S-7: "an afternoon's session is one process"). The boot event marks where a lost window begins. Durable cross-restart telemetry is NOT built and is not claimed. |

**The consequence the order names, confirmed:** a cold restart re-fetches
every live source, because no fetch cache survives. With the outbound
limiter below that is polite rather than an incident, but it is still
real load — so do not restart in a loop, and mount the archive volume so
at least the captures are not repeated work.

**Verified:** `npm start` twice in sequence against the same archive
directory produces a boot report each time with the archive `writable`
and both commodities `ready`; the archive files present before the first
start are present after the second.

## Off-provider backup and the restore drill (D-9)

**Status: NOT DONE, and reported rather than adjusted.**

The current off-repository copy is `notationsystems/Information-Systems-Archive`
— GitHub to GitHub. The shipping order's S-2 report already recorded this
caveat, the response round ratified it as a standing item, and it remains
true: **one provider incident takes the archive and its backup together**,
and the Comtrade vintages are the unreconstructable set.

Moving the copy off-provider requires a credential to a second provider
(S3, B2, GCS, or physical media) that this build environment does not
have and must not invent. The restore drill onto a clean machine has the
same blocker. Both are recorded here as the operator's step, with the
mechanics ready:

```bash
# The archive is self-verifying: every file hashed in MANIFEST.json.
node scripts/archive-manifest.mjs          # regenerate after any archival
npx vitest run src/lib/economy/archiveManifest.test.ts   # verify tree vs manifest

# Off-provider copy (operator supplies the destination and credential):
tar czf sea-dog-archive-$(date -u +%F).tgz data-archive/
#   → upload to a provider that is NOT GitHub
#   → restore drill: fetch onto a clean machine, extract, run the verifier
#     above. A backup that has not been restored is a hypothesis.
```

Until that is executed, the honest statement is: the archive is
replicated, not backed up.

## A staging path (D-11)

**Status: mechanism ready, target is the operator's.**

The image is built and published by CI on every push to `main`. A staging
target is therefore one more instance of the same image, and promotion is
running the newer tag:

```bash
# staging: run the freshly built image on a second port
docker run -d -p 3001:3000 --name sea-dog-staging \
  ghcr.io/notationsystems/sea-dog-payload-terminal-v0:latest
node scripts/smoke.mjs http://localhost:3001    # the D-6 check, against staging

# promote: only after the smoke check passes
docker stop sea-dog && docker rm sea-dog
docker run -d -p 3000:3000 --name sea-dog \
  ghcr.io/notationsystems/sea-dog-payload-terminal-v0:latest
```

The rule the order is really asking for, stated plainly: **never deploy
to the instance a researcher has open without running `npm run smoke`
against a staging copy of the same image first.** Deploying under someone
mid-session is how a good instrument loses its only user.

## Exposure decisions (D-12) — TAKEN

F-6 prepared the options; these are the decisions, and the reasoning is
in `docs/EXPOSURE_OPTIONS.md`.

**1. Telemetry segregation — DECIDED: segregated, permanently.**
Machine traffic never enters the human demand instruments. It does not
increment session telemetry, does not write the miss log, does not write
the export log; it is observed separately in
`data-archive/mcp-sessions.jsonl`. This was the one with a deadline: the
S-7 continue criterion is frozen, its thresholds describe researchers,
and a model can generate ten miss-log entries in a second. Deciding it
after the afternoon would have been deciding it too late, because the
criterion cannot be amended then.

*What this means at day 90:* a corpus used heavily by models and by no
humans reads as UNUSED against the continue criterion. That is the
intended reading — the criterion asks whether the instrument earns a
researcher's return, and a model's curiosity is not evidence that it
does. If machine use should count toward continuation, that is a second
evaluation window with its own pre-registered threshold, not an
amendment to this one.

**2. Authentication — DECIDED: stdio only; no network surface.**
The MCP server speaks over standard input and output to a client on the
same machine. It opens no port and accepts no network connection, so
attaching requires the access that standing the instance up already
requires. No token store, no rotation, no auth middleware — because
there is nothing listening to authenticate. Revisit only if someone
actually needs remote attachment; until then this is the smallest
surface that makes the tools real.

**3. Inbound rate limiting — DECIDED: not needed at this surface, and
why.** A stdio server has exactly one client, which is the process that
spawned it; there is no inbound surface to flood. The outbound direction
— which is where a model client CAN do damage, by driving the instrument
into a rate-limit incident with the SEC or a courtesy violation with
Westmetall — is limited process-wide per host (D-10), and that limiter
applies to machine-driven requests identically because they take the
same code path. If an HTTP surface is ever added, inbound limiting must
be decided WITH it and not after.

## Machine-consumer licensing posture (D-13)

Recorded per source in the registry (`redistribution` +
`redistributionNote`), and **enforced at the MCP boundary**: a source
whose posture is `internal_only` or `unresolved` is withheld from machine
clients and returned as a typed refusal with its remedy — never omitted,
and never served on the assumption that silence means permission.

| Source | Posture | Served to machines? |
|---|---|---|
| USGS MCS | `public_domain` | Yes — US federal work |
| CFTC COT | `public_domain` | Yes — US federal publication |
| UN Comtrade | `attributed` | Yes — attribution travels on every record and claim sentence |
| Curated flow snapshot | `attributed` | Yes — ours, with its representative attestation attached |
| Westmetall (LME republish) | `internal_only` | **No** — republisher scrape carried for internal research; the licensed LME feed is the remedy |
| Yahoo (COMEX HG=F) | `internal_only` | **No** — terms cover personal/non-commercial use; benchmark only, so refusing costs nothing analytically |
| Anything unlisted or unbuilt | `unresolved` | **No** — unresolved refuses; defaulting to permissive is how a licensing question becomes a licensing incident |

A new source is refused to machine clients until someone records its
posture. That is deliberate friction in the correct direction.
