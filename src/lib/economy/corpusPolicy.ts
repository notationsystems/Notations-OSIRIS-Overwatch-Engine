/**
 * Object-level policy for the PayloadOS corpus.
 *
 * Network placement never grants access. Every projection/query receives an
 * explicit actor, purpose and governed object. Missing classification denies
 * access, and agents receive no implicit privilege over human/API clients.
 */

export const CORPUS_VISIBILITIES = ['PUBLIC', 'PAYLOAD_INTERNAL', 'LICENSE_RESTRICTED', 'CUSTOMER_PRIVATE', 'CUSTOMER_SHARED', 'CONFIDENTIAL'] as const;
export const CORPUS_LICENSE_CLASSES = ['OPEN_PUBLIC', 'PUBLIC_ATTRIBUTION_REQUIRED', 'LICENSED_INTERNAL_ONLY', 'LICENSED_DERIVED_ONLY', 'CUSTOMER_CONFIDENTIAL', 'PAYLOAD_PROPRIETARY', 'UNKNOWN'] as const;
export const CORPUS_REDISTRIBUTION_CLASSES = ['UNRESTRICTED', 'ATTRIBUTION_REQUIRED', 'DERIVED_ONLY', 'PROHIBITED'] as const;
export const CORPUS_RETENTION_CLASSES = ['PERMANENT', 'SOURCE_POLICY', 'CUSTOMER_CONTRACT', 'EPHEMERAL'] as const;
export const CORPUS_ALLOWED_USES = ['SEARCH', 'ANALYSIS', 'DERIVATION', 'AGENT_CONTEXT', 'REDISTRIBUTION', 'PROJECTION'] as const;
export const CORPUS_ACTOR_KINDS = ['anonymous', 'user', 'service', 'agent', 'source', 'execution'] as const;
export const CORPUS_PERMISSIONS = ['corpus:read:public', 'corpus:read:internal', 'corpus:read:licensed', 'corpus:read:customer', 'corpus:read:confidential', 'corpus:compile'] as const;

export type CorpusVisibility = typeof CORPUS_VISIBILITIES[number];
export type CorpusLicenseClass = typeof CORPUS_LICENSE_CLASSES[number];
export type CorpusRedistributionClass = typeof CORPUS_REDISTRIBUTION_CLASSES[number];
export type CorpusRetentionClass = typeof CORPUS_RETENTION_CLASSES[number];
export type CorpusAllowedUse = typeof CORPUS_ALLOWED_USES[number];
export type CorpusActorKind = typeof CORPUS_ACTOR_KINDS[number];
export type CorpusPermission = typeof CORPUS_PERMISSIONS[number];

export type CorpusAccess = {
  readonly visibility: CorpusVisibility;
  readonly licenseClass: CorpusLicenseClass;
  readonly redistributionClass: CorpusRedistributionClass;
  readonly retentionClass: CorpusRetentionClass;
  readonly allowedUses: readonly CorpusAllowedUse[];
  readonly tenantId?: string;
  readonly ownerId?: string;
  readonly entitlements?: readonly string[];
  readonly jurisdiction?: string;
};

export type CorpusActorIdentity = {
  readonly actorId: string;
  readonly actorKind: CorpusActorKind;
  readonly permissions: readonly CorpusPermission[];
  readonly tenantId?: string;
  readonly entitlements?: readonly string[];
};

export type CorpusPolicyDecision =
  | { readonly kind: 'allowed'; readonly actorId: string; readonly use: CorpusAllowedUse }
  | { readonly kind: 'denied'; readonly code: 'CORPUS_CLASSIFICATION_MISSING' | 'CORPUS_USE_NOT_ALLOWED' | 'CORPUS_PERMISSION_DENIED' | 'CORPUS_TENANT_DENIED' | 'CORPUS_ENTITLEMENT_DENIED' | 'CORPUS_REDISTRIBUTION_DENIED'; readonly detail: string };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;
const TENANT = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function isUniqueStringArray(value: unknown, allowed?: readonly string[]): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'string' && (allowed ? allowed.includes(item) : IDENTIFIER.test(item)))
    && new Set(value).size === value.length;
}

/** Structural validation used at the canonical append boundary. */
export function corpusAccessDefect(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'access classification is not an object';
  const access = value as Partial<CorpusAccess>;
  if (!CORPUS_VISIBILITIES.includes(access.visibility as CorpusVisibility)) return 'access visibility is invalid';
  if (!CORPUS_LICENSE_CLASSES.includes(access.licenseClass as CorpusLicenseClass)) return 'access licenseClass is invalid';
  if (!CORPUS_REDISTRIBUTION_CLASSES.includes(access.redistributionClass as CorpusRedistributionClass)) return 'access redistributionClass is invalid';
  if (!CORPUS_RETENTION_CLASSES.includes(access.retentionClass as CorpusRetentionClass)) return 'access retentionClass is invalid';
  if (!isUniqueStringArray(access.allowedUses, CORPUS_ALLOWED_USES)) return 'access allowedUses must be a unique non-empty list';
  if (access.tenantId !== undefined && (typeof access.tenantId !== 'string' || !TENANT.test(access.tenantId))) return 'access tenantId is invalid';
  if (access.ownerId !== undefined && (typeof access.ownerId !== 'string' || !IDENTIFIER.test(access.ownerId))) return 'access ownerId is invalid';
  if (access.entitlements !== undefined && !isUniqueStringArray(access.entitlements)) return 'access entitlements are invalid';
  if (access.jurisdiction !== undefined && (typeof access.jurisdiction !== 'string' || !/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(access.jurisdiction))) return 'access jurisdiction is invalid';
  if (access.visibility === 'LICENSE_RESTRICTED' && !access.entitlements?.length) return 'license-restricted access requires at least one entitlement';
  if (access.visibility === 'PUBLIC' && !['OPEN_PUBLIC', 'PUBLIC_ATTRIBUTION_REQUIRED'].includes(access.licenseClass!)) return 'public visibility requires a public license class';
  return null;
}

/** Scope/tenant consistency is checked separately because scope is ledger metadata. */
export function corpusAccessScopeDefect(scope: string, access: CorpusAccess): string | null {
  if (scope === 'global') {
    if (access.tenantId) return 'global records cannot carry a tenantId';
    if (access.visibility === 'CUSTOMER_PRIVATE' || access.visibility === 'CUSTOMER_SHARED') return 'global records cannot use customer visibility';
    return null;
  }
  if (!scope.startsWith('customer:')) return 'scope is invalid';
  const tenantId = scope.slice('customer:'.length);
  if (access.tenantId !== tenantId) return `customer scope ${scope} requires tenantId ${tenantId}`;
  if (access.visibility === 'PUBLIC') return 'customer-overlay records cannot be public; promote them through an explicit global record';
  return null;
}

function denied(code: Extract<CorpusPolicyDecision, { kind: 'denied' }>['code'], detail: string): CorpusPolicyDecision {
  return Object.freeze({ kind: 'denied' as const, code, detail });
}

function has(actor: CorpusActorIdentity, permission: CorpusPermission): boolean {
  return actor.permissions.includes(permission);
}

/** Fail-closed authorization for one canonical object and one declared use. */
export function authorizeCorpusObject(
  governed: { readonly scope: string; readonly access?: CorpusAccess },
  actor: CorpusActorIdentity,
  use: CorpusAllowedUse,
): CorpusPolicyDecision {
  const access = governed.access;
  if (!access) return denied('CORPUS_CLASSIFICATION_MISSING', 'The object has no explicit access classification.');
  if (!access.allowedUses.includes(use)) return denied('CORPUS_USE_NOT_ALLOWED', `${use} is not an allowed use for this object.`);
  if (use === 'REDISTRIBUTION' && (access.redistributionClass === 'DERIVED_ONLY' || access.redistributionClass === 'PROHIBITED')) {
    return denied('CORPUS_REDISTRIBUTION_DENIED', `Redistribution class ${access.redistributionClass} does not allow returning this object.`);
  }

  if (access.visibility === 'PUBLIC') {
    if (!has(actor, 'corpus:read:public')) return denied('CORPUS_PERMISSION_DENIED', 'The actor cannot read public corpus objects.');
  } else if (access.visibility === 'PAYLOAD_INTERNAL') {
    if (!has(actor, 'corpus:read:internal')) return denied('CORPUS_PERMISSION_DENIED', 'The actor cannot read Payload-internal corpus objects.');
  } else if (access.visibility === 'LICENSE_RESTRICTED') {
    if (!has(actor, 'corpus:read:licensed')) return denied('CORPUS_PERMISSION_DENIED', 'The actor cannot read licensed corpus objects.');
    const held = new Set(actor.entitlements ?? []);
    const missing = (access.entitlements ?? []).find(entitlement => !held.has(entitlement));
    if (missing) return denied('CORPUS_ENTITLEMENT_DENIED', `The actor lacks entitlement ${missing}.`);
  } else if (access.visibility === 'CUSTOMER_PRIVATE' || access.visibility === 'CUSTOMER_SHARED') {
    if (!has(actor, 'corpus:read:customer')) return denied('CORPUS_PERMISSION_DENIED', 'The actor cannot read customer corpus objects.');
    const shared = access.visibility === 'CUSTOMER_SHARED' && (actor.entitlements ?? []).includes(`tenant:${access.tenantId}:shared`);
    if (!access.tenantId || (actor.tenantId !== access.tenantId && !shared)) return denied('CORPUS_TENANT_DENIED', 'The object is outside the actor tenant boundary.');
  } else {
    if (!has(actor, 'corpus:read:confidential')) return denied('CORPUS_PERMISSION_DENIED', 'The actor cannot read confidential corpus objects.');
    if (access.tenantId && actor.tenantId !== access.tenantId) return denied('CORPUS_TENANT_DENIED', 'The confidential object is outside the actor tenant boundary.');
  }
  return Object.freeze({ kind: 'allowed' as const, actorId: actor.actorId, use });
}

export const PUBLIC_PROJECTION_ACTOR: CorpusActorIdentity = Object.freeze({
  actorId: 'service:corpus-public-projector',
  actorKind: 'service',
  permissions: Object.freeze(['corpus:read:public', 'corpus:compile'] as const),
  entitlements: Object.freeze([]),
});

export const OPEN_PUBLIC_CORPUS_ACCESS: CorpusAccess = Object.freeze({
  visibility: 'PUBLIC',
  licenseClass: 'OPEN_PUBLIC',
  redistributionClass: 'UNRESTRICTED',
  retentionClass: 'PERMANENT',
  allowedUses: Object.freeze(['SEARCH', 'ANALYSIS', 'DERIVATION', 'REDISTRIBUTION', 'PROJECTION'] as const),
});
