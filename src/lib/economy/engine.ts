/**
 * OSIRIS — Economy engine core.
 *
 * Storm-engine-inspired lifecycle, adapted to an analytical world-state
 * engine rather than a frame-loop game engine:
 *
 *   ACQUIRE   adapters → canonical EconomyState        (store.ts)
 *   INDEX     state → flow/dependency graph            (graph.ts)
 *   SYSTEMS   registered systems run over state+graph  (this file)
 *   PROJECT   API routes serve projections of the run  (app/api/economy)
 *
 * A "system" is a named, pure computation over (state, graph) that returns
 * an AnalyticalResult. Systems are registered, not hard-coded, so new
 * analytical passes (scenario stress, propagation, logistics intelligence)
 * plug in without touching the engine or the routes. The UI never computes
 * economics — it renders projections of an engine run.
 */

import type { AnalyticalResult, EconomyState } from './types';
import type { EconomyGraph } from './graph';
import { buildGraph } from './graph';
import { getEconomyState } from './store';
import {
  bottleneckCandidates, capacityConcentration, concentration, concentrationTrajectory,
  detectAnomalies, facilityCoverage, flowCentrality, knownAtOf,
} from './analytics';
import { detectDivergences } from './divergence';
import { propagateEvents } from './propagation';

export interface SystemContext {
  /** Evaluation date (ISO, YYYY-MM-DD). Temporal systems compute state as of
   *  this date; omitted means "now" / latest available. */
  asOf?: string;
  /**
   * What the evaluation is allowed to know:
   *   best_known     (default) the current best reconstruction of history —
   *                  revised figures, later vintages, everything we hold now.
   *   as_known_then  only evidence knowable at asOf (observation knownAt and
   *                  event firstReportedAt ≤ asOf). Required for backtesting:
   *                  a detector scored under best_known is being graded on
   *                  information it could not have had.
   */
  knowledge?: 'best_known' | 'as_known_then';
}

export interface EconomySystem {
  name: string;
  /** What the system derives — shown to researchers, so write it plainly. */
  describes: string;
  run(state: EconomyState, graph: EconomyGraph, ctx: SystemContext): AnalyticalResult<unknown>;
}

/* Built-in systems. Order is presentation order, not a dependency chain —
 * systems must stay independent; anything needing another system's output
 * belongs in a projection, not a system. */
const SYSTEMS: EconomySystem[] = [
  {
    name: 'concentration',
    describes: 'HHI concentration of production, refining and consumption plus capacity structure',
    run: (state, _graph, ctx) => ({
      // Compound projection of several concentration operations; each inner
      // result keeps its own operation/execution/evidence identity.
      operation: { name: 'concentration-suite', params: { asOf: ctx.asOf } },
      execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
      inputs: {},
      result: {
        mineProductionByCountry: concentration(state, 'production', 'country', ctx.asOf),
        mineProductionByMine: concentration(state, 'production', 'mine', ctx.asOf),
        refinedProductionByCountry: concentration(state, 'refined_production', 'country', ctx.asOf),
        consumptionByRegion: concentration(state, 'consumption', 'region', ctx.asOf),
        smeltingCapacityByCountry: capacityConcentration(state, 'smelting'),
        refiningCapacityByCountry: capacityConcentration(state, 'refining'),
        trajectory: concentrationTrajectory(state, 'production', 'country'),
      },
    }),
  },
  {
    name: 'centrality',
    describes: 'Material throughput per node across the flow graph',
    run: (state, graph) => flowCentrality(state, graph),
  },
  {
    name: 'bottlenecks',
    describes: 'Candidate bottleneck scoring from flow, capacity, redundancy and dependency structure',
    run: (state, graph) => bottleneckCandidates(state, graph),
  },
  {
    name: 'anomalies',
    describes: 'Rolling-deviation and rate-of-change signals over observation time series',
    run: (state) => detectAnomalies(state),
  },
  {
    name: 'coverage',
    describes: 'Facility-model coverage: rolled-up facilities vs direct country observations, per metric',
    run: (state, _graph, ctx) => ({
      operation: { name: 'coverage-suite', params: { asOf: ctx.asOf } },
      execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
      inputs: {},
      result: {
        mineProduction: facilityCoverage(state, 'production', ['mine'], ctx.asOf),
        refinedProduction: facilityCoverage(state, 'refined_production', ['refinery', 'smelter'], ctx.asOf),
      },
    }),
  },
  {
    name: 'divergence',
    describes: 'Observer disagreement: multi-provider conflicts and Comtrade mirror gaps, kept as evidence',
    run: (state) => detectDivergences(state),
  },
  {
    name: 'propagation',
    describes: 'Event → state-change propagation: disrupted flow, downstream exposure, alternative capacity',
    run: (state, graph, ctx) => propagateEvents(state, graph, ctx.asOf ? { asOf: ctx.asOf } : {}),
  },
];

export function listSystems(): Array<Pick<EconomySystem, 'name' | 'describes'>> {
  return SYSTEMS.map(({ name, describes }) => ({ name, describes }));
}

export function registerSystem(system: EconomySystem): void {
  const i = SYSTEMS.findIndex(s => s.name === system.name);
  if (i >= 0) SYSTEMS[i] = system;
  else SYSTEMS.push(system);
}

export interface EngineRun {
  commodity: string;
  /** Evaluation date the systems ran at (undefined = latest/now). */
  asOf?: string;
  knowledge?: 'best_known' | 'as_known_then';
  /** The state the systems actually saw (knowledge-filtered under as_known_then). */
  state: EconomyState;
  graph: EconomyGraph;
  providers: string[];
  /** System outputs keyed by system name. */
  systems: Record<string, AnalyticalResult<unknown>>;
}

/**
 * One full engine pass for a commodity. State assembly is memoized in the
 * store; systems are cheap enough to run per call, which keeps a run
 * consistent with the state it was computed from.
 */
/**
 * Restrict a state to what was knowable at `asOf`: observations by knownAt
 * (falling back to retrieval time as the conservative bound) and events by
 * firstReportedAt (falling back to occurrence, which assumes immediate
 * reporting — curated events set it explicitly).
 */
function asKnownThen(state: EconomyState, asOf: string): EconomyState {
  return {
    ...state,
    observations: state.observations.filter(o => knownAtOf(o) <= asOf),
    events: state.events.filter(ev => (ev.firstReportedAt ?? ev.start) <= asOf),
  };
}

export async function runEngine(commodity: string, ctx: SystemContext = {}): Promise<EngineRun> {
  const assembled = await getEconomyState(commodity);
  const providers = assembled.providers;
  // The run's world state is what the evaluation is allowed to know.
  const state = ctx.knowledge === 'as_known_then' && ctx.asOf
    ? asKnownThen(assembled.state, ctx.asOf)
    : assembled.state;
  const graph = buildGraph(state);
  const systems: Record<string, AnalyticalResult<unknown>> = {};
  for (const system of SYSTEMS) {
    systems[system.name] = system.run(state, graph, ctx);
  }
  return { commodity, asOf: ctx.asOf, knowledge: ctx.knowledge ?? 'best_known', state, graph, providers, systems };
}
