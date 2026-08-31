import { NextResponse } from 'next/server';
import { getEconomyState } from '@/lib/economy/store';
import { asKnownThen } from '@/lib/economy/engine';
import { buildCorpusTable, buildVintageGrid, renderGridMarkdown, renderTableMarkdown, stateFingerprint } from '@/lib/economy/corpusTable';
import { recordExport } from '@/lib/economy/sessionTelemetry';
import { isMachineClient } from '@/lib/economy/machineClient';
import type { EconomyState } from '@/lib/economy/types';
import { env } from '@/lib/economy/envCompat';

/**
 * Payload Terminal — the corpus as a browsable, extractable table.
 *
 *   GET /api/economy/table?commodity=copper[&metric=...][&subject=ent:...]
 *       [&format=json|md][&asOf=YYYY-MM-DD&knowledge=as_known_then]
 *   GET /api/economy/table?view=grid&subject=ent:...&metric=...  (period × edition)
 *
 * GET-ONLY BY DESIGN: no export ever round-trips back into state — an
 * importable export is a parallel truth that bypasses the provenance
 * chain. Markdown and JSON render the SAME objects; no CSV/XLSX, because
 * spreadsheet coercion destroys exactly what this system preserves (codes,
 * dates, unit strings, the axes as labelled columns).
 */

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Canonical vocabulary only — a free-text subject could be person-shaped
// and would otherwise reach the export log; refused at the boundary.
const SUBJECT_RE = /^ent:[a-z-]+:[a-z0-9-]+$/;
const METRIC_RE = /^[a-z_]+$/;
/** D-5: a default bound, statable and raisable. Uncapped is correct for a
 *  work queue and a footgun over a decade of observations across two
 *  commodities — so the return is bounded and the bound is IN THE HEADER,
 *  never a silent slice. `limit=0` means unbounded, explicitly asked for. */
const DEFAULT_ROW_LIMIT = 500;
const MAX_ROW_LIMIT = 10000;

async function archiveExportLog(rec: Record<string, unknown>): Promise<void> {
  if (process.env.VITEST && env('PAYLOAD_FORCE_MISS_LOG') !== '1') return;
  try {
    const fs = await import('node:fs/promises');
    const dir = env('PAYLOAD_MISS_LOG_DIR') ?? `${process.cwd()}/data-archive`;
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(`${dir}/export-log.jsonl`, JSON.stringify(rec) + '\n');
  } catch { /* best-effort by design */ }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const commodity = searchParams.get('commodity') ?? 'copper';
  const metric = searchParams.get('metric') ?? undefined;
  const subject = searchParams.get('subject') ?? undefined;
  const format = searchParams.get('format') ?? 'json';
  const view = searchParams.get('view') ?? 'rows';
  const asOf = searchParams.get('asOf');
  const knowledge = (searchParams.get('knowledge') ?? 'best_known') as 'best_known' | 'as_known_then';
  const limitParam = searchParams.get('limit');
  let limit: number | null = DEFAULT_ROW_LIMIT;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ROW_LIMIT) {
      return NextResponse.json({ error: `limit must be an integer 0..${MAX_ROW_LIMIT} (0 = unbounded, stated explicitly)` }, { status: 400 });
    }
    limit = n === 0 ? null : n;
  }
  if (asOf && !DATE_RE.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  if (subject && !SUBJECT_RE.test(subject)) return NextResponse.json({ error: 'subject must be a canonical ent: identifier' }, { status: 400 });
  if (metric && !METRIC_RE.test(metric)) return NextResponse.json({ error: 'metric must be canonical vocabulary' }, { status: 400 });
  if (format !== 'json' && format !== 'md') return NextResponse.json({ error: 'format must be json or md — no CSV/XLSX (spreadsheet coercion destroys the axes; paste the markdown and own the conversion knowingly)' }, { status: 400 });
  if (knowledge !== 'best_known' && knowledge !== 'as_known_then') {
    return NextResponse.json({ error: 'knowledge must be best_known or as_known_then' }, { status: 400 });
  }

  let state: EconomyState;
  try {
    ({ state } = await getEconomyState(commodity));
  } catch {
    return NextResponse.json({ error: `unknown commodity "${commodity}"` }, { status: 404 });
  }
  // The export honours the knowledge state end to end. The ROWS path
  // passes the full state and lets the table's own filter COUNT what it
  // withholds (pre-filtering would hide the count); the GRID path serves
  // the knowledge-filtered state (an edition not yet knowable is absent
  // from the columns entirely).
  const served = knowledge === 'as_known_then' && asOf ? asKnownThen(state, asOf) : state;

  // Machine clients: served identically, never counted as researcher demand
  // — the export log is the S-7 positive signal (machineClient.ts).
  const machine = isMachineClient(request);

  if (view === 'grid') {
    if (!subject || !metric) return NextResponse.json({ error: 'grid view requires subject and metric' }, { status: 400 });
    const grid = buildVintageGrid(served, subject, metric);
    if (!machine) {
      recordExport();
      await archiveExportLog({ ts: new Date().toISOString(), view, format, commodity, subject, metric, asOf, knowledge, rows: grid.rows.length, fingerprint: stateFingerprint(state) });
    }
    if (format === 'md') return new NextResponse(renderGridMarkdown(grid), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    return NextResponse.json({ fingerprint: stateFingerprint(state), grid });
  }

  const table = buildCorpusTable(state, { metric, subject }, { asOf, knowledge, limit });
  if (!machine) {
    recordExport();
    await archiveExportLog({ ts: new Date().toISOString(), view, format, commodity, subject: subject ?? null, metric: metric ?? null, asOf, knowledge, rows: table.header.row_count, truncated: table.header.truncated, fingerprint: table.header.baseline_fingerprint });
  }
  if (format === 'md') return new NextResponse(renderTableMarkdown(table), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  return NextResponse.json(table);
}
