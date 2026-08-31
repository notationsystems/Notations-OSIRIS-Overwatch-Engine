# SP1 program spec — `payload_condition_v1`

The circuit proves one statement and nothing more:

> Given committed readings with Merkle root `R`, predicate `P` with bounds and
> tolerance, and interval `[from, to]` — the excursion evaluation over those
> readings yields `verdictBit`.

## Public inputs (what a verifier checks against)

```
root:         [u8; 32]      // must match the posted commitment
predicate_id: String        // versioned; changing a threshold changes this
bounds_min:   Option<i32>   // millidegrees, integer — no floats in circuit
bounds_max:   Option<i32>
tolerance_s:  u32
covers_from:  u64           // unix seconds
covers_to:    u64
verdict_bit:  u8            // 0 = held, 1 = breached
```

## Private inputs (never revealed)

```
readings:     Vec<(u64 at, i32 value_milli, [u8;32] device_hash)>
merkle_paths: Vec<...>      // proving each reading is in the committed set
```

## Circuit obligations

1. **Membership** — every reading verifies against `root` under the canonical
   leaf encoding
   `sha256("payload.notary.leaf.v1|{at}|{channel}|{value_milli}|{device}")`,
   where `at` is **unix seconds** and `value_milli` is an **integer**.
2. **Completeness** — the count of verified leaves equals the committed
   `leafCount`, so a prover cannot omit the inconvenient readings.
3. **Ordering** — readings are sorted by `(at, channel)`; the circuit asserts
   monotonic `at`.
4. **Evaluation** — the excursion walk in `notary.ts::evaluateCondition`, in
   integer millidegrees. An open excursion at `covers_to` is closed against
   `covers_to`.
5. **Verdict** — `verdict_bit` equals the computed result. The circuit does not
   choose it.

## Internal-node encoding

Internal nodes are `sha256("payload.notary.node.v1|{left}|{right}")`, domain-
separated from leaves. Odd nodes carry up unchanged.

Without domain separation a value whose encoding resembled a concatenated hash
pair could be presented as an internal node. The separation costs nothing and
closes the shape entirely.

## Deliberately NOT in the circuit

- **Coverage / gap analysis.** Gaps are about readings that DO NOT EXIST, and a
  circuit cannot prove absence from a set it was given. Coverage is computed in
  the clear from the commitment's `leafCount` and the interval, and a gap forces
  `unproven` *before* the prover is invoked.
- **Device attestation.** Different trust root, different proof. Carried
  alongside in `DeviceTrust`, never merged — otherwise a cryptographic proof
  launders an unattested sensor.

## Two encoding hazards, both found by test

**Timestamps.** The reference initially hashed the raw ISO string. That makes
`2026-08-30T01:00:00.000Z` and `2026-08-30T02:00:00+01:00` — the same instant —
produce different leaves, while the circuit (parsing to `u64` seconds) produces
one. A reference and a circuit disagreeing on the encoding disagree on every
root, silently, since both look internally consistent. `canonicalAt()` now
converts to unix seconds and refuses sub-second precision the circuit cannot
represent.

**Values.** The reference initially hashed the float. `assertMilli()` now
converts to integer millidegrees and refuses anything not exactly
representable, rather than committing a stable-looking root over a value the
circuit cannot reproduce.

## The completeness obligation rests on the in-time rule

Obligation 2 stops a prover omitting readings **after** committing. It cannot
stop a committer curating **before** committing — completeness is relative to
the commitment, and the commitment's honesty rests entirely on
`postedInTime()`. The two are one guarantee and neither works alone.

## Equivalence obligation

`notary.ts::evaluateCondition` is the reference. When the circuit lands, a
differential test generates random reading sequences and asserts circuit and
reference agree on every one. A divergence is a defect in whichever is wrong —
the point is that it is detectable.
