# SP1 program boundary — `payload_event_batch_v1`

## Purpose

Prove that a disclosed Payload event-batch root represents an exact contiguous
slice of the globally ordered PayloadOS database and that its load,
carrier-communication, and procurement domain chains are internally consistent.
The proof is evidence about recorded history;
it never authorizes, assigns, dispatches, or delays a load.

## Public values

- program version: `payload_event_batch_v1`;
- `fromSequence`, `toSequence`, and `eventCount`;
- the batch Merkle root;
- the operation-chain root before and after the batch, when the batch contains
  operation events;
- the communication-chain root before and after the batch, when the batch
  contains communication events;
- the procurement-chain root before and after the batch, when the batch
  contains procurement events;
- optional disclosed statement output for a specialized program.

## Private witness

- canonical event JSON for every sequence in the batch;
- stream identity, previous hash, and record hash for every event;
- the immediately preceding record hash for each domain stream.

Raw customer documents, contact details, credentials, and carrier gateway
tokens are not witnesses. The event database already stores sanitized typed
facts and evidence references rather than source documents.

## Required checks

1. Sequences are strictly contiguous from `fromSequence` through `toSequence`.
2. Every event's indexed identity equals the identity in canonical event JSON.
3. Every command hash is 32 bytes and every domain record hash reconstructs
   from its versioned domain, previous hash, and canonical event.
4. Operation, communication, and procurement events extend only their named
   domain chain.
5. Batch leaves are
   `sha256("payload.event_batch.leaf.v1|sequence|stream|recordHash")`.
6. Internal nodes are
   `sha256("payload.event_batch.node.v1|left|right")`; an odd node carries up.
7. The computed batch root and event count equal the public values.

The TypeScript reference is `payloadEventBatchRoot` in
`src/lib/economy/payloadEventDatabase.ts`. Circuit and reference equivalence
must be pinned with shared fixtures before a proof may be called valid.

## High-value specialized proofs

The batch proof establishes log integrity. It should be followed by smaller
programs that reveal only the commercial statement a counterparty needs:

- `payload_dispatch_authorized_v1`: the executed load, selected carrier, and
  action exactly match a prior five-check authorization marked `authorized`;
- `payload_tender_bound_v1`: a carrier delivery receipt binds to the immutable
  dispatch envelope and selected carrier without disclosing shipper target rate;
- `payload_settlement_margin_v1`: disclosed gross margin equals shipper revenue
  less carrier invoice and accessorial cost in one currency, while underlying
  amounts may remain private;
- `payload_condition_v1`: the existing reefer/condition program described in
  `docs/notary.program.md`.

## Worker lifecycle (not implemented in this increment)

1. claim a `pending` batch with a database lease;
2. build the canonical witness from the exact committed range;
3. prove with SP1 outside the request/dispatch path;
4. verify locally against the configured verification key;
5. append a proof-result event and set the batch to `proved`, or retain a typed
   failure and retry policy;
6. anchor selected roots outside Payload when independent timestamping matters.

Until that worker and verification-key ceremony exist, a pending batch is a
Merkle commitment prepared for proving, not a zk proof and not described as one.
