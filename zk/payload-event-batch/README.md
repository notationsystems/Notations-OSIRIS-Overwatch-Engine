# Payload event-batch SP1 program

This workspace is the production proof boundary for `payload_event_batch_v1`.
The guest re-computes every domain record hash, per-stream chain transition,
global sequence, and Merkle root before committing public values. The host
binary generates an SP1 proof and separately verifies the saved artifact
against the locally built, pinned program verification key.

## Verification-key ceremony

The program identity is pinned in [`verification-key.json`](verification-key.json).
It was derived by SP1 6.5.0 from a Linux release build and first exercised by a
real CPU proof in [ceremony run 33547289579](https://github.com/notationsystems/Payload-Terminal-V0/actions/runs/33547289579).
That run verified the proof before sealing its proof digest, guest-source
digest, source commit, and artifact provenance into the committed record.

Every ceremony workflow run rebuilds the guest, derives its verification key,
and fails before proving if the key, SP1 version, program name, or guest-source
digest differs from the committed pin. It then
generates and verifies a fresh fixture proof and retains the proof, verified
public values, and sealed ceremony record as a GitHub Actions artifact for 90
days. Any intentional guest-program change therefore requires a new, reviewed
key-rotation ceremony rather than silently changing the trusted program.

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
compiled binary and durable proof directory through the `PAYLOAD_SP1_*`
settings, create a pending batch, then run
`npm run prove:event-batch` from a supervised worker. `SP1_PROVER=network`
selects the Succinct prover network; local proving remains available through
the SP1 SDK. The committed ceremony record supplies the authoritative key; an
optional environment key must match it. The worker checks the binary's key
before leasing. A batch becomes `proved` only after the saved artifact passes
the SDK verifier and its committed public values exactly match the database
range.
