import { archiveV2CorpusProjection, inspectCorpusProjection } from '../src/lib/economy/corpusProjectionRebuild';
import { compilePublicProjectionFromRepository, CorpusProjectionStore } from '../src/lib/economy/corpusProjection';
import { corpusProjectionPath } from '../src/lib/economy/corpusProjectionRuntime';
import { physicalEconomyCorpus } from '../src/lib/economy/physicalEconomyCorpusRuntime';

const projectionPath = corpusProjectionPath();
const corpus = physicalEconomyCorpus('compiler');
if (!projectionPath) throw new Error('PAYLOAD_CORPUS_READ_MODEL_PATH is required');
if (!corpus) throw new Error('Configure PAYLOAD_CORPUS_DATABASE_PATH or a PostgreSQL compiler connection URL');

const inspection = inspectCorpusProjection(projectionPath);
if (inspection.state === 'unsupported') throw new Error(`CORPUS_PROJECTION_REBUILD_REFUSED: unsupported specification ${inspection.specificationId ?? '(unreadable)'}`);
const archived = inspection.state === 'obsolete' ? archiveV2CorpusProjection(projectionPath) : [];
const projection = new CorpusProjectionStore(projectionPath);
try {
  const cutoffArgument = process.argv.find(argument => argument.startsWith('--knowledge-cutoff='));
  const knowledgeCutoff = cutoffArgument?.slice('--knowledge-cutoff='.length) ?? new Date().toISOString();
  const result = await compilePublicProjectionFromRepository(corpus, projection, knowledgeCutoff);
  process.stdout.write(`${JSON.stringify({ kind: 'corpus_projection_v3_rebuilt', prior: inspection, archived, manifest: result.manifest })}\n`);
} finally {
  projection.close();
  await corpus.close();
}
