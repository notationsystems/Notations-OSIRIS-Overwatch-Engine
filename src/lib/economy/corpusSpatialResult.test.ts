import { describe, expect, it } from 'vitest';
import type { CorpusAgentContext } from './corpusAgentContext';
import { buildCorpusSpatialResult } from './corpusSpatialResult';

function context(located = true): CorpusAgentContext {
  const location = located ? { lat: 43.65, lng: -79.38, precision: 'site' } : undefined;
  return {
    schema: 'notation.agent-context.v1',
    agentContextId: 'agent-context:test-spatial',
    evidenceBudget: { requestedLevel: 'FAST', includedSections: [], omittedSections: [], assuranceAvailable: 'PROVENANCE', sourceTruthClaimed: false },
    query: { text: 'route', asOf: '2026-09-02T12:00:00.000Z', knownAt: '2026-09-02T12:00:00.000Z' },
    corpus: { corpusEngineId: 'engine', corpusEngineVersion: '1', productId: 'payload', corpusDefinitionId: 'definition', corpusBuildId: 'corpus-build:test-spatial', ontologyVersion: 'v1', projectionId: 'public:global', projectionDigest: 'a'.repeat(64) },
    entities: [
      { recordId: 'record:facility:a', canonicalId: 'pe:facility:a', kind: 'facility', name: 'Facility A', knownAt: '2026-09-02T12:00:00.000Z', evidenceIds: ['evidence:a'], ...(location ? { location } : {}) },
      { recordId: 'record:port:b', canonicalId: 'pe:port:b', kind: 'port', name: 'Port B', knownAt: '2026-09-02T12:00:00.000Z', evidenceIds: ['evidence:b'], ...(location ? { location: { lat: 45.5, lng: -73.56, precision: 'exact' } } : {}) },
    ],
    relationships: [{ recordId: 'record:relationship:ab', relationshipId: 'relationship:ab', subject: 'pe:facility:a', predicate: 'ships_via', object: 'pe:port:b', validTime: {}, knownAt: '2026-09-02T12:00:00.000Z', epistemicClass: 'REPORTED', confidence: { kind: 'LABEL', value: 'high', calibratedProbability: false }, evidenceIds: ['evidence:a'] }],
    assertions: [],
    inspection: { operations: [] },
  };
}

describe('corpus spatial result adapter', () => {
  it('emits deterministic CRS84 GeoJSON and kepler.gl addDataToMap datasets', () => {
    const result = buildCorpusSpatialResult(context());
    expect(result).toMatchObject({
      schema: 'notation.spatial-result.v1', status: 'READY', coordinateReferenceSystem: 'OGC:CRS84',
      keplerGl: { action: 'addDataToMap', payload: { options: { centerMap: true, readOnly: true, keepExistingConfig: true } } },
    });
    expect(result.featureCollection.features).toHaveLength(3);
    expect(result.featureCollection.features[0].geometry).toEqual({ type: 'Point', coordinates: [-79.38, 43.65] });
    expect(result.featureCollection.features[2].geometry).toEqual({ type: 'LineString', coordinates: [[-79.38, 43.65], [-73.56, 45.5]] });
    expect(result.keplerGl.payload.datasets.map(dataset => dataset.info.id)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^payload_entities_/), expect.stringMatching(/^payload_relationships_/),
    ]));
    expect(buildCorpusSpatialResult(context())).toEqual(result);
  });

  it('preserves missing geography as an unobserved state and emits no invented coordinates', () => {
    const result = buildCorpusSpatialResult(context(false));
    expect(result).toMatchObject({ status: 'EMPTY', unobservedState: { code: 'SPATIAL_LOCATION_UNOBSERVED' } });
    expect(result.featureCollection.features).toEqual([]);
    expect(result.keplerGl.payload.datasets.every(dataset => dataset.data.rows.length === 0)).toBe(true);
  });
});
