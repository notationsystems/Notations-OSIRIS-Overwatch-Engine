/** Claim at most one proof batch, prove it with SP1, verify it, and exit. */

import { resolve } from 'node:path';
import { PayloadEventDatabase } from '../src/lib/economy/payloadEventDatabase';
import { runOneSp1Proof } from '../src/lib/economy/sp1ProofWorker';

async function main(): Promise<void> {
  const databaseValue = process.env.PAYLOAD_DATABASE_PATH?.trim();
  if (!databaseValue) throw new Error('PAYLOAD_DATABASE_PATH is required.');
  const workerId = process.env.PAYLOAD_SP1_WORKER_ID?.trim();
  if (!workerId) throw new Error('PAYLOAD_SP1_WORKER_ID is required.');
  const database = new PayloadEventDatabase(resolve(databaseValue));
  try {
    const result = await runOneSp1Proof(database, { workerId });
    console.log(JSON.stringify(result, null, 2));
    if (result.kind === 'refusal') process.exitCode = 1;
  } finally { database.close(); }
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
