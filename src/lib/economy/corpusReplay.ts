import { createHash } from 'node:crypto';
import type { CorpusReplaySource, CorpusReplayTarget } from './corpusRepository';
import {
  canonicalCorpusJson,
  verifyCorpusRecordSet,
  type CorpusProjectionSource,
  type CorpusScope,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';

export interface CorpusReplayPlan {
  readonly kind: 'corpus_replay_plan';
  readonly sourceBackend: 'sqlite' | 'postgresql';
  readonly targetBackend: 'sqlite' | 'postgresql';
  readonly recordCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly scopes: readonly CorpusScope[];
  readonly canonicalDigest: string;
}

export interface CorpusReplayResult {
  readonly kind: 'corpus_replay_verified';
  readonly plan: CorpusReplayPlan;
  readonly imported: number;
  readonly edgeCanonicalDigest: string;
  readonly centralCanonicalDigest: string;
  readonly projections: readonly {
    readonly scope: CorpusScope;
    readonly sourceSequence: number;
    readonly sourceDigest: string;
  }[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalCorpusJson(value)).digest('hex');
}

export async function collectCorpusReplayRecords(source: CorpusReplaySource): Promise<StoredCorpusRecord[]> {
  const records: StoredCorpusRecord[] = [];
  let afterSequence = 0;
  do {
    const page = await source.replayPage({ afterSequence, limit: 5_000 });
    records.push(...page.records);
    if (!page.hasMore) break;
    if (page.nextAfterSequence <= afterSequence) throw new Error('CORPUS_REPLAY_STALLED: source cursor did not advance');
    afterSequence = page.nextAfterSequence;
  } while (true);
  verifyCorpusRecordSet(records);
  return records.sort((a, b) => a.sequence - b.sequence);
}

function recordDigest(records: readonly StoredCorpusRecord[]): string {
  return digest(records.map(record => ({
    sequence: record.sequence,
    scope: record.scope,
    recordId: record.recordId,
    recordedAt: record.recordedAt,
    previousHash: record.previousHash,
    recordHash: record.recordHash,
    canonicalRecord: canonicalCorpusJson(record),
  })));
}

export function planCorpusReplay(
  sourceBackend: CorpusReplayPlan['sourceBackend'],
  targetBackend: CorpusReplayPlan['targetBackend'],
  records: readonly StoredCorpusRecord[],
): CorpusReplayPlan {
  verifyCorpusRecordSet(records);
  const scopes = [...new Set(records.map(record => record.scope))].sort() as CorpusScope[];
  return Object.freeze({
    kind: 'corpus_replay_plan' as const,
    sourceBackend,
    targetBackend,
    recordCount: records.length,
    firstSequence: records[0]?.sequence ?? 0,
    lastSequence: records.at(-1)?.sequence ?? 0,
    scopes: Object.freeze(scopes),
    canonicalDigest: recordDigest(records),
  });
}

function projectionIdentity(source: CorpusProjectionSource) {
  return { scope: source.scope, sourceSequence: source.sourceSequence, sourceDigest: source.sourceDigest };
}

/**
 * Replays only into an empty target and refuses success until canonical and
 * per-scope active-state digests are identical on both storage engines.
 */
export async function replayCorpusToCentral(
  source: CorpusReplaySource,
  target: CorpusReplayTarget,
  options: { readonly apply: boolean; readonly knowledgeCutoff: string },
): Promise<CorpusReplayPlan | CorpusReplayResult> {
  if (!Number.isFinite(Date.parse(options.knowledgeCutoff))) throw new Error('CORPUS_REPLAY_INPUT_INVALID: knowledgeCutoff must be an ISO timestamp');
  const edgeRecords = await collectCorpusReplayRecords(source);
  const plan = planCorpusReplay(source.backend, target.backend, edgeRecords);
  const targetSummary = await target.summary();
  if (targetSummary.lastSequence !== 0 || targetSummary.projectionEvents !== 0) throw new Error('CORPUS_REPLAY_TARGET_NOT_EMPTY: use a newly migrated central database');
  if (!options.apply) return plan;
  const imported = await target.importReplayRecords(edgeRecords);
  if (imported.imported !== plan.recordCount || imported.lastSequence !== plan.lastSequence) throw new Error('CORPUS_REPLAY_COUNT_MISMATCH: central import did not acknowledge the complete sequence');
  const centralRecords = await collectCorpusReplayRecords(target);
  const edgeCanonicalDigest = recordDigest(edgeRecords);
  const centralCanonicalDigest = recordDigest(centralRecords);
  if (edgeCanonicalDigest !== centralCanonicalDigest) throw new Error('CORPUS_REPLAY_CANONICAL_MISMATCH: central records differ from edge records');
  const projections: Array<{ scope: CorpusScope; sourceSequence: number; sourceDigest: string }> = [];
  for (const scope of plan.scopes) {
    const [edge, central] = await Promise.all([
      source.projectionSource(scope, options.knowledgeCutoff),
      target.projectionSource(scope, options.knowledgeCutoff),
    ]);
    const left = projectionIdentity(edge);
    const right = projectionIdentity(central);
    if (canonicalCorpusJson(left) !== canonicalCorpusJson(right)) throw new Error(`CORPUS_REPLAY_PROJECTION_MISMATCH: ${scope} active state differs after replay`);
    projections.push(left);
  }
  return Object.freeze({
    kind: 'corpus_replay_verified' as const,
    plan,
    imported: imported.imported,
    edgeCanonicalDigest,
    centralCanonicalDigest,
    projections: Object.freeze(projections),
  });
}
