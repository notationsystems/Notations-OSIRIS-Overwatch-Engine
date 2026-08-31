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


/**
 * THE GUARD'S OWN SCOPE — widened, because it was the defect it exists to catch.
 *
 * The describe above reads exactly one file: `analytics.ts`. Its name says "no
 * analytic ships an unattested number" and its guard-the-guard says it "covers
 * every exported result interface in analytics". Measured across the layer:
 *
 *   59 exported interfaces carry a bare `number` field
 *   10 of them are in analytics.ts        <- all the guard could ever see
 *   49 were invisible to it
 *   40 of those declared no attestation of any kind
 *
 * APPARENT SCOPE: the economy layer's computed numbers.
 * EFFECTIVE SCOPE: one file.
 * Nothing failed. That is the tracked defect class, in the guard written to
 * catch the tracked defect class.
 *
 * The blind spot was already realized, not hypothetical: `notary.ts` and
 * `notary.types.ts` landed number- and verdict-bearing surfaces the guard never
 * looked at.
 *
 * WHAT THIS DOES NOT DO: require `weakestInputClass` everywhere. `RateStats.
 * requests` counts our own HTTP calls; `EconDotStyle.radiusPx` is a pixel;
 * `BootReport.ms` is a stopwatch. Demanding an evidence class from those would
 * be noise, and noise is how a guard gets muted. The requirement is ACCOUNTING:
 * every number-bearing type is attested, or classified as not-a-claim with a
 * stated reason, or recorded as an open debt. A type in none of the three fails.
 */
describe('every number-bearing type in the layer is accounted for', () => {
  const DIR = join(process.cwd(), 'src/lib/economy');

  /** Any of these beside a number means its evidence travels with it. */
  const ATTESTATION_CARRIERS = [
    'weakestInputClass', 'strongestAttestingClass', 'attestation',
    'evidenceClass', 'provenance', 'deviceTrust', 'anchorStrength',
  ];

  /**
   * NOT CLAIMS ABOUT THE WORLD. Each of these numbers describes the terminal
   * itself — its own timings, counters, pixels and structural indices — not
   * something measured outside it. An evidence class on a pixel is a category
   * error, and the reason is stated so the classification can be disputed.
   */
  const NOT_A_WORLD_CLAIM: Record<string, string> = {
    RowAccounting: 'counts of rows this process accepted and rejected — about the fetch, not the world',
    ConcentrationShare: 'a component of Concentration, attested by its parent',
    StructuralClassProfile: 'reports evidence classes; is not itself a claim',
    CoverageRow: 'counts of records held, not a measured quantity',
    ResponseAttribution: 'counts of records that fed one HTTP response',
    CommodityBootOutcome: 'boot stopwatch and record counts',
    BootReport: 'boot stopwatch and budget',
    CorpusHeader: 'row counts and paging limits for a rendered table',
    EvidenceCensus: 'how many results were shown of how many held',
    TraversalStep: 'depth is a position in a walk, not a quantity',
    EconDotStyle: 'radius, opacity and stroke in pixels — a rendering instruction, not a measurement',
    FlowLineStyle: 'line width in pixels — a rendering instruction, not a measurement',
    GraphLinkTreatment: 'link width and particle count for the force graph — rendering, not measurement',
    McpCallRecord: 'counts of our own refusals',
    RouteAroundEstimate: 'counts over our own session log',
    SessionDigest: 'counts over our own session log',
    RateStats: 'our own outbound throttle timings',
    ValidationResult: 'count of claims extracted from a text',
    UnresolvedIdentifier: 'how many times WE failed to resolve a string',
    McsVintageSpec: 'configuration: which report years to read',
    ConditionPredicate: 'configured tolerances — the rule, not a reading',
    Materiality: 'the stake behind one exception; attested by the verdict that combines its evidence, exactly as ConcentrationShare is attested by its parent',
    MaterialityFloor: 'a configured threshold and the measure it is denominated in — the rule that decides what interrupts an operator',
    ExceptionPolicy: 'a materiality floor and a per-load daily cap — the rule that decides what interrupts an operator, not a measurement of anything',
    PostingWindow: 'configured grace thresholds in seconds — policy about when a commitment counts, not a measurement of anything',
    VerdictContext: 'postingOffsetSeconds is when WE published relative to an interval; the nested coverage is classified on its own',
    CustodyPredicate: 'configured tolerance — the rule, not a reading',
    Commitment: 'leafCount is the size of the committed set, checked against the root',
    ProofRef: 'proving cost in ms, recorded to tune the value threshold',
    Entity: 'lat/lng is a location on the entity record, provenance-carried at the observation level',
    // Claimable artifacts, carrier trust, claim economics, transparency log.
    // These are counts and instants about OUR OWN process and OUR OWN records —
    // how long a counterparty took, what we tendered, what we re-covered — and
    // each figure that IS a claim about a carrier carries its own attestation
    // class on the component, which is the whole point of the profile shape.
    Claimable: 'the artifact envelope; validForSeconds and instants are terms of an offer we made',
    ClaimLatency: 'how long a counterparty took to answer US — measured from our own two timestamps',
    SelfContainmentCheck: 'counts of values examined and violations found in our own payload',
    ClaimIncentive: 'a decay schedule and a head start — the terms of an offer, not a measurement',
    ClaimDefault: 'notice seconds on a cancellation we recorded',
    TonuSchedule: 'configured notice bands and amounts — policy, not measurement',
    ResponseProfile: 'counts of offers we made and how they resolved; the verdict that reads it carries the n-floor',
    Money: 'an amount and its currency; attested by the record that produced it',
    CarrierTrustProfile: 'components each carry their own attestation class; loadsRun is a count of our own records',
    FraudSignal: 'evidenceIds count what was observed; the observable is carried, not the inference',
    TrustPolicy: 'configured floors and windows — the rule that decides what blocks a tender',
    ComponentValue: 'the attestation class travels ON the component, which is the shape this type exists for',
    SignedTreeHead: 'treeSize is the size of a log we published',
    InclusionReceipt: 'a leaf index into our own log',
    LogRecord: 'the canonical serialization we hashed; what it asserts is attested by whatever produced it',
    // The seed sweep's own accounting. These count WORLDS AND SEEDS — how often
    // a finding held across a set this process generated — not anything measured
    // outside it. A rate over 16 simulated worlds is a property of the sweep.
    PlantStability: 'counts of worlds a plant recovered in; about the sweep, not the world',
    FindingStability: 'counts of worlds a finding held in, and the band it must fall inside',
    SweepReport: 'counts of worlds built and refused',
    SeasonalityFinding: 'cell sizes and estimator outputs over records already stamped representative by the world that produced them',
    // The simulated world's own records. Every number in them is drawn from a
    // seeded PRNG, so none is a measurement of anything; the world carries ONE
    // attestation at `FreightWorld.meta.attestation`, stamped `representative`,
    // and `isAdmissible` is false for everything derived from any of them. A
    // per-row evidence class would say the same thing 520 times and imply the
    // rows could differ, which is the one thing they cannot do.
    WorldFacility: 'a generated facility; coordinates and reliability are drawn, not observed — the world carries one attestation for all of them',
    WorldCarrier: 'a generated carrier; quote bias and cover limits are drawn, not observed',
    WorldShipper: 'a generated shipper; payment terms are drawn, not observed',
    WorldLane: 'a generated lane; distanceKm is a great-circle figure scaled by a road factor, not a routed measurement',
    WorldLoad: 'a generated load; every rate, dwell and instant is drawn from the seeded PRNG',
    WorldOptions: 'the generator inputs — seed and load count; configuration, not measurement',
    TopologyValidity: 'extrapolationDays measures how far past the topology period WE reached — a property of our corpus coverage that qualifies a claim rather than being one',
  };

  /**
   * OPEN DEBTS. These ARE claims about the world and do not yet carry their
   * attestation. Listing them is not absolution — it is the difference between
   * a known debt and a silent one, and the count below is a RATCHET: it may
   * shrink, never grow.
   */
  const OWED: Record<string, string> = {
    CorridorGrade: 'a grade measured from mirror pairs; should carry the class of the pair',
    FlowEdge: 'ktPerYear after basis conversion; basisUnresolved is carried, the class is not',
    NodeThroughput: 'summed converted tonnage',
    EventImpact: 'disruptedKtPerYear derived from capacities',
    Divergence: 'spread between observers; the observers have classes, the spread does not',
    DivergenceClaim: 'one observer’s value inside a divergence',
    DelayStats: 'measured publication delay per source',
    InformationHorizon: 'achievable lead derived from DelayStats',
    EventHorizon: 'event counts behind a horizon claim',
    CorpusHealthSignal: 'observed staleness of a source, measured against expectation',
    Alert: 'detectionLatencyDays measured against the corpus',
    BacktestAlertRecord: 'lead measured at a historical knowledge state',
    BacktestTruthRow: 'detection and price lead in days',
    AlertScorecard: 'precision and quiet-rate over the backtest',
    BacktestReport: 'precision, recall and median lead',
    Reading: 'a sensor value; the notary carries deviceTrust beside the VERDICT, not the reading',
    Excursion: 'the extremum of a breach — a measured reading; it now carries its UNIT but still not its evidence class, which is the part still owed',
    IntervalCoverage: 'the fraction of an interval covered by committed readings',
  };

  /**
   * Type aliases for `number`, DERIVED from the source rather than listed.
   *
   * Found the hard way: introducing `export type Milli = number` made
   * `Excursion.extremumMilli: Milli` invisible to a scanner matching `: number`
   * literally, so a number-bearing type silently left the accounting the moment
   * it got a more precise name. A guard that only sees one spelling of a number
   * is narrower than it reads — the class this file exists to catch, produced
   * by an ordinary refactor.
   */
  const numericAliases = (): string[] => {
    const found = new Set<string>(['number']);
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(join(DIR, file), 'utf8');
      for (const m of src.matchAll(/export type (\w+)\s*=\s*number\s*;/g)) found.add(m[1]);
    }
    return [...found];
  };

  /**
   * Interfaces that CARRY an attestation, so a field typed as one is attested.
   *
   * The `Milli` lesson one level up. That fix taught the scanner to follow a
   * numeric type ALIAS; this is the same narrowing on the other side of the
   * check — `DownstreamLoad.contribution: Money | null` where `Money` holds the
   * attestation. The body text has no 'attestation' in it, so a type whose
   * evidence class travels inside a named sub-type went unaccounted the moment
   * the sub-type was extracted.
   *
   * One level of indirection is enough for the shapes this layer actually uses,
   * and a deeper chain would still be caught — as unaccounted, which is the
   * safe direction.
   */
  const attestationCarrierTypes = (): string[] => {
    const carriers: string[] = [];
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(join(DIR, file), 'utf8');
      for (const m of src.matchAll(/export interface (\w+)\s*(?:<[^>]*>)?\s*\{/g)) {
        const start = m.index! + m[0].length;
        const end = src.indexOf('\n}', start);
        const body = src.slice(start, end < 0 ? src.length : end);
        if (ATTESTATION_CARRIERS.some(c => body.includes(c))) carriers.push(m[1]);
      }
    }
    return carriers;
  };

  const numberBearing = (): { file: string; name: string; body: string }[] => {
    const out: { file: string; name: string; body: string }[] = [];
    const numeric = new RegExp(
      `^\\s*(?:readonly\\s+)?\\w+\\??:\\s*(?:${numericAliases().join('|')})\\b`, 'm');
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(join(DIR, file), 'utf8');
      // Tolerates generics and any spacing — the original missed `interface X<T> {`.
      for (const m of src.matchAll(/export interface (\w+)\s*(?:<[^>]*>)?\s*\{/g)) {
        const start = m.index! + m[0].length;
        const end = src.indexOf('\n}', start);
        const body = src.slice(start, end < 0 ? src.length : end);
        if (numeric.test(body)) out.push({ file, name: m[1], body });
      }
    }
    return out;
  };

  it('the scan follows an attestation carried inside a named sub-type', () => {
    const carriers = attestationCarrierTypes();
    expect(carriers, 'Money holds the attestation for a contribution').toContain('Money');
    // The type that went unaccounted when the sub-type was extracted.
    const dl = numberBearing().find(t => t.name === 'DownstreamLoad');
    expect(dl, 'DownstreamLoad still carries a bare number').toBeDefined();
    expect(dl!.body).not.toContain('attestation');   // not in its own body...
    expect(dl!.body).toContain('Money');             // ...but reachable through Money
  });

  it('the scan follows numeric type aliases, not just the literal `number`', () => {
    const aliases = numericAliases();
    expect(aliases).toContain('number');
    expect(aliases, 'Milli is declared `export type Milli = number` and must be followed')
      .toContain('Milli');
    // The type that went invisible when the alias was introduced.
    expect(numberBearing().some(t => t.name === 'Excursion')).toBe(true);
  });

  it('the scan sees the whole layer, not one file — the test is not vacuous', () => {
    const found = numberBearing();
    expect(found.length).toBeGreaterThan(40);
    expect(new Set(found.map(f => f.file)).size).toBeGreaterThan(10);
    // The realized blind spot: the notary is in scope now.
    expect(found.some(f => f.file.startsWith('notary'))).toBe(true);
  });

  it('no number-bearing type is unaccounted for', () => {
    const carriers = attestationCarrierTypes();
    const carriesIndirectly = (body: string) =>
      carriers.some(t => new RegExp(`:\\s*(?:readonly\\s+)?${t}\\b`).test(body));
    const unaccounted = numberBearing()
      .filter(({ name, body }) =>
        !ATTESTATION_CARRIERS.some(c => body.includes(c)) &&
        !carriesIndirectly(body) &&
        !(name in NOT_A_WORLD_CLAIM) &&
        !(name in OWED))
      .map(({ file, name }) => `${file}: ${name}`);
    expect(unaccounted, [
      'A new type carrying a computed number must declare its attestation, be classified',
      'as not-a-claim-about-the-world with a reason, or be recorded as an open debt.',
      'Silence is the one option removed.',
    ].join(' ')).toEqual([]);
  });

  it('THE RATCHET: the open-debt list may shrink, never grow', () => {
    // 18 claims about the world that do not yet carry their evidence class.
    // Raising this number requires deleting this comment, which is the point.
    expect(Object.keys(OWED).length).toBeLessThanOrEqual(18);
  });

  it('every classification carries a reason, so it can be argued with', () => {
    for (const [k, v] of [...Object.entries(NOT_A_WORLD_CLAIM), ...Object.entries(OWED)]) {
      expect(v.length, `${k} has no stated reason`).toBeGreaterThan(20);
    }
  });

  it('a type is never in two classifications at once', () => {
    const both = Object.keys(OWED).filter(k => k in NOT_A_WORLD_CLAIM);
    expect(both, 'a claim cannot also be not-a-claim').toEqual([]);
  });
});
