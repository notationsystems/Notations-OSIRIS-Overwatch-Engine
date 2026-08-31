import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { search, type Schema } from '@/lib/sanctions';

/**
 * Payload — counterparty sanctions screening (OFAC SDN via the OpenSanctions
 * `us_ofac_sdn` mirror). Substring + alias-aware match, schema-filterable.
 *
 * CONSTRAINT — ORGANISATIONAL SCREENING ONLY. This route screens
 * COUNTERPARTIES: the carrier, broker, shipper, consignee, vessel or
 * aircraft a movement is transacted with. It must never be used to search
 * for, profile, or return a natural person.
 *
 * `Person` is therefore not an addressable schema and is filtered out of
 * every result set, including unfiltered queries. The filter is applied to
 * the RESULTS and not only to the schema parameter, because an unfiltered
 * search over a list that contains designated individuals returns people
 * whether or not the caller asked for them — the allowlist alone would be a
 * policy that holds for callers who name the schema and fails open for
 * callers who do not.
 *
 * A designated individual is a real finding for a compliance desk, and this
 * is not the surface that serves it: that lookup belongs with a compliance
 * officer against the primary OFAC record, under an authority this
 * application does not hold.
 */

const ALLOWED_SCHEMAS: Schema[] = [
  'Organization',
  'Company',
  'Vessel',
  'Airplane',
  'LegalEntity',
];

/** Schemas whose subject is a natural person. Never served. */
const PERSON_SCHEMAS: ReadonlySet<string> = new Set(['Person']);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get('query') || '').trim();
  const schemaParam = searchParams.get('schema');
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '25', 10), 1), 100);

  if (!query) {
    return NextResponse.json({ error: 'Missing query parameter' }, { status: 400 });
  }
  if (query.length < 4) {
    return NextResponse.json(
      { error: 'Query must be at least 4 characters' },
      { status: 400 }
    );
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 20, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  let schema: Schema | undefined;
  if (schemaParam) {
    if (PERSON_SCHEMAS.has(schemaParam)) {
      return NextResponse.json(
        {
          error: 'The person schema is not served by this route.',
          reason:
            'This surface screens counterparty organisations, vessels and aircraft. ' +
            'Searching for a natural person is outside the collection policy this ' +
            'application enforces, and no parameter enables it.',
          remedy:
            'For a designated-individual check, a compliance officer queries the primary ' +
            'OFAC record directly, under an authority this application does not hold.',
          allowed: ALLOWED_SCHEMAS,
        },
        { status: 400 }
      );
    }
    if (!ALLOWED_SCHEMAS.includes(schemaParam as Schema)) {
      return NextResponse.json(
        { error: `Invalid schema. Allowed: ${ALLOWED_SCHEMAS.join(', ')}` },
        { status: 400 }
      );
    }
    schema = schemaParam as Schema;
  }

  try {
    const found = await search(query, { schema, limit });
    // Applied to results, not only to the parameter: an unfiltered query
    // over a list containing designated individuals returns people unless
    // something removes them here.
    const matches = found.filter((m) => !PERSON_SCHEMAS.has(m.schema));
    const withheld = found.length - matches.length;
    return NextResponse.json({
      query,
      schema: schema ?? null,
      total: matches.length,
      matches,
      personMatchesWithheld: withheld,
      constraint:
        'Organisational screening only — counterparty organisations, vessels and aircraft. ' +
        'Natural persons are never returned by this route.',
      source: 'OpenSanctions / US OFAC SDN',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'Sanctions lookup failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
