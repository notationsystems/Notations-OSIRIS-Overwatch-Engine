// src/lib/economy/worldSweep.ts
//
// THE RECURSIVE STEP: run the run, across seeds, and ask whether each finding
// is a property of the system or an accident of one world.
//
// `worldRun.ts` reports what one world showed. A single seed is a hypothesis —
// the same status as a single green suite. Every defect this programme has
// found in its own checking machinery had the same shape: a check that was
// correct about what it examined and silent about the population it did not.
// A recovery measured once is exactly that.
//
// So this sweeps N worlds and reports, per plant, a RATE rather than a verdict.
// Three outcomes matter and they are not the same fact:
//
//   ALWAYS      recovered in every world      — a property of the detector
//   SOMETIMES   recovered in some             — a detector that depends on luck,
//                                               reported as a success by any run
//                                               that happened to draw a good seed
//   NEVER       recovered in none             — a detector that does not work,
//                                               which a lucky single run can hide
//                                               only if it is SOMETIMES
//
// `SOMETIMES` is the interesting one and the reason this file exists. It is
// invisible to any number of single-world runs and it is what "we ran it and it
// worked" means when the thing does not, in general, work.

import { makeFreightWorld } from './freightWorld';
import { runWorld, type WorldRunReport, type PlantOutcome } from './worldRun';

/** The seeds the standing sweep uses. Fixed, so the sweep is itself reproducible. */
export const SWEEP_SEEDS: readonly number[] = [
  20260831, 1, 2, 3, 7, 8, 9, 10, 42, 99, 555, 777, 1234, 31337, 20250101, 20260101,
];

export type Stability = 'always' | 'sometimes' | 'never';

export interface PlantStability {
  plant: string;
  recovered: number;
  worlds: number;
  rate: number;
  stability: Stability;
  /** The seeds where it did NOT recover, so a failure is reproducible. */
  failingSeeds: number[];
  /** One example note from a failing world, so the reason is legible. */
  exampleFailure: string | null;
}

export interface FindingStability {
  finding: string;
  kind: FindingKind;
  held: number;
  worlds: number;
  rate: number;
  stability: Stability;
  /** For `rate` findings: whether the observed rate fell inside its declared band. */
  inBand: boolean | null;
  band: [number, number] | null;
  failingSeeds: number[];
  note: string;
}

export interface SweepReport {
  seeds: readonly number[];
  worlds: number;
  now: string;
  /** Worlds the generator REFUSED to build, with the reason. Never silently skipped. */
  refused: Array<{ seed: number; reason: string }>;
  plants: PlantStability[];
  findings: FindingStability[];
  /** Plants that are not ALWAYS. The list a reader should act on. */
  unstable: string[];
}

const stabilityOf = (hit: number, n: number): Stability =>
  hit === n ? 'always' : hit === 0 ? 'never' : 'sometimes';

/**
 * Properties the single-world run asserts. Each is re-evaluated per world, so a
 * claim that held once is separated from a claim that holds.
 *
 * These are deliberately the HEADLINE claims — the ones that would be quoted.
 * A finding nobody quotes does not need a stability measurement; a finding that
 * appears in a report does.
 */
/**
 * TWO KINDS OF FINDING, AND DEMANDING `ALWAYS` OF THE SECOND IS A CATEGORY ERROR.
 *
 * `invariant` — a property of the SYSTEM. Zero illegal transitions; three
 *   verdicts reachable; nothing claims admissibility. A SOMETIMES here is a
 *   defect, full stop.
 *
 * `rate` — a claim about how RELIABLE a query is. "The naive calendar-quarter
 *   mean misses this effect" cannot be an invariant, because whether a bad
 *   estimator happens to land on the right answer depends on the draw. Requiring
 *   it to be ALWAYS would be requiring an unreliable query to be reliably wrong.
 *
 * The distinction is NOT an excuse to reclassify a failing invariant. A rate
 * carries a BAND it must fall inside, and the band is what keeps it honest: if
 * the naive query started succeeding in every world the fixture would no longer
 * discriminate a sound estimator from an unsound one, and if it started failing
 * in every world that would be a fixture tuned until it agreed with me. Both
 * ends fail the sweep.
 */
export type FindingKind = 'invariant' | 'rate';

export const SWEPT_FINDINGS: ReadonlyArray<{
  name: string;
  note: string;
  kind?: FindingKind;
  /** For `rate` findings: [lo, hi] inclusive bounds the observed rate must fall inside. */
  band?: [number, number];
  holds: (r: WorldRunReport) => boolean;
}> = [
  {
    name: 'lifecycle: zero illegal transitions',
    note: 'the generator emits only hops TRANSITIONS accepts',
    holds: r => r.lifecycle.illegal === 0 && r.lifecycle.transitions > 1000,
  },
  {
    name: 'notary reaches all three verdicts',
    note: 'held, breached and unproven each at least once — a two-valued notary is a broken one',
    holds: r => r.notary.held > 0 && r.notary.breached > 0 && r.notary.unproven > 0,
  },
  {
    name: 'the two unproven reasons are distinct',
    note: 'the gap plant and the retroactive plant must be separable, or one detector credits both',
    holds: r => Object.keys(r.notary.unprovenReasons).length >= 2,
  },
  {
    name: 'authorization reaches all three states',
    note: 'authorized, refused and undetermined each at least once',
    holds: r => r.authorization.authorized > 0 && r.authorization.refused > 0 && r.authorization.undetermined > 0,
  },
  {
    name: 'the cover check reaches refuse AND undetermined',
    note: 'a check whose effective range is one value has not been exercised',
    holds: r => (r.authorization.refusalsByCheck.value_within_cargo_cover ?? 0) > 0 &&
      (r.authorization.undeterminedByCheck.value_within_cargo_cover ?? 0) > 0,
  },
  {
    name: 'latency excludes inferred instants',
    note: 'a geofence crossing is our reconstruction, not a report',
    holds: r => r.lifecycle.latencyInferredExcluded > 0 &&
      r.lifecycle.latencyObserved + r.lifecycle.latencyInferredExcluded === r.lifecycle.transitions,
  },
  {
    name: 'the plant-basis query recovers the seasonal effect',
    note: 'an INVARIANT: the signal is planted, so a sound estimator must find it in every world',
    kind: 'invariant',
    holds: r => r.seasonality.onPlantBasis.recovers,
  },
  {
    name: 'the naive calendar-quarter mean MISSES the seasonal effect',
    kind: 'rate',
    // Measured at 9/16. The band is wide on purpose: the number is not the
    // finding, the fact that it is neither 0 nor 1 is.
    band: [0.2, 0.85],
    note:
      'a RATE, not an invariant. The plant is present in every world and a sound estimator ' +
      'finds it in every world; whether the NAIVE one also stumbles onto it depends on the ' +
      'draw. That is the finding, and it is stronger than "the naive query fails": a query ' +
      'whose correctness depends on the draw gives you no way to tell, from its own output, ' +
      'which kind of world you are in. Both ends of the band are failures — all-miss would ' +
      'be a fixture tuned until it agreed with me, all-hit would be a fixture that cannot ' +
      'separate a sound estimator from an unsound one.',
    holds: r => !r.seasonality.naive.recovers,
  },
  {
    name: 'nothing claims admissibility',
    note: 'representative in, inadmissible out, at every derivation',
    holds: r => r.admissible === false && r.attestation.restsOnRepresentative === true,
  },
];

export function sweepWorlds(now: string, seeds: readonly number[] = SWEEP_SEEDS): SweepReport {
  const refused: SweepReport['refused'] = [];
  const reports: Array<{ seed: number; report: WorldRunReport }> = [];

  for (const seed of seeds) {
    try {
      const world = makeFreightWorld({ seed, generatedAt: now });
      reports.push({ seed, report: runWorld(world, now) });
    } catch (e) {
      // ACCOUNT FOR EVERY DROP. A world that refused to build is not a world
      // that passed, and a sweep that silently skips it reports a rate over a
      // population it did not measure.
      refused.push({ seed, reason: (e as Error).message.split('\n')[0] });
    }
  }

  const n = reports.length;
  const plantIds = n ? reports[0].report.plants.map(p => p.plant) : [];

  const plants: PlantStability[] = plantIds.map(id => {
    const outcomes: Array<{ seed: number; o: PlantOutcome }> = reports.map(
      ({ seed, report }) => ({ seed, o: report.plants.find(p => p.plant === id)! }));
    const good = outcomes.filter(x => x.o.status === 'recovered');
    const bad = outcomes.filter(x => x.o.status !== 'recovered');
    return {
      plant: id,
      recovered: good.length, worlds: n,
      rate: n ? good.length / n : 0,
      stability: stabilityOf(good.length, n),
      failingSeeds: bad.map(x => x.seed),
      exampleFailure: bad.length ? `seed ${bad[0].seed}: ${bad[0].o.note}` : null,
    };
  });

  const findings: FindingStability[] = SWEPT_FINDINGS.map(f => {
    const bad = reports.filter(({ report }) => !f.holds(report));
    const held = n - bad.length;
    const rate = n ? held / n : 0;
    const kind: FindingKind = f.kind ?? 'invariant';
    const band = f.band ?? null;
    return {
      finding: f.name, kind, note: f.note,
      held, worlds: n, rate,
      stability: stabilityOf(held, n),
      inBand: band ? rate >= band[0] && rate <= band[1] : null,
      band,
      failingSeeds: bad.map(x => x.seed),
    };
  });

  return {
    seeds, worlds: n, now, refused, plants, findings,
    unstable: [
      ...plants.filter(p => p.stability !== 'always').map(p => p.plant),
      // An invariant must be ALWAYS; a rate must be IN BAND. Reclassifying a
      // failing invariant as a rate would mute it, so the kind is declared with
      // the finding rather than inferred from how it came out.
      ...findings.filter(f => f.kind === 'invariant' ? f.stability !== 'always' : f.inBand === false)
        .map(f => f.finding),
    ],
  };
}

const RULE = '─'.repeat(78);

export function renderSweep(s: SweepReport): string {
  const L: string[] = [];
  L.push(RULE, 'PAYLOAD — SEED SWEEP: is each finding a property, or one world?', RULE);
  L.push(`${s.worlds} worlds built of ${s.seeds.length} seeds requested, evaluated at ${s.now}`);
  if (s.refused.length) {
    L.push(`${s.refused.length} REFUSED to build — counted, not skipped:`);
    for (const r of s.refused) L.push(`  seed ${r.seed}: ${r.reason}`);
  } else {
    L.push('0 refused to build.');
  }

  L.push('', RULE, 'PLANT RECOVERY ACROSS WORLDS', RULE);
  for (const p of s.plants) {
    const mark = p.stability === 'always' ? 'ALWAYS   ' : p.stability === 'never' ? 'NEVER    ' : 'SOMETIMES';
    L.push(`  ${mark} ${p.plant}  ${p.recovered}/${p.worlds}`);
    if (p.failingSeeds.length) {
      L.push(`            failing seeds: ${p.failingSeeds.join(', ')}`);
      if (p.exampleFailure) L.push(`            ${p.exampleFailure}`);
    }
  }

  L.push('', RULE, 'HEADLINE FINDINGS ACROSS WORLDS', RULE);
  for (const f of s.findings) {
    const mark = f.kind === 'rate'
      ? (f.inBand ? 'RATE ok  ' : 'RATE OUT ')
      : f.stability === 'always' ? 'ALWAYS   ' : f.stability === 'never' ? 'NEVER    ' : 'SOMETIMES';
    const band = f.band ? `  band [${f.band[0]}, ${f.band[1]}]` : '';
    L.push(`  ${mark} ${f.finding}  ${f.held}/${f.worlds} = ${(f.rate * 100).toFixed(0)}%${band}`);
    for (const line of wrap(f.note, 70)) L.push(`            ${line}`);
    if (f.kind === 'invariant' && f.failingSeeds.length) {
      L.push(`            failing seeds: ${f.failingSeeds.join(', ')}`);
    }
  }

  L.push('', RULE, 'WHAT TO ACT ON', RULE);
  if (!s.unstable.length) {
    L.push('  Nothing is SOMETIMES. Every plant and every headline finding held in every');
    L.push('  world built. That is the only reading under which a single-world report is');
    L.push('  safe to quote.');
  } else {
    L.push(`  ${s.unstable.length} item(s) are not ALWAYS:`);
    for (const u of s.unstable) L.push(`    - ${u}`);
    L.push('');
    L.push('  A SOMETIMES is invisible to any number of single-world runs. It is what');
    L.push('  "we ran it and it worked" means when the thing does not, in general, work.');
  }
  L.push('');
  return L.join('\n');
}

function wrap(str: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of str.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > w) { out.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
