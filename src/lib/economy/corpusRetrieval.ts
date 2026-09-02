/**
 * Deterministic GraphRAG boundary over a verified, policy-filtered CorpusBuild.
 *
 * Models receive a bounded ContextPackage, never direct database/vector access.
 * Every returned record is named in a trace bound to the exact projection.
 */

import { createHash } from 'node:crypto';
import { stableValue } from './loadOperationsStore';
import type { CompiledCorpusProjection } from './corpusProjection';
import { corpusEvidenceClosure } from './physicalEconomyCorpus';
import type {
  CorpusCanonicalAssertionRecord,
  CorpusEntityRecord,
  CorpusEvidenceRecord,
  CorpusEvidenceUnitRecord,
  CorpusObservationRecord,
  CorpusRelationshipPredicate,
  CorpusRelationshipRecord,
  StoredCorpusRecord,
} from './physicalEconomyCorpus';

export type CorpusRetrievalDirection = 'outbound' | 'inbound' | 'both';

export type CorpusRetrievalRequest = {
  readonly query: string;
  readonly entityIds?: readonly string[];
  readonly propertyKeys?: readonly string[];
  readonly asOf?: string;
  readonly knownAt?: string;
  readonly traversal?: {
    readonly predicates: readonly CorpusRelationshipPredicate[];
    readonly direction?: CorpusRetrievalDirection;
    readonly maxHops?: number;
  };
  readonly evidenceQuery?: string;
  readonly entityLimit?: number;
  readonly evidenceLimit?: number;
};

export type CorpusRetrievalStep = {
  readonly tool: 'resolve_entities' | 'get_entity_state' | 'traverse_graph' | 'search_evidence' | 'get_claim_support';
  readonly purpose: string;
  readonly inputDigest: string;
};

export type CorpusRetrievalPlan = {
  readonly schema: 'payload.corpus.retrieval-plan.v1';
  readonly planId: string;
  readonly query: string;
  readonly asOf: string;
  readonly knownAt: string;
  readonly projectionId: string;
  readonly projectionDigest: string;
  readonly corpusBuildId: string;
  readonly entityIds: readonly string[];
  readonly resolvedCandidates: readonly { readonly entityId: string; readonly score: number; readonly matchedBy: 'canonical_id' | 'canonical_name' | 'alias' }[];
  readonly propertyKeys: readonly string[];
  readonly traversal?: {
    readonly predicates: readonly CorpusRelationshipPredicate[];
    readonly direction: CorpusRetrievalDirection;
    readonly maxHops: number;
  };
  readonly evidenceQuery?: string;
  readonly evidenceLimit: number;
  readonly steps: readonly CorpusRetrievalStep[];
};

export type CorpusContextArtifact = {
  readonly recordId: string;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly artifactSha256: string;
  readonly retrievedAt: string;
  readonly publishedAt?: string;
  readonly mediaType?: string;
  readonly license?: string;
};

export type CorpusContextPackage = {
  readonly schema: 'payload.corpus.context-package.v1';
  readonly contextId: string;
  readonly query: { readonly text: string; readonly asOf: string; readonly knownAt: string };
  readonly entities: readonly (StoredCorpusRecord & CorpusEntityRecord)[];
  readonly relationships: readonly (StoredCorpusRecord & CorpusRelationshipRecord)[];
  readonly assertions: readonly (StoredCorpusRecord & CorpusCanonicalAssertionRecord)[];
  readonly observations: readonly (StoredCorpusRecord & CorpusObservationRecord)[];
  readonly evidenceUnits: readonly (StoredCorpusRecord & CorpusEvidenceUnitRecord)[];
  /** Citation metadata only; internal object-storage coordinates are never model context. */
  readonly artifacts: readonly CorpusContextArtifact[];
  readonly computedResults: readonly never[];
  readonly contradictions: readonly { readonly assertionId: string; readonly observationIds: readonly string[] }[];
  readonly missingEvidence: readonly { readonly recordId: string; readonly missingReferenceId: string; readonly reason: string }[];
  readonly retrievalTrace: {
    readonly traceId: string;
    readonly planId: string;
    readonly corpusBuildId: string;
    readonly projectionId: string;
    readonly projectionDigest: string;
    readonly policyLineageId: string;
    readonly operations: readonly { readonly tool: CorpusRetrievalStep['tool']; readonly inputDigest: string; readonly outputRecordIds: readonly string[] }[];
  };
};

export class CorpusRetrievalError extends Error {
  constructor(readonly code: 'CORPUS_RETRIEVAL_INPUT_INVALID' | 'CORPUS_PROJECTION_TIME_UNAVAILABLE' | 'CORPUS_ENTITY_UNRESOLVED', message: string) {
    super(message);
    this.name = 'CorpusRetrievalError';
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;
const PREDICATES: readonly CorpusRelationshipPredicate[] = [
  'operated_by', 'owned_by', 'located_in', 'produces', 'consumes', 'transforms',
  'supplies', 'connects_to', 'ships_via', 'trades_in', 'substitutes_for',
  'depends_on', 'calls_at', 'carries', 'loads_at', 'unloads_at', 'moves_between',
  'routes_via', 'affected_by', 'observed_at', 'priced_by',
];

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function validTime(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function normalized(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
function unique(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function activeAt(record: { readonly validFrom?: string; readonly validTo?: string }, at: string): boolean {
  const point = Date.parse(at);
  return (!record.validFrom || Date.parse(record.validFrom) <= point) && (!record.validTo || point < Date.parse(record.validTo));
}

function terms(value: string): string[] { return normalized(value).split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1); }

function resolveEntities(
  records: readonly StoredCorpusRecord[], query: string, explicitIds: readonly string[], limit: number,
): { entityIds: string[]; candidates: CorpusRetrievalPlan['resolvedCandidates'] } {
  const entities = records.filter((record): record is StoredCorpusRecord & CorpusEntityRecord => record.recordType === 'entity');
  const entityMap = new Map(entities.map(record => [record.entityId, record]));
  if (explicitIds.length) {
    const missing = explicitIds.find(id => !entityMap.has(id));
    if (missing) throw new CorpusRetrievalError('CORPUS_ENTITY_UNRESOLVED', `Entity ${missing} is absent from this authorized projection.`);
    return { entityIds: [...explicitIds], candidates: explicitIds.map(entityId => ({ entityId, score: 1, matchedBy: 'canonical_id' as const })) };
  }
  const aliases = records.filter(record => record.recordType === 'alias');
  const queryTerms = terms(query);
  const candidates = entities.map(entity => {
    const idText = normalized(entity.entityId);
    const nameText = normalized(entity.canonicalName);
    const matchingAlias = aliases.find(alias => alias.entityId === entity.entityId && queryTerms.some(term => normalized(alias.value).includes(term)));
    const hits = queryTerms.filter(term => idText.includes(term) || nameText.includes(term) || Boolean(matchingAlias && normalized(matchingAlias.value).includes(term))).length;
    const exactId = normalized(query) === idText;
    const exactName = normalized(query) === nameText;
    const score = exactId ? 1 : exactName ? 0.95 : hits / Math.max(queryTerms.length, 1);
    return { entityId: entity.entityId, score, matchedBy: exactId ? 'canonical_id' as const : matchingAlias ? 'alias' as const : 'canonical_name' as const };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId)).slice(0, limit);
  return { entityIds: candidates.map(item => item.entityId), candidates };
}

function step(tool: CorpusRetrievalStep['tool'], purpose: string, input: unknown): CorpusRetrievalStep {
  return freeze({ tool, purpose, inputDigest: digest(input) });
}

export function planCorpusRetrieval(projection: CompiledCorpusProjection, request: CorpusRetrievalRequest): CorpusRetrievalPlan {
  const query = request.query?.trim();
  const asOf = request.asOf ?? projection.manifest.knowledgeCutoff;
  const knownAt = request.knownAt ?? projection.manifest.knowledgeCutoff;
  const entityLimit = request.entityLimit ?? 8;
  const evidenceLimit = request.evidenceLimit ?? 12;
  const explicitIds = unique(request.entityIds ?? []);
  const propertyKeys = unique((request.propertyKeys ?? []).map(value => value.trim()));
  if (!query || query.length < 2 || query.length > 500 || !validTime(asOf) || !validTime(knownAt) || !Number.isSafeInteger(entityLimit) || entityLimit < 1 || entityLimit > 20 || !Number.isSafeInteger(evidenceLimit) || evidenceLimit < 1 || evidenceLimit > 50 || explicitIds.some(id => !ID.test(id)) || propertyKeys.some(key => !key || key.length > 128)) {
    throw new CorpusRetrievalError('CORPUS_RETRIEVAL_INPUT_INVALID', 'Query, identifiers, time boundary, property keys, or result limits are invalid.');
  }
  if (Date.parse(knownAt) !== Date.parse(projection.manifest.knowledgeCutoff)) {
    throw new CorpusRetrievalError('CORPUS_PROJECTION_TIME_UNAVAILABLE', `This projection is pinned to knowledge time ${projection.manifest.knowledgeCutoff}.`);
  }
  let traversal: CorpusRetrievalPlan['traversal'];
  if (request.traversal) {
    const predicates = unique(request.traversal.predicates) as CorpusRelationshipPredicate[];
    const direction = request.traversal.direction ?? 'outbound';
    const maxHops = request.traversal.maxHops ?? 2;
    if (predicates.length < 1 || predicates.length > 12 || predicates.some(predicate => !PREDICATES.includes(predicate)) || !['outbound', 'inbound', 'both'].includes(direction) || !Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > 4) {
      throw new CorpusRetrievalError('CORPUS_RETRIEVAL_INPUT_INVALID', 'Traversal predicates, direction, or hop bound are invalid.');
    }
    traversal = freeze({ predicates, direction, maxHops });
  }
  const resolved = resolveEntities(projection.records, query, explicitIds, entityLimit);
  const evidenceQuery = request.evidenceQuery?.trim();
  if (evidenceQuery !== undefined && (evidenceQuery.length < 2 || evidenceQuery.length > 500)) throw new CorpusRetrievalError('CORPUS_RETRIEVAL_INPUT_INVALID', 'evidenceQuery must contain 2..500 characters.');
  if (resolved.entityIds.length === 0 && !evidenceQuery) throw new CorpusRetrievalError('CORPUS_ENTITY_UNRESOLVED', 'No canonical entity resolved and no evidence search was requested.');
  const steps: CorpusRetrievalStep[] = [
    step('resolve_entities', 'Resolve canonical identities inside the authorized CorpusBuild.', { query, explicitIds, entityLimit }),
    ...(resolved.entityIds.length ? [step('get_entity_state', 'Retrieve accepted bitemporal assertions for resolved identities.', { entityIds: resolved.entityIds, propertyKeys, asOf, knownAt })] : []),
    ...(traversal && resolved.entityIds.length ? [step('traverse_graph', 'Traverse only typed relationships with a bounded hop count.', { entityIds: resolved.entityIds, traversal, asOf })] : []),
    ...(evidenceQuery ? [step('search_evidence', 'Retrieve source-bounded evidence records rather than anonymous passages.', { evidenceQuery, evidenceLimit })] : []),
    ...(resolved.entityIds.length ? [step('get_claim_support', 'Hydrate assertion support, contradiction, and qualification links.', { entityIds: resolved.entityIds, propertyKeys })] : []),
  ];
  const basis = {
    schema: 'payload.corpus.retrieval-plan.v1' as const, query, asOf, knownAt,
    projectionId: projection.manifest.projectionId, projectionDigest: projection.manifest.projectionDigest,
    corpusBuildId: projection.manifest.corpusBuildId, entityIds: resolved.entityIds,
    resolvedCandidates: resolved.candidates, propertyKeys, ...(traversal ? { traversal } : {}),
    ...(evidenceQuery ? { evidenceQuery } : {}), evidenceLimit, steps,
  };
  return freeze({ ...basis, planId: `retrieval-plan:${digest(basis)}` });
}

function traverse(plan: CorpusRetrievalPlan, records: readonly StoredCorpusRecord[]): { entityIds: Set<string>; relationships: Array<StoredCorpusRecord & CorpusRelationshipRecord> } {
  const entityIds = new Set(plan.entityIds);
  if (!plan.traversal) return { entityIds, relationships: [] };
  const relationships = records.filter((record): record is StoredCorpusRecord & CorpusRelationshipRecord => record.recordType === 'relationship' && plan.traversal!.predicates.includes(record.predicate) && activeAt(record, plan.asOf));
  const selected = new Map<string, StoredCorpusRecord & CorpusRelationshipRecord>();
  let frontier = new Set(plan.entityIds);
  for (let hop = 0; hop < plan.traversal.maxHops && frontier.size; hop += 1) {
    const next = new Set<string>();
    for (const relationship of relationships) {
      const outbound = frontier.has(relationship.subjectEntityId);
      const inbound = frontier.has(relationship.objectEntityId);
      if ((plan.traversal.direction === 'outbound' && !outbound) || (plan.traversal.direction === 'inbound' && !inbound) || (plan.traversal.direction === 'both' && !outbound && !inbound)) continue;
      selected.set(relationship.recordId, relationship);
      const discovered = outbound ? relationship.objectEntityId : relationship.subjectEntityId;
      if (!entityIds.has(discovered)) { entityIds.add(discovered); next.add(discovered); }
    }
    frontier = next;
  }
  return { entityIds, relationships: [...selected.values()].sort((a, b) => a.sequence - b.sequence) };
}

function evidenceSearch(plan: CorpusRetrievalPlan, records: readonly StoredCorpusRecord[]): StoredCorpusRecord[] {
  if (!plan.evidenceQuery) return [];
  const queryTerms = terms(plan.evidenceQuery);
  return records.map(record => {
    const content = record.recordType === 'evidence' ? `${record.title} ${record.sourceId}`
      : record.recordType === 'evidence_unit' ? `${record.extractedText ?? ''} ${canonical(record.locator)}`
        : record.recordType === 'observation' ? `${record.metric} ${canonical(record.value)}` : '';
    const haystack = normalized(content);
    const score = queryTerms.filter(term => haystack.includes(term)).length / Math.max(queryTerms.length, 1);
    return { record, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.record.sequence - b.record.sequence).slice(0, plan.evidenceLimit).map(item => item.record);
}

export function buildCorpusContextPackage(projection: CompiledCorpusProjection, plan: CorpusRetrievalPlan): CorpusContextPackage {
  if (plan.projectionDigest !== projection.manifest.projectionDigest || plan.corpusBuildId !== projection.manifest.corpusBuildId) throw new CorpusRetrievalError('CORPUS_RETRIEVAL_INPUT_INVALID', 'Retrieval plan belongs to another CorpusBuild.');
  const graph = traverse(plan, projection.records);
  const entities = projection.records.filter((record): record is StoredCorpusRecord & CorpusEntityRecord => record.recordType === 'entity' && graph.entityIds.has(record.entityId));
  const propertyKeys = new Set(plan.propertyKeys);
  const assertions = projection.records.filter((record): record is StoredCorpusRecord & CorpusCanonicalAssertionRecord => record.recordType === 'assertion' && record.status === 'accepted' && graph.entityIds.has(record.entityId) && (!propertyKeys.size || propertyKeys.has(record.propertyKey)) && activeAt(record, plan.asOf));
  const support = corpusEvidenceClosure(projection.records, [...entities, ...graph.relationships, ...assertions]);
  const observationIds = new Set([
    ...assertions.flatMap(assertion => assertion.evidence.map(link => link.observationId)),
    ...support.flatMap(record => record.recordType === 'observation' ? [record.observationId] : []),
  ]);
  const searched = evidenceSearch(plan, projection.records);
  for (const record of searched) if (record.recordType === 'observation') observationIds.add(record.observationId);
  const observations = projection.records.filter((record): record is StoredCorpusRecord & CorpusObservationRecord => record.recordType === 'observation' && observationIds.has(record.observationId) && activeAt(record, plan.asOf));
  const evidenceIds = new Set([
    ...observations.flatMap(observation => observation.evidenceIds),
    ...support.flatMap(record => record.recordType === 'evidence_unit' ? [record.evidenceUnitId] : record.recordType === 'evidence' ? [record.evidenceId] : []),
  ]);
  for (const record of searched) {
    if (record.recordType === 'evidence') evidenceIds.add(record.evidenceId);
    if (record.recordType === 'evidence_unit') evidenceIds.add(record.evidenceUnitId);
  }
  const evidenceUnits = projection.records.filter((record): record is StoredCorpusRecord & CorpusEvidenceUnitRecord => record.recordType === 'evidence_unit' && evidenceIds.has(record.evidenceUnitId));
  const artifactIds = new Set([...evidenceIds, ...evidenceUnits.map(unit => unit.artifactEvidenceId)]);
  const artifactRecords = projection.records.filter((record): record is StoredCorpusRecord & CorpusEvidenceRecord => record.recordType === 'evidence' && artifactIds.has(record.evidenceId));
  const artifacts: CorpusContextArtifact[] = artifactRecords.map(record => ({
    recordId: record.recordId, evidenceId: record.evidenceId, sourceId: record.sourceId,
    title: record.title, sourceUrl: record.sourceUrl, artifactSha256: record.artifactSha256,
    retrievedAt: record.retrievedAt, ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    ...(record.mediaType ? { mediaType: record.mediaType } : {}), ...(record.license ? { license: record.license } : {}),
  }));
  const missingEvidence: Array<{ recordId: string; missingReferenceId: string; reason: string }> = [];
  const observationById = new Set(observations.map(record => record.observationId));
  for (const assertion of assertions) for (const link of assertion.evidence) if (!observationById.has(link.observationId)) missingEvidence.push({ recordId: assertion.recordId, missingReferenceId: link.observationId, reason: 'Assertion observation is unavailable at the requested valid time.' });
  const resolvedEvidence = new Set([...evidenceUnits.map(record => record.evidenceUnitId), ...artifactRecords.map(record => record.evidenceId)]);
  for (const observation of observations) for (const evidenceId of observation.evidenceIds) if (!resolvedEvidence.has(evidenceId)) missingEvidence.push({ recordId: observation.recordId, missingReferenceId: evidenceId, reason: 'Observation evidence is unavailable in this projection.' });
  const contradictions = assertions.flatMap(assertion => {
    const ids = assertion.evidence.filter(link => link.role === 'contradicts').map(link => link.observationId);
    return ids.length ? [{ assertionId: assertion.assertionId, observationIds: ids }] : [];
  });
  const operationOutputs: Record<CorpusRetrievalStep['tool'], readonly string[]> = {
    resolve_entities: entities.map(record => record.recordId),
    get_entity_state: assertions.map(record => record.recordId),
    traverse_graph: graph.relationships.map(record => record.recordId),
    search_evidence: searched.map(record => record.recordId),
    get_claim_support: [...observations, ...evidenceUnits, ...artifactRecords].map(record => record.recordId),
  };
  const operations = plan.steps.map(item => ({ tool: item.tool, inputDigest: item.inputDigest, outputRecordIds: unique(operationOutputs[item.tool]) }));
  const traceBasis = { planId: plan.planId, corpusBuildId: plan.corpusBuildId, projectionDigest: plan.projectionDigest, operations };
  const retrievalTrace = {
    traceId: `retrieval-trace:${digest(traceBasis)}`, planId: plan.planId,
    corpusBuildId: plan.corpusBuildId, projectionId: plan.projectionId,
    projectionDigest: plan.projectionDigest, policyLineageId: projection.manifest.policyLineageId,
    operations,
  };
  const contextBasis = {
    schema: 'payload.corpus.context-package.v1' as const,
    query: { text: plan.query, asOf: plan.asOf, knownAt: plan.knownAt }, entities,
    relationships: graph.relationships, assertions, observations, evidenceUnits, artifacts,
    computedResults: [] as const, contradictions, missingEvidence, retrievalTrace,
  };
  return freeze({ ...contextBasis, contextId: `context-package:${digest(contextBasis)}` });
}
