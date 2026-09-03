import type {
  CorpusAppendResult,
  CorpusPage,
  CorpusProjectionEventPage,
  CorpusProjectionSource,
  CorpusProjectorCheckpoint,
  CorpusRecordInput,
  CorpusReplayPage,
  CorpusScope,
  CorpusSummary,
  FacilityDiscoveryResult,
  StoredCorpusRecord,
} from './physicalEconomyCorpus';

export type Awaitable<T> = T | Promise<T>;

export interface CorpusRepository {
  readonly backend: 'sqlite' | 'postgresql';
  readonly databasePath: string;
  close(): Awaitable<void>;
  summary(): Awaitable<CorpusSummary>;
  append(scope: CorpusScope, records: readonly CorpusRecordInput[], recordedAt?: string): Awaitable<CorpusAppendResult>;
  page(options?: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number; readonly knowledgeCutoff?: string }): Awaitable<CorpusPage>;
  projectionSource(scope?: CorpusScope, knowledgeCutoff?: string): Awaitable<CorpusProjectionSource>;
  findFacilities(materialRef: string, options?: { readonly scope?: CorpusScope; readonly asOf?: string; readonly knowledgeCutoff?: string }): Awaitable<FacilityDiscoveryResult>;
  readProjectionEvents(options?: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number }): Awaitable<CorpusProjectionEventPage>;
  checkpointProjection(input: { readonly projector: string; readonly scope?: CorpusScope; readonly sequence: number; readonly updatedAt?: string }): Awaitable<CorpusProjectorCheckpoint>;
}

export interface CorpusReplaySource extends CorpusRepository {
  replayPage(options?: { readonly afterSequence?: number; readonly limit?: number }): Awaitable<CorpusReplayPage>;
}

export interface CorpusReplayTarget extends CorpusRepository {
  /** Exact-sequence import. Production request handlers never receive this capability. */
  importReplayRecords(records: readonly StoredCorpusRecord[]): Promise<{ readonly imported: number; readonly lastSequence: number }>;
  replayPage(options?: { readonly afterSequence?: number; readonly limit?: number }): Promise<CorpusReplayPage>;
}

/** Server routes await this boundary, so both embedded and central adapters obey one contract. */
export async function awaitCorpus<T>(value: Awaitable<T>): Promise<T> {
  return value;
}
