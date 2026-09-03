/** A score-free, walkable view of why one corpus answer exists. */

import type { CorpusProjectionManifest } from './corpusProjection';
import {
  corpusEvidenceClosure,
  corpusRecordReferenceIds,
  corpusStableIdentity,
  type CorpusAssertionEvidenceRole,
  type CorpusRecordType,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';
import {
  corpusVerificationDigest,
  type VerificationEnvelope,
} from './corpusVerification';

export type WarrantEpistemicClass = 'observed' | 'declared' | 'derived' | 'mined' | 'hypothetical' | 'representative' | 'system';
export type WarrantNodeKind = 'answer' | 'computation' | 'record' | 'evidence' | 'source' | 'corpus_build' | 'commitment' | 'unresolved_reference';
export type WarrantEdgeKind =
  | 'produced_by' | 'used_record' | 'ran_over' | 'committed_by' | 'included_in'
  | 'supported_by' | 'contradicted_by' | 'qualified_by' | 'extracted_from'
  | 'published_by' | 'describes' | 'subject' | 'object' | 'supersedes' | 'unresolved';

export type CorpusWarrantGraphNode = {
  readonly id: string;
  readonly kind: WarrantNodeKind;
  readonly label: string;
  readonly epistemicClass: WarrantEpistemicClass;
  readonly description: string;
  readonly recordId?: string;
  readonly recordType?: CorpusRecordType;
  readonly canonicalId?: string;
  readonly knownAt?: string;
  readonly valueKind?: string;
  readonly confidence?: string;
  readonly contentHash?: string;
  readonly sourceUrl?: string;
};

export type CorpusWarrantGraphEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: WarrantEdgeKind;
  readonly label: string;
};

export type CorpusWarrantGraph = {
  readonly schema: 'payload.corpus.warrant-graph.v1';
  readonly graphId: string;
  readonly rootNodeId: string;
  readonly corpusBuildId: string;
  readonly statement: string;
  readonly scorePolicy: 'NO_COMPOSITE_TRUST_SCORE';
  readonly nodes: readonly CorpusWarrantGraphNode[];
  readonly edges: readonly CorpusWarrantGraphEdge[];
  readonly legend: readonly {
    readonly epistemicClass: WarrantEpistemicClass;
    readonly meaning: string;
  }[];
};

export class CorpusWarrantError extends Error {
  constructor(readonly code: 'CORPUS_WARRANT_INPUT_INVALID' | 'CORPUS_WARRANT_SUBJECT_UNRESOLVED' | 'CORPUS_WARRANT_TOO_BROAD', message: string) {
    super(message);
    this.name = 'CorpusWarrantError';
  }
}

const LEGEND: CorpusWarrantGraph['legend'] = Object.freeze([
  Object.freeze({ epistemicClass: 'observed' as const, meaning: 'Source material, extracted evidence, or an observation.' }),
  Object.freeze({ epistemicClass: 'declared' as const, meaning: 'A canonical identity, relationship, alias, or selected assertion.' }),
  Object.freeze({ epistemicClass: 'derived' as const, meaning: 'A deterministic transformation over named inputs.' }),
  Object.freeze({ epistemicClass: 'mined' as const, meaning: 'Candidate knowledge produced by a mining program; not canonical truth.' }),
  Object.freeze({ epistemicClass: 'hypothetical' as const, meaning: 'A counterfactual input or result; never an observation.' }),
  Object.freeze({ epistemicClass: 'representative' as const, meaning: 'Illustrative or modelled material, visually separated from observations.' }),
  Object.freeze({ epistemicClass: 'system' as const, meaning: 'Corpus build, commitment, or execution infrastructure.' }),
]);

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function compact(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function recordLabel(record: StoredCorpusRecord): string {
  if (record.recordType === 'evidence') return record.title;
  if (record.recordType === 'evidence_unit') return record.extractedText?.slice(0, 96) || `${record.modality} evidence unit`;
  if (record.recordType === 'entity') return record.canonicalName;
  if (record.recordType === 'alias') return `${record.scheme}: ${record.value}`;
  if (record.recordType === 'relationship') return record.predicate.replaceAll('_', ' ');
  if (record.recordType === 'observation') return `${record.metric}: ${compact(record.value)}${record.unit ? ` ${record.unit}` : ''}`;
  return `${record.propertyKey}: ${compact(record.selectedValue)}${record.unit ? ` ${record.unit}` : ''}`;
}

function recordDescription(record: StoredCorpusRecord): string {
  if (record.recordType === 'evidence') return `Artifact from ${record.sourceId}, retrieved ${record.retrievedAt}.`;
  if (record.recordType === 'evidence_unit') return `${record.modality} evidence extracted by ${record.extraction.kind} ${record.extraction.version}.`;
  if (record.recordType === 'entity') return `${record.entityKind} identity accepted into canonical state.`;
  if (record.recordType === 'alias') return `Explicit ${record.scheme} alias for ${record.entityId}.`;
  if (record.recordType === 'relationship') return `${record.subjectEntityId} ${record.predicate} ${record.objectEntityId}.`;
  if (record.recordType === 'observation') return `${record.valueKind} observation with a ${record.confidence} confidence label.`;
  return `${record.status} canonical assertion selected by ${record.selectionPolicy}.`;
}

function epistemicClass(record: StoredCorpusRecord): WarrantEpistemicClass {
  if (record.recordType === 'evidence' || record.recordType === 'evidence_unit') return 'observed';
  if (record.recordType === 'observation') return record.valueKind === 'derived' ? 'derived' : 'observed';
  if (record.recordType === 'relationship' && record.valueKind === 'derived') return 'derived';
  return 'declared';
}

function canonicalId(record: StoredCorpusRecord): string | undefined {
  if (record.recordType === 'evidence') return record.evidenceId;
  if (record.recordType === 'evidence_unit') return record.evidenceUnitId;
  if (record.recordType === 'entity') return record.entityId;
  if (record.recordType === 'alias') return record.aliasId;
  if (record.recordType === 'relationship') return record.relationshipId;
  if (record.recordType === 'observation') return record.observationId;
  if (record.recordType === 'assertion') return record.assertionId;
  return undefined;
}

function referenceEdge(record: StoredCorpusRecord, referenceId: string): { kind: WarrantEdgeKind; label: string } {
  if (record.recordType === 'evidence_unit') return { kind: 'extracted_from', label: 'extracted from' };
  if (record.recordType === 'assertion') {
    const role = record.evidence.find(item => item.observationId === referenceId)?.role;
    const byRole: Record<CorpusAssertionEvidenceRole, { kind: WarrantEdgeKind; label: string }> = {
      supports: { kind: 'supported_by', label: 'supported by' },
      contradicts: { kind: 'contradicted_by', label: 'contradicted by' },
      qualifies: { kind: 'qualified_by', label: 'qualified by' },
    };
    return byRole[role ?? 'supports'];
  }
  return { kind: 'supported_by', label: 'supported by' };
}

function entityRecordMap(records: readonly StoredCorpusRecord[]): Map<string, StoredCorpusRecord> {
  return new Map(records.flatMap(record => record.recordType === 'entity' ? [[record.entityId, record] as const] : []));
}

export function selectCorpusWarrantBasis(
  records: readonly StoredCorpusRecord[],
  subject: { readonly recordId?: string; readonly entityId?: string },
  maximumRecords = 200,
): readonly StoredCorpusRecord[] {
  const hasRecord = typeof subject.recordId === 'string' && subject.recordId.length > 0;
  const hasEntity = typeof subject.entityId === 'string' && subject.entityId.length > 0;
  if (hasRecord === hasEntity || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 500) {
    throw new CorpusWarrantError('CORPUS_WARRANT_INPUT_INVALID', 'Specify exactly one recordId or entityId and a bound from 1 to 500 records.');
  }
  let seeds: StoredCorpusRecord[];
  if (hasRecord) {
    const match = records.find(record => record.recordId === subject.recordId);
    if (!match) throw new CorpusWarrantError('CORPUS_WARRANT_SUBJECT_UNRESOLVED', `Record ${subject.recordId} is absent from this CorpusBuild.`);
    seeds = [match];
  } else {
    seeds = records.filter(record =>
      (record.recordType === 'entity' && record.entityId === subject.entityId)
      || (record.recordType === 'alias' && record.entityId === subject.entityId)
      || (record.recordType === 'observation' && record.entityId === subject.entityId)
      || (record.recordType === 'assertion' && record.entityId === subject.entityId)
      || (record.recordType === 'relationship' && (record.subjectEntityId === subject.entityId || record.objectEntityId === subject.entityId)));
    if (seeds.length === 0) throw new CorpusWarrantError('CORPUS_WARRANT_SUBJECT_UNRESOLVED', `Entity ${subject.entityId} is absent from this CorpusBuild.`);
  }
  const entities = entityRecordMap(records);
  const endpointRecords = seeds.flatMap(record => record.recordType === 'relationship'
    ? [entities.get(record.subjectEntityId), entities.get(record.objectEntityId)].filter((value): value is StoredCorpusRecord => Boolean(value))
    : []);
  const initial = [...seeds, ...endpointRecords];
  const closure = corpusEvidenceClosure(records, initial);
  const selected = [...initial, ...closure]
    .filter((record, index, all) => all.findIndex(candidate => candidate.recordId === record.recordId) === index)
    .sort((left, right) => left.sequence - right.sequence);
  if (selected.length > maximumRecords) throw new CorpusWarrantError('CORPUS_WARRANT_TOO_BROAD', `The warrant requires ${selected.length} records, above the ${maximumRecords}-record response bound.`);
  return freeze(selected);
}

export function buildCorpusWarrantGraph(input: {
  readonly statement: string;
  readonly basisRecords: readonly StoredCorpusRecord[];
  readonly manifest: CorpusProjectionManifest;
  readonly verification: VerificationEnvelope;
}): CorpusWarrantGraph {
  const nodes = new Map<string, CorpusWarrantGraphNode>();
  const edges = new Map<string, CorpusWarrantGraphEdge>();
  const answerId = `answer:${input.verification.contentHash}`;
  const computationId = input.verification.computation.computationId;
  const buildId = input.manifest.corpusBuildId;
  const commitmentId = input.verification.commitment.commitmentId;

  const addNode = (node: CorpusWarrantGraphNode) => { if (!nodes.has(node.id)) nodes.set(node.id, freeze(node)); };
  const addEdge = (source: string, target: string, kind: WarrantEdgeKind, label: string) => {
    const id = `warrant-edge:${corpusVerificationDigest({ source, target, kind, label })}`;
    if (!edges.has(id)) edges.set(id, freeze({ id, source, target, kind, label }));
  };

  addNode({ id: answerId, kind: 'answer', label: input.statement, epistemicClass: 'derived', description: 'The API result being explained. Its structure, not a composite score, carries the warrant.', contentHash: input.verification.contentHash });
  addNode({ id: computationId, kind: 'computation', label: input.verification.computation.programId, epistemicClass: 'derived', description: `Deterministic program ${input.verification.computation.algorithmVersion}.`, contentHash: input.verification.computation.outputDigest });
  addNode({ id: buildId, kind: 'corpus_build', label: `CorpusBuild ${buildId.slice(-12)}`, epistemicClass: 'system', description: `Policy-filtered projection generated ${input.manifest.generatedAt}.`, contentHash: input.manifest.projectionDigest });
  addNode({ id: commitmentId, kind: 'commitment', label: `Merkle ${input.verification.commitment.root.slice(0, 12)}…`, epistemicClass: 'system', description: input.verification.attestation.status === 'ATTESTED' ? `Cryptographically attested by ${input.verification.attestation.anchorId}; inspect the attestation to determine whether its time source is independent.` : input.verification.attestation.reason, contentHash: input.verification.commitment.root });
  addEdge(answerId, computationId, 'produced_by', 'produced by');
  addEdge(computationId, buildId, 'ran_over', 'ran over');
  addEdge(buildId, commitmentId, 'committed_by', 'committed by');

  const supportByIdentity = new Map<string, StoredCorpusRecord>();
  const entities = entityRecordMap(input.basisRecords);
  for (const record of input.basisRecords) {
    if (record.recordType === 'evidence') supportByIdentity.set(record.evidenceId, record);
    if (record.recordType === 'evidence_unit') supportByIdentity.set(record.evidenceUnitId, record);
    if (record.recordType === 'observation') supportByIdentity.set(record.observationId, record);
  }

  for (const record of input.basisRecords) {
    const id = `record:${record.recordId}`;
    addNode({
      id,
      kind: record.recordType === 'evidence' || record.recordType === 'evidence_unit' ? 'evidence' : 'record',
      label: recordLabel(record),
      epistemicClass: epistemicClass(record),
      description: recordDescription(record),
      recordId: record.recordId,
      recordType: record.recordType,
      canonicalId: canonicalId(record),
      knownAt: record.knownAt,
      ...('valueKind' in record ? { valueKind: String(record.valueKind) } : {}),
      ...('confidence' in record ? { confidence: String(record.confidence) } : {}),
      contentHash: record.recordHash,
      ...(record.recordType === 'evidence' ? { sourceUrl: record.sourceUrl } : {}),
    });
    addEdge(computationId, id, 'used_record', 'used record');
    addEdge(id, buildId, 'included_in', 'included in');

    for (const reference of corpusRecordReferenceIds(record)) {
      const target = supportByIdentity.get(reference);
      if (target) {
        const relation = referenceEdge(record, reference);
        addEdge(id, `record:${target.recordId}`, relation.kind, relation.label);
      } else {
        const missingId = `unresolved:${reference}`;
        addNode({ id: missingId, kind: 'unresolved_reference', label: reference, epistemicClass: 'system', description: 'A referenced support object is absent from this warrant graph.' });
        addEdge(id, missingId, 'unresolved', 'unresolved');
      }
    }

    if (record.supersedes) {
      const prior = input.basisRecords.find(candidate => candidate.recordId === record.supersedes);
      const priorId = prior ? `record:${prior.recordId}` : `unresolved:${record.supersedes}`;
      if (!prior) addNode({ id: priorId, kind: 'unresolved_reference', label: record.supersedes, epistemicClass: 'system', description: 'Superseded history is outside this active projection; query the version-addressed historical build to inspect it.' });
      addEdge(id, priorId, 'supersedes', 'supersedes');
    }
    if (record.recordType === 'evidence') {
      const sourceId = `source:${record.sourceId}`;
      addNode({ id: sourceId, kind: 'source', label: record.sourceId, epistemicClass: 'observed', description: `Origin named by evidence ${record.evidenceId}.`, sourceUrl: record.sourceUrl });
      addEdge(id, sourceId, 'published_by', 'published by');
    }
    if (record.recordType === 'alias' || record.recordType === 'observation' || record.recordType === 'assertion') {
      const entityId = record.entityId;
      const entity = entities.get(entityId);
      if (entity) addEdge(id, `record:${entity.recordId}`, 'describes', 'describes');
    }
    if (record.recordType === 'relationship') {
      const subject = entities.get(record.subjectEntityId);
      const object = entities.get(record.objectEntityId);
      if (subject) addEdge(id, `record:${subject.recordId}`, 'subject', 'subject');
      if (object) addEdge(id, `record:${object.recordId}`, 'object', 'object');
    }
  }

  const graphBasis = {
    schema: 'payload.corpus.warrant-graph.v1' as const,
    rootNodeId: answerId,
    corpusBuildId: input.manifest.corpusBuildId,
    statement: input.statement,
    scorePolicy: 'NO_COMPOSITE_TRUST_SCORE' as const,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    legend: LEGEND,
  };
  return freeze({ ...graphBasis, graphId: `warrant-graph:${corpusVerificationDigest(graphBasis)}` });
}

export function markCorpusWarrantGraphAttested(
  graph: CorpusWarrantGraph,
  commitmentId: string,
  attestationId: string,
): CorpusWarrantGraph {
  const basis = {
    schema: graph.schema,
    rootNodeId: graph.rootNodeId,
    corpusBuildId: graph.corpusBuildId,
    statement: graph.statement,
    scorePolicy: graph.scorePolicy,
    nodes: graph.nodes.map(node => node.id === commitmentId ? {
      ...node,
      description: `Cryptographically attested by ${attestationId}; inspect the attestation to determine whether its time source is independent.`,
    } : node),
    edges: graph.edges,
    legend: graph.legend,
  };
  return freeze({ ...basis, graphId: `warrant-graph:${corpusVerificationDigest(basis)}` });
}

export function warrantSubjectLabel(records: readonly StoredCorpusRecord[]): string {
  const primary = records.find(record => record.recordType === 'entity') ?? records[0];
  return primary ? `Why Payload holds ${recordLabel(primary)}` : 'Why Payload produced this answer';
}

export function warrantSubjectIdentity(records: readonly StoredCorpusRecord[]): string | null {
  const primary = records.find(record => record.recordType === 'entity') ?? records[0];
  return primary ? corpusStableIdentity(primary) : null;
}
