import { migrateCorpusPostgres } from '../src/lib/economy/postgresCorpusMigrations';

const connectionString = process.env.PAYLOAD_CORPUS_MIGRATION_DATABASE_URL?.trim();
if (!connectionString) throw new Error('PAYLOAD_CORPUS_MIGRATION_DATABASE_URL is required');

const result = await migrateCorpusPostgres(connectionString);
process.stdout.write(`${JSON.stringify(result)}\n`);
