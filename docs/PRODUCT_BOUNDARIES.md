# Notation Systems product boundaries

## Corporate hierarchy

```text
Notation Systems
|- internal technology
|  `- PayloadOS: machinery for building and maintaining governed corpora
`- products
   `- Payload: physical-economy data, graph, retrieval and intelligence APIs
```

PayloadOS is not the customer data product. It is Notation Systems' internal
corpus factory, mining, validation, compilation, retrieval and verification
machinery. Payload is the first domain corpus produced and maintained by that
machinery.

This gives the company two distinct assets:

- **PayloadOS technology:** acquisition, normalization, resolution, evidence,
  ontology, compilation, mining, validation, context and verification systems.
- **Payload data:** accumulated physical-economy identities, evidence,
  facilities, materials, relationships, flows, spatial state, observations and
  governed derived knowledge.

Neither asset substitutes for the other.

## CorpusDefinition-bound production

The generic Corpus Engine accepts a versioned CorpusDefinition:

```text
D = ontology + entity types + relation types + observation types
  + source registry + extraction rules + resolution rules + validation rules
  + mining programs + access policy + publication contract
Corpus Engine(D) -> domain corpus
```

`payloados.corpus.definition.v1` makes that boundary machine-readable. It
identifies the product and corpus, ontology, entity/relation/observation types,
source registry, extraction/resolution/validation rules, mining programs,
access policy and publication contract. A canonical-write manifest and every
CorpusBuild bind the exact CorpusDefinition fingerprint.

The implemented definition is:

```text
engine:  notation-systems.payloados.corpus-engine
product: notation-systems.product.payload
domain:  physical-economy
definition: payload.corpus-definition.physical-economy.v1
```

Future Materials, Architecture, or other corpora receive different product,
domain, ontology and policy identities even if they reuse the same PayloadOS
machinery. Their records and projections cannot be mistaken for Payload builds.
The current repository adapter intentionally accepts only the Payload physical-
economy definition; reuse of the engine contract does not pretend that
storage adapters for those future products already exist.

## Payload product

Payload is a provenance-first physical-economy dataset, logical knowledge graph,
retrieval system and intelligence API. Relational, spatial, graph, vector,
search and analytical stores are representations of that product corpus, not
separate products or truth authorities.

PayloadOS supplies generic retrieval, context, graph and vector compilers.
Payload supplies the physical-economy graph, embeddings, summaries, policies
and product-specific retrieval build. Payload Earth, Terminal, Tradewind,
customer applications and agents consume Payload through controlled contracts.

## Customer boundary

The external product surface is Payload:

```text
Payload Data API
Payload Graph API
Payload Spatial API
Payload Intelligence API
Payload Research API / PayloadRAG
```

Customers do not need access to PayloadOS internals or underlying databases.
Every answer remains evidence-bearing, policy-bounded and tied to the exact
Payload CorpusBuild that produced it.
