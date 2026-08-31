import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEconomyState } from './store';
import { buildGraph } from './graph';
import { flowCentrality, bottleneckCandidates, detectAnomalies, concentrationTrajectory } from './analytics';
import type { EconomyState } from './types';

/**
 * EVERY COMPUTED NUMBER CARRIES ITS ATTESTATION (ledger phase 49).
 *
 * The measurement that produced this test: `bottleneckCandidates`,
 * `flowCentrality`, `concentrationTrajectory` and `detectAnomalies` shipped
 * numbers with NO attestation field at all, over a state carrying 23
 * representative-class flow rows — and the bottleneck score drives a map
 * layer, so the honest label was stripped exactly where the number becomes
 * a red dot. Attestation was computed correctly at three call sites and
 * forgotten at four, which is what "a field beside the number rather than
 * inside its identity" costs.
 */
describe('no analytic ships an unattested number', () => {
  let state: EconomyState;
  let graph: ReturnType<typeof buildGraph>;

  beforeAll(async () => {
    state = (await getEconomyState('copper')).state;
    graph = buildGraph(state);
  });

  it('the fixture actually contains representative rows — the test is not vacuous', () => {
    const rep = state.flows.filter(f => f.valueKind === 'representative');
    expect(rep.length).toBeGreaterThan(0);
  });

  it('flowCentrality rows carry weakestInputClass', () => {
    const rows = flowCentrality(state, graph).result;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toHaveProperty('weakestInputClass');
  });

  it('bottleneck candidates standing on curated topology come out representative', () => {
    // The load-bearing assertion. The topology is curated, so the honest
    // answer is that these candidates are representative — and saying so is
    // the point. A bottleneck reported as though it were sourced is the
    // defect this closes.
    const rows = bottleneckCandidates(state, graph).result;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toHaveProperty('weakestInputClass');
    const contaminated = rows.filter(r => r.weakestInputClass === 'representative' || r.weakestInputClass === 'derived');
    expect(contaminated.length).toBeGreaterThan(0);
  });

  it('anomaly signals carry weakestInputClass — an alert says what it rests on', () => {
    const signals = detectAnomalies(state).result;
    for (const s of signals) expect(s).toHaveProperty('weakestInputClass');
  });

  it('trajectory points carry it PER POINT, so a mid-series transition is visible', () => {
    const points = concentrationTrajectory(state, 'production', 'country').result;
    for (const p of points) expect(p).toHaveProperty('weakestInputClass');
  });
});

/**
 * The standing check: a NEW analytic result type cannot ship unattested.
 *
 * The four types above were not caught by any test — they were found by
 * reading. This enumerates the row types that carry a computed number and
 * asserts each declares an attestation field, so the next one added is
 * caught by the suite rather than by someone looking.
 */
describe('the attestation requirement is enumerated, not remembered', () => {
  const SRC = readFileSync(join(process.cwd(), 'src/lib/economy/analytics.ts'), 'utf8');

  /** Result row types that carry a computed quantity. Adding one without
   *  attestation fails here. */
  const NUMBER_BEARING_ROWS = [
    'Concentration', 'TrajectoryPoint', 'CentralityRow',
    'BottleneckCandidate', 'AnomalySignal', 'OperatorConcentration',
  ];

  it('every number-bearing result type declares weakestInputClass', () => {
    const missing: string[] = [];
    for (const name of NUMBER_BEARING_ROWS) {
      const start = SRC.indexOf(`export interface ${name} {`);
      expect(start, `${name} not found — rename it here too`).toBeGreaterThanOrEqual(0);
      const end = SRC.indexOf('\n}', start);
      const body = SRC.slice(start, end);
      if (!body.includes('weakestInputClass')) missing.push(name);
    }
    expect(missing, [
      'These result types carry a computed number and do not declare their attestation.',
      'A number whose evidence class is a field someone remembers to set is a number that',
      'ships unmarked the first time someone forgets — measured, four times, in this file.',
    ].join(' ')).toEqual([]);
  });

  it('the enumeration covers every exported result interface in analytics', () => {
    // Guards the guard: the list above is an enumeration, and an
    // enumeration silently falls behind the file it describes. Any exported
    // interface holding a bare `number` field must be listed or explicitly
    // excluded, so a new row type cannot slip past by not being named.
    const EXCLUDED = new Set([
      'ConcentrationShare',    // a component of Concentration, attested by its parent
      'StructuralClassProfile', // reports classes; is not itself a claim about the world
      'CoverageRow',           // counts of records, not a measured quantity
      'SeriesPoint',           // a raw observation projection, carries observationId
    ]);
    const declared = [...SRC.matchAll(/export interface (\w+) \{/g)].map(m => m[1]);
    const unaccounted = declared.filter(
      n => !NUMBER_BEARING_ROWS.includes(n) && !EXCLUDED.has(n));
    expect(unaccounted, 'new exported result types must be listed or excluded with a reason')
      .toEqual([]);
  });
});
