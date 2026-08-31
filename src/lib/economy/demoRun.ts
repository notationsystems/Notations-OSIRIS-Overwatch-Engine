// src/lib/economy/demoRun.ts
//
// THE END-TO-END RUN. Every layer, over the simulated backend and the load book,
// producing one report a person can read.
//
//   spatial   -> a truck-legal route, and a matrix that refuses on the same profile
//   lifecycle -> where each load is, including the one that has gone silent
//   exception -> what fires, what is suppressed, and why
//   impact    -> what a delay costs downstream, and what cannot be assessed
//   notary    -> whether the reefer envelope held, and whether custody is proven
//
// It holds no clock: `now` is threaded from the caller, so two runs over the same
// inputs are byte-identical and the report can be diffed.

import { createSimulatedEngine, createSimulatedOptimizer } from '../spatial/simulated';
import { SpatialRegistry, shortfallOf, type Arbitration } from '../spatial/registry';
import type { RestrictionKind, SpatialResult, Route, Matrix } from '../spatial/engine.types';
import {
  DEMO_NOW, LOADS, PLACES, HANDOFFS, placeById, loadById,
  reeferReadings, reeferReadingsClean, REEFER_ENVELOPE, REEFER_FROM, REEFER_TO,
  EXCEPTION_EVIDENCE, TALL_REEFER, STANDARD_DRYVAN, type DemoLoad,
} from './freightFixture';
import { readState, evaluateException, downstreamImpact, MIXED_CURRENCY } from './lifecycle';
import { DEFAULT_EXCEPTION_POLICY, type StateReading, type ExceptionVerdict,
  type DownstreamImpact, type DownstreamLoad } from './lifecycle.types';
import { merkleRoot, notarizeCondition, notarizeCustody } from './notary';
import { DEFAULT_POSTING_WINDOW, type Commitment, type NotaryVerdict } from './notary.types';

export interface DemoReport {
  now: string;
  backend: string;
  /** Stated at the top of the report and repeated on every claim. */
  banner: string;
  spatial: {
    routeStrict: { load: string; status: string; sentence: string };
    routeControl: { load: string; status: string; sentence: string };
    matrixSameProfile: { status: string; sentence: string };
    arbitration: { route: string[]; matrix: string[] };
  };
  lifecycle: Array<{ loadId: string; reading: string; detail: string }>;
  exceptions: Array<{ loadId: string; status: string; detail: string }>;
  impact: { total: string; assessed: string[]; unassessed: string[]; refusedTotal: string | null };
  notary: { condition: string; conditionClean: string; custody: string };
  refusals: string[];
}

const line = (r: SpatialResult<Route> | SpatialResult<Matrix>): string =>
  r.status === 'ok' ? r.claim.renderedClaim
    : r.status === 'degraded' ? `DEGRADED — ${r.warning}`
      : `REFUSED (${r.reason}) — ${r.remedy}`;

function commitmentFor(readings: ReturnType<typeof reeferReadings>, postedAt: string): Commitment {
  const { root, leafCount } = merkleRoot(readings);
  return {
    commitmentId: 'C-reefer-1', root, leafCount,
    subject: { kind: 'load_condition', loadId: 'L-1', channel: 'temperature_c' },
    coversFrom: REEFER_FROM, coversTo: REEFER_TO, postedAt,
    anchor: { kind: 'internal', logId: 'payload-demo-log' },
    postedBy: 'ops:demo', authority: 'payload',
  };
}

export async function runDemo(now: string = DEMO_NOW): Promise<DemoReport> {
  const refusals: string[] = [];
  const engine = createSimulatedEngine({ now });
  const optimizer = createSimulatedOptimizer({ now });
  const registry = new SpatialRegistry().register(engine).registerOptimizer(optimizer);

  /* ── spatial ─────────────────────────────────────────────────────────── */

  const requireHeight: RestrictionKind[] = ['height'];
  const l1 = loadById('L-1');
  const from = placeById(l1.originId).at, to = placeById(l1.destinationId).at;

  // The tall reefer: the modelled clearance binds, so the route is slower.
  const routeStrict = await registry.route(
    { from, to, profile: TALL_REEFER, require: requireHeight }, { strict: true });
  // The standard van on the same lane: the control.
  const routeControl = await registry.route(
    { from, to, profile: STANDARD_DRYVAN, require: requireHeight }, { strict: true });

  // The SAME profile and the SAME restriction, on matrix — which this backend
  // does not honour there. Strict must refuse, on a backend that just routed.
  const matrixArb = registry.select('matrix', requireHeight);
  const matrixShort = matrixArb.arbitration ? shortfallOf(matrixArb.arbitration) : requireHeight;
  const matrixSameProfile: SpatialResult<Matrix> = matrixShort.length > 0
    ? { status: 'refused', reason: 'restriction_not_honoured',
        remedy: `The backend does not honour ${matrixShort.join(', ')} on matrix, though it `
          + 'does on route. A matrix is what a dispatcher calls for fleet assignment, so a '
          + 'car-legal matrix under a truck profile is the dangerous shape.',
        requestedRestrictions: requireHeight, unhonoured: matrixShort }
    : await engine.matrix({
        origins: [from], destinations: [to], profile: TALL_REEFER,
        require: requireHeight, metrics: ['duration', 'distance'] });
  if (matrixSameProfile.status === 'refused') refusals.push(`matrix: ${matrixSameProfile.reason}`);

  const arb = (a: Arbitration | null): string[] => a ? shortfallOf(a) : ['(no candidate)'];

  /* ── lifecycle ───────────────────────────────────────────────────────── */

  const lifecycle = LOADS.map(l => {
    const r: StateReading = readState(l.transitions, now);
    return {
      loadId: l.loadId,
      reading: r.kind,
      detail: r.kind === 'known' ? `${r.state} as of ${r.asOf}`
        : r.kind === 'unobserved'
          ? `WAS ${r.lastKnownState}; ${(r.staleForSeconds / 3600).toFixed(1)}h silent — ${r.remedy}`
          : r.remedy,
    };
  });
  for (const l of lifecycle) if (l.reading !== 'known') refusals.push(`${l.loadId}: ${l.reading}`);

  /* ── exceptions ──────────────────────────────────────────────────────── */

  const exceptions: DemoReport['exceptions'] = [];
  const fire = (v: ExceptionVerdict) => exceptions.push({
    loadId: v.loadId, status: v.status,
    detail: v.status === 'fired' ? v.renderedClaim : `${v.reason} — ${v.explanation}`,
  });

  // Fires: evidence, materiality above the floor, and an action available.
  fire(evaluateException({
    loadId: 'L-1', kind: 'appointment_at_risk', evidence: [...EXCEPTION_EVIDENCE],
    materiality: { measure: 'minutes', value: 120 },
    actions: [{ actionId: 'a1', label: 're-sequence L-2 ahead of L-3', authority: 'proposal' }],
    leadMinutes: 95, detectedAt: now,
  }, DEFAULT_EXCEPTION_POLICY, 0));

  // PLANT 7 — evidence and materiality, no action. Suppressed, and COUNTED.
  fire(evaluateException({
    loadId: 'L-2', kind: 'silence_exceeds_cadence', evidence: [...EXCEPTION_EVIDENCE],
    materiality: { measure: 'minutes', value: 600 },
    actions: [], leadMinutes: null, detectedAt: now,
  }, DEFAULT_EXCEPTION_POLICY, 0));

  // The measure does not match the floor's. Refused as incommensurable.
  fire(evaluateException({
    loadId: 'L-5', kind: 'margin_erosion', evidence: [...EXCEPTION_EVIDENCE],
    materiality: { measure: 'km', value: 15_000 },
    actions: [{ actionId: 'a2', label: 'rebill accessorial', authority: 'proposal' }],
    leadMinutes: -30, detectedAt: now,
  }, DEFAULT_EXCEPTION_POLICY, 0));
  for (const e of exceptions) if (e.status === 'suppressed') refusals.push(`${e.loadId}: suppressed`);

  /* ── downstream impact ───────────────────────────────────────────────── */

  const toDownstream = (l: DemoLoad): DownstreamLoad => ({
    loadId: l.loadId, bufferMinutes: l.bufferMinutes,
    hasAppointment: l.appointmentAt !== null, contribution: l.contribution,
  });

  const cadOnly = LOADS.filter(l => l.loadId !== 'L-1' && l.contribution?.currency !== 'USD');
  const impactCad: DownstreamImpact = downstreamImpact(120, cadOnly.map(toDownstream), 'CAD');

  // PLANT 5 — including the USD load must refuse rather than sum across currencies.
  let refusedTotal: string | null = null;
  try {
    downstreamImpact(120, LOADS.filter(l => l.loadId !== 'L-1').map(toDownstream), 'CAD');
  } catch (e) {
    refusedTotal = (e as Error).message;
    refusals.push(`impact: ${MIXED_CURRENCY}`);
  }

  /* ── notary ──────────────────────────────────────────────────────────── */

  const breached = reeferReadings();
  const clean = reeferReadingsClean();
  const prove = (a: { root: string; predicateId: string; from: string; to: string;
                      verdictBit: 'held' | 'breached' }) => ({
    system: 'sp1' as const, vkey: 'vk:demo', proofId: `pf:${a.verdictBit}`,
    publicInputs: { root: a.root, predicateId: a.predicateId,
      coversFrom: a.from, coversTo: a.to, verdictBit: a.verdictBit },
    provedAt: now, provingMs: 4_200,
  });
  const device = {
    deviceId: 'probe:reefer-1', attestation: 'carrier_asserted' as const,
    lastCalibratedAt: '2026-06-01T00:00:00.000Z',
    note: 'carrier-supplied reefer probe; not hardware attested',
  };
  const base = {
    predicate: REEFER_ENVELOPE, from: REEFER_FROM, to: REEFER_TO,
    device, now, postingWindow: DEFAULT_POSTING_WINDOW, prove,
  };
  const condition: NotaryVerdict = notarizeCondition({
    ...base, readings: breached, commitment: commitmentFor(breached, REEFER_TO) });
  const conditionClean: NotaryVerdict = notarizeCondition({
    ...base, readings: clean, commitment: commitmentFor(clean, REEFER_TO) });
  const custody: NotaryVerdict = notarizeCustody(
    [...HANDOFFS],
    { predicateId: 'unbroken_custody@1.0.0', statement: 'every handoff signed by both parties',
      maxHandoffGapSeconds: 21_600, requireBothSignatures: true },
    REEFER_FROM, REEFER_TO, commitmentFor(breached, REEFER_TO), now);
  for (const v of [condition, custody]) if (v.status !== 'held') refusals.push(`notary: ${v.status}`);

  return {
    now,
    backend: engine.capabilities.backendId,
    banner:
      'SIMULATED RUN — every spatial number below comes from a synthetic network and every '
      + 'freight record from a fixture. Nothing here is a measurement of the world. The '
      + 'refusals, however, are real: they are the same gates a live backend would meet.',
    spatial: {
      routeStrict: { load: 'L-1 (tall reefer, over the modelled clearance)',
        status: routeStrict.status, sentence: line(routeStrict) },
      routeControl: { load: 'L-1 (standard van, under it)',
        status: routeControl.status, sentence: line(routeControl) },
      matrixSameProfile: { status: matrixSameProfile.status, sentence: line(matrixSameProfile) },
      arbitration: {
        route: arb(registry.select('route', requireHeight).arbitration),
        matrix: arb(matrixArb.arbitration),
      },
    },
    lifecycle,
    exceptions,
    impact: {
      total: `${impactCad.totalAtRiskMinor} CAD minor units across ${impactCad.assessed.length} assessed load(s)`,
      assessed: impactCad.assessed.map(a =>
        `${a.loadId}: +${a.delayMinutes}min (buffer ${a.bufferBasis}), breach=${String(a.breachesAppointment)}, at risk ${a.atRiskMinor}`),
      unassessed: impactCad.unassessed.map(u =>
        `${u.loadId}: ${u.reason} — delay +${u.impact.delayMinutes}min, breach=${String(u.impact.breachesAppointment)}`),
      refusedTotal,
    },
    notary: {
      condition: `${condition.status} — ${condition.renderedClaim}`,
      conditionClean: `${conditionClean.status} — ${conditionClean.renderedClaim}`,
      custody: `${custody.status} — ${custody.renderedClaim}`,
    },
    refusals,
  };
}

/** A plain-text rendering, for a terminal or a route body. */
export function renderDemo(r: DemoReport): string {
  const L: string[] = [];
  L.push('═══ PAYLOAD TERMINAL — END-TO-END RUN ═══');
  L.push(r.banner);
  L.push(`\nbackend: ${r.backend}    as of: ${r.now}`);

  L.push('\n── SPATIAL ─────────────────────────────────────────────');
  L.push(`  route  [${r.spatial.routeStrict.status}] ${r.spatial.routeStrict.load}`);
  L.push(`         ${r.spatial.routeStrict.sentence}`);
  L.push(`  route  [${r.spatial.routeControl.status}] ${r.spatial.routeControl.load}`);
  L.push(`         ${r.spatial.routeControl.sentence}`);
  L.push(`  matrix [${r.spatial.matrixSameProfile.status}] same profile, same restriction`);
  L.push(`         ${r.spatial.matrixSameProfile.sentence}`);
  L.push(`  arbitration — route shortfall: ${r.spatial.arbitration.route.join(', ') || 'none'}`);
  L.push(`                matrix shortfall: ${r.spatial.arbitration.matrix.join(', ') || 'none'}`);

  L.push('\n── LIFECYCLE ───────────────────────────────────────────');
  for (const l of r.lifecycle) L.push(`  ${l.loadId}  [${l.reading}] ${l.detail}`);

  L.push('\n── EXCEPTIONS ──────────────────────────────────────────');
  for (const e of r.exceptions) L.push(`  ${e.loadId}  [${e.status}] ${e.detail}`);

  L.push('\n── DOWNSTREAM IMPACT ───────────────────────────────────');
  L.push(`  total: ${r.impact.total}`);
  for (const a of r.impact.assessed) L.push(`    assessed   ${a}`);
  for (const u of r.impact.unassessed) L.push(`    UNASSESSED ${u}`);
  if (r.impact.refusedTotal) L.push(`    mixed-currency total REFUSED: ${r.impact.refusedTotal}`);

  L.push('\n── NOTARY ──────────────────────────────────────────────');
  L.push(`  condition (excursion): ${r.notary.condition}`);
  L.push(`  condition (clean run): ${r.notary.conditionClean}`);
  L.push(`  custody:               ${r.notary.custody}`);

  L.push(`\n── REFUSALS THIS RUN (${r.refusals.length}) ─────────────────────────`);
  for (const x of r.refusals) L.push(`  ${x}`);
  L.push('\nEvery refusal above is the system declining to answer rather than guessing.');
  return L.join('\n');
}
