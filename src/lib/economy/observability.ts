/**
 * Sea Dog Terminal — process observability (deployment order D-7).
 *
 * Corpus health covers DATA staleness. This covers PROCESS health: what
 * the process did, how often it failed, and what its outbound behaviour
 * looked like — enough that a failure at 3am is diagnosable at 9am
 * without reproducing it.
 *
 * Deliberately in-process and small. This is not a metrics backend and
 * does not pretend to be one: counters and a bounded ring of recent
 * events, exposed at /api/health, carrying the D-3 state fingerprint so
 * a log line and a researcher's screenshot can be tied together. A
 * process that restarts loses them, which is stated rather than implied
 * — durable telemetry across restarts is a different item and is not
 * claimed here.
 *
 * NO PERSONAL DATA and NO QUERY STRINGS, by the same construction as the
 * rest of the instrument: route paths, status codes, counts and
 * fingerprints only.
 */

import { processSingleton } from './processSingleton';

export interface ProcessEvent {
  ts: string;
  kind: 'boot' | 'request_error' | 'adapter_outcome';
  detail: string;
  /** D-3 fingerprint of the state involved, where one applies. */
  fingerprint?: string;
}

const MAX_EVENTS = 200;

/** On globalThis for the same reason as boot and the rate limiter: Next
 *  runs instrumentation in a separate module context, and boot events
 *  recorded there would otherwise be invisible to /api/health. */
const store = () => processSingleton('observability', () => ({
  events: [] as ProcessEvent[],
  counters: {
    requests: 0,
    errors: 0,
    byRoute: {} as Record<string, { requests: number; errors: number }>,
  },
}));

export function recordRequest(route: string, ok: boolean): void {
  const { counters } = store();
  counters.requests += 1;
  if (!ok) counters.errors += 1;
  const r = counters.byRoute[route] ?? { requests: 0, errors: 0 };
  r.requests += 1;
  if (!ok) r.errors += 1;
  counters.byRoute[route] = r;
}

export function recordProcessEvent(kind: ProcessEvent['kind'], detail: string, fingerprint?: string): void {
  const { events } = store();
  events.push({ ts: new Date().toISOString(), kind, detail, ...(fingerprint ? { fingerprint } : {}) });
  // Bounded ring: an unbounded event list in a month-long process is a
  // memory leak wearing an observability badge.
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function processReport() {
  const { counters, events } = store();
  return {
    counters: {
      requests: counters.requests,
      errors: counters.errors,
      errorRate: counters.requests > 0 ? Number((counters.errors / counters.requests).toFixed(4)) : null,
      byRoute: { ...counters.byRoute },
    },
    recentEvents: [...events].slice(-25),
    eventCapacity: MAX_EVENTS,
    note: 'In-process counters and a bounded event ring. These do NOT survive a restart — the boot event marks where a lost window begins. No query strings or personal data are held here, by construction.',
  };
}

export function resetProcessReport(): void {
  const { counters, events } = store();
  events.length = 0;
  counters.requests = 0;
  counters.errors = 0;
  counters.byRoute = {};
}
