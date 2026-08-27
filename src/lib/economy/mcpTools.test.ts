import { describe, it, expect, beforeAll } from 'vitest';
import { MCP_TOOLS, requireKnowledge, refusalCount, machineServeable, type McpContext, type McpToolResult } from './mcpTools';
import { SOURCE_REGISTRY } from './sourceRegistry';
import { recordMcpCall, resetMcpSession, mcpSessionCalls, routeAroundEstimate, type McpCallRecord } from './mcpSession';
import { resetSessionTelemetry, sessionDigest } from './sessionTelemetry';
import { getEconomyState } from './store';
import { stateFingerprint } from './corpusTable';
import { GET as searchGet } from '@/app/api/economy/search/route';
import { GET as entityGet } from '@/app/api/economy/entity/route';
import { GET as tableGet } from '@/app/api/economy/table/route';
import { GET as economyGet } from '@/app/api/economy/route';
import { GET as refusalsGet } from '@/app/api/economy/refusals/route';
import { GET as validateGet } from '@/app/api/economy/validate/route';
import { POST as scenarioPost } from '@/app/api/economy/scenario/route';
import { MACHINE_CLIENT_HEADER } from './machineClient';

/**
 * Final order F-2 (the MCP tool surface) and F-4 (route-around telemetry)
 * — the pre-registered acceptance criteria, each against its planted or
 * standing failing state. The in-process context routes MCP tool calls
 * through the REAL route handlers, carrying the machine-client header
 * exactly as the stdio server does — same logic path, nothing mocked but
 * the transport.
 */

const inProcessCtx: McpContext = {
  async fetchJson(path, init) {
    const req = new Request(`http://localhost${path}`, {
      method: init?.method ?? 'GET',
      headers: { [MACHINE_CLIENT_HEADER]: 'machine', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      body: init?.body,
    });
    const route = path.split('?')[0];
    const handler =
      route === '/api/economy/search' ? searchGet
        : route === '/api/economy/entity' ? entityGet
          : route === '/api/economy/table' ? tableGet
            : route === '/api/economy/refusals' ? refusalsGet
              : route === '/api/economy/validate' ? validateGet
                : route === '/api/economy/scenario' ? scenarioPost
                  : route === '/api/economy' ? economyGet
                    : null;
    if (!handler) throw new Error(`no in-process handler for ${route}`);
    const res = await handler(req);
    return { status: res.status, body: await res.json() };
  },
};

const K = { asOf: '2026-08-27', mode: 'best_known' as const };
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

/** Valid minimal args per tool, for the no-mutation sweep. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  bottlenecks: { ...K },
  search_entities: { ...K, q: 'escondida' },
  search_evidence: { ...K, kind: 'refused' },
  get_entity: { ...K, id: 'ent:mine:escondida' },
  get_observations: { ...K, metric: 'production' },
  concentration: { ...K },
  propagate: { ...K },
  scenario: { ...K, label: 'pin', events: [{ entityId: 'ent:mine:escondida', type: 'strike', title: 'pin strike', start: '2026-08-01', severity: 'high' }] },
  refusals_digest: { ...K },
  corpus_health: { ...K },
  source_registry: { ...K },
  validate_claim: { ...K, claim: 'a claim of 42 units', record_ids: [] },
};

describe('F-2: the MCP tool surface (pre-registered criteria)', () => {
  // ── Criterion 1: a tool call omitting knowledge state fails with the
  //    missing parameter NAMED — on every tool, never defaulted. ──
  it('every tool refuses a call without asOf/mode, naming the missing parameter', async () => {
    expect(MCP_TOOLS.length).toBe(12);
    for (const def of MCP_TOOLS) {
      await expect(def.handler({}, inProcessCtx), def.name).rejects.toThrow(/missing required parameter: asOf/);
      await expect(def.handler({ asOf: '2026-08-27' }, inProcessCtx), def.name).rejects.toThrow(/missing required parameter: mode/);
      expect(def.params.asOf, `${def.name} must declare asOf`).toBeDefined();
      expect(def.params.mode, `${def.name} must declare mode`).toBeDefined();
    }
    expect(() => requireKnowledge({ asOf: 'yesterday', mode: 'best_known' })).toThrow(/asOf/);
  });

  // ── Criterion 2: every quantitative return carries record ids, the five
  //    axes and a rendered claim sentence — at the TOP level; a planted
  //    incomplete record returns nulls FLAGGED rather than omitted. ──
  it('quantitative returns carry record ids, axes and claim sentences at top level', async () => {
    const obs = await tool('get_observations').handler(VALID_ARGS.get_observations, inProcessCtx);
    expect(obs.record_ids.length).toBeGreaterThan(0);
    expect(obs.claims.length).toBeGreaterThan(0);
    const rows = (obs.data as { rows: Array<Record<string, unknown>> }).rows;
    for (const r of rows) {
      for (const axis of ['unit', 'basis', 'value_kind', 'source_id', 'period_start', 'known_at', 'attestation']) {
        expect(axis in r, `row lacks ${axis}`).toBe(true);
      }
      expect(typeof r.claim).toBe('string');
    }

    const conc = await tool('concentration').handler(VALID_ARGS.concentration, inProcessCtx);
    const indices = (conc.data as { indices: Array<Record<string, unknown>> }).indices;
    expect(indices.length).toBeGreaterThan(0);
    expect(conc.record_ids.length).toBeGreaterThan(0);
    for (const idx of indices) {
      const axes = idx.axes as Record<string, unknown>;
      for (const axis of ['basis', 'population', 'universe', 'partition', 'completeness']) {
        expect(axis in axes, `${idx.name} axes lack ${axis}`).toBe(true);
      }
      // The unknown axis is null AND FLAGGED, never omitted or defaulted.
      expect(axes.basis).toBeNull();
      expect(String(axes.basis_flag)).toContain('unstated');
      expect(typeof idx.claim).toBe('string');
    }
  });

  it('a planted incomplete record surfaces its gap in the claim, not as an omission', async () => {
    // Planted at the transport seam: a table row with a missing basis, as
    // the corpus table emits one (null + flagged + UNSTATED in the claim).
    const planted: McpContext = {
      async fetchJson() {
        return {
          status: 200,
          body: {
            header: { withheld: 0, caveats: [] },
            rows: [{
              record_id: 'obs:test-plant:incomplete', subject_id: 'ent:country:cl', subject_label: 'Chile',
              metric: 'production', value: 999, unit: 'kt/y', basis: null, value_kind: 'reported',
              // A SERVEABLE source: the criterion under test is axis
              // completeness, not the D-13 redistribution gate (tested
              // separately below) — a planted row refused for its posture
              // would pass this test for the wrong reason.
              confidence: 'medium', source_id: 'usgs-mcs2025', source_name: 'USGS MCS 2025',
              period_start: '2021-01-01', period_end: '2021-12-31', known_at: '2026-08-27',
              supersedes: null, attestation: null,
              flags: ['basis unspecified — flagged, not defaulted'],
              claim: 'Chile production 2021: 999 kt/y [basis UNSTATED, reported, attestation unknown-attested subject, usgs-mcs2025, knowable from 2026-08-27]',
            }],
          },
        };
      },
    };
    const res = await tool('get_observations').handler(VALID_ARGS.get_observations, planted);
    expect(res.claims[0]).toContain('basis UNSTATED');
    expect(res.record_ids).toContain('obs:test-plant:incomplete');
    const row = (res.data as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row.basis).toBeNull();
    expect((row.flags as string[])[0]).toContain('flagged');
  });

  // ── Criterion 3: a refused query returns SUCCESS with refusalType and
  //    remedy — per refusal mechanism, on the standing corpus. ──
  it('refusals return successfully with type and remedy, across the standing mechanisms', async () => {
    // Today's queue: resolution refusals stand in the real corpus.
    const today = await tool('refusals_digest').handler(VALID_ARGS.refusals_digest, inProcessCtx);
    expect(today.refusals.length).toBeGreaterThan(0);
    // At the 2017 evaluation date the corpus's four standing refusal
    // mechanisms are all live (ledger: resolution, topology, basis,
    // attribution) — each must arrive as null-with-remedy, never an error.
    const at2017 = await tool('refusals_digest').handler({ asOf: '2017-02-15', mode: 'best_known' }, inProcessCtx);
    const types = new Set(at2017.refusals.map(r => r.refusalType));
    for (const mechanism of ['resolution', 'topology', 'basis', 'attribution']) {
      expect(types.has(mechanism), `mechanism ${mechanism} missing from the queue`).toBe(true);
    }
    for (const r of at2017.refusals) {
      expect(r.value).toBeNull();
      expect(r.remedy.length).toBeGreaterThan(0);
    }
    // Null-HHI indices arrive as refusals through concentration too.
    const conc = await tool('concentration').handler(VALID_ARGS.concentration, inProcessCtx);
    for (const r of conc.refusals) {
      expect(r.value).toBeNull();
      expect(r.refusalType.length).toBeGreaterThan(0);
      expect(r.remedy.length).toBeGreaterThan(0);
    }
  });

  // ── Criterion 4: no tool mutates state — verified structurally by
  //    fingerprinting canonical state across a full sweep of every tool. ──
  it('a full sweep of every tool leaves the canonical state fingerprint unchanged', async () => {
    const { state: before } = await getEconomyState('copper');
    const fpBefore = stateFingerprint(before);
    for (const def of MCP_TOOLS) {
      const res = await def.handler(VALID_ARGS[def.name], inProcessCtx);
      expect(res.knowledge_state.mode).toBe('best_known');
    }
    const { state: after } = await getEconomyState('copper');
    expect(stateFingerprint(after)).toBe(fpBefore);
  });

  // ── Criterion 5: a call under as_known_then returns no row whose knownAt
  //    postdates asOf — and the withholding is COUNTED, not silent. ──
  it('as_known_then returns nothing knowable only later, and counts what it withheld', async () => {
    const asOf = '2024-06-30';
    const res = await tool('get_observations').handler({ asOf, mode: 'as_known_then', metric: 'production' }, inProcessCtx);
    const rows = (res.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.known_at) expect(String(r.known_at) <= asOf, `${r.record_id} leaked`).toBe(true);
    }
    const header = (res.data as { header: Record<string, unknown> }).header;
    expect(header.withheld as number).toBeGreaterThan(0);
    expect(res.claims.some(c => c.includes('withheld'))).toBe(true);
  });

  // ── Contract: machine traffic never lands in the frozen S-7 counters. ──
  it('MCP calls do not increment the human session telemetry', async () => {
    resetSessionTelemetry();
    await tool('search_entities').handler(VALID_ARGS.search_entities, inProcessCtx);
    await tool('get_observations').handler(VALID_ARGS.get_observations, inProcessCtx);
    await tool('refusals_digest').handler(VALID_ARGS.refusals_digest, inProcessCtx);
    const digest = sessionDigest();
    expect(digest.queries).toBe(0);
    expect(digest.exportsServed).toBe(0);
    expect(digest.refusalDigestsServed).toBe(0);
  });
});

describe('F-4: route-around telemetry (a proxy that says so)', () => {
  it('a simulated refuse-then-quiet session produces the signal, and the method is stated as a proxy', () => {
    resetMcpSession('session-quiet');
    recordMcpCall('search_entities', 0);
    recordMcpCall('refusals_digest', 5); // hits refusals… and goes quiet
    const quiet = mcpSessionCalls();

    resetMcpSession('session-continued');
    recordMcpCall('refusals_digest', 3); // hits refusals…
    recordMcpCall('get_observations', 0); // …and keeps working
    const continued = mcpSessionCalls();

    resetMcpSession('session-no-refusals');
    recordMcpCall('search_entities', 0);
    const clean = mcpSessionCalls();

    const all: McpCallRecord[] = [...quiet, ...continued, ...clean];
    const est = routeAroundEstimate(all);
    expect(est.sessionsWithRefusals).toBe(2); // the refusal-free session is out of the denominator
    expect(est.quietAfterRefusal).toBe(1);
    expect(est.estimate).toBe(0.5);
    expect(est.method).toContain('PROXY');
    expect(est.method).toContain('not a measurement');
    // A rate over nothing is not a rate.
    expect(routeAroundEstimate(clean).estimate).toBeNull();
    resetMcpSession();
  });

  it('the session log holds tool names and counts only — no parameter value can reach it', async () => {
    resetMcpSession('session-values');
    const def = tool('search_entities');
    await def.handler({ ...K, q: 'jane doe person-shaped text' }, inProcessCtx).catch(() => undefined);
    recordMcpCall(def.name, 0);
    const logged = JSON.stringify(mcpSessionCalls());
    expect(logged).not.toContain('jane');
    expect(logged).toContain('search_entities');
    resetMcpSession();
  });
});

describe('F-2 result envelope', () => {
  let sample: McpToolResult;
  beforeAll(async () => {
    sample = await tool('concentration').handler(VALID_ARGS.concentration, inProcessCtx);
  });
  it('carries knowledge state, claims, record ids, refusals and caveats on every result', () => {
    expect(sample.knowledge_state).toEqual({ as_of: '2026-08-27', mode: 'best_known' });
    expect(Array.isArray(sample.claims)).toBe(true);
    expect(Array.isArray(sample.record_ids)).toBe(true);
    expect(Array.isArray(sample.refusals)).toBe(true);
    expect(refusalCount(sample)).toBe(sample.refusals.length);
  });
  it('tool descriptions are contracts: refusal conduct, knowledge bounds and claim-pasting are stated on every tool', () => {
    for (const def of MCP_TOOLS) {
      expect(def.description).toContain('Do not substitute external knowledge');
      expect(def.description).toContain('bounded by the asOf and mode you supplied');
      expect(def.description).toContain('refusalType and remedy');
    }
  });
});

describe('D-13: the machine-consumer redistribution gate', () => {
  it('refuses a source whose posture is internal_only or unresolved, and says which and why', async () => {
    const planted: McpContext = {
      async fetchJson() {
        const row = (id: string, source: string) => ({
          record_id: id, subject_id: 'ent:country:cl', subject_label: 'Chile', metric: 'production',
          value: 1, unit: 'kt/y', basis: 'metal_content', value_kind: 'reported', confidence: 'high',
          source_id: source, source_name: source, period_start: '2024-01-01', period_end: '2024-12-31',
          known_at: '2025-01-31', supersedes: null, attestation: 'reported', flags: [], claim: `claim for ${source}`,
        });
        return {
          status: 200,
          body: {
            header: { withheld: 0, caveats: [] },
            rows: [
              row('obs:a', 'usgs-mcs2025'),        // public_domain  → served
              row('obs:b', 'westmetall-lme'),      // internal_only  → refused
              row('obs:c', 'some-unknown-source'), // unresolved     → refused
            ],
          },
        };
      },
    };
    const res = await tool('get_observations').handler(VALID_ARGS.get_observations, planted);
    const served = (res.data as { rows: Array<{ record_id: string }> }).rows;
    expect(served.map(r => r.record_id)).toEqual(['obs:a']);

    const gated = res.refusals.filter(r => r.refusalType === 'redistribution-posture');
    expect(gated.length).toBe(2);
    const westmetall = gated.find(r => r.subject.includes('westmetall'))!;
    expect(westmetall.value).toBeNull();
    expect(westmetall.remedy).toContain('INTERNAL research');
    expect(westmetall.remedy).toContain('license the feed');
    const unknown = gated.find(r => r.subject.includes('some-unknown-source'))!;
    expect(unknown.remedy).toContain('unresolved REFUSES rather than defaulting permissive');
    // The withholding is stated in the caveats, not silent.
    expect(res.caveats.some(c => c.includes('withheld from machine clients'))).toBe(true);
  });

  it('unresolved is the DEFAULT, so a new source is refused until someone decides', () => {
    expect(machineServeable('usgs-mcs2025')).toBe(true);
    expect(machineServeable('cftc-mm-net')).toBe(true);
    expect(machineServeable('westmetall-lme')).toBe(false);
    expect(machineServeable('yahoo-hg')).toBe(false);
    expect(machineServeable('a-source-invented-tomorrow')).toBe(false);
    // Every BUILT source has an explicit posture — no built source relies
    // on the unresolved default, which would be a silent refusal.
    for (const s of SOURCE_REGISTRY.filter(x => x.adapter)) {
      expect(s.redistribution, `${s.sourceId} has no recorded posture`).toBeDefined();
      expect(s.redistributionNote!.length, s.sourceId).toBeGreaterThan(30);
    }
  });
});

/**
 * The same defect at the machine surface.
 *
 * `search_evidence(kind=refused, type=basis)` returned an empty array and the
 * sentence "0 refused item(s)". True today — and indistinguishable, to an
 * attached model, from a type that does not exist or a page that was capped.
 * A model with no way to tell those apart writes "the instrument holds no
 * basis refusals", which is a claim about the world made from a rendering
 * artefact. The pivot was that external models attach; this is the part of
 * that pivot that has to be right.
 */
describe('search_evidence states which kind of zero it is', () => {
  it('an empty typed result carries the condition, the census, and a caveat against over-reading it', async () => {
    const r = await tool('search_evidence').handler({ ...K, kind: 'refused', type: 'basis' }, inProcessCtx) as McpToolResult;
    const text = r.claims.join(' ');
    expect(text).toMatch(/0 of 0 refused item\(s\)/);
    expect(text).toMatch(/statement about the corpus, not a failure/);
    expect(text).toMatch(/2017-06-30/);                       // where the type IS live
    expect(text).toMatch(/refused:resolution \(\d+\)/);        // what the kind does hold
    expect(r.caveats.join(' ')).toMatch(/NOT evidence that the mechanism is absent/);
  });

  it('the same query at the date the corpus carries it returns records', async () => {
    const r = await tool('search_evidence').handler(
      { asOf: '2017-06-30', mode: 'best_known', kind: 'refused', type: 'basis' }, inProcessCtx) as McpToolResult;
    expect(refusalCount(r)).toBeGreaterThan(0);
    expect(r.refusals[0].refusalType).toBe('basis');
    expect(r.refusals[0].remedy).toMatch(/corridor grade/);
    // Discriminating against the test above: same tool, same type, one date
    // apart. If both were empty the assertion above would be vacuous.
    expect(r.claims.join(' ')).not.toMatch(/0 of 0/);
  });

  it('an undeclared type is refused at the boundary, never answered with an empty list', async () => {
    await expect(tool('search_evidence').handler({ ...K, kind: 'refused', type: 'bassis' }, inProcessCtx))
      .rejects.toThrow(/not a declared refused type[\s\S]*basis/);
  });

  it('a capped page says so and names the uncapped route', async () => {
    const r = await tool('search_evidence').handler({ ...K, kind: 'refused' }, inProcessCtx) as McpToolResult;
    const text = r.claims.join(' ');
    const m = text.match(/(\d+) of (\d+) refused item\(s\)/);
    expect(m, 'the served/total sentence is the accounting').not.toBeNull();
    const [, served, total] = m!.map(Number);
    expect(total).toBeGreaterThan(served);      // the standing queue is deeper than the page
    expect(text).toMatch(/the page is capped, the queue is not/);
    expect(r.caveats.join(' ')).toMatch(/api\/economy\/refusals returns the full queue uncapped/);
  });
});

/**
 * The runbook's first move, given a machine equivalent.
 *
 * Ranked first on the operator's instruction: "the first move is the one an
 * attaching model will also try first, and a capability present in the UI
 * and absent from the tool list is exactly the asymmetry that makes an
 * external client answer from training data instead." The gap was reported
 * in the previous round and closed here.
 */
describe('bottlenecks — the first question, available to an attached model', () => {
  it('ranks candidates with the basis stated and the cap declared', async () => {
    const r = await tool('bottlenecks').handler({ ...K }, inProcessCtx) as McpToolResult;
    expect(r.claims.length).toBeGreaterThan(0);
    const data = r.data as { candidates: Array<{ score: number | null }>; scored: number; rendered_as_claims: number; empty_because: string | null };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.empty_because).toBeNull();
    // The magnitude carries its basis into a client we do not control.
    expect(r.claims.join(' ')).toMatch(/CONTAINED METAL/);
    // The rendered set is capped and the cap is STATED — a ranked list
    // served short without saying so reads as the whole ranking.
    expect(data.rendered_as_claims).toBeLessThanOrEqual(data.scored);
    if (data.scored > data.rendered_as_claims) {
      expect(r.claims.join(' ')).toMatch(new RegExp(`${data.rendered_as_claims} of ${data.scored} scored candidate`));
    }
    // Ranked, highest first, refusals rendered ahead of scores.
    const scores = data.candidates.filter(c => c.score !== null).map(c => c.score as number);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(r.record_ids.length).toBeGreaterThan(0);
  });

  it('an EMPTY ranking arrives as a claim with its warrant, never as an absence', async () => {
    // The whole point of the round that found this gap: at every historical
    // date the ranking is empty, and an attached model handed a bare empty
    // array writes "there were no bottlenecks in 2017".
    const r = await tool('bottlenecks').handler({ asOf: '2017-06-30', mode: 'best_known' }, inProcessCtx) as McpToolResult;
    const data = r.data as { candidates: unknown[]; empty_because: string | null };
    expect(data.candidates).toEqual([]);
    expect(data.empty_because).toBeTruthy();
    expect(r.claims.join(' '), 'the warrant must reach the claims, not only the payload').toMatch(/AGGREGATES/);
    expect(r.caveats.join(' ')).toMatch(/NOT evidence that the chain has no chokepoints/);
    // And the caveat is absent when the ranking is populated — a caveat on
    // every result is a caveat on none.
    const today = await tool('bottlenecks').handler({ ...K }, inProcessCtx) as McpToolResult;
    expect(today.caveats.join(' ')).not.toMatch(/NOT evidence that the chain has no chokepoints/);
  });

  it('a refused score is a successful return carrying its remedy', async () => {
    // Planted through the REAL pipeline: the refusal path exists in the
    // corpus only when a node's contributing flow refuses conversion, so
    // the assertion is written to hold either way and to be explicit about
    // which case it saw.
    const r = await tool('bottlenecks').handler({ ...K }, inProcessCtx) as McpToolResult;
    const data = r.data as { refused: number };
    expect(refusalCount(r)).toBe(data.refused);
    for (const ref of r.refusals) {
      expect(ref.value).toBeNull();
      expect(ref.refusalType).toBe('component');
      expect(ref.remedy.length).toBeGreaterThan(10);
    }
  });
});

/**
 * The tool count in the operator-facing docs is PINNED, not restated.
 *
 * Class 6, whose first instance moved a miscount from a ledger sentence
 * into two operator work orders: a hand-maintained number describing
 * something the tree already knows. `bottlenecks` made the documents say
 * eleven while the surface served twelve, which is exactly how the last one
 * started.
 */
describe('the documented tool count is derived, not remembered', () => {
  it('every operator-facing doc states the real number', async () => {
    const { readFileSync } = await import('node:fs');
    const n = MCP_TOOLS.length;
    for (const doc of ['docs/OPERATOR_STEPS.md', 'docs/PHYSICAL_ECONOMY.md']) {
      const text = readFileSync(new URL(`../../../${doc}`, import.meta.url), 'utf8');
      const claims = [...text.matchAll(/(\d+|eleven|twelve|ten)\s+read-only tools/gi)].map(m => m[1]);
      const sweeps = [...text.matchAll(/sweep of all (\d+|eleven|twelve|ten)/gi)].map(m => m[1]);
      const all = [...claims, ...sweeps];
      expect(all.length, `${doc} no longer states a tool count — the pin has gone vacuous`).toBeGreaterThan(0);
      for (const c of all) expect(Number(c), `${doc} states "${c}" read-only tools; the surface serves ${n}`).toBe(n);
    }
  });
});
