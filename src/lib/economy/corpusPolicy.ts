/**
 * Object-level policy for the PayloadOS corpus.
 *
 * Network placement never grants access. Every projection/query receives an
 * explicit actor, purpose and governed object. Missing classification denies
 * access, and agents receive no implicit privilege over human/API clients.
 */

import { createHash } from 'node:crypto';

export const CORPUS_VISIBILITIES = ['PUBLIC', 'PAYLOAD_INTERNAL', 'LICENSE_RESTRICTED', 'CUSTOMER_PRIVATE', 'CUSTOMER_SHARED', 'CONFIDENTIAL'] as const;
export const CORPUS_LICENSE_CLASSES = ['OPEN_PUBLIC', 'PUBLIC_ATTRIBUTION_REQUIRED', 'LICENSED_INTERNAL_ONLY', 'LICENSED_DERIVED_ONLY', 'CUSTOMER_CONFIDENTIAL', 'PAYLOAD_PROPRIETARY', 'UNKNOWN'] as const;
export const CORPUS_REDISTRIBUTION_CLASSES = ['UNRESTRICTED', 'ATTRIBUTION_REQUIRED', 'DERIVED_ONLY', 'PROHIBITED'] as const;
export const CORPUS_RETENTION_CLASSES = ['PERMANENT', 'SOURCE_POLICY', 'CUSTOMER_CONTRACT', 'EPHEMERAL'] as const;
export const CORPUS_ALLOWED_USES = ['SEARCH', 'ANALYSIS', 'DERIVATION', 'AGENT_CONTEXT', 'MODEL_TRAINING', 'REDISTRIBUTION', 'PROJECTION'] as const;
export const CORPUS_DERIVATION_POLICIES = ['PERMITTED', 'AGGREGATE_ONLY', 'INTERNAL_ONLY', 'PROHIBITED'] as const;
export const CORPUS_ACTOR_KINDS = ['anonymous', 'user', 'service', 'agent', 'source', 'execution'] as const;
export const CORPUS_PERMISSIONS = ['corpus:read:public', 'corpus:read:internal', 'corpus:read:licensed', 'corpus:read:customer', 'corpus:read:confidential', 'corpus:compile'] as const;

export type CorpusVisibility = typeof CORPUS_VISIBILITIES[number];
export type CorpusLicenseClass = typeof CORPUS_LICENSE_CLASSES[number];
export type CorpusRedistributionClass = typeof CORPUS_REDISTRIBUTION_CLASSES[number];
export type CorpusRetentionClass = typeof CORPUS_RETENTION_CLASSES[number];
export type CorpusAllowedUse = typeof CORPUS_ALLOWED_USES[number];
export type CorpusDerivationPolicy = typeof CORPUS_DERIVATION_POLICIES[number];
export type CorpusActorKind = typeof CORPUS_ACTOR_KINDS[number];
export type CorpusPermission = typeof CORPUS_PERMISSIONS[number];

export type CorpusAccess = {
  readonly visibility: CorpusVisibility;
  readonly licenseClass: CorpusLicenseClass;
  readonly sourceLicenseId?: string;
  readonly redistributionClass: CorpusRedistributionClass;
  readonly retentionClass: CorpusRetentionClass;
  readonly allowedUses: readonly CorpusAllowedUse[];
  readonly prohibitedUses?: readonly CorpusAllowedUse[];
  readonly derivationPolicy?: CorpusDerivationPolicy;
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

export const CORPUS_POLICY_VERSION = 'payload.corpus.policy.v1';

export type CorpusPolicyInput = {
  readonly recordId: string;
  readonly scope: string;
  readonly access?: CorpusAccess;
};

export type DerivedCorpusPolicy = {
  readonly schema: typeof CORPUS_POLICY_VERSION;
  readonly outputForm: 'RECORD_LEVEL' | 'AGGREGATE';
  readonly classification: CorpusVisibility;
  readonly tenantId?: string;
  readonly sourceLicenses: readonly CorpusLicenseClass[];
  readonly sourceLicenseIds: readonly string[];
  readonly permittedUses: readonly CorpusAllowedUse[];
  readonly prohibitedUses: readonly CorpusAllowedUse[];
  readonly redistribution: CorpusRedistributionClass;
  readonly derivationPolicy: CorpusDerivationPolicy;
  readonly retention: readonly CorpusRetentionClass[];
  readonly jurisdictions: readonly string[];
  readonly requiredEntitlements: readonly string[];
  readonly attributionRequired: boolean;
  readonly externalRelease: 'PERMITTED' | 'PROHIBITED';
};

export type CorpusPolicyLineage = {
  readonly schema: 'payload.corpus.policy-lineage.v1';
  readonly lineageId: string;
  readonly inputCount: number;
  readonly inputs: readonly { readonly recordId: string; readonly policyDigest: string }[];
  readonly effectivePolicyDigest: string;
  readonly effective: DerivedCorpusPolicy;
};

export type CorpusPolicyJoinResult =
  | { readonly kind: 'policy_joined'; readonly lineage: CorpusPolicyLineage }
  | { readonly kind: 'refusal'; readonly code: 'CORPUS_POLICY_INPUT_EMPTY' | 'CORPUS_POLICY_INPUT_CONFLICT' | 'CORPUS_POLICY_CLASSIFICATION_MISSING' | 'CORPUS_POLICY_DERIVATION_DENIED' | 'CORPUS_POLICY_TENANT_CONFLICT'; readonly detail: string };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;
const TENANT = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function isUniqueStringArray(value: unknown, allowed?: readonly string[], allowEmpty = false): value is readonly string[] {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every(item => typeof item === 'string' && (allowed ? allowed.includes(item) : IDENTIFIER.test(item)))
    && new Set(value).size === value.length;
}

/** Structural validation used at the canonical append boundary. */
export function corpusAccessDefect(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'access classification is not an object';
  const access = value as Partial<CorpusAccess>;
  if (!CORPUS_VISIBILITIES.includes(access.visibility as CorpusVisibility)) return 'access visibility is invalid';
  if (!CORPUS_LICENSE_CLASSES.includes(access.licenseClass as CorpusLicenseClass)) return 'access licenseClass is invalid';
  if (access.sourceLicenseId !== undefined && (typeof access.sourceLicenseId !== 'string' || !IDENTIFIER.test(access.sourceLicenseId))) return 'access sourceLicenseId is invalid';
  if (!CORPUS_REDISTRIBUTION_CLASSES.includes(access.redistributionClass as CorpusRedistributionClass)) return 'access redistributionClass is invalid';
  if (!CORPUS_RETENTION_CLASSES.includes(access.retentionClass as CorpusRetentionClass)) return 'access retentionClass is invalid';
  if (!isUniqueStringArray(access.allowedUses, CORPUS_ALLOWED_USES)) return 'access allowedUses must be a unique non-empty list';
  if (access.prohibitedUses !== undefined && !isUniqueStringArray(access.prohibitedUses, CORPUS_ALLOWED_USES, true)) return 'access prohibitedUses must be a unique list';
  if (access.prohibitedUses?.some(use => access.allowedUses?.includes(use))) return 'access permitted and prohibited uses overlap';
  if (access.derivationPolicy !== undefined && !CORPUS_DERIVATION_POLICIES.includes(access.derivationPolicy)) return 'access derivationPolicy is invalid';
  if (access.derivationPolicy === 'PROHIBITED' && access.allowedUses?.includes('DERIVATION')) return 'access cannot permit DERIVATION while derivationPolicy prohibits it';
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
  if (access.prohibitedUses?.includes(use)) return denied('CORPUS_USE_NOT_ALLOWED', `${use} is explicitly prohibited for this object.`);
  if (!access.allowedUses.includes(use)) return denied('CORPUS_USE_NOT_ALLOWED', `${use} is not an allowed use for this object.`);
  if (use === 'DERIVATION' && effectiveDerivationPolicy(access) === 'PROHIBITED') return denied('CORPUS_USE_NOT_ALLOWED', 'Derivation is prohibited for this object.');
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

const VISIBILITY_RANK: Record<CorpusVisibility, number> = {
  PUBLIC: 0,
  PAYLOAD_INTERNAL: 1,
  CUSTOMER_SHARED: 2,
  LICENSE_RESTRICTED: 3,
  CUSTOMER_PRIVATE: 4,
  CONFIDENTIAL: 5,
};
const REDISTRIBUTION_RANK: Record<CorpusRedistributionClass, number> = { UNRESTRICTED: 0, ATTRIBUTION_REQUIRED: 1, DERIVED_ONLY: 2, PROHIBITED: 3 };
const DERIVATION_RANK: Record<CorpusDerivationPolicy, number> = { PERMITTED: 0, AGGREGATE_ONLY: 1, INTERNAL_ONLY: 2, PROHIBITED: 3 };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function mostRestrictive<T extends string>(values: readonly T[], rank: Record<T, number>): T {
  return [...values].sort((a, b) => rank[b] - rank[a] || a.localeCompare(b))[0];
}

function effectiveDerivationPolicy(access: CorpusAccess): CorpusDerivationPolicy {
  if (access.derivationPolicy) return access.derivationPolicy;
  if (!access.allowedUses.includes('DERIVATION')) return 'PROHIBITED';
  if (access.licenseClass === 'LICENSED_DERIVED_ONLY') return 'AGGREGATE_ONLY';
  if (access.visibility === 'PUBLIC') return 'PERMITTED';
  return 'INTERNAL_ONLY';
}

function joinRefusal(code: Extract<CorpusPolicyJoinResult, { kind: 'refusal' }>['code'], detail: string): CorpusPolicyJoinResult {
  return Object.freeze({ kind: 'refusal' as const, code, detail });
}

/**
 * Join input labels for a derived computation. The result is deterministic and
 * inherits the most restrictive relevant constraints. Global inputs may join
 * one tenant overlay; two tenant overlays can never be combined implicitly.
 */
export function joinCorpusPolicies(
  inputs: readonly CorpusPolicyInput[],
  options: { readonly outputForm?: 'RECORD_LEVEL' | 'AGGREGATE' } = {},
): CorpusPolicyJoinResult {
  if (inputs.length === 0) return joinRefusal('CORPUS_POLICY_INPUT_EMPTY', 'A derived object must identify at least one governed input.');
  const ordered = [...inputs].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const seen = new Map<string, string>();
  for (const input of ordered) {
    if (!input.access) return joinRefusal('CORPUS_POLICY_CLASSIFICATION_MISSING', `Input ${input.recordId} has no explicit policy label.`);
    const accessDigest = digest(input.access);
    const prior = seen.get(input.recordId);
    if (prior && prior !== accessDigest) return joinRefusal('CORPUS_POLICY_INPUT_CONFLICT', `Input ${input.recordId} was supplied with contradictory policy labels.`);
    seen.set(input.recordId, accessDigest);
    if (input.access.prohibitedUses?.includes('DERIVATION') || !input.access.allowedUses.includes('DERIVATION') || effectiveDerivationPolicy(input.access) === 'PROHIBITED') {
      return joinRefusal('CORPUS_POLICY_DERIVATION_DENIED', `Input ${input.recordId} does not permit derivation.`);
    }
  }
  const unique = ordered.filter((input, index) => index === 0 || input.recordId !== ordered[index - 1].recordId);
  const tenants = [...new Set(unique.flatMap(input => input.access!.tenantId ? [input.access!.tenantId] : []))].sort();
  if (tenants.length > 1) return joinRefusal('CORPUS_POLICY_TENANT_CONFLICT', `Inputs span tenant boundaries: ${tenants.join(', ')}.`);

  const accesses = unique.map(input => input.access!);
  const prohibitedUses = [...new Set(accesses.flatMap(access => access.prohibitedUses ?? []))].sort() as CorpusAllowedUse[];
  const permittedUses = CORPUS_ALLOWED_USES.filter(use => accesses.every(access => access.allowedUses.includes(use)) && !prohibitedUses.includes(use));
  const redistribution = mostRestrictive(accesses.map(access => access.redistributionClass), REDISTRIBUTION_RANK);
  const derivationPolicy = mostRestrictive(accesses.map(effectiveDerivationPolicy), DERIVATION_RANK);
  const outputForm = options.outputForm ?? 'RECORD_LEVEL';
  const effective: DerivedCorpusPolicy = Object.freeze({
    schema: CORPUS_POLICY_VERSION,
    outputForm,
    classification: mostRestrictive(accesses.map(access => access.visibility), VISIBILITY_RANK),
    ...(tenants[0] ? { tenantId: tenants[0] } : {}),
    sourceLicenses: Object.freeze([...new Set(accesses.map(access => access.licenseClass))].sort()),
    sourceLicenseIds: Object.freeze([...new Set(accesses.flatMap(access => access.sourceLicenseId ? [access.sourceLicenseId] : []))].sort()),
    permittedUses: Object.freeze(permittedUses),
    prohibitedUses: Object.freeze(prohibitedUses),
    redistribution,
    derivationPolicy,
    retention: Object.freeze([...new Set(accesses.map(access => access.retentionClass))].sort()),
    jurisdictions: Object.freeze([...new Set(accesses.flatMap(access => access.jurisdiction ? [access.jurisdiction] : []))].sort()),
    requiredEntitlements: Object.freeze([...new Set(accesses.flatMap(access => access.entitlements ?? []))].sort()),
    attributionRequired: accesses.some(access => access.licenseClass === 'PUBLIC_ATTRIBUTION_REQUIRED' || access.redistributionClass === 'ATTRIBUTION_REQUIRED'),
    externalRelease: permittedUses.includes('REDISTRIBUTION')
      && redistribution !== 'PROHIBITED'
      && derivationPolicy !== 'INTERNAL_ONLY'
      && (derivationPolicy !== 'AGGREGATE_ONLY' || outputForm === 'AGGREGATE')
      ? 'PERMITTED' : 'PROHIBITED',
  });
  const lineageInputs = Object.freeze(unique.map(input => Object.freeze({ recordId: input.recordId, policyDigest: digest(input.access) })));
  const effectivePolicyDigest = digest(effective);
  const lineageBasis = { schema: 'payload.corpus.policy-lineage.v1' as const, inputs: lineageInputs, effectivePolicyDigest };
  return Object.freeze({
    kind: 'policy_joined' as const,
    lineage: Object.freeze({ ...lineageBasis, lineageId: digest(lineageBasis), inputCount: lineageInputs.length, effective }),
  });
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
  sourceLicenseId: 'license:open-public',
  redistributionClass: 'UNRESTRICTED',
  retentionClass: 'PERMANENT',
  allowedUses: Object.freeze(['SEARCH', 'ANALYSIS', 'DERIVATION', 'REDISTRIBUTION', 'PROJECTION'] as const),
  prohibitedUses: Object.freeze([]),
  derivationPolicy: 'PERMITTED',
});
