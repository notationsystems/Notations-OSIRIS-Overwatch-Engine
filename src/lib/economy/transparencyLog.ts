// src/lib/economy/transparencyLog.ts
//
// THE INTERNAL RECORD — and why it is not a blockchain.
//
// A blockchain solves CONSENSUS AMONG MUTUALLY DISTRUSTING WRITERS. Internally
// there is one writer, so consensus is free and its machinery is pure overhead:
// you would be paying for Byzantine fault tolerance against yourself.
//
// And a private chain where you control every node CANNOT PROVE YOU DID NOT
// REWRITE IT. "The chain says so" means "we say so" — which is precisely the
// claim a customer or auditor needs, and the one a private chain cannot make.
//
// What you actually want is tamper-evidence and third-party verifiability: a
// Merkle transparency log, the RFC 6962 / Certificate Transparency design. It
// gives two proofs, and the second is the one people do not realise they want:
//
//   INCLUSION    "your record is in the log" — log2(n) sibling hashes, verified
//                without seeing anyone else's data.
//   CONSISTENCY  "the log at 100 records is an append-only extension of the log
//                at 64." A customer holding an old root can prove you did not
//                quietly alter record 12.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THAT MADE THE FIRST BUILD LOOK CORRECT
// ─────────────────────────────────────────────────────────────────────────────
//
// The first implementation emitted the audit path BOTTOM-UP and verified it
// TOP-DOWN, so every valid proof failed. The tamper test beside it PASSED — it
// rejected the altered record because verification was broken for EVERYTHING,
// not because it detected anything.
//
// A passing negative test next to a failing positive one is vacuous and reads as
// coverage. It is the same shape as a guard whose effective scope is narrower
// than its apparent scope, with nothing failing — here, a verifier whose
// effective scope was ZERO. `transparencyLog.test.ts` pins the positive case
// first and asserts the pair together, because the negative alone proves nothing.
//
// This module implements the RFC 6962 algorithms specifically because AN
// EXTERNAL PARTY RUNS THE VERIFIER, not us. A bespoke scheme that only our code
// can check gives back the trust the log exists to remove.

import { createHash } from 'crypto';
import type { ISODateTime, Hash } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Hashing — RFC 6962 domain separation
// ─────────────────────────────────────────────────────────────────────────────

const sha256 = (b: Buffer): Hash => createHash('sha256').update(b).digest('hex');
const hex = (h: Hash) => Buffer.from(h, 'hex');

/** MTH({}) = SHA-256() — the empty tree has a defined root, not a null one. */
export const EMPTY_ROOT: Hash = sha256(Buffer.alloc(0));

/** Leaves are prefixed 0x00, internal nodes 0x01, so no leaf can pose as a node. */
export function leafHash(data: string): Hash {
  return sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(data, 'utf8')]));
}

export function nodeHash(left: Hash, right: Hash): Hash {
  return sha256(Buffer.concat([Buffer.from([0x01]), hex(left), hex(right)]));
}

/** Largest power of two strictly less than n. RFC 6962's `k`. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH(D[n]) over already-hashed leaves. */
export function merkleTreeHash(leaves: readonly Hash[]): Hash {
  if (leaves.length === 0) return EMPTY_ROOT;
  if (leaves.length === 1) return leaves[0];
  const k = splitPoint(leaves.length);
  return nodeHash(merkleTreeHash(leaves.slice(0, k)), merkleTreeHash(leaves.slice(k)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The log — append only. No update, no delete. A correction is a new record.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogRecord {
  /** The party this record belongs to, for scoped serving. */
  ownerId: string;
  /** Canonical serialization. What is hashed IS what is served. */
  data: string;
}

export const LOG_APPEND_ONLY = 'LOG_APPEND_ONLY';

export class TransparencyLog {
  private readonly leaves: Hash[] = [];
  private readonly records: LogRecord[] = [];
  /**
   * SUBTREE CACHE, and the reason it exists is a benchmark that measured the
   * wrong thing.
   *
   * Appending is `leafHash` plus a push, and it clocks 276,000-376,000 records/s.
   * That number is real and it measures the operation NOBODY WAITS ON. Measured
   * on the uncached version over 20,000 records:
   *
   *     append 20,000      53-72 ms      (~300k rec/s)
   *     root once          62-76 ms      <- a tree head costs this
   *     one inclusion proof 64-69 ms     <- a CUSTOMER waits on this
   *
   * A log that appends at 300k/s and takes 70 ms to answer one customer is not
   * fast where it matters, and quoting the append rate against "a private chain
   * does tens per second" compares an append that commits to nothing against a
   * chain transaction that commits and reaches consensus. Different denominators,
   * plausible number.
   *
   * The log is append-only, so the hash of any canonical range [lo, hi) is fixed
   * once computed — the cache is permanently valid rather than invalidated on
   * write, which is the property that makes it safe here and would not be safe
   * on a mutable store.
   */
  private readonly rangeCache = new Map<string, Hash>();

  get size(): number { return this.leaves.length; }

  /** MTH over leaves [lo, hi), memoized. RFC 6962 splits are deterministic. */
  private rangeHash(lo: number, hi: number): Hash {
    if (hi <= lo) return EMPTY_ROOT;
    if (hi - lo === 1) return this.leaves[lo];
    const key = `${lo}:${hi}`;
    const hit = this.rangeCache.get(key);
    if (hit !== undefined) return hit;
    const k = splitPoint(hi - lo);
    const h = nodeHash(this.rangeHash(lo, lo + k), this.rangeHash(lo + k, hi));
    this.rangeCache.set(key, h);
    return h;
  }

  /**
   * Append and return the index. There is deliberately no `update` and no
   * `delete`: the log is the integrity spine, and a mutable spine proves
   * nothing. A correction is a NEW record that supersedes, which is also how the
   * correction becomes auditable rather than invisible.
   */
  append(rec: LogRecord): number {
    this.leaves.push(leafHash(rec.data));
    this.records.push(rec);
    return this.leaves.length - 1;
  }

  root(atSize: number = this.leaves.length): Hash {
    if (atSize < 0 || atSize > this.leaves.length) {
      throw new Error(
        `${LOG_APPEND_ONLY}: asked for the root at size ${atSize} of a log holding ` +
        `${this.leaves.length}. A root for a size the log never had is not a historical ` +
        'root, it is a fabricated one.',
      );
    }
    return this.rangeHash(0, atSize);
  }

  recordAt(i: number): LogRecord | undefined { return this.records[i]; }

  /** Indices owned by one party. Scoped serving — a customer gets theirs, not everyone's. */
  indicesFor(ownerId: string): number[] {
    return this.records.flatMap((r, i) => (r.ownerId === ownerId ? [i] : []));
  }

  /**
   * PATH(m, D[n]) — the audit path, BOTTOM-UP, as RFC 6962 defines it and as an
   * external verifier will expect it.
   */
  inclusionProof(m: number, atSize: number = this.leaves.length): Hash[] {
    if (m < 0 || m >= atSize || atSize > this.leaves.length) {
      throw new Error(
        `transparencyLog: no inclusion proof for leaf ${m} at size ${atSize} ` +
        `(log holds ${this.leaves.length}). Asking for one would return a path that ` +
        'verifies against nothing, which is worse than an error.',
      );
    }
    const path = (i: number, lo: number, hi: number): Hash[] => {
      if (hi - lo === 1) return [];
      const k = splitPoint(hi - lo);
      return i < lo + k
        ? [...path(i, lo, lo + k), this.rangeHash(lo + k, hi)]
        : [...path(i, lo + k, hi), this.rangeHash(lo, lo + k)];
    };
    return path(m, 0, atSize);
  }

  /** PROOF(m, D[n]) — consistency between an old size and the current one. */
  consistencyProof(oldSize: number, newSize: number = this.leaves.length): Hash[] {
    if (oldSize < 0 || oldSize > newSize || newSize > this.leaves.length) {
      throw new Error(
        `transparencyLog: no consistency proof from ${oldSize} to ${newSize} ` +
        `(log holds ${this.leaves.length}).`,
      );
    }
    if (oldSize === 0) return [];
    const sub = (m: number, lo: number, hi: number, b: boolean): Hash[] => {
      if (m === hi - lo) return b ? [] : [this.rangeHash(lo, hi)];
      const k = splitPoint(hi - lo);
      return m <= k
        ? [...sub(m, lo, lo + k, b), this.rangeHash(lo + k, hi)]
        : [...sub(m - k, lo + k, hi, false), this.rangeHash(lo, lo + k)];
    };
    return sub(oldSize, 0, newSize, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Verification — what the COUNTERPARTY runs, holding no log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC 6962 §2.1.1, BOTTOM-UP, by index arithmetic.
 *
 * THE DIRECTION IS THE WHOLE DEFECT, AND I WALKED INTO IT TOO. My first verifier
 * here recursed from the top, splitting the tree at `k` and consuming `proof[0]`
 * at the top level — while `inclusionProof` emits the DEEPEST sibling first. Leaf
 * 0 verified (its path happens to be symmetric under that mistake) and leaf 1 did
 * not, so 5 of 43 pins failed.
 *
 * And the tamper pin beside it PASSED, rejecting the altered record because
 * verification was broken for everything. That is the vacuity exactly as
 * described: a passing negative test next to a failing positive one proves
 * nothing and reads as coverage. What caught it was asserting the POSITIVE case
 * first and over every leaf rather than one convenient index.
 *
 * This is the algorithm an external verifier implements, which is the point —
 * a scheme only our code can check hands back the trust the log exists to remove.
 */
export function verifyInclusion(args: {
  data: string; leafIndex: number; treeSize: number; proof: readonly Hash[]; root: Hash;
}): boolean {
  const { leafIndex, treeSize, proof, root } = args;
  if (leafIndex < 0 || treeSize < 0 || leafIndex >= treeSize) return false;
  let fn = leafIndex, sn = treeSize - 1;
  let r: Hash = leafHash(args.data);
  for (const sibling of proof) {
    // A proof longer than the tree is deep is not a valid proof that happens to
    // be long — it is a proof for a different tree, and accepting it would let a
    // prover pad a path until something matched.
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(sibling, r);
      while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = nodeHash(r, sibling);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && r === root;
}

/**
 * Consistency (RFC 6962 §2.1.2): is `newRoot` at `newSize` an append-only
 * extension of `oldRoot` at `oldSize`?
 *
 * THE PROPERTY A PRIVATE CHAIN UNDER OUR OWN CONTROL CANNOT GIVE. We control
 * every node, so "the chain says so" means "we say so". A consistency proof
 * against a root the customer already holds does not.
 */
export function verifyConsistency(args: {
  oldSize: number; oldRoot: Hash; newSize: number; newRoot: Hash; proof: readonly Hash[];
}): boolean {
  const { oldSize, oldRoot, newSize, newRoot, proof } = args;
  if (oldSize < 0 || newSize < 0 || oldSize > newSize) return false;
  if (oldSize === newSize) return proof.length === 0 && oldRoot === newRoot;
  if (oldSize === 0) return true;

  let fn = oldSize - 1, sn = newSize - 1;
  while ((fn & 1) === 1) { fn >>= 1; sn >>= 1; }

  let start = 0;
  let fr: Hash, sr: Hash;
  if (fn === 0) {
    // The old tree is a complete left subtree; its root IS the seed.
    fr = oldRoot; sr = oldRoot;
  } else {
    if (proof.length === 0) return false;
    fr = proof[0]; sr = proof[0]; start = 1;
  }

  for (let i = start; i < proof.length; i++) {
    const c = proof[i];
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && fr === oldRoot && sr === newRoot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The receipt — and the trust note that does not overstate
// ─────────────────────────────────────────────────────────────────────────────

export type AnchorKind = 'internal' | 'timestamp_authority' | 'public_chain';

export interface SignedTreeHead {
  treeSize: number;
  root: Hash;
  /** Injected. A log that reads a clock cannot be replayed in a dispute. */
  publishedAt: ISODateTime;
  signature: string;
  anchor: { kind: AnchorKind; ref: string | null; anchoredAt: ISODateTime | null };
}

export interface InclusionReceipt {
  ownerId: string;
  leafIndex: number;
  data: string;
  proof: Hash[];
  sth: SignedTreeHead;
  /** States its own limit rather than implying it away. */
  trustNote: string;
}

/**
 * ANCHORING IS WHAT MAKES THE TIMESTAMP UNFORGEABLE, and it does not require
 * being a chain: publish the tree head to a timestamp authority or a public
 * chain, ONE TRANSACTION PER BATCH, not per record.
 *
 * The note distinguishes the two cases instead of letting a reader assume the
 * stronger one — an internally-anchored head proves the record is in the log AS
 * WE PUBLISHED IT, and says exactly that.
 */
export function trustNoteFor(anchor: SignedTreeHead['anchor']): string {
  return anchor.kind === 'internal'
    ? 'This tree head is signed by Payload and anchored only in our own log. It proves the ' +
      'record is in the log AS WE PUBLISHED IT; it does not prove we published that root at ' +
      'that time to anyone else. Request an externally anchored head for a dispute.'
    : `Tree head anchored via ${anchor.kind}${anchor.ref ? ` (${anchor.ref})` : ''}` +
      `${anchor.anchoredAt ? ` at ${anchor.anchoredAt}` : ''}. The root existed at the anchored ` +
      'time independently of Payload, so the inclusion proof is checkable without trusting us.';
}

export function issueReceipt(
  log: TransparencyLog, leafIndex: number, sth: SignedTreeHead,
): InclusionReceipt {
  const rec = log.recordAt(leafIndex);
  if (!rec) throw new Error(`transparencyLog: no record at ${leafIndex}`);
  return {
    ownerId: rec.ownerId, leafIndex, data: rec.data,
    // The audit path leaks SIBLING HASHES ONLY, never another party's payload.
    proof: log.inclusionProof(leafIndex, sth.treeSize),
    sth,
    trustNote: trustNoteFor(sth.anchor),
  };
}

export function verifyReceipt(r: InclusionReceipt): boolean {
  return verifyInclusion({
    data: r.data, leafIndex: r.leafIndex, treeSize: r.sth.treeSize,
    proof: r.proof, root: r.sth.root,
  });
}
