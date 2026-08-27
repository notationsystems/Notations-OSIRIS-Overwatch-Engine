/**
 * Sea Dog Terminal — process-wide singletons that survive Next's module
 * duplication (deployment order, found in the running configuration).
 *
 * THE FINDING. Next.js runs the `instrumentation.ts` hook in a different
 * module context from the route handlers. Module-level state is
 * therefore NOT shared: boot wrote its report into one copy of
 * `boot.ts`, and `/api/health` read a different copy. Measured — the
 * server log said `boot ready in 2805ms` while the health endpoint still
 * answered `booting`, indefinitely. A boot report nobody can read is not
 * a boot report.
 *
 * The same defect was silently worse for the outbound rate limiter
 * (D-10): two module instances mean two chains, so a boot-time fetch and
 * a request-time fetch to the SAME HOST would not queue behind each
 * other — the exact compounding the limiter exists to prevent,
 * reappearing through a door the limiter could not see. That is the
 * hazard class this project keeps naming: a check correct about the
 * thing it examined and silent about the thing that shipped.
 *
 * So every piece of state that must be process-wide is anchored on
 * `globalThis`, which IS shared across those contexts, and reached only
 * through this helper.
 */

const REGISTRY = Symbol.for('sea-dog-terminal.process-singletons');

type Registry = Map<string, unknown>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let r = g[REGISTRY];
  if (!r) {
    r = new Map<string, unknown>();
    g[REGISTRY] = r;
  }
  return r;
}

/**
 * Get the one process-wide instance of `key`, creating it with `init` on
 * first use. Every module context that asks gets the SAME object.
 */
export function processSingleton<T>(key: string, init: () => T): T {
  const r = registry();
  if (!r.has(key)) r.set(key, init());
  return r.get(key) as T;
}

/** Test seam: drop a singleton so the next call re-initialises it. */
export function resetProcessSingleton(key: string): void {
  registry().delete(key);
}
