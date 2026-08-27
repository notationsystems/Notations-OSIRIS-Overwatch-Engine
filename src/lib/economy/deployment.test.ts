import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET as guardsGet } from '@/app/api/economy/guards/route';
import { GET as economyGet } from '@/app/api/economy/route';
import { GET as tableGet } from '@/app/api/economy/table/route';
import { GET as healthGet } from '@/app/api/health/route';
import { getEconomyState } from './store';
import { attribution, buildVersion } from './attribution';
import { buildCorpusTable, stateFingerprint } from './corpusTable';
import { checkArchiveWritable, runBoot, bootReport } from './boot';
import { DEFERRED_DECISIONS } from './ledgerGuards';
import { withHostRateLimit, hostIntervalMs, rateStats, resetRateStats } from './outboundRate';
import { recordRequest, recordProcessEvent, processReport, resetProcessReport } from './observability';
import { processSingleton, resetProcessSingleton } from './processSingleton';

/**
 * Deployment hardening order, Tier 1 — the criteria that must hold
 * before a researcher is handed a URL.
 */

const req = (path: string) => new Request(`http://localhost${path}`);

describe('D-1: guards evaluate against DEPLOYED state, and the two verdicts are never conflated', () => {
  it('the endpoint reports a runtime verdict scoped to the state it is serving', async () => {
    const res = await guardsGet(req('/api/economy/guards'));
    expect(res.status).toBe(200); // a firing guard is a CONDITION, not an error
    const d = await res.json();
    expect(d.verdict_of).toBe('runtime');
    expect(d.guardCount).toBe(DEFERRED_DECISIONS.length);
    // EIGHT, not the seven every document said. Phase 34 added
    // typed-refusal-emission-unbuilt and its ledger entry called it "the
    // seventh deferred decision"; the register already held seven, so it
    // was the eighth. The miscount propagated from that ledger line into
    // the docs and then into two operator orders. Pinned here against the
    // register so the literal can never drift from the tree again — the
    // same reason guardEvaluationScope() is derived rather than listed.
    expect(d.guardCount).toBe(8);
    // Every partition in the derived scope is actually evaluated — the
    // scoped-check blindness this project named in round 26.
    expect(d.scope.length).toBeGreaterThan(1);
    expect(d.evaluatedCells.length).toBe(d.scope.length);
    for (const cell of d.evaluatedCells) {
      expect(cell.predicates.length).toBe(DEFERRED_DECISIONS.length);
    }
    // It reports the state it evaluated against, per commodity.
    for (const s of d.states) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(s.observations).toBeGreaterThan(0);
    }
    // And it never claims to know CI's verdict.
    expect(d.note).toContain('separate fact');
    expect(d).not.toHaveProperty('ci');
  });

  it('a planted breach in the evaluated state is VISIBLE at the endpoint', async () => {
    // Vacuity: the endpoint reporting "all_holding" only means something
    // because a lapsed condition would show. Evaluated at a date beyond
    // the extrapolation bound, the topology guard's condition no longer
    // holds — the same mechanism a deployed instance would hit as its
    // snapshot ages, which is exactly why runtime evaluation exists.
    const far = await guardsGet(req('/api/economy/guards?now=2032-01-01'));
    const d = await far.json();
    expect(far.status).toBe(200);
    expect(d.status).toBe('condition_lapsed');
    expect(d.failures.length).toBeGreaterThan(0);
    for (const f of d.failures) {
      expect(f.commodity).toBeTruthy();   // scope travels with every failure
      expect(f.ledgerRef).toBeTruthy();   // and the ledger entry it defers
      expect(f.condition.length).toBeGreaterThan(10);
    }
    // Today, by contrast, the guards hold — so the check above is not
    // vacuously true of every date.
    const today = await (await guardsGet(req('/api/economy/guards'))).json();
    expect(today.status).toBe('all_holding');
  });

  it('the health surface carries the runtime guard summary and points at the detail', async () => {
    const d = await (await healthGet()).json();
    expect(d.seaDogTerminal.guards.verdict_of).toBe('runtime');
    expect(d.seaDogTerminal.guards.detail).toBe('/api/economy/guards');
    expect(d.seaDogTerminal.guards.note).toContain('CI');
  });
});

describe('D-2: boot behaviour is bounded, and its degradations are named', () => {
  it('an unwritable archive path is reported WITH THE PATH, not discovered later', async () => {
    const missing = await checkArchiveWritable('/nonexistent/sea-dog-archive');
    expect(missing.status).toBe('missing');
    expect(missing.path).toBe('/nonexistent/sea-dog-archive');
    expect(missing.detail).toContain('/nonexistent/sea-dog-archive');
    expect(missing.detail).toContain('best-effort'); // says WHY it would be silent

    // Discriminating case: a writable directory reports writable, so the
    // check is not simply always-alarming.
    const dir = mkdtempSync(join(tmpdir(), 'sea-dog-archive-'));
    try {
      const ok = await checkArchiveWritable(dir);
      expect(ok.status).toBe('writable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real boot completes within its budget and reports per-commodity outcomes', async () => {
    const report = await runBoot();
    expect(report.completedAt).not.toBeNull();
    expect(report.ms).toBeLessThanOrEqual(report.budgetMs * 2);
    expect(report.commodities.length).toBeGreaterThan(1);
    for (const c of report.commodities) {
      expect(['ready', 'degraded', 'failed', 'timed_out']).toContain(c.status);
      // A degraded commodity NAMES what degraded it — never a bare flag.
      if (c.status !== 'ready') expect(c.issues.length).toBeGreaterThan(0);
      if (c.status === 'ready') expect(c.providers.length).toBeGreaterThan(0);
    }
    expect(bootReport().status).toBe(report.status);
    expect(report.note.length).toBeGreaterThan(20);
  });
});

describe('D-3: every response is attributable to a build, a state and a knowledge mode', () => {
  it('the analytics, map and state views all carry version, fingerprint and knowledge', async () => {
    for (const view of ['analytics', 'map', 'state']) {
      const d = await (await economyGet(req(`/api/economy?commodity=copper&view=${view}`))).json();
      expect(d.attribution, view).toBeDefined();
      expect(d.attribution.version.release, view).toBeTruthy();
      expect(d.attribution.state.fingerprint, view).toMatch(/^[0-9a-f]{16}$/);
      expect(d.attribution.knowledge.mode, view).toBe('best_known');
      expect(d.attribution.degradation.status, view).toBeDefined();
    }
    const akt = await (await economyGet(req('/api/economy?commodity=copper&view=analytics&asOf=2024-06-30&knowledge=as_known_then'))).json();
    expect(akt.attribution.knowledge).toEqual({ as_of: '2024-06-30', mode: 'as_known_then' });
  });

  it('a mutated state produces a different fingerprint on the same request path', async () => {
    const { state } = await getEconomyState('copper');
    const live = await (await economyGet(req('/api/economy?commodity=copper&view=analytics'))).json();
    expect(live.attribution.state.fingerprint).toBe(stateFingerprint(state));
    const mutated = structuredClone(state);
    mutated.observations[0].value += 1;
    expect(stateFingerprint(mutated)).not.toBe(live.attribution.state.fingerprint);
  });

  it('build identity is never fabricated: an unstamped build says so', () => {
    const before = process.env.SEA_DOG_BUILD_SHA;
    delete process.env.SEA_DOG_BUILD_SHA;
    try {
      const v = buildVersion();
      expect(v.commit).toBeNull();
      expect(v.commit_source).toBe('unstamped-build');
      process.env.SEA_DOG_BUILD_SHA = 'abc1234';
      expect(buildVersion()).toMatchObject({ commit: 'abc1234', commit_source: 'env:SEA_DOG_BUILD_SHA' });
    } finally {
      if (before === undefined) delete process.env.SEA_DOG_BUILD_SHA;
      else process.env.SEA_DOG_BUILD_SHA = before;
    }
  });
});

describe('D-4: a degraded request NAMES its degradation', () => {
  it('adapter failures reach the response instead of dying in assembly issues', async () => {
    const { state } = await getEconomyState('copper');
    // Planted: the assembly issue shape a failed adapter produces.
    const degraded = attribution(state, {}, {
      providers: ['usgs-mcs'],
      issues: [{ severity: 'warning', message: 'Adapter comtrade failed: fetch timeout' }],
    });
    expect(degraded.degradation.status).toBe('degraded');
    expect(degraded.degradation.issues[0]).toContain('comtrade');
    expect(degraded.degradation.providers).toEqual(['usgs-mcs']);
    // Discriminating: a clean assembly reads nominal, so "degraded" is not
    // the only value this field can take.
    expect(attribution(state, {}, { providers: ['a', 'b'], issues: [] }).degradation.status).toBe('nominal');
    // And the live path is nominal today with providers listed.
    const live = await (await economyGet(req('/api/economy?commodity=copper&view=analytics'))).json();
    expect(live.attribution.degradation.providers.length).toBeGreaterThan(0);
  });
});

describe('D-5: bounded returns, with the truncation stated', () => {
  it('a query past the limit returns the limit, the total, and the truncation count', async () => {
    const d = await (await tableGet(req('/api/economy/table?commodity=copper&metric=production&limit=3'))).json();
    expect(d.rows.length).toBe(3);
    expect(d.header.limit).toBe(3);
    expect(d.header.total_rows).toBeGreaterThan(3);
    expect(d.header.truncated).toBe(d.header.total_rows - 3);
    // Row accounting conservation still holds — the standing property.
    expect(d.header.row_count + d.header.truncated).toBe(d.header.total_rows);
    // The truncation is STATED, not merely computable.
    expect(d.header.caveats.some((c: string) => c.includes('TRUNCATED'))).toBe(true);
  });

  it('an unbounded query must be asked for explicitly, and says it truncated nothing', async () => {
    const d = await (await tableGet(req('/api/economy/table?commodity=copper&metric=production&limit=0'))).json();
    expect(d.header.limit).toBeNull();
    expect(d.header.truncated).toBe(0);
    expect(d.header.row_count).toBe(d.header.total_rows);
    expect(d.header.caveats.some((c: string) => c.includes('TRUNCATED'))).toBe(false);
    const bad = await tableGet(req('/api/economy/table?commodity=copper&limit=-1'));
    expect(bad.status).toBe(400);
  });

  it('the default bound applies without being asked for, and the markdown states it', async () => {
    const table = buildCorpusTable((await getEconomyState('copper')).state, {}, { limit: 2 });
    expect(table.rows.length).toBe(2);
    expect(table.header.truncated).toBeGreaterThan(0);
    const res = await tableGet(req('/api/economy/table?commodity=copper&format=md&limit=2'));
    const md = await res.text();
    expect(md).toContain('TRUNCATED');
  });
});

describe('D-10: outbound rate discipline holds in a LONG-RUNNING process', () => {
  it('concurrent callers against one host cannot compound — they serialise and space', async () => {
    resetRateStats();
    const starts: number[] = [];
    const call = () => withHostRateLimit('https://comtradeapi.un.org/x', async () => {
      starts.push(Date.now());
      return 'ok';
    });
    // Three callers fired AT THE SAME INSTANT — the shape boot warming
    // creates by assembling every commodity with Promise.all. Before this
    // module they would have hit the host together, each politely spacing
    // only its own in-loop requests.
    const t0 = Date.now();
    await Promise.all([call(), call(), call()]);
    expect(starts.length).toBe(3);
    starts.sort((a, b) => a - b);
    const interval = hostIntervalMs('comtradeapi.un.org');
    expect(interval).toBe(1100);
    // Each start is at least one interval after the previous one.
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(interval - 50);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(interval - 50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2 * interval - 100);

    const stats = rateStats().find(s => s.host === 'comtradeapi.un.org')!;
    expect(stats.requests).toBe(3);
    expect(stats.maxWaitedMs).toBeGreaterThanOrEqual(interval - 50);
    resetRateStats();
  }, 20_000);

  it('different hosts do not block each other, and each carries its own stated interval', async () => {
    resetRateStats();
    // SEC's cap is 10 req/s → 120ms spacing, under the limit; Westmetall
    // is a courtesy scrape and is spaced slower than required.
    expect(hostIntervalMs('data.sec.gov')).toBe(120);
    expect(hostIntervalMs('www.westmetall.com')).toBe(2000);
    expect(hostIntervalMs('an.unlisted.host')).toBe(250); // unlisted still queues
    const t0 = Date.now();
    await Promise.all([
      withHostRateLimit('https://data.sec.gov/a', async () => 'a'),
      withHostRateLimit('https://comtradeapi.un.org/b', async () => 'b'),
    ]);
    // Two different hosts in parallel: no cross-host blocking.
    expect(Date.now() - t0).toBeLessThan(600);
    resetRateStats();
  }, 20_000);

  it('a failing request still releases the host lock', async () => {
    resetRateStats();
    await expect(withHostRateLimit('https://data.sec.gov/x', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    // The next caller is not deadlocked behind the failure.
    await expect(withHostRateLimit('https://data.sec.gov/y', async () => 'ok')).resolves.toBe('ok');
    resetRateStats();
  }, 20_000);
});

describe('D-7: process observability', () => {
  it('counts requests and errors by route, and bounds its event ring', () => {
    resetProcessReport();
    recordRequest('/api/economy', true);
    recordRequest('/api/economy', false);
    recordRequest('/api/economy/table', true);
    const r = processReport();
    expect(r.counters.requests).toBe(3);
    expect(r.counters.errors).toBe(1);
    expect(r.counters.errorRate).toBeCloseTo(0.3333, 3);
    expect(r.counters.byRoute['/api/economy']).toEqual({ requests: 2, errors: 1 });
    // The ring is bounded — an unbounded list in a month-long process is
    // a memory leak wearing an observability badge.
    for (let i = 0; i < 300; i++) recordProcessEvent('request_error', `e${i}`);
    const after = processReport();
    expect(after.recentEvents.length).toBeLessThanOrEqual(25);
    expect(after.recentEvents[after.recentEvents.length - 1].detail).toBe('e299');
    // And it says what it does NOT survive.
    expect(after.note).toContain('do NOT survive a restart');
    resetProcessReport();
  });

  it('an error rate over zero requests is null, not zero', () => {
    resetProcessReport();
    expect(processReport().counters.errorRate).toBeNull();
    resetProcessReport();
  });
});

describe('process singletons survive Next module duplication (running-configuration finding)', () => {
  it('state anchored on globalThis is shared, and a plain module-level copy would not have been', () => {
    // The defect, reproduced: Next runs instrumentation in a DIFFERENT
    // module context from the routes, so two copies of a module hold two
    // copies of its state. Measured live: the log said "boot ready in
    // 2805ms" while /api/health answered "booting" indefinitely, and the
    // rate limiter would silently have kept two independent per-host
    // chains — the compounding it exists to prevent.
    const A = processSingleton('dup-test', () => ({ n: 0 }));
    const B = processSingleton('dup-test', () => ({ n: 999 })); // a "second module instance"
    B.n += 1;
    expect(A).toBe(B);          // same object, not a copy
    expect(A.n).toBe(1);        // the initialiser did NOT run twice
    resetProcessSingleton('dup-test');
    expect(processSingleton('dup-test', () => ({ n: 42 })).n).toBe(42);
  });

  it('the boot report and the rate limiter both read through the shared registry', async () => {
    // Whatever context writes, every context reads.
    const report = await runBoot();
    expect(bootReport().completedAt).toBe(report.completedAt);
    expect(bootReport().status).toBe(report.status);
    resetRateStats();
    await withHostRateLimit('https://data.sec.gov/z', async () => 'ok');
    expect(rateStats().find(s => s.host === 'data.sec.gov')?.requests).toBe(1);
    resetRateStats();
  }, 200_000);
});
