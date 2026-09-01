/** Authenticated operations read model for the Payload brokerage desk. */

import { NextResponse } from 'next/server';
import { operationsControlTower } from '../../../../lib/economy/controlTowerRuntime';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;

  const result = await operationsControlTower().read(new Date().toISOString());
  if (result.kind === 'refusal') {
    return NextResponse.json(result, {
      status: result.code === 'CONTROL_TOWER_REQUEST_INVALID' ? 400 : 503,
    });
  }
  return NextResponse.json(result, {
    status: 200,
    headers: { 'cache-control': 'private, no-store' },
  });
}
