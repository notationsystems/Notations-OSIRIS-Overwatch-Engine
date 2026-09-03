/** Deterministic, challengeable checks that run before a CorpusBuild is published. */

import { authorizeCorpusObject, PUBLIC_PROJECTION_ACTOR, type CorpusAllowedUse } from './corpusPolicy';
import { PAYLOAD_CORPUS_METHODOLOGY_VERSION, PAYLOAD_CORPUS_PREFLIGHT_VERSION } from './corpusMethodologyVersions';
import { PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION } from './payloadCorpusDefinition';
import {
  corpusRecordReferenceIds,
  corpusStableIdentity,
  type CorpusProjectionSource,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';
import type { CompiledCorpusProjection } from './corpusProjection';
import { corpusVerificationDigest } from './corpusVerification';

export type CorpusPreflightCheck = {
  readonly checkId: string;
  readonly status: 'PASS' | 'FAIL' | 'UNOBSERVED';
  readonly blocking: boolean;
  readonly detail: string;
  readonly evidenceRefs: readonly string[];
};

export type CorpusBuildPreflight = {
  readonly schema: 'payload.corpus.preflight.v1';
  readonly preflightVersion: typeof PAYLOAD_CORPUS_PREFLIGHT_VERSION;
  readonly methodologyVersion: typeof PAYLOAD_CORPUS_METHODOLOGY_VERSION;
  readonly corpusBuildId: string;
  readonly sourceSequence: number;
  readonly sourceDigest: string;
  readonly projectionDigest: string;
  readonly evaluatedAt: string;
  readonly status: 'PASS' | 'FAIL' | 'DEGRADED';
  readonly publicationAllowed: boolean;
  readonly checks: readonly CorpusPreflightCheck[];
  readonly identityRisks: readonly {
    readonly kind: 'AMBIGUOUS_ALIAS';
    readonly normalizedMention: string;
    readonly conflictingEntityIds: readonly string[];
    readonly validationStatus: 'REVIEW_REQUIRED';
  }[];
  readonly preflightDigest: string;
};

const PUBLIC_USES = ['PROJECTION', 'SEARCH', 'DERIVATION', 'REDISTRIBUTION'] as const satisfies readonly CorpusAllowedUse[];

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function check(checkId: string, status: CorpusPreflightCheck['status'], blocking: boolean, detail: string, evidenceRefs: readonly string[] = []): CorpusPreflightCheck {
  return freeze({ checkId, status, blocking, detail, evidenceRefs: [...evidenceRefs].sort() });
}

function ontologyDefects(records: readonly StoredCorpusRecord[]): string[] {
  const definition = PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION;
  return records.flatMap(record => record.recordType === 'entity' && !definition.entityTypes.includes(record.entityKind)
    ? [`${record.recordId}:entity:${record.entityKind}`]
    : record.recordType === 'relationship' && !definition.relationTypes.includes(record.predicate)
      ? [`${record.recordId}:relationship:${record.predicate}`]
      : record.recordType === 'observation' && !definition.observationTypes.includes(record.observationType ?? 'metric')
        ? [`${record.recordId}:observation:${record.observationType ?? 'metric'}`]
        : []);
}

function stableIdentityCollisions(records: readonly StoredCorpusRecord[]): string[] {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const record of records) {
    const identity = `${record.recordType}:${corpusStableIdentity(record)}`;
    const prior = seen.get(identity);
    if (prior && prior !== record.recordId) collisions.push(`${identity}:${prior}:${record.recordId}`);
    else seen.set(identity, record.recordId);
  }
  return [...new Set(collisions)].sort();
}

function ambiguousAliases(records: readonly StoredCorpusRecord[]): CorpusBuildPreflight['identityRisks'] {
  const mentions = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.recordType !== 'alias') continue;
    const key = record.value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
    const entities = mentions.get(key) ?? new Set<string>();
    entities.add(record.entityId);
    mentions.set(key, entities);
  }
  return freeze([...mentions.entries()].filter(([, ids]) => ids.size > 1).map(([normalizedMention, ids]) => ({
    kind: 'AMBIGUOUS_ALIAS' as const,
    normalizedMention,
    conflictingEntityIds: [...ids].sort(),
    validationStatus: 'REVIEW_REQUIRED' as const,
  })).sort((left, right) => left.normalizedMention.localeCompare(right.normalizedMention)));
}

/** Run the full publication contract without mutating the projection or checkpoint. */
export function preflightPublicCorpusBuild(source: CorpusProjectionSource, projection: CompiledCorpusProjection): CorpusBuildPreflight {
  const evidenceIds = new Set(projection.records.flatMap(record => record.recordType === 'evidence' ? [record.evidenceId] : record.recordType === 'evidence_unit' ? [record.evidenceUnitId] : []));
  const entityIds = new Set(projection.records.flatMap(record => record.recordType === 'entity' ? [record.entityId] : []));
  const observationIds = new Set(projection.records.flatMap(record => record.recordType === 'observation' ? [record.observationId] : []));
  const identityCollisions = stableIdentityCollisions(projection.records);
  const ontology = ontologyDefects(projection.records);
  const temporalLeakage = projection.records.filter(record => Date.parse(record.knownAt) > Date.parse(projection.manifest.knowledgeCutoff)).map(record => record.recordId).sort();
  const policyDefects = projection.records.flatMap(record => PUBLIC_USES.flatMap(use => {
    const decision = authorizeCorpusObject(record, PUBLIC_PROJECTION_ACTOR, use);
    return decision.kind === 'denied' ? [`${record.recordId}:${use}:${decision.code}`] : [];
  })).sort();
  const evidenceClosure = projection.records.flatMap(record => corpusRecordReferenceIds(record).filter(reference => {
    if (record.recordType === 'assertion') return !observationIds.has(reference);
    return !evidenceIds.has(reference);
  }).map(reference => `${record.recordId}:support:${reference}`)).concat(projection.records.flatMap(record => {
    if (record.recordType === 'relationship') return [record.subjectEntityId, record.objectEntityId].filter(id => !entityIds.has(id)).map(id => `${record.recordId}:endpoint:${id}`);
    if (record.recordType === 'alias' || record.recordType === 'observation' || record.recordType === 'assertion') return entityIds.has(record.entityId) ? [] : [`${record.recordId}:entity:${record.entityId}`];
    return [];
  })).sort();
  const sourceMatches = source.scope === 'global' && source.sourceSequence === projection.manifest.sourceSequence && source.sourceDigest === projection.manifest.sourceDigest;
  const identityRisks = ambiguousAliases(projection.records);
  const checks = freeze([
    check('projection-source-equivalence', sourceMatches ? 'PASS' : 'FAIL', true, sourceMatches ? 'Projection identifies the exact supplied canonical source state.' : 'Projection sequence or fingerprint does not match the supplied canonical source state.', [source.sourceDigest, projection.manifest.sourceDigest]),
    check('ontology-conformance', ontology.length ? 'FAIL' : 'PASS', true, ontology.length ? `${ontology.length} record(s) use an unregistered ontology term.` : 'All projected entity, relationship, and observation types are registered.', ontology),
    check('stable-identity-collision', identityCollisions.length ? 'FAIL' : 'PASS', true, identityCollisions.length ? `${identityCollisions.length} active stable identity collision(s) detected.` : 'Every active record-type identity maps to one record.', identityCollisions),
    check('alias-ambiguity', identityRisks.length ? 'FAIL' : 'PASS', false, identityRisks.length ? `${identityRisks.length} normalized mention(s) resolve to multiple entities and require review.` : 'No normalized alias in this build maps to multiple entities.', identityRisks.map(risk => `${risk.normalizedMention}:${risk.conflictingEntityIds.join(',')}`)),
    check('evidence-closure', evidenceClosure.length ? 'FAIL' : 'PASS', true, evidenceClosure.length ? `${evidenceClosure.length} projected reference(s) lack an admissible target.` : 'All projected evidence and endpoint references close inside the build.', evidenceClosure),
    check('temporal-leakage', temporalLeakage.length ? 'FAIL' : 'PASS', true, temporalLeakage.length ? `${temporalLeakage.length} record(s) were known after the build cutoff.` : 'No projected record exceeds the declared knowledge cutoff.', temporalLeakage),
    check('publication-policy', policyDefects.length ? 'FAIL' : 'PASS', true, policyDefects.length ? `${policyDefects.length} record/use policy denial(s) remain.` : 'Every projected record is authorized for projection, search, derivation, and redistribution.', policyDefects),
    check('live-source-health', 'UNOBSERVED', false, 'Build validity does not imply that every upstream source is currently reachable; live source health is measured separately.'),
  ]);
  const publicationAllowed = checks.every(item => !item.blocking || item.status === 'PASS');
  const status = !publicationAllowed ? 'FAIL' as const : checks.some(item => item.status !== 'PASS') ? 'DEGRADED' as const : 'PASS' as const;
  const digestBasis = {
    schema: 'payload.corpus.preflight.v1' as const,
    preflightVersion: PAYLOAD_CORPUS_PREFLIGHT_VERSION,
    methodologyVersion: PAYLOAD_CORPUS_METHODOLOGY_VERSION,
    corpusBuildId: projection.manifest.corpusBuildId,
    sourceSequence: source.sourceSequence,
    sourceDigest: source.sourceDigest,
    projectionDigest: projection.manifest.projectionDigest,
    status,
    publicationAllowed,
    checks,
    identityRisks,
  };
  return freeze({ ...digestBasis, evaluatedAt: projection.manifest.compiledAt, preflightDigest: corpusVerificationDigest(digestBasis) });
}

export function assertCorpusBuildPublicationAllowed(preflight: CorpusBuildPreflight): void {
  if (!preflight.publicationAllowed) {
    const failed = preflight.checks.filter(item => item.blocking && item.status !== 'PASS').map(item => item.checkId).join(',');
    throw new Error(`CORPUS_PREFLIGHT_FAILED: publication blocked by ${failed}`);
  }
}
