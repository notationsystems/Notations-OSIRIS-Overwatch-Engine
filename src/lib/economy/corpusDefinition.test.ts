import { describe, expect, it } from 'vitest';
import { CORPUS_ENGINE_ID, createCorpusDefinition } from './corpusDefinition';
import { PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION, PAYLOAD_PRODUCT_ID } from './payloadCorpusDefinition';

describe('PayloadOS CorpusDefinition', () => {
  it('separates generic corpus machinery from the enormous Payload physical-economy graph', () => {
    expect(CORPUS_ENGINE_ID).toBe('notation-systems.payloados.corpus-engine');
    expect(PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION).toMatchObject({
      schema: 'payloados.corpus.definition.v1',
      definitionId: 'payload.corpus-definition.physical-economy.v1',
      product: { productId: PAYLOAD_PRODUCT_ID, productName: 'Payload' },
      domainId: 'physical-economy',
      sourceRegistry: { admission: 'REGISTERED_SOURCES_ONLY' },
      accessPolicy: { informationFlow: 'MOST_RESTRICTIVE_JOIN' },
      publicationContract: { evidenceRequired: true },
      definitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.entityTypes).toEqual(expect.arrayContaining([
      'organization', 'facility', 'commodity', 'supplier', 'port', 'vessel',
      'infrastructure', 'market', 'flow', 'event',
    ]));
    expect(Object.isFrozen(PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION)).toBe(true);
  });

  it('normalizes declaration order while keeping another corpus distinct', () => {
    const input = {
      definitionId: 'materials.corpus-definition.v1',
      product: { productId: 'notation-systems.product.materials', productName: 'Materials', corpusName: 'Materials Corpus' },
      domainId: 'materials-science',
      ontology: { ontologyId: 'materials.ontology', ontologyVersion: 'materials.ontology.v1' },
      entityTypes: ['compound', 'element'], relationTypes: ['contains', 'substitutes_for'], observationTypes: ['property_measurement'],
      sourceRegistry: { admission: 'REGISTERED_SOURCES_ONLY' as const, sourceClasses: ['reviewed_paper', 'public_authority_api'] },
      extractionRules: ['materials.extraction.paper.v1'], resolutionRules: ['materials.resolution.identity.v1'],
      validationRules: ['materials.validation.identity.v1'], miningPrograms: ['materials.mining.substitution@1.0.0'],
      accessPolicy: { profileId: 'materials.policy.v1', informationFlow: 'MOST_RESTRICTIVE_JOIN' as const },
      publicationContract: { contractId: 'materials.publication.v1', audiences: ['public'], representations: ['relational'], evidenceRequired: true as const },
    };
    const one = createCorpusDefinition(input);
    const two = createCorpusDefinition({ ...input, entityTypes: [...input.entityTypes].reverse(), relationTypes: [...input.relationTypes].reverse() });
    expect(two.definitionFingerprint).toBe(one.definitionFingerprint);
    expect(one.definitionFingerprint).not.toBe(PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.definitionFingerprint);
  });
});
