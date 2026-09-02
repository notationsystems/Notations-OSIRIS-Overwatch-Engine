import { describe, expect, it } from 'vitest';
import {
  authorizeCorpusObject,
  corpusAccessDefect,
  corpusAccessScopeDefect,
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
  });
});
