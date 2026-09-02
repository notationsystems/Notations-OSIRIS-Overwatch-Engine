import { describe, expect, it } from 'vitest';
import {
  authorizeCorpusObject,
  corpusAccessDefect,
  corpusAccessScopeDefect,
  joinCorpusPolicies,
  OPEN_PUBLIC_CORPUS_ACCESS,
  type CorpusAccess,
  type CorpusActorIdentity,
} from './corpusPolicy';

const publicReader: CorpusActorIdentity = {
  actorId: 'anonymous:test', actorKind: 'anonymous', permissions: ['corpus:read:public'],
};

describe('corpus object policy', () => {
  it('denies unclassified objects and purposes the object did not permit', () => {
    expect(authorizeCorpusObject({ scope: 'global' }, publicReader, 'SEARCH')).toMatchObject({ kind: 'denied', code: 'CORPUS_CLASSIFICATION_MISSING' });
    expect(authorizeCorpusObject({ scope: 'global', access: { ...OPEN_PUBLIC_CORPUS_ACCESS, allowedUses: ['ANALYSIS'] } }, publicReader, 'SEARCH')).toMatchObject({ kind: 'denied', code: 'CORPUS_USE_NOT_ALLOWED' });
    expect(authorizeCorpusObject({ scope: 'global', access: { ...OPEN_PUBLIC_CORPUS_ACCESS, prohibitedUses: ['MODEL_TRAINING'] } }, publicReader, 'MODEL_TRAINING')).toMatchObject({ kind: 'denied', code: 'CORPUS_USE_NOT_ALLOWED' });
  });

  it('allows explicitly public search but refuses prohibited redistribution', () => {
    expect(authorizeCorpusObject({ scope: 'global', access: OPEN_PUBLIC_CORPUS_ACCESS }, publicReader, 'SEARCH')).toMatchObject({ kind: 'allowed' });
    const noRedistribution: CorpusAccess = { ...OPEN_PUBLIC_CORPUS_ACCESS, redistributionClass: 'PROHIBITED' };
    expect(authorizeCorpusObject({ scope: 'global', access: noRedistribution }, publicReader, 'REDISTRIBUTION')).toMatchObject({ kind: 'denied', code: 'CORPUS_REDISTRIBUTION_DENIED' });
  });

  it('requires both licensed permission and the named entitlement', () => {
    const access: CorpusAccess = {
      visibility: 'LICENSE_RESTRICTED', licenseClass: 'LICENSED_INTERNAL_ONLY', redistributionClass: 'PROHIBITED', retentionClass: 'SOURCE_POLICY',
      allowedUses: ['ANALYSIS'], entitlements: ['vendor:kpler'],
    };
    const licensed: CorpusActorIdentity = { actorId: 'service:analyst', actorKind: 'service', permissions: ['corpus:read:licensed'], entitlements: [] };
    expect(authorizeCorpusObject({ scope: 'global', access }, licensed, 'ANALYSIS')).toMatchObject({ kind: 'denied', code: 'CORPUS_ENTITLEMENT_DENIED' });
    expect(authorizeCorpusObject({ scope: 'global', access }, { ...licensed, entitlements: ['vendor:kpler'] }, 'ANALYSIS')).toMatchObject({ kind: 'allowed' });
  });

  it('keeps customer overlays tenant-bound even when an actor has customer-read permission', () => {
    const access: CorpusAccess = {
      visibility: 'CUSTOMER_PRIVATE', licenseClass: 'CUSTOMER_CONFIDENTIAL', redistributionClass: 'PROHIBITED', retentionClass: 'CUSTOMER_CONTRACT',
      allowedUses: ['SEARCH', 'ANALYSIS'], tenantId: 'acme',
    };
    const actor: CorpusActorIdentity = { actorId: 'user:other', actorKind: 'user', tenantId: 'other', permissions: ['corpus:read:customer'] };
    expect(corpusAccessScopeDefect('customer:acme', access)).toBeNull();
    expect(authorizeCorpusObject({ scope: 'customer:acme', access }, actor, 'SEARCH')).toMatchObject({ kind: 'denied', code: 'CORPUS_TENANT_DENIED' });
    expect(authorizeCorpusObject({ scope: 'customer:acme', access }, { ...actor, tenantId: 'acme' }, 'SEARCH')).toMatchObject({ kind: 'allowed' });
  });

  it('rejects contradictory or incomplete classification metadata', () => {
    expect(corpusAccessDefect({ ...OPEN_PUBLIC_CORPUS_ACCESS, licenseClass: 'LICENSED_INTERNAL_ONLY' })).toMatch(/public visibility/i);
    expect(corpusAccessDefect({ ...OPEN_PUBLIC_CORPUS_ACCESS, visibility: 'LICENSE_RESTRICTED', licenseClass: 'LICENSED_INTERNAL_ONLY' })).toMatch(/entitlement/i);
    expect(corpusAccessScopeDefect('customer:acme', { ...OPEN_PUBLIC_CORPUS_ACCESS, tenantId: 'acme' })).toMatch(/cannot be public/i);
    expect(corpusAccessDefect({ ...OPEN_PUBLIC_CORPUS_ACCESS, prohibitedUses: ['SEARCH'] })).toMatch(/overlap/i);
    expect(corpusAccessDefect({ ...OPEN_PUBLIC_CORPUS_ACCESS, derivationPolicy: 'PROHIBITED' })).toMatch(/cannot permit DERIVATION/i);
    expect(corpusAccessDefect({ ...OPEN_PUBLIC_CORPUS_ACCESS, sourceLicenseId: 'x' })).toMatch(/sourceLicenseId/i);
  });

  it('deterministically inherits the most restrictive policy and attribution duty', () => {
    const attribution: CorpusAccess = {
      ...OPEN_PUBLIC_CORPUS_ACCESS,
      licenseClass: 'PUBLIC_ATTRIBUTION_REQUIRED',
      sourceLicenseId: 'license:ca-open-government',
      redistributionClass: 'ATTRIBUTION_REQUIRED',
      jurisdiction: 'CA',
    };
    const one = joinCorpusPolicies([
      { recordId: 'record:b', scope: 'global', access: attribution },
      { recordId: 'record:a', scope: 'global', access: OPEN_PUBLIC_CORPUS_ACCESS },
    ]);
    const two = joinCorpusPolicies([
      { recordId: 'record:a', scope: 'global', access: OPEN_PUBLIC_CORPUS_ACCESS },
      { recordId: 'record:b', scope: 'global', access: attribution },
    ]);
    expect(one).toMatchObject({
      kind: 'policy_joined',
      lineage: {
        inputCount: 2,
        effective: {
          classification: 'PUBLIC',
          redistribution: 'ATTRIBUTION_REQUIRED',
          attributionRequired: true,
          externalRelease: 'PERMITTED',
          jurisdictions: ['CA'],
          sourceLicenseIds: ['license:ca-open-government', 'license:open-public'],
        },
      },
    });
    expect(two).toEqual(one);
  });

  it('preserves licensed constraints and refuses cross-tenant composition', () => {
    const licensed: CorpusAccess = {
      visibility: 'LICENSE_RESTRICTED', licenseClass: 'LICENSED_DERIVED_ONLY', redistributionClass: 'DERIVED_ONLY', retentionClass: 'SOURCE_POLICY',
      allowedUses: ['ANALYSIS', 'DERIVATION'], derivationPolicy: 'AGGREGATE_ONLY', entitlements: ['vendor:kpler'],
    };
    expect(joinCorpusPolicies([
      { recordId: 'record:public', scope: 'global', access: OPEN_PUBLIC_CORPUS_ACCESS },
      { recordId: 'record:licensed', scope: 'global', access: licensed },
    ])).toMatchObject({
      kind: 'policy_joined',
      lineage: { effective: { classification: 'LICENSE_RESTRICTED', requiredEntitlements: ['vendor:kpler'], externalRelease: 'PROHIBITED' } },
    });
    const tenant = (tenantId: string): CorpusAccess => ({
      visibility: 'CUSTOMER_PRIVATE', licenseClass: 'CUSTOMER_CONFIDENTIAL', redistributionClass: 'PROHIBITED', retentionClass: 'CUSTOMER_CONTRACT',
      allowedUses: ['ANALYSIS', 'DERIVATION'], derivationPolicy: 'INTERNAL_ONLY', tenantId,
    });
    expect(joinCorpusPolicies([
      { recordId: 'record:acme', scope: 'customer:acme', access: tenant('acme') },
      { recordId: 'record:other', scope: 'customer:other', access: tenant('other') },
    ])).toMatchObject({ kind: 'refusal', code: 'CORPUS_POLICY_TENANT_CONFLICT' });
  });

  it('refuses to derive from an input whose permitted-use set excludes derivation', () => {
    expect(joinCorpusPolicies([{
      recordId: 'record:no-derivation', scope: 'global', access: { ...OPEN_PUBLIC_CORPUS_ACCESS, allowedUses: ['SEARCH', 'ANALYSIS', 'REDISTRIBUTION', 'PROJECTION'] },
    }])).toMatchObject({ kind: 'refusal', code: 'CORPUS_POLICY_DERIVATION_DENIED' });
  });

  it('releases aggregate-only inputs only through an explicitly aggregate computation', () => {
    const aggregateOnly: CorpusAccess = {
      ...OPEN_PUBLIC_CORPUS_ACCESS,
      redistributionClass: 'DERIVED_ONLY',
      derivationPolicy: 'AGGREGATE_ONLY',
    };
    const inputs = [{ recordId: 'record:aggregate-only', scope: 'global', access: aggregateOnly }];
    expect(joinCorpusPolicies(inputs)).toMatchObject({ kind: 'policy_joined', lineage: { effective: { outputForm: 'RECORD_LEVEL', externalRelease: 'PROHIBITED' } } });
    expect(joinCorpusPolicies(inputs, { outputForm: 'AGGREGATE' })).toMatchObject({ kind: 'policy_joined', lineage: { effective: { outputForm: 'AGGREGATE', externalRelease: 'PERMITTED' } } });
  });
});
