/**
 * Live, authoritative freight-source acquisition.
 *
 * This module is deliberately narrower than a generic HTTP proxy. Provider
 * hosts and paths are fixed here, secrets never enter evidence ids or errors,
 * and the normalized output excludes carrier phone/address fields. A public
 * record that does not contain a policy expiry or cargo limit produces nulls
 * for those fields; it never turns absence into insurance clearance.
 */

import { createHash } from 'node:crypto';
import { attest, attestationOf, type Attested, type Attestation } from './attestation';
import type { AuthorizationRequest } from './authorization';
import { withHostRateLimit } from './outboundRate';
import type { ISODateTime } from './types';
import { userAgent } from '@/lib/identity';

export const FMCSA_SOURCE_ID = 'fmcsa-qcmobile';
export const EIA_DIESEL_SOURCE_ID = 'eia-weekly-diesel';
export const EIA_US_DIESEL_SERIES = 'EMD_EPD2D_PTE_NUS_DPG';

const FMCSA_ORIGIN = 'https://mobile.fmcsa.dot.gov';
const FMCSA_BASE_PATH = '/qc/services';
const EIA_ORIGIN = 'https://api.eia.gov';
const EIA_DIESEL_PATH = '/v2/petroleum/pri/gnd/data/';
const UA = userAgent('freight source acquisition');
const INTERNAL_CARRIER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SOURCE_RESPONSE_BYTES = 2_000_000;

const OFFICIAL_ATTESTATION = (source: string): Attestation =>
  attestationOf('reported', 'high', 'disinterested', source);

export type FreightSourceRefusalCode =
  | 'SOURCE_REQUEST_INVALID'
  | 'SOURCE_NOT_CONFIGURED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_RESPONSE_INVALID';

export type FreightSourceRefusal = {
  readonly kind: 'refusal';
  readonly code: FreightSourceRefusalCode;
  readonly sourceId: string;
  readonly detail: string;
  readonly remedy: string;
};

export type SourceEvidence = {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly endpoint: string;
  readonly retrievedAt: ISODateTime;
  readonly attestation: Attestation;
};

export type RegulatoryStatus = 'active' | 'inactive' | 'undetermined';

export type CarrierSourceObservation = {
  readonly kind: 'carrier_source_observation';
  readonly sourceId: typeof FMCSA_SOURCE_ID;
  readonly usdot: string;
  readonly carrierId: string;
  readonly legalName: string | null;
  readonly dbaName: string | null;
  readonly registration: {
    readonly status: RegulatoryStatus;
    readonly allowToOperate: 'Y' | 'N' | null;
    readonly outOfService: 'Y' | 'N' | null;
    readonly outOfServiceDate: ISODateTime | null;
    readonly attestation: Attestation;
    readonly evidenceIds: readonly string[];
  };
  readonly authority: {
    readonly status: RegulatoryStatus;
    readonly grantedAt: ISODateTime | null;
    readonly revokedAt: ISODateTime | null;
    readonly activeClasses: readonly ('common' | 'contract')[];
    readonly attestation: Attestation;
    readonly evidenceIds: readonly string[];
  };
  /**
   * Exact input the deterministic authorization gate can consume. FMCSA's
   * public feed does not prove cargo policy expiry or limit, so both remain
   * null until a certificate/insurer feed supplies them.
   */
  readonly authorizationCarrier: AuthorizationRequest['carrier'];
  readonly evidence: readonly SourceEvidence[];
  readonly missing: readonly {
    readonly field:
      | 'authority_record'
      | 'authority_grant_date'
      | 'out_of_service_record'
      | 'cargo_insurance_expiry'
      | 'cargo_cover_limit';
    readonly reason: string;
    readonly remedy: string;
  }[];
};

export type DieselBenchmarkObservation = {
  readonly kind: 'diesel_benchmark_observation';
  readonly sourceId: typeof EIA_DIESEL_SOURCE_ID;
  readonly seriesId: typeof EIA_US_DIESEL_SERIES;
  readonly period: string;
  readonly geography: 'United States';
  readonly currency: 'USD';
  readonly unit: string;
  readonly price: Attested<number>;
  readonly evidence: SourceEvidence;
};

export type FreightDataSourceOptions = {
  readonly fmcsaWebKey?: string;
  readonly eiaApiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>;
};

export type PullCarrierInput = {
  readonly usdot: string;
  readonly carrierId: string;
  readonly retrievedAt: ISODateTime;
};

export type PullDieselInput = {
  readonly retrievedAt: ISODateTime;
};

type JsonFetch = {
  readonly payload: unknown;
  readonly evidence: SourceEvidence;
};

type AuthorityValues = {
  readonly status: RegulatoryStatus;
  readonly grantedAt: ISODateTime | null;
  readonly revokedAt: ISODateTime | null;
  readonly activeClasses: readonly ('common' | 'contract')[];
};

class SourceRequestError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid_response',
    readonly safeDetail: string,
  ) {
    super(safeDetail);
  }
}

function refusal(
  code: FreightSourceRefusalCode,
  sourceId: string,
  detail: string,
  remedy: string,
): FreightSourceRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, sourceId, detail, remedy });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function allRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return [];
  if (Array.isArray(value)) return value.flatMap(child => allRecords(child, depth + 1));
  const found = record(value);
  if (!found) return [];
  return [found, ...Object.values(found).flatMap(child => allRecords(child, depth + 1))];
}

function bestRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  const candidates = allRecords(value)
    .map(candidate => ({
      candidate,
      score: fields.reduce((total, field) => total + (field in candidate ? 1 : 0), 0),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.candidate ?? null;
}

function textField(source: Record<string, unknown> | null, ...fields: string[]): string | null {
  if (!source) return null;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function yn(value: string | null): 'Y' | 'N' | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'Y' || normalized === 'YES') return 'Y';
  if (normalized === 'N' || normalized === 'NO') return 'N';
  return null;
}

function statusValue(value: string | null): RegulatoryStatus {
  const normalized = value?.trim().toUpperCase();
  if (['A', 'ACTIVE', 'Y', 'YES', 'AUTHORIZED'].includes(normalized ?? '')) return 'active';
  if (['I', 'INACTIVE', 'N', 'NO', 'REVOKED', 'NOT AUTHORIZED'].includes(normalized ?? '')) return 'inactive';
  return 'undetermined';
}

function instant(value: string | null): ISODateTime | null {
  if (!value) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const candidate = us
    ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}T00:00:00.000Z`
    : value;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function evidencePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(evidencePayload);
  const source = record(value);
  if (!source) return value;
  const secretFields = new Set(['api_key', 'apikey', 'webkey', 'token', 'authorization']);
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => !secretFields.has(key.toLowerCase()))
    .map(([key, child]) => [key, evidencePayload(child)]));
}

function evidenceId(sourceId: string, endpoint: string, retrievedAt: string, payload: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ sourceId, endpoint, retrievedAt, payload: evidencePayload(payload) }))
    .digest('hex');
  return `evidence:${sourceId}:${digest}`;
}

function authorityValues(payload: unknown): AuthorityValues {
  const authority = bestRecord(payload, [
    'commonAuthorityStatus', 'contractAuthorityStatus',
    'commonAuthorityGrantDate', 'contractAuthorityGrantDate',
  ]);
  const commonStatus = statusValue(textField(authority, 'commonAuthorityStatus', 'commonAuthStatus'));
  const contractStatus = statusValue(textField(authority, 'contractAuthorityStatus', 'contractAuthStatus'));
  const statuses = [commonStatus, contractStatus].filter(value => value !== 'undetermined');
  const activeClasses: ('common' | 'contract')[] = [];
  if (commonStatus === 'active') activeClasses.push('common');
  if (contractStatus === 'active') activeClasses.push('contract');
  const status: RegulatoryStatus = activeClasses.length > 0
    ? 'active'
    : statuses.length > 0 && statuses.every(value => value === 'inactive')
      ? 'inactive'
      : 'undetermined';

  const activeGrantDates = [
    commonStatus === 'active'
      ? instant(textField(authority, 'commonAuthorityGrantDate', 'commonAuthGrantDate'))
      : null,
    contractStatus === 'active'
      ? instant(textField(authority, 'contractAuthorityGrantDate', 'contractAuthGrantDate'))
      : null,
  ].filter((value): value is ISODateTime => value !== null).sort();
  const revokeDates = [
    instant(textField(authority, 'commonAuthorityRevokedDate', 'commonAuthRevokedDate')),
    instant(textField(authority, 'contractAuthorityRevokedDate', 'contractAuthRevokedDate')),
  ].filter((value): value is ISODateTime => value !== null).sort();

  return {
    status,
    grantedAt: activeGrantDates[0] ?? null,
    revokedAt: status === 'inactive' ? revokeDates[revokeDates.length - 1] ?? null : null,
    activeClasses,
  };
}

/** Parse a set of already-fetched official responses without doing I/O. */
export function parseFmcsaCarrierResponses(input: {
  readonly carrierPayload: unknown;
  readonly authorityPayload: unknown | null;
  readonly oosPayload: unknown | null;
  readonly carrierId: string;
  readonly requestedUsdot: string;
  readonly retrievedAt: ISODateTime;
  readonly evidence: readonly SourceEvidence[];
}): CarrierSourceObservation | FreightSourceRefusal {
  const carrier = bestRecord(input.carrierPayload, [
    'dotNumber', 'legalName', 'dbaName', 'allowToOperate', 'outOfService',
  ]);
  if (!carrier) {
    return refusal(
      'SOURCE_RESPONSE_INVALID', FMCSA_SOURCE_ID,
      'FMCSA returned JSON without a recognizable carrier record.',
      'Confirm the USDOT number and inspect the provider contract before retrying.',
    );
  }
  const returnedUsdot = textField(carrier, 'dotNumber');
  if (returnedUsdot && returnedUsdot !== input.requestedUsdot) {
    return refusal(
      'SOURCE_RESPONSE_INVALID', FMCSA_SOURCE_ID,
      `FMCSA returned USDOT ${returnedUsdot} for requested USDOT ${input.requestedUsdot}.`,
      'Do not use this record; retry the exact USDOT lookup and investigate the provider response.',
    );
  }

  const oos = bestRecord(input.oosPayload, ['outOfService', 'outOfServiceDate']);
  const allowToOperate = yn(textField(carrier, 'allowToOperate', 'allowedToOperate'));
  const outOfService = yn(textField(oos, 'outOfService') ?? textField(carrier, 'outOfService'));
  const registrationStatus: RegulatoryStatus = outOfService === 'Y' || allowToOperate === 'N'
    ? 'inactive'
    : allowToOperate === 'Y'
      ? 'active'
      : 'undetermined';
  const authority = authorityValues(input.authorityPayload);
  const combinedRegulatoryStatus: RegulatoryStatus =
    registrationStatus === 'inactive' || authority.status === 'inactive'
      ? 'inactive'
      : registrationStatus === 'active' && authority.status === 'active'
        ? 'active'
        : 'undetermined';
  const official = OFFICIAL_ATTESTATION('FMCSA QCMobile carrier, authority, and out-of-service records');
  const authorityEvidence = input.evidence
    .filter(item => item.endpoint.endsWith('/authority'))
    .map(item => item.evidenceId);
  const registrationEvidence = input.evidence
    .filter(item => !item.endpoint.endsWith('/authority'))
    .map(item => item.evidenceId);
  const missing: CarrierSourceObservation['missing'][number][] = [];
  if (input.authorityPayload === null) {
    missing.push({
      field: 'authority_record',
      reason: 'The FMCSA authority sub-request did not return a usable response.',
      remedy: 'Retry the authority endpoint or verify the carrier in FMCSA Licensing & Insurance.',
    });
  }
  if (authority.grantedAt === null) {
    missing.push({
      field: 'authority_grant_date',
      reason: authority.status === 'active'
        ? 'FMCSA reports active authority but the response contains no grant date.'
        : 'No dated active authority was returned.',
      remedy: 'Obtain the dated authority record from FMCSA Licensing & Insurance or the regulator of record.',
    });
  }
  if (input.oosPayload === null && textField(carrier, 'outOfService') === null) {
    missing.push({
      field: 'out_of_service_record',
      reason: 'The FMCSA out-of-service sub-request did not return a usable response.',
      remedy: 'Retry the OOS endpoint before treating this pull as complete regulatory evidence.',
    });
  }
  missing.push({
    field: 'cargo_insurance_expiry',
    reason: 'The public FMCSA response is not a certificate of insurance and does not prove policy validity at pickup.',
    remedy: 'Pull a current certificate from the insurer, broker, or configured insurance provider.',
  });
  missing.push({
    field: 'cargo_cover_limit',
    reason: 'The public FMCSA response does not prove the cargo limit and currency for this load.',
    remedy: 'Pull the cargo limit and currency from the current certificate of insurance.',
  });

  return Object.freeze({
    kind: 'carrier_source_observation' as const,
    sourceId: FMCSA_SOURCE_ID,
    usdot: input.requestedUsdot,
    carrierId: input.carrierId,
    legalName: textField(carrier, 'legalName'),
    dbaName: textField(carrier, 'dbaName'),
    registration: {
      status: registrationStatus,
      allowToOperate,
      outOfService,
      outOfServiceDate: instant(textField(oos, 'outOfServiceDate') ?? textField(carrier, 'outOfServiceDate')),
      attestation: official,
      evidenceIds: registrationEvidence,
    },
    authority: {
      ...authority,
      attestation: official,
      evidenceIds: authorityEvidence,
    },
    authorizationCarrier: {
      carrierId: input.carrierId,
      insuranceExpiresAt: null,
      cargoCoverAmount: null,
      authorityGrantedAt: authority.grantedAt,
      authorityRevokedAt: authority.revokedAt,
      regulatoryStatus: {
        status: combinedRegulatoryStatus,
        observedAt: input.retrievedAt,
        sourceId: FMCSA_SOURCE_ID,
        evidenceIds: input.evidence.map(item => item.evidenceId),
      },
    },
    evidence: input.evidence,
    missing,
  });
}

/** Parse an EIA API v2 weekly diesel response without doing I/O. */
export function parseEiaDieselResponse(
  payload: unknown,
  retrievedAt: ISODateTime,
  evidence: SourceEvidence,
): DieselBenchmarkObservation | FreightSourceRefusal {
  const root = record(payload);
  const response = record(root?.response);
  const rows = response?.data;
  const row = Array.isArray(rows) ? record(rows[0]) : null;
  const value = typeof row?.value === 'number' ? row.value : Number(row?.value);
  const period = typeof row?.period === 'string' ? row.period.trim() : '';
  const returnedSeries = textField(row, 'series');
  const unit = textField(row, 'units', 'value-units');
  if (!row || !Number.isFinite(value) || !period || !unit ||
      (returnedSeries !== null && returnedSeries !== EIA_US_DIESEL_SERIES)) {
    return refusal(
      'SOURCE_RESPONSE_INVALID', EIA_DIESEL_SOURCE_ID,
      'EIA returned JSON without a valid latest U.S. diesel price, period, or unit.',
      'Inspect the EIA API v2 route/series contract; do not substitute zero for the missing benchmark.',
    );
  }
  return Object.freeze({
    kind: 'diesel_benchmark_observation' as const,
    sourceId: EIA_DIESEL_SOURCE_ID,
    seriesId: EIA_US_DIESEL_SERIES,
    period,
    geography: 'United States' as const,
    currency: 'USD' as const,
    unit,
    price: attest(value, OFFICIAL_ATTESTATION('EIA weekly U.S. retail on-highway diesel price')),
    evidence: { ...evidence, retrievedAt },
  });
}

export class FreightDataSourceGateway {
  private readonly fmcsaWebKey: string;
  private readonly eiaApiKey: string;
  private readonly timeoutMs: number;
  private readonly fetcher: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: FreightDataSourceOptions = {}) {
    this.fmcsaWebKey = options.fmcsaWebKey?.trim() ?? '';
    this.eiaApiKey = options.eiaApiKey?.trim() ?? '';
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) >= 1_000 &&
      (options.timeoutMs ?? 0) <= 30_000 ? options.timeoutMs! : 10_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  configured(): { readonly fmcsa: boolean; readonly eia: boolean } {
    return { fmcsa: this.fmcsaWebKey.length > 0, eia: this.eiaApiKey.length > 0 };
  }

  private async getJson(
    sourceId: string,
    origin: string,
    path: string,
    params: URLSearchParams,
    retrievedAt: ISODateTime,
  ): Promise<JsonFetch> {
    const url = new URL(path, origin);
    url.search = params.toString();
    const endpoint = `${url.origin}${url.pathname}`;
    let response: Response;
    try {
      response = await withHostRateLimit(url.toString(), () => this.fetcher(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json', 'User-Agent': UA },
      }));
    } catch {
      throw new SourceRequestError(
        'unavailable',
        `${sourceId} request to ${endpoint} failed before an HTTP response.`,
      );
    }
    if (!response.ok) {
      throw new SourceRequestError('unavailable', `${sourceId} request to ${endpoint} returned HTTP ${response.status}.`);
    }
    const announcedBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(announcedBytes) && announcedBytes > MAX_SOURCE_RESPONSE_BYTES) {
      throw new SourceRequestError(
        'invalid_response',
        `${sourceId} response from ${endpoint} exceeded the ${MAX_SOURCE_RESPONSE_BYTES}-byte contract.`,
      );
    }
    let raw: string;
    try { raw = await response.text(); }
    catch { throw new SourceRequestError('invalid_response', `${sourceId} response from ${endpoint} was unreadable.`); }
    if (Buffer.byteLength(raw, 'utf8') > MAX_SOURCE_RESPONSE_BYTES) {
      throw new SourceRequestError(
        'invalid_response',
        `${sourceId} response from ${endpoint} exceeded the ${MAX_SOURCE_RESPONSE_BYTES}-byte contract.`,
      );
    }
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { throw new SourceRequestError('invalid_response', `${sourceId} returned non-JSON data from ${endpoint}.`); }
    return {
      payload,
      evidence: {
        evidenceId: evidenceId(sourceId, endpoint, retrievedAt, payload),
        sourceId,
        endpoint,
        retrievedAt,
        attestation: OFFICIAL_ATTESTATION(`${sourceId} official API response`),
      },
    };
  }

  async pullCarrier(
    input: PullCarrierInput,
  ): Promise<CarrierSourceObservation | FreightSourceRefusal> {
    if (!/^\d{1,8}$/.test(input.usdot) || !INTERNAL_CARRIER_ID.test(input.carrierId) ||
        !Number.isFinite(Date.parse(input.retrievedAt))) {
      return refusal(
        'SOURCE_REQUEST_INVALID', FMCSA_SOURCE_ID,
        'Carrier pull requires a 1–8 digit USDOT number, an internal carrier id, and a valid retrieval time.',
        'Correct the source request before contacting FMCSA.',
      );
    }
    if (!this.fmcsaWebKey) {
      return refusal(
        'SOURCE_NOT_CONFIGURED', FMCSA_SOURCE_ID,
        'FMCSA carrier acquisition is fail-closed because FMCSA_WEB_KEY is not configured.',
        'Create a free FMCSA QCMobile WebKey and set FMCSA_WEB_KEY on the server.',
      );
    }
    const params = () => new URLSearchParams({ webKey: this.fmcsaWebKey });
    const paths = [
      `${FMCSA_BASE_PATH}/carriers/${input.usdot}`,
      `${FMCSA_BASE_PATH}/carriers/${input.usdot}/authority`,
      `${FMCSA_BASE_PATH}/carriers/${input.usdot}/oos`,
    ] as const;
    const results = await Promise.allSettled(paths.map(path =>
      this.getJson(FMCSA_SOURCE_ID, FMCSA_ORIGIN, path, params(), input.retrievedAt)));
    const carrier = results[0];
    if (carrier.status === 'rejected') {
      const error = carrier.reason as SourceRequestError;
      return refusal(
        error.code === 'invalid_response' ? 'SOURCE_RESPONSE_INVALID' : 'SOURCE_UNAVAILABLE',
        FMCSA_SOURCE_ID,
        error.safeDetail ?? 'FMCSA carrier lookup failed.',
        'Retry without weakening the authorization gate; if the source remains unavailable, verify the carrier manually.',
      );
    }
    const authority = results[1].status === 'fulfilled' ? results[1].value : null;
    const oos = results[2].status === 'fulfilled' ? results[2].value : null;
    return parseFmcsaCarrierResponses({
      carrierPayload: carrier.value.payload,
      authorityPayload: authority?.payload ?? null,
      oosPayload: oos?.payload ?? null,
      carrierId: input.carrierId,
      requestedUsdot: input.usdot,
      retrievedAt: input.retrievedAt,
      evidence: [carrier.value.evidence, authority?.evidence, oos?.evidence]
        .filter((value): value is SourceEvidence => value !== undefined),
    });
  }

  async pullDiesel(
    input: PullDieselInput,
  ): Promise<DieselBenchmarkObservation | FreightSourceRefusal> {
    if (!Number.isFinite(Date.parse(input.retrievedAt))) {
      return refusal(
        'SOURCE_REQUEST_INVALID', EIA_DIESEL_SOURCE_ID,
        'Diesel pull requires a valid retrieval time.',
        'Correct the source request before contacting EIA.',
      );
    }
    if (!this.eiaApiKey) {
      return refusal(
        'SOURCE_NOT_CONFIGURED', EIA_DIESEL_SOURCE_ID,
        'EIA fuel acquisition is fail-closed because EIA_API_KEY is not configured.',
        'Register for a free EIA Open Data key and set EIA_API_KEY on the server.',
      );
    }
    const params = new URLSearchParams();
    params.set('api_key', this.eiaApiKey);
    params.set('frequency', 'weekly');
    params.append('data[]', 'value');
    params.append('facets[series][]', EIA_US_DIESEL_SERIES);
    params.set('sort[0][column]', 'period');
    params.set('sort[0][direction]', 'desc');
    params.set('offset', '0');
    params.set('length', '1');
    let result: JsonFetch;
    try {
      result = await this.getJson(EIA_DIESEL_SOURCE_ID, EIA_ORIGIN, EIA_DIESEL_PATH, params, input.retrievedAt);
    } catch (caught) {
      const error = caught as SourceRequestError;
      return refusal(
        error.code === 'invalid_response' ? 'SOURCE_RESPONSE_INVALID' : 'SOURCE_UNAVAILABLE',
        EIA_DIESEL_SOURCE_ID,
        error.safeDetail ?? 'EIA diesel lookup failed.',
        'Retry without substituting a stale or zero fuel value; record an explicit absence if unavailable.',
      );
    }
    return parseEiaDieselResponse(result.payload, input.retrievedAt, result.evidence);
  }
}
