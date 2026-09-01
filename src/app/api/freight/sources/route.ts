/**
 * Private pull-through surface for authoritative freight data.
 *
 * The route accepts only USDOT carrier identity and a fixed EIA diesel
 * benchmark. It is not a generic URL proxy, does not return carrier contact
 * details, and never converts a missing source field into a permissive value.
 */

import { NextResponse } from 'next/server';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { freightDataSources } from '../../../../lib/economy/freightDataSourcesRuntime';
import type { FreightSourceRefusal } from '../../../../lib/economy/freightDataSources';

export const runtime = 'nodejs';

function isTrue(value: string | null): boolean | null {
  if (value === null || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return null;
}

function refusalStatus(refusals: readonly FreightSourceRefusal[]): number {
  if (refusals.some(item => item.code === 'SOURCE_REQUEST_INVALID')) return 400;
  if (refusals.every(item => item.code === 'SOURCE_NOT_CONFIGURED')) return 503;
  if (refusals.some(item => item.code === 'SOURCE_UNAVAILABLE')) return 502;
  return 422;
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const query = new URL(req.url).searchParams;
  const usdot = query.get('usdot')?.trim() ?? '';
  const carrierId = query.get('carrierId')?.trim() ?? '';
  const diesel = isTrue(query.get('includeDiesel'));
  if (diesel === null) {
    return NextResponse.json({
      error: 'source_request_invalid',
      detail: 'includeDiesel must be 1, 0, true, or false.',
    }, { status: 400 });
  }
  if ((usdot && !carrierId) || (!usdot && carrierId)) {
    return NextResponse.json({
      error: 'source_request_invalid',
      detail: 'usdot and carrierId must be supplied together.',
    }, { status: 400 });
  }
  if ((usdot && !/^\d{1,8}$/.test(usdot)) ||
      (carrierId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(carrierId))) {
    return NextResponse.json({
      error: 'source_request_invalid',
      detail: 'usdot must be 1–8 digits and carrierId must be a bounded internal identifier.',
    }, { status: 400 });
  }
  if (!usdot && !diesel) {
    return NextResponse.json({
      error: 'source_request_empty',
      detail: 'Request a carrier with usdot + carrierId, the diesel benchmark with includeDiesel=1, or both.',
    }, { status: 400 });
  }

  const retrievedAt = new Date().toISOString();
  const gateway = freightDataSources();
  const [carrier, fuel] = await Promise.all([
    usdot ? gateway.pullCarrier({ usdot, carrierId, retrievedAt }) : Promise.resolve(null),
    diesel ? gateway.pullDiesel({ retrievedAt }) : Promise.resolve(null),
  ]);
  const requested = [carrier, fuel].filter(value => value !== null);
  const refusals = requested.filter((value): value is FreightSourceRefusal => value?.kind === 'refusal');
  const incomplete = refusals.length > 0 ||
    (carrier?.kind === 'carrier_source_observation' && carrier.missing.length > 0);
  const status = refusals.length === requested.length ? refusalStatus(refusals) : 200;
  return NextResponse.json({
    retrievedAt,
    incomplete,
    carrier,
    fuel,
  }, { status });
}
