'use client';

import { useSyncExternalStore } from 'react';

/**
 * Client-only values, without setState-in-effect.
 *
 * The pattern being replaced looked like this:
 *
 *   const [mounted, setMounted] = useState(false);
 *   useEffect(() => setMounted(true), []);
 *
 * That works, but it renders twice, and it trips
 * `react-hooks/set-state-in-effect` for a real reason: an effect that
 * unconditionally writes state is a render the component asked for and
 * then immediately invalidated. `useSyncExternalStore` says the same
 * thing in the form React has for it — a value with two snapshots, one
 * for the server and one for the client — so there is nothing to
 * disable and nothing to explain at the call site.
 *
 * `subscribe` is a module constant rather than an inline arrow. An
 * inline `() => () => {}` is a fresh reference on every render, so
 * React tears down and re-establishes the subscription every time;
 * with a stable reference it subscribes once. The store never emits,
 * because neither value ever changes after hydration.
 */
const subscribe = (): (() => void) => () => {};

/** `false` during SSR and on the hydrating render, `true` afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

/**
 * `window.location.origin` in the browser, `''` on the server.
 *
 * The empty string is the honest server answer, not a placeholder: the
 * server genuinely does not know which host the reader reached it on,
 * and a guessed origin in a copyable snippet is worse than a relative
 * one. Callers render `${origin}/path`, which degrades to `/path`.
 */
export function useOrigin(): string {
  return useSyncExternalStore(subscribe, () => window.location.origin, () => '');
}
