import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from '../../../../lib/economy/envCompat';
import {
  type AuthorizeAlternativeCommand,
  type CaptureOperationOutcomeCommand,
  type DispatchOperationCommand,
  type ExploreOperationAssignmentCommand,
  type LoadOperationCommandResult,
  type OpenOperationEpisodeCommand,
  type RecordOperationAssignmentCommand,
  type RegisterAlternativeCommand,
  type RegisterOpportunityCommand,
} from '../../../../lib/economy/loadOperations';
import { loadOperationsWorkflow } from '../../../../lib/economy/loadOperationsRuntime';
import {
  settlementOutcomeCommand,
  type OperationalSettlementEvidence,
} from '../../../../lib/economy/loadOutcomeCapture';

export const runtime = 'nodejs';

const MAX_COMMAND_BYTES = 1_000_000;

function configuredToken(): string | null {
  const token = env('PAYLOAD_OPERATIONS_TOKEN');
  return token?.trim() ? token : null;
}

function tokenMatches(req: Request, expected: string): boolean {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function authorizeSurface(req: Request): NextResponse | null {
  const token = configuredToken();
  if (!token) {
    return NextResponse.json({
      error: 'operations_not_configured',
      detail: 'Persistent load operations are fail-closed until PAYLOAD_OPERATIONS_TOKEN is configured.',
      remedy: 'Set a deployment secret and send it as a Bearer token; never expose this route anonymously.',
    }, { status: 503 });
  }
  if (!tokenMatches(req, token)) {
    return NextResponse.json({
      error: 'operations_unauthorized',
      detail: 'The request did not carry the configured operations authority.',
      remedy: 'Authenticate as an authorized Terminal operator.',
    }, { status: 401 });
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function statusFor(result: LoadOperationCommandResult): number {
  if (result.kind === 'accepted') return result.persistence === 'appended' ? 201 : 200;
  if (result.code === 'OPERATION_NOT_FOUND') return 404;
  if (result.code === 'OPERATION_STORE_UNAVAILABLE' || result.code === 'OPERATION_STORE_CORRUPT') return 503;
  if (result.code === 'OPERATION_EVENT_ID_CONFLICT' || result.code === 'OPERATION_PHASE_INVALID' ||
      result.code === 'OPERATION_ALREADY_REGISTERED' || result.code === 'OPERATION_ALTERNATIVE_DUPLICATE' ||
      result.code === 'OPERATION_STORE_CONCURRENT_WRITE') return 409;
  return 422;
}

export async function GET(req: Request) {
  const denied = authorizeSurface(req);
  if (denied) return denied;
  const operationId = new URL(req.url).searchParams.get('operationId');
  const workflow = loadOperationsWorkflow();
  const result = operationId ? await workflow.get(operationId) : await workflow.list();
  if (Array.isArray(result)) return NextResponse.json({ operations: result });
  if ('kind' in result && result.kind === 'refusal') {
    return NextResponse.json(result, { status: result.code === 'OPERATION_NOT_FOUND' ? 404 : 503 });
  }
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const denied = authorizeSurface(req);
  if (denied) return denied;
  let bodyText: string;
  try { bodyText = await req.text(); }
  catch {
    return NextResponse.json({ error: 'command_unreadable' }, { status: 400 });
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_COMMAND_BYTES) {
    return NextResponse.json({
      error: 'command_too_large',
      detail: `Operation command exceeds ${MAX_COMMAND_BYTES} bytes. Raw documents do not belong in this journal.`,
    }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch {
    return NextResponse.json({ error: 'command_not_json' }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.command !== 'string' || !isRecord(body.payload)) {
    return NextResponse.json({
      error: 'command_shape_invalid',
      detail: 'Expected { command: string, payload: object }.',
    }, { status: 400 });
  }

  const workflow = loadOperationsWorkflow();
  let result: LoadOperationCommandResult;
  try {
    switch (body.command) {
      case 'register_opportunity':
        result = await workflow.registerOpportunity(body.payload as unknown as RegisterOpportunityCommand);
        break;
      case 'register_alternative':
        result = await workflow.registerAlternative(body.payload as unknown as RegisterAlternativeCommand);
        break;
      case 'authorize_alternative':
        result = await workflow.authorizeAlternative(body.payload as unknown as AuthorizeAlternativeCommand);
        break;
      case 'open_episode':
        result = await workflow.openEpisode(body.payload as unknown as OpenOperationEpisodeCommand);
        break;
      case 'record_assignment':
        result = await workflow.recordAssignment(body.payload as unknown as RecordOperationAssignmentCommand);
        break;
      case 'explore_assignment':
        result = await workflow.exploreAssignment(body.payload as unknown as ExploreOperationAssignmentCommand);
        break;
      case 'dispatch':
        result = await workflow.dispatch(body.payload as unknown as DispatchOperationCommand);
        break;
      case 'capture_outcome':
        result = await workflow.captureOutcome(body.payload as unknown as CaptureOperationOutcomeCommand);
        break;
      case 'capture_settlement': {
        const captured = settlementOutcomeCommand(body.payload as unknown as OperationalSettlementEvidence);
        if (captured.kind === 'refusal') return NextResponse.json(captured, { status: 422 });
        result = await workflow.captureOutcome(captured.command);
        break;
      }
      default:
        return NextResponse.json({
          error: 'command_unknown',
          detail: `Unknown operations command ${body.command}.`,
        }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({
      error: 'command_shape_invalid',
      detail: (error as Error).message,
      remedy: 'Submit the typed command contract; malformed input never reaches the journal.',
    }, { status: 400 });
  }
  return NextResponse.json(result, { status: statusFor(result) });
}
