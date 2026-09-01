/** Trusted identity for the checked-in Payload event-batch SP1 program. */

import ceremonyRecord from '../../../zk/payload-event-batch/verification-key.json';

export type Sp1ProgramIdentity = {
  readonly schemaVersion: 1;
  readonly program: 'payload_event_batch_v1';
  readonly sp1Version: string;
  readonly verificationKey: `0x${string}`;
  readonly guestSourceSha256: string;
  readonly ceremony: {
    readonly sourceCommit: string;
    readonly runUrl: string;
    readonly artifactId: number;
    readonly artifactDigest: `sha256:${string}`;
    readonly proofSha256: string;
    readonly generatedAt: string;
  };
};

const SHA256 = /^[a-f0-9]{64}$/;
const VKEY = /^0x[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SP1_VERSION = /^\d+\.\d+\.\d+$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SP1_PROGRAM_IDENTITY_INVALID: expected an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`SP1_PROGRAM_IDENTITY_INVALID: ${label} fields are not canonical`);
  }
}

export function parseSp1ProgramIdentity(value: unknown): Sp1ProgramIdentity {
  const root = object(value);
  exactKeys(root, ['schemaVersion', 'program', 'sp1Version', 'verificationKey', 'guestSourceSha256', 'ceremony'], 'root');
  const ceremony = object(root.ceremony);
  exactKeys(ceremony, ['sourceCommit', 'runUrl', 'artifactId', 'artifactDigest', 'proofSha256', 'generatedAt'], 'ceremony');
  if (root.schemaVersion !== 1 || root.program !== 'payload_event_batch_v1' ||
      typeof root.sp1Version !== 'string' || !SP1_VERSION.test(root.sp1Version) ||
      typeof root.verificationKey !== 'string' || !VKEY.test(root.verificationKey) ||
      typeof root.guestSourceSha256 !== 'string' || !SHA256.test(root.guestSourceSha256) ||
      typeof ceremony.sourceCommit !== 'string' || !COMMIT.test(ceremony.sourceCommit) ||
      typeof ceremony.runUrl !== 'string' || !/^https:\/\/github\.com\/.+\/actions\/runs\/\d+$/.test(ceremony.runUrl) ||
      !Number.isSafeInteger(ceremony.artifactId) || Number(ceremony.artifactId) < 1 ||
      typeof ceremony.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ceremony.artifactDigest) ||
      typeof ceremony.proofSha256 !== 'string' || !SHA256.test(ceremony.proofSha256) ||
      typeof ceremony.generatedAt !== 'string' || !Number.isFinite(Date.parse(ceremony.generatedAt))) {
    throw new Error('SP1_PROGRAM_IDENTITY_INVALID: ceremony record failed validation');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    program: 'payload_event_batch_v1' as const,
    sp1Version: root.sp1Version,
    verificationKey: root.verificationKey as `0x${string}`,
    guestSourceSha256: root.guestSourceSha256,
    ceremony: Object.freeze({
      sourceCommit: ceremony.sourceCommit,
      runUrl: ceremony.runUrl,
      artifactId: Number(ceremony.artifactId),
      artifactDigest: ceremony.artifactDigest as `sha256:${string}`,
      proofSha256: ceremony.proofSha256,
      generatedAt: ceremony.generatedAt,
    }),
  });
}

const trustedIdentity = parseSp1ProgramIdentity(ceremonyRecord);

export function payloadSp1ProgramIdentity(): Sp1ProgramIdentity {
  return trustedIdentity;
}

export function proofBatchLifecycleSummary(batches: readonly { readonly status: 'pending' | 'proving' | 'proved' | 'failed'; readonly eventCount: number }[]) {
  const summary = { total: batches.length, pending: 0, proving: 0, proved: 0, failed: 0, committedEvents: 0, provedEvents: 0 };
  for (const batch of batches) {
    summary[batch.status] += 1;
    summary.committedEvents += batch.eventCount;
    if (batch.status === 'proved') summary.provedEvents += batch.eventCount;
  }
  return Object.freeze(summary);
}
