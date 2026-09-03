/**
 * ═══════════════════════════════════════════════════════════════
 *  Payload — API Catalog
 *  Machine-readable description of every public route under /api.
 *  Kept in sync by hand with src/app/api/ * /route.ts
 * ═══════════════════════════════════════════════════════════════
 */

export type HttpMethod = 'GET' | 'POST';

export interface ApiParam {
  name: string;
  required?: boolean;
  desc: string;
  example?: string;
}

export interface ApiEndpoint {
  /** Path relative to the deployment origin, e.g. `/api/flights` */
  path: string;
  method: HttpMethod | HttpMethod[];
  summary: string;
  /** Query-string parameters (GET) */
  params?: ApiParam[];
  /** Top-level keys present on a 2xx response */
  returns: string[];
  /** Free-form notes: caching, auth, upstream source, failure modes */
  notes?: string;
  /** Environment variables the route reads */
  env?: string[];
  /** Pretty-printed JSON request body, for POST routes */
  bodyExample?: string;
  /** True when the route needs a credential the docs cannot supply */
  requiresAuth?: boolean;
}

/** Stable DOM id / deep-link anchor for an endpoint. */
export function endpointId(ep: ApiEndpoint): string {
  const method = Array.isArray(ep.method) ? ep.method[0] : ep.method;
  return `ep-${method}-${ep.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`.toLowerCase();
}

/** Example request URL with required params filled from their documented examples. */
export function sampleUrl(ep: ApiEndpoint, origin = ''): string {
  const qs = (ep.params || [])
    .filter(p => p.required || p.example)
    .map(p => `${p.name}=${encodeURIComponent((p.example || '').split(' | ')[0] || 'value')}`)
    .join('&');
  return `${origin}${ep.path}${qs ? `?${qs}` : ''}`;
}

export interface ApiGroup {
  id: string;
  title: string;
  blurb: string;
  endpoints: ApiEndpoint[];
}

export const API_GROUPS: ApiGroup[] = [
  {
    id: 'corpus',
    title: 'Physical-Economy Corpus',
    blurb: 'Evidence-bearing computational queries plus authenticated, linearly replayable corpus administration.',
    endpoints: [
      {
        path: '/api/corpus/facilities',
        method: 'GET',
        summary: 'Resolves a material identity and returns active producing facilities with coordinates, operators, confidence and exact evidence.',
        params: [
          { name: 'q', required: true, desc: 'Canonical material ID, explicit alias, or “<material> production”.', example: 'polypropylene production' },
          { name: 'asOf', desc: 'Relationship-validity time in ISO UTC form.' },
          { name: 'knowledgeCutoff', desc: 'Optional exact cutoff of the active compiled projection; other historical cutoffs are refused in V0.' },
        ],
        returns: ['kind', 'material', 'scope', 'asOf', 'knowledgeCutoff', 'facilities', 'warrant'],
        notes: 'Reads only the compiled, policy-filtered public/global read model. Successful answers carry canonical identities, evidence hashes, computation digests, uncertainty, joined policy lineage, a privacy-safe corpus-build reference, a VerificationEnvelope, and a score-free Warrant Graph. Current answers are reproducible and have Merkle inclusion proofs; they are not presented as externally attested or zk-verified. Missing, ambiguous, stale, corrupt, unauthorized, or historically unavailable state returns a typed refusal; customer scope cannot be requested here.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_QUERY_DATABASE_URL', 'PAYLOAD_CORPUS_READ_MODEL_PATH'],
      },
      {
        path: '/api/corpus/warrants',
        method: 'GET',
        summary: 'Explains one current public corpus record or entity as a walkable, score-free provenance and computation graph.',
        params: [
          { name: 'recordId', desc: 'Exact record ID. Supply this or entityId, never both.', example: 'record:entity:warrant-api' },
          { name: 'entityId', desc: 'Canonical entity ID. Supply this or recordId, never both.' },
          { name: 'maximumRecords', desc: 'Hard response bound from 1 to 500.', example: '200' },
        ],
        returns: ['kind', 'subject', 'verification', 'graph'],
        notes: 'Requires dedicated query authority and reads only the current policy-filtered public projection. It preserves supports, contradicts, and qualifies as separate edges and never computes a composite trust score. The VerificationEnvelope binds exact records to a CorpusBuild Merkle root and deterministic computation; membership is not source truth, external timestamping, or an SP1 proof.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_QUERY_DATABASE_URL', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_QUERY_TOKEN'],
        requiresAuth: true,
      },
      {
        path: '/api/corpus/projections',
        method: ['GET', 'POST'],
        summary: 'Compiles or inspects the deterministic public/global corpus read model.',
        returns: ['kind', 'idempotent', 'manifest'],
        notes: 'Requires corpus-compiler authority. Compilation admits only explicitly public, redistributable records, prunes denied dependencies, joins input policy lineage, and emits a content-addressed build manifest bound to the PayloadOS engine, Payload product, physical-economy CorpusDefinition, canonical state, schema, ontology, policy, compiler, embedding, and representation versions. The resulting database is disposable.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_COMPILER_DATABASE_URL', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_COMPILER_TOKEN'],
        requiresAuth: true,
        bodyExample: '{\n  "audience": "public",\n  "scope": "global",\n  "knowledgeCutoff": "2026-09-02T12:00:00.000Z"\n}',
      },
      {
        path: '/api/corpus/records',
        method: ['GET', 'POST'],
        summary: 'Commits a typed Corpus Builder batch or replays the canonical sequence by cursor.',
        params: [
          { name: 'scope', desc: 'global or one authorized customer:<id> scope.', example: 'global' },
          { name: 'afterSequence', desc: 'Exclusive global cursor.', example: '0' },
          { name: 'limit', desc: 'Page size from 1 to 500.', example: '100' },
          { name: 'view', desc: 'Use summary for record counts and the last sequence.' },
        ],
        returns: ['kind', 'scope', 'nextAfterSequence', 'hasMore', 'records', 'builderManifest'],
        notes: 'Requires the dedicated corpus-administration bearer token. A successful POST includes a deterministic builder manifest binding the PayloadOS engine, Payload product, CorpusDefinition and exact canonical write performed; it does not falsely attest to upstream acquisition or extraction. Exact replay is idempotent and immutable identity conflicts are refused.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_QUERY_DATABASE_URL', 'PAYLOAD_CORPUS_INGEST_DATABASE_URL', 'PAYLOAD_CORPUS_INGEST_TOKEN'],
        requiresAuth: true,
        bodyExample: '{\n  "scope": "global",\n  "records": [{\n    "schema": "payload.corpus.record.v1",\n    "...": "...",\n    "access": { "visibility": "PUBLIC", "licenseClass": "OPEN_PUBLIC", "redistributionClass": "UNRESTRICTED", "retentionClass": "PERMANENT", "allowedUses": ["SEARCH", "REDISTRIBUTION", "PROJECTION"] }\n  }],\n  "recordedAt": "2026-09-02T12:00:00.000Z"\n}',
      },
      {
        path: '/api/corpus/retrieval',
        method: 'POST',
        summary: 'Builds a deterministic retrieval plan and provenance-complete ContextPackage for people or agents.',
        returns: ['kind', 'plan', 'context'],
        notes: 'Requires dedicated query authority. Reads only the current verified public projection, bounds resolution/traversal/evidence retrieval, refuses stale or unavailable historical state, and returns exact record IDs and CorpusBuild identity in its trace. mode=plan omits execution.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_QUERY_DATABASE_URL', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_QUERY_TOKEN'],
        requiresAuth: true,
        bodyExample: '{\n  "query": "Which facilities depend on this supplier?",\n  "entityIds": ["pe:organization:supplier"],\n  "asOf": "2026-09-02T12:00:00.000Z",\n  "traversal": { "predicates": ["depends_on"], "direction": "inbound", "maxHops": 2 },\n  "evidenceQuery": "supplier dependency"\n}',
      },
      {
        path: '/api/corpus/projectors',
        method: ['GET', 'POST'],
        summary: 'Pages the transactional corpus projection outbox or advances one monotonic projector checkpoint.',
        params: [
          { name: 'scope', desc: 'global or one customer:<id> composition scope.', example: 'global' },
          { name: 'afterSequence', desc: 'Exclusive canonical event cursor.', example: '0' },
          { name: 'limit', desc: 'Page size from 1 to 500.', example: '100' },
        ],
        returns: ['kind', 'scope', 'nextAfterSequence', 'hasMore', 'events'],
        notes: 'Requires dedicated projection-worker authority. Events are written atomically with canonical records; checkpoints cannot move backward or beyond the visible outbox.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_PROJECTOR_DATABASE_URL', 'PAYLOAD_CORPUS_PROJECTOR_TOKEN'],
        requiresAuth: true,
        bodyExample: '{\n  "projector": "projector:qdrant",\n  "scope": "global",\n  "sequence": 1204,\n  "updatedAt": "2026-09-02T12:01:00.000Z"\n}',
      },
      {
        path: '/api/corpus/mining/dependencies',
        method: ['GET', 'POST'],
        summary: 'Mines explicit shared-dependency fan-in and retrieves append-only candidate-knowledge runs.',
        params: [
          { name: 'afterSequence', desc: 'Exclusive Pattern Registry run cursor.', example: '0' },
          { name: 'limit', desc: 'Page size from 1 to 250.', example: '100' },
          { name: 'view', desc: 'Use summary for run/candidate counts and the last sequence.' },
        ],
        returns: ['kind', 'idempotent', 'run', 'candidates'],
        notes: 'Requires the dedicated miner bearer token. POST reads only the current verified public CorpusBuild, uses explicit depth-1 depends_on records, carries evidence and policy lineage, and appends CANDIDATE objects to a separate hash-chained Pattern Registry. A mined pattern never mutates canonical state or claims causality, materiality, exclusivity, or corpus completeness.',
        env: ['PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_QUERY_DATABASE_URL', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH', 'PAYLOAD_CORPUS_MINER_TOKEN'],
        requiresAuth: true,
        bodyExample: '{\n  "entityId": "pe:facility:gulf-coast-ethylene",\n  "depth": 1,\n  "minimumDependents": 2,\n  "executedAt": "2026-09-02T12:00:00.000Z"\n}',
      },
    ],
  },
  {
    id: 'system',
    title: 'System',
    blurb: 'Liveness and aggregate counters. Safe to poll from monitoring.',
    endpoints: [
      {
        path: '/api/health',
        method: 'GET',
        summary: 'Liveness probe. Never touches an upstream feed, so it stays fast under load.',
        returns: ['status', 'platform', 'version', 'uptime', 'timestamp', 'endpoints'],
        notes: '`status` is the literal string `operational`. `uptime` is process uptime in seconds.',
      },
      {
        path: '/api/stats',
        method: 'GET',
        summary:
          'Fans out to the heavy feeds in parallel and returns only the counts — roughly 100 bytes instead of 10 MB of GeoJSON.',
        returns: ['stats', 'timestamp'],
        notes:
          '`stats` contains `flights`, `sats`, `cctv`, `weather`, `nuclear`, `incidents`. Cached `s-maxage=30, stale-while-revalidate=60`, so 10k concurrent dashboard boots collapse into one upstream fetch per minute.',
      },
    ],
  },
  {
    id: 'earth',
    title: 'Earth & Environment',
    blurb: 'Seismic, fire, atmospheric, and orbital-imagery feeds.',
    endpoints: [
      {
        path: '/api/weather',
        method: 'GET',
        summary: 'Severe weather and natural events from NASA EONET.',
        returns: ['events', 'total', 'timestamp'],
      },
      {
        path: '/api/air-quality',
        method: 'GET',
        summary: 'Ground station air quality readings.',
        returns: ['stations', 'total', 'timestamp'],
      },
    ],
  },
  {
    id: 'media-markets',
    title: 'Media & Markets',
    blurb: 'News aggregation, live broadcast streams, and financial instruments.',
    endpoints: [
      {
        path: '/api/news',
        method: 'GET',
        summary: 'Aggregated OSINT news items.',
        returns: ['news', 'total', 'timestamp'],
      },
      {
        path: '/api/markets',
        method: 'GET',
        summary: 'Defence-sector equities and commodities.',
        returns: ['stocks', 'timestamp'],
      },
    ],
  },
  {
    id: 'surveillance',
    title: 'Surveillance & Infrastructure',
    blurb: 'Camera networks, fixed infrastructure, maritime traffic, and tile/stream proxies.',
    endpoints: [
      {
        path: '/api/infrastructure',
        method: 'GET',
        summary: 'Fixed strategic infrastructure — nuclear sites, plants, and facilities.',
        returns: ['infrastructure', 'total', 'timestamp'],
      },
      {
        path: '/api/maritime',
        method: 'GET',
        summary: 'Ports, chokepoints, and vessel positions.',
        returns: ['ports', 'chokepoints', 'ships', 'total_ports', 'total_chokepoints', 'total_ships', 'timestamp'],
        env: ['AIS_API_KEY'],
      },
      {
        path: '/api/arcgis',
        method: 'GET',
        summary: 'Queries a configured ArcGIS feature service.',
        params: [
          { name: 'service', desc: 'Service identifier to query.' },
          { name: 'q', desc: 'Attribute query string.' },
          { name: 'bbox', desc: 'Bounding box filter, `minLng,minLat,maxLng,maxLat`.' },
        ],
        returns: ['…feature collection'],
      },
      {
        path: '/api/proxy-tiles',
        method: 'GET',
        summary: 'Same-origin raster tile proxy for basemaps that block cross-origin reads.',
        params: [{ name: 'url', required: true, desc: 'Upstream tile URL.' }],
        returns: ['…binary tile'],
      },
      {
        path: '/api/geo',
        method: 'GET',
        summary: 'Geolocates the calling client by IP.',
        returns: ['status', 'query', 'city', 'regionName', 'country', 'lat', 'lon', 'isp', 'org'],
      },
    ],
  },
  {
    id: 'osint',
    title: 'OSINT Toolkit',
    blurb:
      'Infrastructure attribution and counterparty screening. Every route takes a single subject and returns a normalised result, so they compose well in scripts. Scoped to organisations: never used to profile a person.',
    endpoints: [
      {
        path: '/api/osint/dns',
        method: 'GET',
        summary: 'Resolves A, AAAA, MX, NS, TXT, and SOA records.',
        params: [{ name: 'domain', required: true, desc: 'Domain to resolve.', example: 'example.com' }],
        returns: ['…record sets'],
      },
      {
        path: '/api/osint/whois',
        method: 'GET',
        summary: 'Registration and registrar detail for a domain.',
        params: [{ name: 'domain', required: true, desc: 'Domain to look up.', example: 'example.com' }],
        returns: ['…registration record'],
      },
      {
        path: '/api/osint/certs',
        method: 'GET',
        summary: 'Certificate transparency search — an effective passive subdomain enumerator.',
        params: [{ name: 'domain', required: true, desc: 'Apex domain to search.', example: 'example.com' }],
        returns: ['certificates', 'subdomains', 'total_certs', 'unique_subdomains', 'timestamp'],
      },
      {
        path: '/api/osint/ip',
        method: 'GET',
        summary: 'Geolocation, ASN, and network ownership for an address.',
        params: [{ name: 'ip', required: true, desc: 'IPv4 or IPv6 address.', example: '8.8.8.8' }],
        returns: ['…address record'],
      },
      {
        path: '/api/osint/bgp',
        method: 'GET',
        summary: 'ASN, prefix, and peering relationships.',
        params: [{ name: 'query', required: true, desc: 'ASN, prefix, or IP.', example: 'AS15169' }],
        returns: ['…routing record'],
      },
      {
        path: '/api/osint/mac',
        method: 'GET',
        summary: 'Resolves a MAC address or OUI prefix to its hardware vendor.',
        params: [{ name: 'mac', required: true, desc: 'MAC address or OUI prefix.', example: '00:1A:2B:3C:4D:5E' }],
        returns: ['mac', 'prefix', 'vendor', 'address', 'detail'],
      },
      {
        path: '/api/osint/sanctions',
        method: 'GET',
        summary: 'Searches the OpenSanctions mirror of the US OFAC SDN list.',
        params: [
          { name: 'query', required: true, desc: 'Name of a person, organisation, or vessel.' },
          { name: 'schema', desc: 'Entity type filter.', example: 'Person | Organization | Vessel' },
          { name: 'limit', desc: 'Maximum results to return.', example: '10' },
        ],
        returns: ['schema', 'total', 'source', 'timestamp'],
      },
      {
        path: '/api/osint/threats',
        method: 'GET',
        summary: 'Reputation and threat-intel enrichment for an indicator.',
        params: [{ name: 'query', required: true, desc: 'IP, domain, or file hash.' }],
        returns: ['…enrichment record'],
      },
    ],
  },
  {
    id: 'graph',
    title: 'Entity Graph',
    blurb: 'Link analysis over entities surfaced elsewhere in the platform.',
    endpoints: [
      {
        path: '/api/entity/expand',
        method: 'GET',
        summary: 'Expands one graph node into its neighbours.',
        params: [
          { name: 'id', required: true, desc: 'Entity identifier to expand.' },
          { name: 'type', required: true, desc: 'Entity type, which selects the expansion strategy.' },
        ],
        returns: ['…nodes and edges'],
      },
    ],
  },
  {
    id: 'ai',
    title: 'AI Analysis',
    blurb:
      'Gemini-backed correlation over feed data you supply. All three are POST, all three are rate limited to 5 requests per minute per IP.',
    endpoints: [
    ],
  },
  {
    id: 'sdk',
    title: 'Polybolos SDK',
    blurb:
      'Push entities from an external platform into the Common Operating Picture, and stream the merged picture back out.',
    endpoints: [
      {
        path: '/api/sdk/ingest',
        method: 'POST',
        summary: 'Accepts Polybolos-format entities from an external system and merges them into the map.',
        returns: ['accepted', 'rejected', 'errors', 'timestamp'],
        env: ['SDK_INGEST_KEY'],
        requiresAuth: true,
        notes:
          'Each entity needs `id`, `position.lat`, and `position.lng`; everything else is defaulted. Stored ids are namespaced to `ext-{source}-{id}`, so two platforms can push the same id safely. Fails closed: 503 when `SDK_INGEST_KEY` is unset, 401 on key mismatch, 400 on a malformed payload.',
        bodyExample: `{
  "source": "lattice",
  "apiKey": "$SDK_INGEST_KEY",
  "entities": [
    {
      "id": "TRK-4471",
      "name": "UNKNOWN SURFACE CONTACT",
      "domain": "SEA",
      "entityType": "TRACK",
      "position": { "lat": 36.14, "lng": -5.35, "heading": 271, "speed": 14.2 },
      "threat": "UNKNOWN",
      "classification": "UNCLASSIFIED",
      "confidence": 0.86
    }
  ]
}`,
      },
      {
        path: '/api/sdk/ingest',
        method: 'GET',
        summary: 'Reports how many external entities are currently held, plus recent ingest history.',
        returns: ['sdk', 'version', 'entityCount', 'recentIngestions', 'timestamp'],
      },
      {
        path: '/api/sdk/stream',
        method: 'GET',
        summary: 'Server-Sent Events stream of normalised entities as they arrive.',
        returns: ['…SSE event stream'],
        notes:
          'Opens with a `status` event carrying `connected`, `entityCount`, `feedCount`, `latticeStatus`, and `lastUpdate`. Consume with `EventSource`, not `fetch`.',
      },
    ],
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    blurb: 'Inbound hooks from external services.',
    endpoints: [
      {
        path: '/api/github-webhook',
        method: 'POST',
        summary: 'Receives GitHub repository events.',
        returns: ['success', 'message', 'error'],
        requiresAuth: true,
        notes: 'Signature-verified. Unsigned or mismatched deliveries are rejected with 401.',
      },
    ],
  },
];

/** Total endpoint count, derived rather than hard-coded so it cannot drift. */
export const ENDPOINT_COUNT = API_GROUPS.reduce((n, g) => n + g.endpoints.length, 0);
