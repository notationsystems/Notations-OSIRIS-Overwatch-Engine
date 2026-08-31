/**
 * Payload Terminal — boot behaviour and honest degradation (deployment
 * order D-2).
 *
 * INSPECTION FIRST, and it corrected two of the order's assumptions:
 *
 * 1. A cold start did NOT build state at all. `register()` asserted
 *    configuration and nothing else; the canonical state was assembled
 *    lazily on the FIRST REQUEST and memoized for ten minutes. So the
 *    researcher's first click paid the whole assembly cost — live
 *    adapter fetches included — with no indication anything was
 *    happening. That is the "silent cold start a researcher assumes is
 *    broken" the order names, and it was worse than assumed: not slow
 *    boot, but boot that deferred its work into the first user's lap.
 *
 * 2. "A missing archive path fails at startup" has no referent as
 *    written: snapshots are ES-module imports bundled into the build,
 *    so the SNAPSHOT rungs cannot go missing at runtime — a missing
 *    archive directory does not break serving. What it actually breaks
 *    is the WRITE path: the miss log, the export log, the MCP session
 *    log and the Comtrade vintage archive all append there, and an
 *    unwritable directory loses demand evidence silently (every writer
 *    is deliberately best-effort so a read-only filesystem never breaks
 *    a query). So the archive check here is a WRITABILITY check, named
 *    with its path, reported at boot rather than discovered when the
 *    evidence turns out to be missing at day 90.
 *
 * Boot is BOUNDED: state warming runs against a timeout, and a source
 * that hangs brings the instance up DEGRADED and saying so rather than
 * blocking startup indefinitely. Failure to warm is never fatal — the
 * lazy path still works — but it is recorded, not swallowed.
 */

import { getEconomyState } from './store';
import { guardEvaluationScope } from './ledgerGuards';
import { recordProcessEvent } from './observability';
import { processSingleton } from './processSingleton';

export interface CommodityBootOutcome {
  commodity: string;
  status: 'ready' | 'degraded' | 'failed' | 'timed_out';
  ms: number;
  /** Providers that actually answered. */
  providers: string[];
  /** Adapter failures, named — a degraded state says which source is out. */
  issues: string[];
  observations?: number;
}

export interface ArchiveBootOutcome {
  path: string;
  status: 'writable' | 'not_writable' | 'missing';
  detail: string;
}

export interface BootReport {
  startedAt: string;
  completedAt: string | null;
  ms: number | null;
  status: 'booting' | 'ready' | 'degraded';
  budgetMs: number;
  archive: ArchiveBootOutcome | null;
  commodities: CommodityBootOutcome[];
  note: string;
}

// The budget bounds how long a warm attempt is TRACKED, not how long the
// server waits before serving: warming is fired without blocking startup
// (see instrumentation.ts). A generous budget therefore costs nothing at
// startup and makes the report accurate — measured in the running
// configuration, the copper assembly runs past 30s once D-10's per-host
// limiter serialises both commodities against comtradeapi.un.org.
const BOOT_BUDGET_MS = Number(process.env.SEA_DOG_BOOT_BUDGET_MS ?? 180_000);

/** The boot report lives on globalThis. Next runs instrumentation in a
 *  DIFFERENT module context from the route handlers, so a module-level
 *  report is written by one copy and read by another — measured in the
 *  running configuration: the server log said "boot ready in 2805ms"
 *  while /api/health answered "booting" indefinitely. A boot report
 *  nobody can read is not a boot report. */
const slot = () => processSingleton<{ current: BootReport }>('boot-report', () => ({
  current: {
    startedAt: new Date().toISOString(),
    completedAt: null,
    ms: null,
    status: 'booting',
    budgetMs: BOOT_BUDGET_MS,
    archive: null,
    commodities: [],
    note: 'Warming. The instance is ALREADY SERVING — state assembly runs in the background so startup is not blocked; a request arriving now joins the in-flight assembly rather than starting a second one.',
  },
}));

export function bootReport(): BootReport {
  const r = slot().current;
  return { ...r, commodities: [...r.commodities] };
}

/** Test seam. */
export function resetBootReport(): void {
  slot().current = {
    startedAt: new Date().toISOString(), completedAt: null, ms: null, status: 'booting',
    budgetMs: BOOT_BUDGET_MS, archive: null, commodities: [], note: 'reset',
  };
}

/** The archive directory the append-only demand evidence goes to. Absence
 *  or unwritability is reported WITH THE PATH — every writer is
 *  best-effort by design, so this is the only place it can be noticed. */
export async function checkArchiveWritable(dir?: string): Promise<ArchiveBootOutcome> {
  const path = dir ?? process.env.SEA_DOG_MISS_LOG_DIR ?? `${process.cwd()}/data-archive`;
  try {
    const fs = await import('node:fs/promises');
    try {
      await fs.access(path);
    } catch {
      return { path, status: 'missing', detail: `archive directory does not exist: ${path} — demand evidence (miss log, export log, MCP session log, Comtrade vintages) would be lost silently, because every writer is best-effort by design` };
    }
    const probe = `${path}/.boot-write-probe`;
    await fs.writeFile(probe, 'probe');
    await fs.unlink(probe);
    return { path, status: 'writable', detail: 'archive directory present and writable' };
  } catch (e) {
    return { path, status: 'not_writable', detail: `archive directory not writable: ${path} — ${e instanceof Error ? e.message : String(e)}; demand evidence would be lost silently` };
  }
}

async function warmCommodity(commodity: string, budgetMs: number): Promise<CommodityBootOutcome> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs); });
    const result = await Promise.race([getEconomyState(commodity), timeout]);
    if (result === 'timeout') {
      return {
        commodity, status: 'timed_out', ms: Date.now() - t0, providers: [],
        issues: [`assembly exceeded the ${budgetMs}ms boot budget — the instance comes up and will assemble lazily on first request rather than blocking startup indefinitely`],
      };
    }
    const issues = result.issues.filter(i => i.severity === 'warning').map(i => i.message);
    return {
      commodity,
      // A source that failed is DEGRADED, not ready: the instance is up
      // and serving, and says which provider is missing.
      status: issues.length > 0 ? 'degraded' : 'ready',
      ms: Date.now() - t0,
      providers: result.providers,
      issues,
      observations: result.state.observations.length,
    };
  } catch (e) {
    // Total assembly failure (every adapter down) — recorded, not fatal.
    return {
      commodity, status: 'failed', ms: Date.now() - t0, providers: [],
      issues: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Warm state for every commodity in the derived scope, bounded by the
 *  boot budget, and record the outcome. Never throws: a boot that cannot
 *  warm still serves (lazily), and says so. */
export async function runBoot(): Promise<BootReport> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const archive = await checkArchiveWritable();
  const scope = guardEvaluationScope();
  const commodities = await Promise.all(scope.map(c => warmCommodity(c, BOOT_BUDGET_MS)));
  const ms = Date.now() - t0;
  const degraded = archive.status !== 'writable' || commodities.some(c => c.status !== 'ready');
  const report: BootReport = {
    startedAt,
    completedAt: new Date().toISOString(),
    ms,
    status: degraded ? 'degraded' : 'ready',
    budgetMs: BOOT_BUDGET_MS,
    archive,
    commodities,
    note: degraded
      ? 'UP AND DEGRADED: the instance serves, and every degradation is named above — a source that did not answer, an assembly past the boot budget, or an archive that cannot take demand evidence. Nothing here is silent and nothing here blocks serving.'
      : 'Ready: every commodity assembled within the boot budget with all providers answering, and the archive directory accepts writes.',
  };
  slot().current = report;
  recordProcessEvent('boot', `boot ${report.status} in ${ms}ms — ` +
    commodities.map(c => `${c.commodity}:${c.status}`).join(' ') + ` archive:${archive.status}`);
  for (const c of commodities) {
    for (const issue of c.issues) recordProcessEvent('adapter_outcome', `${c.commodity}: ${issue}`);
  }
  return report;
}
