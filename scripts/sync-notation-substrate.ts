/** Consume one page at a time into the local Notation Data Substrate. */

import { setTimeout as wait } from 'node:timers/promises';
import { NotationSubstrateStore } from '../src/lib/economy/notationSubstrateStore';
import { notationSubstratePath } from '../src/lib/economy/notationSubstrateRuntime';
import { runNotationSubstrateSyncOnce } from '../src/lib/economy/notationSubstrateSyncWorker';

async function main(): Promise<void> {
  const databasePath = notationSubstratePath();
  const sourceUrl = process.env.PAYLOAD_NOTATION_SOURCE_URL?.trim();
  const sourceToken = process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN?.trim();
  const consumerId = process.env.PAYLOAD_NOTATION_SUBSTRATE_CONSUMER_ID?.trim() ?? 'primary-fabric';
  const pageLimit = Number(process.env.PAYLOAD_NOTATION_SUBSTRATE_PAGE_LIMIT ?? '100');
  const pollMs = Number(process.env.PAYLOAD_NOTATION_SUBSTRATE_POLL_MS ?? '5000');
  const watch = process.argv.includes('--watch');
  if (!databasePath || !sourceUrl || !sourceToken) throw new Error('PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH, PAYLOAD_NOTATION_SOURCE_URL, and PAYLOAD_CORPUS_PROJECTOR_TOKEN are required');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 60_000) throw new Error('PAYLOAD_NOTATION_SUBSTRATE_POLL_MS must be 1000..60000');
  const store = new NotationSubstrateStore(databasePath);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  try {
    do {
      const result = await runNotationSubstrateSyncOnce(store, { sourceUrl, sourceToken, consumerId, pageLimit });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!watch) break;
      if (!result.upstreamAcknowledged) process.exitCode = 1;
      if (!result.hasMore) await wait(pollMs);
    } while (!stopping);
  } finally { store.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
