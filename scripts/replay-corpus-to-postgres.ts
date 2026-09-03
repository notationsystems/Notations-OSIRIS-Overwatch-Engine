import { resolve } from 'node:path';
import { replayCorpusToCentral } from '../src/lib/economy/corpusReplay';
import { PostgresCorpusRepository } from '../src/lib/economy/postgresCorpusRepository';
import { PhysicalEconomyCorpus } from '../src/lib/economy/physicalEconomyCorpus';

const edgePath = process.env.PAYLOAD_CORPUS_DATABASE_PATH?.trim();
const centralUrl = process.env.PAYLOAD_CORPUS_REPLAY_DATABASE_URL?.trim();
if (!edgePath) throw new Error('PAYLOAD_CORPUS_DATABASE_PATH is required');
if (!centralUrl) throw new Error('PAYLOAD_CORPUS_REPLAY_DATABASE_URL is required');

const apply = process.argv.includes('--apply');
const cutoffArgument = process.argv.find(argument => argument.startsWith('--knowledge-cutoff='));
const knowledgeCutoff = cutoffArgument?.slice('--knowledge-cutoff='.length) ?? new Date().toISOString();
const edge = new PhysicalEconomyCorpus(resolve(process.cwd(), edgePath));
const central = new PostgresCorpusRepository(centralUrl, {
  allowGlobalWrites: true,
  allowReplay: true,
  maxConnections: 1,
  applicationName: 'payload-corpus-replay',
});

try {
  const result = await replayCorpusToCentral(edge, central, { apply, knowledgeCutoff });
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result })}\n`);
} finally {
  edge.close();
  await central.close();
}
