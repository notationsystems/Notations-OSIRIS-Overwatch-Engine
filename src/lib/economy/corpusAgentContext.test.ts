import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCorpusAgentContext, parseCorpusEvidenceLevel } from './corpusAgentContext';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { buildCorpusContextPackage, planCorpusRetrieval } from './corpusRetrieval';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';
import { verifyCorpusRecordInclusion } from './corpusVerification';

const at = '2026-09-02T14:00:00.000Z';

function records(): CorpusRecordInput[] {
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS };
  return [
    { ...common, recordId: 'record:evidence:agent', recordType: 'evidence', evidenceId: 'evidence:agent', sourceId: 'source:agent', title: 'Agent context source', sourceUrl: 'https://example.test/agent', artifactSha256: 'a'.repeat(64), retrievedAt: at },
    { ...common, recordId: 'record:evidence-unit:agent', recordType: 'evidence_unit', evidenceUnitId: 'evidence-unit:agent', artifactEvidenceId: 'evidence:agent', modality: 'structured_record', locator: { jsonPath: '$.capacity' }, extraction: { kind: 'parser', version: '1.0.0', adapter: 'agent-test', confidence: 0.84 }, contentSha256: 'b'.repeat(64), extractedText: 'capacity values 800 and 620 kt/y' },
    { ...common, recordId: 'record:entity:agent', recordType: 'entity', entityId: 'pe:facility:agent', entityKind: 'facility', canonicalName: 'Agent Context Facility', countryCode: 'CA', evidenceIds: ['evidence-unit:agent'] },
    { ...common, recordId: 'record:observation:agent-primary', recordType: 'observation', observationId: 'observation:agent-primary', entityId: 'pe:facility:agent', observationType: 'capacity', metric: 'capacity', value: 800, unit: 'kt/y', validFrom: at, valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence-unit:agent'] },
    { ...common, recordId: 'record:observation:agent-conflict', recordType: 'observation', observationId: 'observation:agent-conflict', entityId: 'pe:facility:agent', observationType: 'capacity', metric: 'capacity', value: 620, unit: 'kt/y', validFrom: at, valueKind: 'estimated', confidence: 'medium', evidenceIds: ['evidence-unit:agent'] },
    { ...common, recordId: 'record:assertion:agent', recordType: 'assertion', assertionId: 'assertion:agent', entityId: 'pe:facility:agent', propertyKey: 'capacity', selectedValue: 800, unit: 'kt/y', status: 'accepted', selectionPolicy: 'reviewed-source-v1', validFrom: at, confidence: 'medium', evidence: [{ observationId: 'observation:agent-primary', role: 'supports' }, { observationId: 'observation:agent-conflict', role: 'contradicts' }] },
  ];
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-agent-context-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const appended = corpus.append('global', records(), at);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const projection = buildPublicProjection(corpus.projectionSource('global', at), '2026-09-02T14:01:00.000Z');
  const plan = planCorpusRetrieval(projection, { query: 'Agent Context Facility capacity', entityIds: ['pe:facility:agent'], propertyKeys: ['capacity'], evidenceQuery: 'capacity' });
  const context = buildCorpusContextPackage(projection, plan);
  return { directory, corpus, projection, plan, context };
}

describe('agent-native evidence budgets', () => {
  it('parses one explicit budget and defaults to GROUNDED without silently accepting unknown values', () => {
    expect(parseCorpusEvidenceLevel(undefined)).toBe('GROUNDED');
    expect(parseCorpusEvidenceLevel('AUDIT')).toBe('AUDIT');
    expect(() => parseCorpusEvidenceLevel('verified')).toThrow(/FAST, GROUNDED, AUDIT, or VERIFIED/);
  });

  it('adds evidence monotonically while preserving one canonical assertion identity', () => {
    const value = fixture();
    try {
      const fast = compileCorpusAgentContext(value.projection, value.plan, value.context, 'FAST');
      const grounded = compileCorpusAgentContext(value.projection, value.plan, value.context, 'GROUNDED');
      const audit = compileCorpusAgentContext(value.projection, value.plan, value.context, 'AUDIT');
      expect(fast).not.toHaveProperty('evidence');
      expect(fast).not.toHaveProperty('audit');
      expect(fast).not.toHaveProperty('proof');
      expect(grounded.evidence?.artifacts).toMatchObject([{ evidenceId: 'evidence:agent', sourceId: 'source:agent' }]);
      expect(grounded).not.toHaveProperty('audit');
      expect(audit.audit).toMatchObject({
        observations: [{ observationId: 'observation:agent-primary', epistemicClass: 'REPORTED' }, { observationId: 'observation:agent-conflict', epistemicClass: 'ESTIMATED' }],
        evidenceUnits: [{ evidenceUnitId: 'evidence-unit:agent', extraction: { confidence: { kind: 'EXTRACTOR_SCORE', value: 0.84, calibratedProbability: false } } }],
        contradictions: [{ assertionId: 'assertion:agent', observationIds: ['observation:agent-conflict'] }],
        missingEvidence: [],
      });
      for (const result of [fast, grounded, audit]) {
        expect(result.assertions[0]).toMatchObject({
          schema: 'notation.assertion.v1', assertionId: 'assertion:agent', epistemicClass: 'REPORTED',
          confidence: { kind: 'LABEL', value: 'medium', calibratedProbability: false },
          uncertainty: { status: 'CONFLICTING', contradictionObservationIds: ['observation:agent-conflict'] },
          provenance: { evidenceIds: ['evidence-unit:agent'], sourceIds: ['source:agent'] },
          verification: { level: 'PROVENANCE', sourceTruthClaimed: false },
        });
      }
      expect(compileCorpusAgentContext(value.projection, value.plan, value.context, 'AUDIT')).toEqual(audit);
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it('includes checked membership proofs at VERIFIED while naming absent SP1 and attestation honestly', () => {
    const value = fixture();
    try {
      const verified = compileCorpusAgentContext(value.projection, value.plan, value.context, 'VERIFIED');
      expect(verified.evidenceBudget).toMatchObject({ requestedLevel: 'VERIFIED', assuranceAvailable: 'REPRODUCIBLE', sourceTruthClaimed: false });
      expect(verified.proof).toMatchObject({
        membershipProofsVerified: true,
        envelope: { verificationLevel: 'REPRODUCIBLE', sourceTruthClaimed: false, attestation: { status: 'NOT_ATTESTED' }, zkProof: { status: 'NOT_GENERATED' } },
        warrantGraph: { scorePolicy: 'NO_COMPOSITE_TRUST_SCORE' },
      });
      expect(verified.proof!.envelope.inclusionProofs).toHaveLength(6);
      expect(verified.proof!.envelope.inclusionProofs.every(proof => verifyCorpusRecordInclusion(verified.proof!.envelope.commitment, proof))).toBe(true);
      expect(verified.proof!.warrantGraph.edges.some(edge => edge.kind === 'contradicted_by')).toBe(true);
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
