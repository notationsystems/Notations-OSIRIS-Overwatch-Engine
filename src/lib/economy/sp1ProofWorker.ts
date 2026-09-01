/** Leased production worker for proving and independently verifying event batches with SP1. */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { PayloadProofBatch } from './payloadEventDatabase';
import { PayloadEventDatabase } from './payloadEventDatabase';

export type Sp1WorkerResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'proved'; readonly batch: PayloadProofBatch; readonly proofPath: string }
  | { readonly kind: 'refusal'; readonly code: 'SP1_WORKER_NOT_CONFIGURED' | 'SP1_WORKER_FAILED'; readonly detail: string; readonly remedy: string };

type VerifiedResult = {
  readonly proofId: string;
  readonly verificationKey: string;
  readonly proofMode: 'core' | 'compressed' | 'groth16' | 'plonk';
  readonly publicValues: Readonly<Record<string, unknown>>;
};

function configuredPath(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value || !isAbsolute(value)) return null;
  return resolve(value);
}

function run(executable: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`SP1 process exceeded ${timeoutMs}ms`)); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`SP1 process exited ${code}: ${stderr.trim().slice(0, 4000)}`));
    });
  });
}

function refusal(code: Extract<Sp1WorkerResult, { kind: 'refusal' }>['code'], detail: string, remedy: string): Sp1WorkerResult {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

export async function runOneSp1Proof(database: PayloadEventDatabase, options: {
  readonly workerId: string;
  readonly executable?: string;
  readonly proofDirectory?: string;
  readonly verificationKey?: string;
  readonly proofMode?: 'core' | 'compressed' | 'groth16' | 'plonk';
  readonly leaseSeconds?: number;
  readonly timeoutMs?: number;
}): Promise<Sp1WorkerResult> {
  const executable = options.executable ? resolve(options.executable) : configuredPath('PAYLOAD_SP1_EXECUTABLE');
  const proofDirectory = options.proofDirectory ? resolve(options.proofDirectory) : configuredPath('PAYLOAD_SP1_PROOF_DIR');
  const verificationKey = options.verificationKey ?? process.env.PAYLOAD_SP1_VERIFICATION_KEY?.trim();
  const proofMode = options.proofMode ?? (process.env.PAYLOAD_SP1_PROOF_MODE as typeof options.proofMode | undefined) ?? 'core';
  if (!executable || !proofDirectory || !verificationKey) return refusal('SP1_WORKER_NOT_CONFIGURED', 'SP1 executable, durable proof directory, or pinned verification key is missing.', 'Build the checked-in SP1 worker and configure absolute PAYLOAD_SP1_EXECUTABLE, PAYLOAD_SP1_PROOF_DIR, and PAYLOAD_SP1_VERIFICATION_KEY paths/values.');
  if (!['core', 'compressed', 'groth16', 'plonk'].includes(proofMode)) return refusal('SP1_WORKER_NOT_CONFIGURED', `Unsupported proof mode ${proofMode}.`, 'Use core, compressed, groth16, or plonk as supported by the installed worker.');
  // The lease deliberately spans the default prover timeout. A proof that is
  // still executing must not become claimable by a second worker.
  const claim = database.claimProofBatch(options.workerId, options.leaseSeconds ?? 3_600);
  if (claim.kind === 'idle') return { kind: 'idle' };
  if (claim.kind === 'refusal') return refusal('SP1_WORKER_FAILED', claim.detail, claim.remedy);
  const temporary = await mkdtemp(resolve(tmpdir(), 'payload-sp1-'));
  await mkdir(proofDirectory, { recursive: true });
  const safeBatch = claim.batch.batchId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const witnessPath = resolve(temporary, 'witness.json');
  const resultPath = resolve(temporary, 'verified.json');
  const proofPath = resolve(proofDirectory, `${safeBatch}.${proofMode}.proof`);
  try {
    await writeFile(witnessPath, `${JSON.stringify(claim.witness)}\n`, 'utf8');
    const timeout = options.timeoutMs ?? 3_500_000;
    await run(executable, ['prove', '--witness', witnessPath, '--proof', proofPath, '--mode', proofMode], timeout);
    await run(executable, ['verify', '--proof', proofPath, '--result', resultPath, '--expected-vkey', verificationKey], timeout);
    const verified = JSON.parse(await readFile(resultPath, 'utf8')) as VerifiedResult;
    if (verified.verificationKey !== verificationKey || verified.proofMode !== proofMode || !verified.proofId?.trim() || !verified.publicValues) throw new Error('SP1 verifier result does not match the pinned worker configuration');
    const proofBytes = await readFile(proofPath);
    const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
    const batch = database.completeProofBatch({ batchId: claim.batch.batchId, workerId: options.workerId, proofId: `${verified.proofId}:${basename(proofPath)}`, verificationKey, proofMode, proofSha256, publicValues: verified.publicValues, verifiedAt: new Date().toISOString() });
    return Object.freeze({ kind: 'proved' as const, batch, proofPath });
  } catch (error) {
    try { database.failProofBatch(claim.batch.batchId, options.workerId, (error as Error).message); } catch { /* lease loss is surfaced in the returned failure */ }
    return refusal('SP1_WORKER_FAILED', (error as Error).message, 'Inspect the SP1 worker and prover backend, then rerun the same leased batch after correcting the failure. Three failed attempts remain failed for operator review. Never mark an unverified artifact proved.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
