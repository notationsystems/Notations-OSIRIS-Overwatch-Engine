/**
 * Payload Terminal — outbound rate discipline in a LONG-RUNNING process
 * (deployment order D-10).
 *
 * INSPECTION FINDING, and the order was right to ask: the only throttle
 * in the codebase was a single `await sleep(1100)` between sequential
 * Comtrade keys INSIDE one adapter run. That is a one-shot-script
 * discipline. It holds while exactly one assembly is in flight and
 * nothing else is; it says nothing about two assemblies overlapping.
 *
 * And this order's own D-2 item made that worse before this module
 * existed: boot warming assembles every commodity with `Promise.all`,
 * so copper and aluminium now start their Comtrade runs at the SAME
 * INSTANT, each politely spacing its own requests by 1.1s while
 * interleaving with the other. Two polite streams are one impolite one.
 * Concurrency introduced by a hardening item is exactly the kind of
 * thing that only shows up when someone looks, which is what D-10 is.
 *
 * So the throttle moves from inside one loop to a PROCESS-WIDE, PER-HOST
 * gate: every outbound request queues behind the same lock for its host
 * and is spaced by that host's minimum interval, whoever asked and
 * however many callers are in flight. Concurrent requests cannot
 * compound because they cannot run concurrently against one host.
 *
 * Per-host intervals, from each source's own stated limits:
 *   comtradeapi.un.org  1100ms — the public preview's courtesy spacing
 *   data.sec.gov        120ms  — SEC caps at 10 req/s; 0.12s spacing sits
 *                                under it, and a 403 is NEVER retried
 *                                immediately (that lengthens the block)
 *   westmetall.com      2000ms — a courtesy scrape of a republisher;
 *                                slower than required, deliberately
 *   default             250ms  — anything unlisted still queues
 */

import { processSingleton } from './processSingleton';

const HOST_INTERVAL_MS: Record<string, number> = {
  'comtradeapi.un.org': 1100,
  'data.sec.gov': 120,
  'www.sec.gov': 120,
  'www.westmetall.com': 2000,
  'westmetall.com': 2000,
};

const DEFAULT_INTERVAL_MS = 250;

/**
 * Per-host serialisation chain, ON globalThis. Next duplicates modules
 * across the instrumentation and request contexts, and two limiter
 * instances mean two chains: a boot-time fetch and a request-time fetch
 * to the SAME host would not queue behind each other — precisely the
 * compounding this module exists to prevent, reappearing through a door
 * the limiter itself could not see.
 */
const shared = () => processSingleton('outbound-rate', () => ({
  hostChains: new Map<string, Promise<void>>(),
  lastStart: new Map<string, number>(),
  stats: new Map<string, RateStats>(),
}));

export function hostIntervalMs(host: string): number {
  return HOST_INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS;
}

/** Observability (D-7): what the limiter actually did. */
export interface RateStats {
  host: string;
  requests: number;
  totalWaitedMs: number;
  maxWaitedMs: number;
}
export function rateStats(): RateStats[] {
  return [...shared().stats.values()].sort((a, b) => b.requests - a.requests);
}

export function resetRateStats(): void {
  const s = shared();
  s.stats.clear();
  s.hostChains.clear();
  s.lastStart.clear();
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Run `fn` under the host's outbound rate discipline. Returns whatever
 * `fn` returns; failures propagate unchanged (the ladder above decides
 * what a failure means — this module only decides WHEN).
 */
export async function withHostRateLimit<T>(url: string, fn: () => Promise<T>): Promise<T> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return fn(); // not a URL we can attribute; never block on a parse failure
  }
  const interval = hostIntervalMs(host);

  // Chain: this call waits for the previous call on the same host, then
  // for the remainder of the interval since that call STARTED.
  const g = shared();
  const previous = g.hostChains.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(r => { release = r; });
  g.hostChains.set(host, previous.then(() => mine));

  const t0 = Date.now();
  await previous;
  const since = Date.now() - (g.lastStart.get(host) ?? 0);
  const wait = Math.max(0, interval - since);
  if (wait > 0) await sleep(wait);
  g.lastStart.set(host, Date.now());

  const waited = Date.now() - t0;
  const s = g.stats.get(host) ?? { host, requests: 0, totalWaitedMs: 0, maxWaitedMs: 0 };
  s.requests += 1;
  s.totalWaitedMs += waited;
  s.maxWaitedMs = Math.max(s.maxWaitedMs, waited);
  g.stats.set(host, s);

  try {
    return await fn();
  } finally {
    release();
  }
}
