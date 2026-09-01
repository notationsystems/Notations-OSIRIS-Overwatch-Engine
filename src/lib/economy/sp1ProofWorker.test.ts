import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PayloadProofBatch, PayloadEventDatabase } from './payloadEventDatabase';
import { payloadSp1ProgramIdentity } from './sp1ProgramIdentity';
import { runOneSp1Proof, type Sp1CommandRunner } from './sp1ProofWorker';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function pendingBatch(): PayloadProofBatch {
  return {
    batchId: 'proof-batch:test:001',
    fromSequence: 1,
    toSequence: 1,
    eventCount: 1,
    root: 'b'.repeat(64),
    program: 'payload_event_batch_v1',
    proverSystem: 'sp1',
    status: 'proving',
    createdAt: '2026-09-01T10:00:00.000Z',
    proofId: null,
    verificationKey: null,
    proofMode: null,
    proofSha256: null,
    publicValues: null,
    verifiedAt: null,
    leaseOwner: 'worker:test',
    leaseExpiresAt: '2099-09-01T11:00:00.000Z',
    attempts: 1,
    error: null,
  };
}

describe('SP1 proof worker trust boundary', () => {
  it('preflights the binary before leasing, then persists only independently verified output', async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), 'payload-sp1-worker-test-'));
    temporaryDirectories.push(temporary);
    const identity = payloadSp1ProgramIdentity();
    const batch = pendingBatch();
    const commands: string[] = [];
    let claims = 0;
    let completion: Record<string, unknown> | null = null;
    const publicValues = {
      program: batch.program,
      batchId: batch.batchId,
      fromSequence: batch.fromSequence,
      toSequence: batch.toSequence,
      eventCount: batch.eventCount,
      root: batch.root,
      finalHashes: {},
    };
    const commandRunner: Sp1CommandRunner = async (_executable, args) => {
      commands.push(args[0]);
      if (args[0] === 'vkey') return { stdout: `${identity.verificationKey}\n`, stderr: '' };
      const pathAfter = (flag: string) => args[args.indexOf(flag) + 1];
      if (args[0] === 'prove') await writeFile(pathAfter('--proof'), 'verified-proof-bytes', 'utf8');
      if (args[0] === 'verify') await writeFile(pathAfter('--result'), JSON.stringify({
        proofId: 'sp1:test-proof',
        verificationKey: identity.verificationKey,
        proofMode: 'core',
        publicValues,
      }), 'utf8');
      return { stdout: '', stderr: '' };
    };
    const database = {
      claimProofBatch: () => {
        claims += 1;
        return { kind: 'claimed', batch, witness: { schema: 'payload.event_batch.witness.v1' } };
      },
      completeProofBatch: (input: Record<string, unknown>) => {
        completion = input;
        return { ...batch, status: 'proved', proofId: input.proofId };
      },
      failProofBatch: () => { throw new Error('unexpected failure'); },
    } as unknown as PayloadEventDatabase;

    const result = await runOneSp1Proof(database, {
      workerId: 'worker:test',
      executable: resolve(temporary, 'payload-sp1-worker'),
      proofDirectory: resolve(temporary, 'proofs'),
      verificationKey: identity.verificationKey,
      commandRunner,
    });

    expect(result.kind).toBe('proved');
    expect(claims).toBe(1);
    expect(commands).toEqual(['vkey', 'prove', 'verify']);
    expect(completion).toMatchObject({
      batchId: batch.batchId,
      workerId: 'worker:test',
      verificationKey: identity.verificationKey,
      proofMode: 'core',
      proofSha256: createHash('sha256').update('verified-proof-bytes').digest('hex'),
      publicValues,
    });
  });

  it('refuses a mismatched executable before consuming a database attempt', async () => {
    let claims = 0;
    const database = {
      claimProofBatch: () => { claims += 1; return { kind: 'idle' }; },
    } as unknown as PayloadEventDatabase;
    const result = await runOneSp1Proof(database, {
      workerId: 'worker:test',
      executable: resolve(tmpdir(), 'wrong-payload-sp1-worker'),
      proofDirectory: resolve(tmpdir(), 'payload-sp1-proofs'),
      commandRunner: async () => ({ stdout: `0x${'f'.repeat(64)}\n`, stderr: '' }),
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'SP1_PROGRAM_IDENTITY_MISMATCH' });
    expect(claims).toBe(0);
  });

  it('refuses a stale key override without invoking the binary or database', async () => {
    let calls = 0;
    const database = { claimProofBatch: () => { calls += 1; return { kind: 'idle' }; } } as unknown as PayloadEventDatabase;
    const result = await runOneSp1Proof(database, {
      workerId: 'worker:test',
      executable: resolve(tmpdir(), 'payload-sp1-worker'),
      proofDirectory: resolve(tmpdir(), 'payload-sp1-proofs'),
      verificationKey: `0x${'e'.repeat(64)}`,
      commandRunner: async () => { calls += 1; return { stdout: '', stderr: '' }; },
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'SP1_PROGRAM_IDENTITY_MISMATCH' });
    expect(calls).toBe(0);
  });
});
