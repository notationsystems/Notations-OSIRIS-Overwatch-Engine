/** One-time, idempotent migration from all compatibility JSONL journals to SQLite. */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { FileCarrierCommunicationStore } from '../src/lib/economy/carrierCommunicationsStore';
import { FileLoadOperationStore, stableValue } from '../src/lib/economy/loadOperationsStore';
import { PayloadEventDatabase } from '../src/lib/economy/payloadEventDatabase';
import { FileProcurementStore } from '../src/lib/economy/procurementStore';
import { FileCommercialStore } from '../src/lib/economy/commercialStore';
import { FileProjectCargoStore } from '../src/lib/economy/projectCargoStore';

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function canonical(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function main(): Promise<void> {
  const databaseValue = option('database') ?? process.env.PAYLOAD_DATABASE_PATH;
  if (!databaseValue?.trim()) {
    throw new Error('Set PAYLOAD_DATABASE_PATH or pass --database=<path>. The migration never invents a destination.');
  }
  const databasePath = resolve(databaseValue);
  const operationsPath = resolve(option('operations') ?? process.env.PAYLOAD_OPERATIONS_LOG ?? 'data-archive/load-operations.jsonl');
  const communicationsPath = resolve(option('communications') ?? process.env.PAYLOAD_CARRIER_COMMUNICATIONS_LOG ?? 'data-archive/carrier-communications.jsonl');
  const procurementPath = resolve(option('procurement') ?? process.env.PAYLOAD_PROCUREMENT_LOG ?? 'data-archive/procurement.jsonl');
  const commercialPath = resolve(option('commercial') ?? process.env.PAYLOAD_COMMERCIAL_LOG ?? 'data-archive/commercial.jsonl');
  const projectCargoPath = resolve(option('project-cargo') ?? process.env.PAYLOAD_PROJECT_CARGO_LOG ?? 'data-archive/project-cargo.jsonl');
  if (!existsSync(operationsPath) && !existsSync(communicationsPath) && !existsSync(procurementPath) && !existsSync(commercialPath) && !existsSync(projectCargoPath)) {
    throw new Error('No legacy journal exists. Start a new database directly, or point the migration at the deployment volume.');
  }

  const operationRecords = await new FileLoadOperationStore(operationsPath).readAll();
  const communicationRecords = await new FileCarrierCommunicationStore(communicationsPath).readAll();
  const procurementRecords = await new FileProcurementStore(procurementPath).readAll();
  const commercialRecords = await new FileCommercialStore(commercialPath).readAll();
  const projectCargoRecords = await new FileProjectCargoStore(projectCargoPath).readAll();
  const legacy = [
    ...operationRecords.map((record, index) => ({ stream: 'load_operation' as const, index, event: record.event })),
    ...communicationRecords.map((record, index) => ({ stream: 'carrier_communication' as const, index, event: record.event })),
    ...procurementRecords.map((record, index) => ({ stream: 'procurement' as const, index, event: record.event })),
    ...commercialRecords.map((record, index) => ({ stream: 'commercial' as const, index, event: record.event })),
    ...projectCargoRecords.map((record, index) => ({ stream: 'project_cargo' as const, index, event: record.event })),
  ].sort((left, right) => {
    const time = Date.parse(left.event.recordedAt) - Date.parse(right.event.recordedAt);
    if (time) return time;
    if (left.stream === right.stream) return left.index - right.index;
    return left.stream.localeCompare(right.stream);
  });

  const database = new PayloadEventDatabase(databasePath);
  try {
    const existing = database.queryEvents({ limit: 500 });
    const allExisting = [...existing.events];
    let cursor = existing.nextAfterSequence;
    while (existing.hasMore && cursor < database.summary().lastSequence) {
      const page = database.queryEvents({ afterSequence: cursor, limit: 500 });
      allExisting.push(...page.events);
      if (!page.hasMore) break;
      cursor = page.nextAfterSequence;
    }
    if (allExisting.length > 0) {
      const byIdentity = new Map(allExisting.map(event => [`${event.stream}|${event.eventId}`, canonical(event.event)]));
      const exact = legacy.every(item => byIdentity.get(`${item.stream}|${item.event.eventId}`) === canonical(item.event));
      if (!exact || allExisting.length !== legacy.length) {
        throw new Error(
          'Destination database is not an exact prior migration of these journals. Use an empty destination; historical events are never merged behind newer sequence numbers.',
        );
      }
      console.log(JSON.stringify({ kind: 'migration_already_complete', database: database.summary() }, null, 2));
      return;
    }

    for (const item of legacy) {
      const result = item.stream === 'load_operation'
        ? database.appendOperation(item.event)
        : item.stream === 'carrier_communication'
          ? database.appendCommunication(item.event)
          : item.stream === 'procurement'
            ? database.appendProcurement(item.event)
            : item.stream === 'commercial'
              ? database.appendCommercial(item.event)
              : database.appendProjectCargo(item.event);
      if (result.kind === 'refusal') throw new Error(`${result.code}: ${result.detail}`);
    }
    const summary = database.summary();
    if (summary.operationEvents !== operationRecords.length || summary.communicationEvents !== communicationRecords.length ||
        summary.procurementEvents !== procurementRecords.length || summary.commercialEvents !== commercialRecords.length ||
        summary.projectCargoEvents !== projectCargoRecords.length) {
      throw new Error('Migration count verification failed; leave legacy journals in place and inspect the destination.');
    }
    console.log(JSON.stringify({
      kind: 'migration_complete',
      source: { operationsPath, communicationsPath, procurementPath, commercialPath, projectCargoPath },
      database: summary,
    }, null, 2));
  } finally {
    database.close();
  }
}

main().catch(error => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
