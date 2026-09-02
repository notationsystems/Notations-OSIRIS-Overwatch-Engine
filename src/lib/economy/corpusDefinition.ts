/** Product-neutral PayloadOS Corpus Engine contract. */

import { createHash } from 'node:crypto';
import { stableValue } from './loadOperationsStore';

export const CORPUS_ENGINE_ID = 'notation-systems.payloados.corpus-engine';
export const CORPUS_ENGINE_VERSION = '1.0.0';

export type CorpusDefinitionInput = {
  readonly definitionId: string;
  readonly product: {
    readonly productId: string;
    readonly productName: string;
    readonly corpusName: string;
  };
  readonly domainId: string;
  readonly ontology: {
    readonly ontologyId: string;
    readonly ontologyVersion: string;
  };
  readonly entityTypes: readonly string[];
  readonly relationTypes: readonly string[];
  readonly observationTypes: readonly string[];
  readonly sourceRegistry: {
    readonly admission: 'REGISTERED_SOURCES_ONLY';
    readonly sourceClasses: readonly string[];
  };
  readonly extractionRules: readonly string[];
  readonly resolutionRules: readonly string[];
  readonly validationRules: readonly string[];
  readonly miningPrograms: readonly string[];
  readonly accessPolicy: {
    readonly profileId: string;
    readonly informationFlow: 'MOST_RESTRICTIVE_JOIN';
  };
  readonly publicationContract: {
    readonly contractId: string;
    readonly audiences: readonly string[];
    readonly representations: readonly string[];
    readonly evidenceRequired: true;
  };
};

export type CorpusDefinition = CorpusDefinitionInput & {
  readonly schema: 'payloados.corpus.definition.v1';
  readonly definitionFingerprint: string;
};

const ID = /^[a-z0-9][a-z0-9._:@/-]{2,255}$/;

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
function normalizedValues(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string' || !ID.test(value))) {
    throw new Error(`CORPUS_DEFINITION_INVALID: ${field} must contain valid identifiers`);
  }
  return Object.freeze([...new Set(values)].sort());
}

export function createCorpusDefinition(input: CorpusDefinitionInput): CorpusDefinition {
  if (!input || typeof input !== 'object' || !ID.test(input.definitionId) || !ID.test(input.domainId)
    || !input.product || !ID.test(input.product.productId) || !input.product.productName?.trim() || !input.product.corpusName?.trim()
    || !input.ontology || !ID.test(input.ontology.ontologyId) || !ID.test(input.ontology.ontologyVersion)
    || input.sourceRegistry?.admission !== 'REGISTERED_SOURCES_ONLY' || !ID.test(input.accessPolicy?.profileId)
    || input.accessPolicy.informationFlow !== 'MOST_RESTRICTIVE_JOIN' || !ID.test(input.publicationContract?.contractId)
    || input.publicationContract.evidenceRequired !== true) {
    throw new Error('CORPUS_DEFINITION_INVALID: identity, product, ontology, source, access, or publication contract is invalid');
  }
  const basis: CorpusDefinitionInput = {
    definitionId: input.definitionId,
    product: Object.freeze({
      productId: input.product.productId,
      productName: input.product.productName.trim(),
      corpusName: input.product.corpusName.trim(),
    }),
    domainId: input.domainId,
    ontology: Object.freeze({ ontologyId: input.ontology.ontologyId, ontologyVersion: input.ontology.ontologyVersion }),
    entityTypes: normalizedValues(input.entityTypes, 'entityTypes'),
    relationTypes: normalizedValues(input.relationTypes, 'relationTypes'),
    observationTypes: normalizedValues(input.observationTypes, 'observationTypes'),
    sourceRegistry: Object.freeze({
      admission: 'REGISTERED_SOURCES_ONLY' as const,
      sourceClasses: normalizedValues(input.sourceRegistry.sourceClasses, 'sourceRegistry.sourceClasses'),
    }),
    extractionRules: normalizedValues(input.extractionRules, 'extractionRules'),
    resolutionRules: normalizedValues(input.resolutionRules, 'resolutionRules'),
    validationRules: normalizedValues(input.validationRules, 'validationRules'),
    miningPrograms: normalizedValues(input.miningPrograms, 'miningPrograms'),
    accessPolicy: Object.freeze({ profileId: input.accessPolicy.profileId, informationFlow: 'MOST_RESTRICTIVE_JOIN' as const }),
    publicationContract: Object.freeze({
      contractId: input.publicationContract.contractId,
      audiences: normalizedValues(input.publicationContract.audiences, 'publicationContract.audiences'),
      representations: normalizedValues(input.publicationContract.representations, 'publicationContract.representations'),
      evidenceRequired: true as const,
    }),
  };
  const schema = 'payloados.corpus.definition.v1' as const;
  return freeze({ schema, ...basis, definitionFingerprint: digest({ schema, ...basis }) });
}

export function assertCorpusDefinition(value: CorpusDefinition): void {
  try {
    if (!value || value.schema !== 'payloados.corpus.definition.v1') throw new Error('schema is invalid');
    const input = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'schema' && key !== 'definitionFingerprint'),
    ) as CorpusDefinitionInput;
    const normalized = createCorpusDefinition(input);
    if (canonical(normalized) !== canonical(value)) throw new Error('content or fingerprint is not canonical');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'corpus definition is invalid';
    throw new Error(`CORPUS_DEFINITION_INVALID: ${detail}`);
  }
}
