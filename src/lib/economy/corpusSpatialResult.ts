/** Renderer-neutral spatial projection with an explicit kepler.gl adapter. */

import type { CorpusAgentContext } from './corpusAgentContext';
import { corpusVerificationDigest } from './corpusVerification';

type KeplerFieldType = 'string' | 'integer' | 'real' | 'boolean' | 'timestamp';

export type KeplerDataset = {
  readonly info: { readonly id: string; readonly label: string };
  readonly data: {
    readonly fields: readonly { readonly name: string; readonly type: KeplerFieldType }[];
    readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  };
};

export type CorpusSpatialResult = {
  readonly schema: 'notation.spatial-result.v1';
  readonly spatialResultId: string;
  readonly corpusBuildId: string;
  readonly agentContextId: string;
  readonly coordinateReferenceSystem: 'OGC:CRS84';
  readonly status: 'READY' | 'EMPTY';
  readonly unobservedState?: {
    readonly code: 'SPATIAL_LOCATION_UNOBSERVED';
    readonly detail: string;
    readonly remedy: string;
  };
  readonly featureCollection: {
    readonly type: 'FeatureCollection';
    readonly features: readonly {
      readonly type: 'Feature';
      readonly id: string;
      readonly properties: Readonly<Record<string, string | number | boolean | null>>;
      readonly geometry:
        | { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
        | { readonly type: 'LineString'; readonly coordinates: readonly [readonly [number, number], readonly [number, number]] };
    }[];
  };
  readonly keplerGl: {
    readonly compatibility: 'kepler.gl addDataToMap';
    readonly datasetIdentityRule: 'info.id_is_stable_and_matches_dataId';
    readonly action: 'addDataToMap';
    readonly payload: {
      readonly datasets: readonly KeplerDataset[];
      readonly options: {
        readonly centerMap: true;
        readonly readOnly: true;
        readonly keepExistingConfig: true;
      };
    };
  };
  readonly limitations: readonly string[];
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const entityFields: KeplerDataset['data']['fields'] = [
  { name: 'canonical_id', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'entity_kind', type: 'string' },
  { name: 'latitude', type: 'real' },
  { name: 'longitude', type: 'real' },
  { name: 'location_precision', type: 'string' },
  { name: 'known_at', type: 'timestamp' },
  { name: 'corpus_build_id', type: 'string' },
  { name: 'agent_context_id', type: 'string' },
  { name: 'evidence_ids', type: 'string' },
];

const relationshipFields: KeplerDataset['data']['fields'] = [
  { name: 'relationship_id', type: 'string' },
  { name: 'predicate', type: 'string' },
  { name: 'source_id', type: 'string' },
  { name: 'source_latitude', type: 'real' },
  { name: 'source_longitude', type: 'real' },
  { name: 'target_id', type: 'string' },
  { name: 'target_latitude', type: 'real' },
  { name: 'target_longitude', type: 'real' },
  { name: 'epistemic_class', type: 'string' },
  { name: 'known_at', type: 'timestamp' },
  { name: 'corpus_build_id', type: 'string' },
  { name: 'agent_context_id', type: 'string' },
  { name: 'evidence_ids', type: 'string' },
];

/**
 * Build a spatial view without promoting renderer configuration to canonical
 * state. OGC:CRS84 makes coordinate order explicit: longitude, latitude.
 */
export function buildCorpusSpatialResult(context: CorpusAgentContext): CorpusSpatialResult {
  const located = context.entities.filter(entity => entity.location !== undefined);
  const byId = new Map(located.map(entity => [entity.canonicalId, entity]));
  const drawableRelationships = context.relationships.filter(relationship => byId.has(relationship.subject) && byId.has(relationship.object));
  const entityRows = located.map(entity => [
    entity.canonicalId,
    entity.name,
    entity.kind,
    entity.location!.lat,
    entity.location!.lng,
    entity.location!.precision,
    entity.knownAt,
    context.corpus.corpusBuildId,
    context.agentContextId,
    JSON.stringify(entity.evidenceIds),
  ] as const);
  const relationshipRows = drawableRelationships.map(relationship => {
    const source = byId.get(relationship.subject)!;
    const target = byId.get(relationship.object)!;
    return [
      relationship.relationshipId,
      relationship.predicate,
      relationship.subject,
      source.location!.lat,
      source.location!.lng,
      relationship.object,
      target.location!.lat,
      target.location!.lng,
      relationship.epistemicClass,
      relationship.knownAt,
      context.corpus.corpusBuildId,
      context.agentContextId,
      JSON.stringify(relationship.evidenceIds),
    ] as const;
  });
  const datasetStem = corpusVerificationDigest({
    agentContextId: context.agentContextId,
    corpusBuildId: context.corpus.corpusBuildId,
    entities: located.map(entity => entity.canonicalId),
    relationships: drawableRelationships.map(relationship => relationship.relationshipId),
  });
  const datasets: readonly KeplerDataset[] = [
    {
      info: { id: `payload_entities_${datasetStem}`, label: 'Payload corpus entities' },
      data: { fields: entityFields, rows: entityRows },
    },
    {
      info: { id: `payload_relationships_${datasetStem}`, label: 'Payload corpus relationships' },
      data: { fields: relationshipFields, rows: relationshipRows },
    },
  ];
  const features: CorpusSpatialResult['featureCollection']['features'] = [
    ...located.map(entity => ({
      type: 'Feature' as const,
      id: entity.canonicalId,
      properties: {
        feature_class: 'entity',
        canonical_id: entity.canonicalId,
        name: entity.name,
        entity_kind: entity.kind,
        location_precision: entity.location!.precision,
        known_at: entity.knownAt,
        corpus_build_id: context.corpus.corpusBuildId,
        agent_context_id: context.agentContextId,
      },
      geometry: { type: 'Point' as const, coordinates: [entity.location!.lng, entity.location!.lat] as const },
    })),
    ...drawableRelationships.map(relationship => {
      const source = byId.get(relationship.subject)!;
      const target = byId.get(relationship.object)!;
      return {
        type: 'Feature' as const,
        id: relationship.relationshipId,
        properties: {
          feature_class: 'relationship',
          relationship_id: relationship.relationshipId,
          predicate: relationship.predicate,
          source_id: relationship.subject,
          target_id: relationship.object,
          epistemic_class: relationship.epistemicClass,
          known_at: relationship.knownAt,
          corpus_build_id: context.corpus.corpusBuildId,
          agent_context_id: context.agentContextId,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: [
            [source.location!.lng, source.location!.lat] as const,
            [target.location!.lng, target.location!.lat] as const,
          ] as const,
        },
      };
    }),
  ];
  const status = located.length > 0 ? 'READY' as const : 'EMPTY' as const;
  const basis = {
    schema: 'notation.spatial-result.v1' as const,
    corpusBuildId: context.corpus.corpusBuildId,
    agentContextId: context.agentContextId,
    coordinateReferenceSystem: 'OGC:CRS84' as const,
    status,
    ...(status === 'EMPTY' ? {
      unobservedState: {
        code: 'SPATIAL_LOCATION_UNOBSERVED' as const,
        detail: 'No returned canonical entity carries an observed location.',
        remedy: 'Acquire and validate location evidence; do not geocode a similar name and present it as canonical state.',
      },
    } : {}),
    featureCollection: { type: 'FeatureCollection' as const, features },
    keplerGl: {
      compatibility: 'kepler.gl addDataToMap' as const,
      datasetIdentityRule: 'info.id_is_stable_and_matches_dataId' as const,
      action: 'addDataToMap' as const,
      payload: {
        datasets,
        options: { centerMap: true as const, readOnly: true as const, keepExistingConfig: true as const },
      },
    },
    limitations: [
      'This is a disposable projection of canonical corpus records; edits in a renderer do not mutate Payload state.',
      'Only evidence-backed coordinates are emitted. Missing locations remain an explicit unobserved state.',
      'Straight relationship lines express graph adjacency, not a surveyed or navigable route.',
    ],
  };
  return freeze({ ...basis, spatialResultId: `spatial-result:${corpusVerificationDigest(basis)}` });
}
