import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetRateStats } from './outboundRate';
import {
  EIA_DIESEL_SOURCE_ID,
  EIA_US_DIESEL_SERIES,
  FMCSA_SOURCE_ID,
  FreightDataSourceGateway,
  parseEiaDieselResponse,
  parseFmcsaCarrierResponses,
  type SourceEvidence,
} from './freightDataSources';
import { attestationOf } from './attestation';
import { authorize } from './authorization';

const retrievedAt = '2026-09-01T12:00:00.000Z';

function evidence(sourceId: string, endpoint: string): SourceEvidence {
  return {
    evidenceId: `evidence:${sourceId}:${endpoint}`,
    sourceId,
    endpoint,
    retrievedAt,
    attestation: attestationOf('reported', 'high', 'disinterested', sourceId),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRateStats();
});

describe('FMCSA carrier acquisition', () => {
  it('normalizes identity, dated authority, and OOS evidence without contact fields', () => {
    const result = parseFmcsaCarrierResponses({
      carrierPayload: { content: { carrier: {
        dotNumber: 44110,
        legalName: 'GREYHOUND LINES INC',
        dbaName: 'GREYHOUND',
        allowToOperate: 'Y',
        telephone: '555-0100',
        phyStreet: 'not emitted',
      } } },
      authorityPayload: { content: { authority: {
        commonAuthorityStatus: 'A',
        commonAuthorityGrantDate: '06/30/1982',
        contractAuthorityStatus: 'N',
      } } },
      oosPayload: { content: { carrier: { outOfService: 'N' } } },
      carrierId: 'carrier:greyhound',
      requestedUsdot: '44110',
      retrievedAt,
      evidence: [
        evidence(FMCSA_SOURCE_ID, 'https://mobile.fmcsa.dot.gov/qc/services/carriers/44110'),
        evidence(FMCSA_SOURCE_ID, 'https://mobile.fmcsa.dot.gov/qc/services/carriers/44110/authority'),
        evidence(FMCSA_SOURCE_ID, 'https://mobile.fmcsa.dot.gov/qc/services/carriers/44110/oos'),
      ],
    });
    expect(result.kind).toBe('carrier_source_observation');
    if (result.kind !== 'carrier_source_observation') return;
    expect(result).toMatchObject({
      usdot: '44110',
      carrierId: 'carrier:greyhound',
      legalName: 'GREYHOUND LINES INC',
      registration: { status: 'active', allowToOperate: 'Y', outOfService: 'N' },
      authority: {
        status: 'active',
        grantedAt: '1982-06-30T00:00:00.000Z',
        activeClasses: ['common'],
      },
      authorizationCarrier: {
        carrierId: 'carrier:greyhound',
        insuranceExpiresAt: null,
        cargoCoverAmount: null,
        authorityGrantedAt: '1982-06-30T00:00:00.000Z',
        authorityRevokedAt: null,
        regulatoryStatus: { status: 'active', sourceId: FMCSA_SOURCE_ID },
      },
    });
    expect(result).not.toHaveProperty('telephone');
    expect(result).not.toHaveProperty('phyStreet');
    expect(JSON.stringify(result)).not.toContain('555-0100');
    expect(result.missing.map(item => item.field)).toEqual([
      'cargo_insurance_expiry', 'cargo_cover_limit',
    ]);
    expect(result.registration.attestation).toMatchObject({
      evidenceClass: 'reported', interest: 'disinterested', restsOnRepresentative: false,
    });
  });

  it('keeps an active-but-undated authority undetermined at the authorization gate boundary', () => {
    const result = parseFmcsaCarrierResponses({
      carrierPayload: { content: { carrier: { dotNumber: '123456', allowToOperate: 'Y' } } },
      authorityPayload: { content: { authority: { commonAuthorityStatus: 'A' } } },
      oosPayload: null,
      carrierId: 'carrier:123456',
      requestedUsdot: '123456',
      retrievedAt,
      evidence: [evidence(FMCSA_SOURCE_ID, 'https://mobile.fmcsa.dot.gov/qc/services/carriers/123456')],
    });
    expect(result.kind).toBe('carrier_source_observation');
    if (result.kind !== 'carrier_source_observation') return;
    expect(result.authority.status).toBe('active');
    expect(result.authorizationCarrier.authorityGrantedAt).toBeNull();
    expect(result.missing).toContainEqual(expect.objectContaining({ field: 'authority_grant_date' }));
  });

  it('refuses a provider response for a different USDOT identity', () => {
    const result = parseFmcsaCarrierResponses({
      carrierPayload: { content: { carrier: { dotNumber: '999999', allowToOperate: 'Y' } } },
      authorityPayload: null,
      oosPayload: null,
      carrierId: 'carrier:123456',
      requestedUsdot: '123456',
      retrievedAt,
      evidence: [],
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'SOURCE_RESPONSE_INVALID' });
  });

  it('feeds an in-span inactive regulator observation into a blocking refusal', () => {
    const result = parseFmcsaCarrierResponses({
      carrierPayload: { content: { carrier: {
        dotNumber: '123456', allowToOperate: 'N', outOfService: 'Y', outOfServiceDate: '08/30/2026',
      } } },
      authorityPayload: { content: { authority: {
        commonAuthorityStatus: 'A', commonAuthorityGrantDate: '01/02/2020',
      } } },
      oosPayload: { content: { carrier: { outOfService: 'Y', outOfServiceDate: '08/30/2026' } } },
      carrierId: 'carrier:123456',
      requestedUsdot: '123456',
      retrievedAt,
      evidence: [evidence(FMCSA_SOURCE_ID, 'https://mobile.fmcsa.dot.gov/qc/services/carriers/123456')],
    });
    expect(result.kind).toBe('carrier_source_observation');
    if (result.kind !== 'carrier_source_observation') return;
    const authorization = authorize({
      loadId: 'load:1',
      tenderedCarrierId: 'carrier:123456',
      bolCarrierId: 'carrier:123456',
      bookedAt: '2026-08-28T12:00:00.000Z',
      pickupAt: '2026-09-02T12:00:00.000Z',
      declaredValue: null,
      carrier: {
        ...result.authorizationCarrier,
        insuranceExpiresAt: '2027-01-01T00:00:00.000Z',
      },
      actingAuthority: { principal: 'operator:1', mayBind: true },
    }, retrievedAt);
    expect(authorization.decision).toBe('refused');
    expect(authorization.checks).toContainEqual(expect.objectContaining({
      check: 'operating_authority_active', outcome: 'refused',
    }));
  });

  it('fails closed when unconfigured or when the source rejects the key, without leaking it', async () => {
    const unconfigured = new FreightDataSourceGateway();
    await expect(unconfigured.pullCarrier({
      usdot: '44110', carrierId: 'carrier:greyhound', retrievedAt,
    })).resolves.toMatchObject({ kind: 'refusal', code: 'SOURCE_NOT_CONFIGURED' });

    const secret = 'FMCSA-TEST-WEB-KEY-DO-NOT-LEAK';
    const rejected = new FreightDataSourceGateway({
      fmcsaWebKey: secret,
      fetcher: vi.fn(async () => new Response('{}', { status: 401 })),
    });
    const result = await rejected.pullCarrier({
      usdot: '44110', carrierId: 'carrier:greyhound', retrievedAt,
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'SOURCE_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('calls only the three fixed FMCSA paths with the server-side WebKey', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString());
      const payload = url.pathname.endsWith('/authority')
        ? { content: { authority: { commonAuthorityStatus: 'A', commonAuthorityGrantDate: '01/02/2020' } } }
        : url.pathname.endsWith('/oos')
          ? { content: { carrier: { outOfService: 'N' } } }
          : { content: { carrier: { dotNumber: '44110', legalName: 'CARRIER', allowToOperate: 'Y' } } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const gateway = new FreightDataSourceGateway({ fmcsaWebKey: 'server-key', fetcher });
    const result = await gateway.pullCarrier({
      usdot: '44110', carrierId: 'carrier:greyhound', retrievedAt,
    });
    expect(result.kind).toBe('carrier_source_observation');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const urls = fetcher.mock.calls.map(call => new URL(call[0].toString()));
    expect(urls.map(url => url.origin)).toEqual(Array(3).fill('https://mobile.fmcsa.dot.gov'));
    expect(urls.map(url => url.pathname).sort()).toEqual([
      '/qc/services/carriers/44110',
      '/qc/services/carriers/44110/authority',
      '/qc/services/carriers/44110/oos',
    ]);
    expect(urls.every(url => url.searchParams.get('webKey') === 'server-key')).toBe(true);
  });
});

describe('EIA diesel acquisition', () => {
  it('normalizes the latest weekly benchmark with an attested value', () => {
    const sourceEvidence = evidence(EIA_DIESEL_SOURCE_ID, 'https://api.eia.gov/v2/petroleum/pri/gnd/data/');
    const result = parseEiaDieselResponse({ response: { data: [{
      period: '2026-08-31',
      series: EIA_US_DIESEL_SERIES,
      value: '3.812',
      units: 'dollars per gallon',
    }] } }, retrievedAt, sourceEvidence);
    expect(result.kind).toBe('diesel_benchmark_observation');
    if (result.kind !== 'diesel_benchmark_observation') return;
    expect(result).toMatchObject({
      period: '2026-08-31', currency: 'USD', unit: 'dollars per gallon',
      price: { value: 3.812, attestation: { evidenceClass: 'reported', interest: 'disinterested' } },
    });
  });

  it('uses the fixed EIA v2 series and refuses a missing value instead of returning zero', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      void input;
      return new Response(JSON.stringify({ response: { data: [] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const gateway = new FreightDataSourceGateway({ eiaApiKey: 'eia-server-key', fetcher });
    const result = await gateway.pullDiesel({ retrievedAt });
    expect(result).toMatchObject({ kind: 'refusal', code: 'SOURCE_RESPONSE_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(fetcher.mock.calls[0][0].toString());
    expect(url.origin).toBe('https://api.eia.gov');
    expect(url.pathname).toBe('/v2/petroleum/pri/gnd/data/');
    expect(url.searchParams.get('facets[series][]')).toBe(EIA_US_DIESEL_SERIES);
    expect(url.searchParams.get('length')).toBe('1');
  });

  it('removes an EIA-echoed API key before constructing evidence identity', async () => {
    const responseFor = (echoedKey: string) => ({
      response: { data: [{
        period: '2026-08-24', series: EIA_US_DIESEL_SERIES, value: '5.652', units: '$/GAL',
      }] },
      request: { params: { api_key: echoedKey } },
    });
    const first = new FreightDataSourceGateway({
      eiaApiKey: 'first-secret',
      fetcher: vi.fn(async () => new Response(JSON.stringify(responseFor('first-secret')), { status: 200 })),
    });
    const second = new FreightDataSourceGateway({
      eiaApiKey: 'second-secret',
      fetcher: vi.fn(async () => new Response(JSON.stringify(responseFor('second-secret')), { status: 200 })),
    });
    const [left, right] = await Promise.all([
      first.pullDiesel({ retrievedAt }), second.pullDiesel({ retrievedAt }),
    ]);
    expect(left.kind).toBe('diesel_benchmark_observation');
    expect(right.kind).toBe('diesel_benchmark_observation');
    if (left.kind !== 'diesel_benchmark_observation' || right.kind !== 'diesel_benchmark_observation') return;
    expect(left.evidence.evidenceId).toBe(right.evidence.evidenceId);
  });
});
