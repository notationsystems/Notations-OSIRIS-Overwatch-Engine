/** Payload product definition consumed by the product-neutral Corpus Engine. */

import { createCorpusDefinition } from './corpusDefinition';

export const PAYLOAD_PRODUCT_ID = 'notation-systems.product.payload';
export const CORPUS_ONTOLOGY_VERSION = 'payload.physical-economy.v1';
export const PAYLOAD_SHARED_DEPENDENCY_MINING_PROGRAM_ID = 'payload.mining.shared-dependency-fan-in@1.0.0';

export const PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION = createCorpusDefinition({
  definitionId: 'payload.corpus-definition.physical-economy.v1',
  product: {
    productId: PAYLOAD_PRODUCT_ID,
    productName: 'Payload',
    corpusName: 'Payload Physical-Economy Corpus',
  },
  domainId: 'physical-economy',
  ontology: {
    ontologyId: 'payload.ontology.physical-economy',
    ontologyVersion: CORPUS_ONTOLOGY_VERSION,
  },
  entityTypes: [
    'organization', 'facility', 'material', 'commodity', 'supplier', 'port',
    'vessel', 'infrastructure', 'process', 'network', 'market', 'flow', 'event',
    'geography',
  ],
  relationTypes: [
    'operated_by', 'owned_by', 'located_in', 'produces', 'consumes', 'transforms',
    'supplies', 'connects_to', 'ships_via', 'trades_in', 'substitutes_for',
    'depends_on', 'calls_at', 'carries', 'loads_at', 'unloads_at', 'moves_between',
    'routes_via', 'affected_by', 'observed_at', 'priced_by',
  ],
  observationTypes: [
    'metric', 'capacity', 'production', 'inventory', 'price', 'trade_flow',
    'vessel_position', 'shipment', 'infrastructure_status', 'market_state',
    'event_signal',
  ],
  sourceRegistry: {
    admission: 'REGISTERED_SOURCES_ONLY',
    sourceClasses: ['public_authority_api', 'reviewed_document', 'company_disclosure', 'geospatial_dataset', 'sensor_telemetry'],
  },
  extractionRules: ['payload.extraction.typed-record-input.v1'],
  resolutionRules: ['payload.resolution.canonical-id-or-evidenced-alias.v1'],
  validationRules: [
    'payload.validation.corpus-record.v1', 'payload.validation.evidence-closure.v1',
    'payload.validation.access-policy.v1', 'payload.validation.temporal-revision.v1',
  ],
  miningPrograms: [PAYLOAD_SHARED_DEPENDENCY_MINING_PROGRAM_ID],
  accessPolicy: {
    profileId: 'payload.policy.physical-economy.v1',
    informationFlow: 'MOST_RESTRICTIVE_JOIN',
  },
  publicationContract: {
    contractId: 'payload.publication.evidence-bearing-api.v1',
    audiences: ['public', 'authorized_customer', 'internal'],
    representations: ['relational', 'graph', 'spatial', 'vector', 'search', 'statistics'],
    evidenceRequired: true,
  },
});
