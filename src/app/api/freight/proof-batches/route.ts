import { NextResponse } from 'next/server';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { payloadEventDatabase } from '../../../../lib/economy/payloadEventDatabaseRuntime';
import { payloadSp1ProgramIdentity, proofBatchLifecycleSummary } from '../../../../lib/economy/sp1ProgramIdentity';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 4_096;

function databaseOrRefusal() {
  return payloadEventDatabase();
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const database = databaseOrRefusal();
  if (!database) return NextResponse.json({
    kind: 'refusal', code: 'PAYLOAD_DATABASE_NOT_CONFIGURED',
    detail: 'SP1 batch commitments require the globally ordered event database.',
    remedy: 'Configure PAYLOAD_DATABASE_PATH and migrate legacy journals first.',
  }, { status: 503 });
  const batches = database.listProofBatches();
  return NextResponse.json({
    kind: 'payload_proof_batch_list',
    trustedProgram: payloadSp1ProgramIdentity(),
    summary: proofBatchLifecycleSummary(batches),
    batches,
  });
}

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const database = databaseOrRefusal();
  if (!database) return NextResponse.json({
    kind: 'refusal', code: 'PAYLOAD_DATABASE_NOT_CONFIGURED',
    detail: 'SP1 batch commitments require the globally ordered event database.',
    remedy: 'Configure PAYLOAD_DATABASE_PATH and migrate legacy journals first.',
  }, { status: 503 });
  let raw: string;
  try { raw = await req.text(); }
  catch { return NextResponse.json({ error: 'proof_batch_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'proof_batch_too_large' }, { status: 413 });
  }
  let body: unknown = {};
  if (raw.trim()) {
    try { body = JSON.parse(raw); }
    catch { return NextResponse.json({ error: 'proof_batch_not_json' }, { status: 400 }); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => key !== 'throughSequence')) {
    return NextResponse.json({
      error: 'proof_batch_shape_invalid',
      detail: 'Expected an empty object or { throughSequence: integer }. Proofs and verification keys are written only by the leased SP1 worker.',
    }, { status: 400 });
  }
  const supplied = (body as { throughSequence?: unknown }).throughSequence;
  if (supplied !== undefined && (!Number.isSafeInteger(supplied) || Number(supplied) < 1)) {
    return NextResponse.json({ error: 'proof_batch_range_invalid' }, { status: 400 });
  }
  const result = database.createProofBatch(supplied === undefined ? undefined : Number(supplied));
  if (result.kind === 'refusal') {
    return NextResponse.json(result, { status: result.code === 'PROOF_BATCH_CONCURRENT_WRITE' ? 409 : 422 });
  }
  return NextResponse.json(result, { status: 201 });
}
