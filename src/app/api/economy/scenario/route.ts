import { NextResponse } from 'next/server';
import { runEngine } from '@/lib/economy/engine';
import type { ScenarioSpec } from '@/lib/economy/engine';
import type { EventImpact } from '@/lib/economy/propagation';
import { DISRUPTIVE_EVENT_TYPES, isEventActive } from '@/lib/economy/propagation';
import type { AnalyticalResult, EconEventType, EconomyState } from '@/lib/economy/types';

/**
 * OSIRIS — Scenario endpoint: counterfactual event injection.
 *
 *   POST /api/economy/scenario
 *   {
 *     commodity?: "copper",
 *     asOf?: "YYYY-MM-DD",
 *     knowledge?: "best_known" | "as_known_then",
 *     label: "Escondida strike",
 *     events: [{ entityId, type, title, start, end?, severity, description? }]
 *   }
 *
 * Runs the engine twice on the same frame — once as a reconstruction, once
 * with the hypothetical events injected — and returns both plus the delta.
 * The frame carries kind: 'counterfactual' and the knowledge mode, so a
 * replay can never confuse "the scenario changed the world" with "we know
 * more now", and a hypothetical can never be read as a reconstruction.
 *
 * With knowledge=as_known_then this is a backtest of the analytical layer
 * itself: "given only what was knowable on date D, what would propagation
 * have concluded?"
 */

export const dynamic = 'force-dynamic';

const EVENT_TYPES: EconEventType[] = ['outage', 'strike', 'closure', 'expansion', 'disruption', 'weather', 'policy', 'demand_surge', 'sanction', 'insolvency'];
const SEVERITIES = ['low', 'medium', 'high'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENTS = 8;

interface ScenarioRequest {
  commodity?: string;
  asOf?: string;
  knowledge?: 'best_known' | 'as_known_then';
  label?: string;
  events?: Array<{ entityId?: string; type?: string; title?: string; start?: string; end?: string; severity?: string; description?: string }>;
}

function disruptedEntities(state: EconomyState, asOf: string): Set<string> {
  const out = new Set<string>();
  for (const ev of state.events) {
    if (ev.entityId && DISRUPTIVE_EVENT_TYPES.includes(ev.type) && isEventActive(ev, asOf)) out.add(ev.entityId);
  }
  return out;
}

export async function POST(request: Request) {
  let body: ScenarioRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const commodity = body.commodity ?? 'copper';
  const asOf = body.asOf;
  if (asOf && !DATE_RE.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  const knowledge = body.knowledge ?? 'best_known';
  if (knowledge !== 'best_known' && knowledge !== 'as_known_then') {
    return NextResponse.json({ error: 'knowledge must be best_known or as_known_then' }, { status: 400 });
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return NextResponse.json({ error: 'events must be a non-empty array' }, { status: 400 });
  }
  if (body.events.length > MAX_EVENTS) {
    return NextResponse.json({ error: `at most ${MAX_EVENTS} events per scenario` }, { status: 400 });
  }
  for (const ev of body.events) {
    if (!ev.entityId) return NextResponse.json({ error: 'every event needs an entityId' }, { status: 400 });
    if (!ev.type || !EVENT_TYPES.includes(ev.type as EconEventType)) {
      return NextResponse.json({ error: `event type must be one of ${EVENT_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!ev.title) return NextResponse.json({ error: 'every event needs a title' }, { status: 400 });
    if (!ev.start || !DATE_RE.test(ev.start)) return NextResponse.json({ error: 'event start must be YYYY-MM-DD' }, { status: 400 });
    if (ev.end && !DATE_RE.test(ev.end)) return NextResponse.json({ error: 'event end must be YYYY-MM-DD' }, { status: 400 });
    if (!ev.severity || !SEVERITIES.includes(ev.severity)) {
      return NextResponse.json({ error: 'event severity must be low|medium|high' }, { status: 400 });
    }
  }

  const scenario: ScenarioSpec = {
    id: `s${Date.now().toString(36)}`,
    label: body.label ?? 'unnamed scenario',
    events: body.events as ScenarioSpec['events'],
  };

  let baseline, counterfactual;
  try {
    baseline = await runEngine(commodity, { asOf, knowledge });
    counterfactual = await runEngine(commodity, { asOf, knowledge, scenario });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'engine failure';
    return NextResponse.json({ error: message }, { status: message.includes('unknown entity') ? 400 : 404 });
  }

  const evalDate = asOf ?? new Date().toISOString().slice(0, 10);
  const baseDisrupted = disruptedEntities(baseline.state, evalDate);
  const cfDisrupted = disruptedEntities(counterfactual.state, evalDate);
  const newlyDisrupted = [...cfDisrupted].filter(id => !baseDisrupted.has(id));

  const cfPropagation = counterfactual.systems.propagation as AnalyticalResult<EventImpact[]>;
  const scenarioImpacts = cfPropagation.result.filter(i => i.eventId.startsWith('evt:scenario:'));
  const basePropagation = baseline.systems.propagation as AnalyticalResult<EventImpact[]>;
  const baseAffected = new Set(basePropagation.result.filter(i => i.active).flatMap(i => i.affected.map(a => a.entityId)));
  const entityName = new Map(counterfactual.state.entities.map(e => [e.id, e.name]));

  return NextResponse.json({
    commodity,
    // Both frames, so a consumer can verify what each run was allowed to know.
    baselineFrame: baseline.frame,
    counterfactualFrame: counterfactual.frame,
    scenarioImpacts,
    delta: {
      newlyDisrupted: newlyDisrupted.map(id => ({ id, name: entityName.get(id) ?? id })),
      /** Downstream entities the scenario puts in reach of an active
       *  disruption that the baseline did not. */
      newlyAffectedDownstream: [...new Set(
        scenarioImpacts.filter(i => i.active).flatMap(i => i.affected.map(a => a.entityId)),
      )]
        .filter(id => !baseAffected.has(id))
        .map(id => ({ id, name: entityName.get(id) ?? id })),
      // A null impact figure ("cannot state at this date") poisons the sum:
      // adding it as 0 would launder unknown into a smaller known total.
      disruptedKtPerYear: scenarioImpacts.filter(i => i.active).some(i => i.disruptedKtPerYear === null)
        ? null
        : scenarioImpacts.filter(i => i.active).reduce((s, i) => s + (i.disruptedKtPerYear ?? 0), 0),
    },
  });
}
