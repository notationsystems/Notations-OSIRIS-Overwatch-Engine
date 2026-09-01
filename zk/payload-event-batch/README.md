# Payload event-batch SP1 program

This workspace is the production proof boundary for `payload_event_batch_v1`.
The guest re-computes every domain record hash, per-stream chain transition,
global sequence, and Merkle root before committing public values. The host
binary generates an SP1 proof and separately verifies the saved artifact
against the locally built, pinned program verification key.

Build and run this boundary on Linux. Current SP1 SDK/JIT dependencies require
Unix file-descriptor and shared-memory facilities and do not compile as a
native Windows prover.

Build with the official SP1 toolchain:

```text
cd zk/payload-event-batch/script
cargo build --release
cargo run --release -- vkey
```

The web application never runs proving on an API request. Configure the
compiled binary, durable proof directory, and exact vkey through the
`PAYLOAD_SP1_*` settings, create a pending batch, then run
`npm run prove:event-batch` from a supervised worker. `SP1_PROVER=network`
selects the Succinct prover network; local proving remains available through
the SP1 SDK. A batch becomes `proved` only after the saved artifact passes the
SDK verifier and its committed public values exactly match the database range.
