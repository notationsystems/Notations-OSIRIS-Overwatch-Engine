/**
 * Sea Dog Terminal — response attribution (deployment order D-3).
 *
 * A researcher who says "this number looks wrong" is unattributable
 * unless the response says which BUILD, which STATE and which KNOWLEDGE
 * MODE produced it. During the afternoon that is the difference between
 * a finding and an anecdote: the miss log records what was asked, but
 * without the state fingerprint nobody can tell later whether a figure
 * came from a live vintage, a snapshot rung, or a corpus two revisions
 * ago.
 *
 * The three facts, on every response:
 *   version    the build serving it (release + commit when stamped)
 *   state      the fingerprint of the canonical state it was computed
 *              from — the SAME function the corpus export uses, so an
 *              exported number and a screen number are comparable
 *   knowledge  as_of and mode, the world the answer is about
 *
 * BUILD IDENTITY IS NEVER FABRICATED. If the image was built without a
 * commit stamp, `commit` is null and `commit_source` says so — an
 * invented or guessed SHA would make attribution worse than absent,
 * because it would look authoritative.
 */

import pkg from '../../../package.json';
import { stateFingerprint } from './corpusTable';
import type { EconomyState } from './types';

export interface ResponseAttribution {
  version: {
    release: string;
    /** Commit the image was built from — null when unstamped, never guessed. */
    commit: string | null;
    commit_source: 'env:SEA_DOG_BUILD_SHA' | 'unstamped-build';
  };
  state: {
    /** Same fingerprint function the corpus export stamps on every table. */
    fingerprint: string;
    commodity: string;
    observations: number;
    flows: number;
  };
  knowledge: { as_of: string | null; mode: 'best_known' | 'as_known_then' };
  /**
   * D-4: the request path must name its degradation, not merely survive
   * it. Adapter failures were recorded as assembly `issues` and reached
   * NO response — a state served from snapshot rungs because a provider
   * was unreachable looked identical to a fully live one, which is the
   * fresh-but-wrong failure wearing a healthy face. Now every response
   * says which providers answered and names every degradation.
   */
  degradation: {
    /** Providers that answered for this assembly. */
    providers: string[];
    /** Named adapter failures — empty means nothing degraded. */
    issues: string[];
    status: 'nominal' | 'degraded';
  };
}

export function buildVersion(): ResponseAttribution['version'] {
  const sha = process.env.SEA_DOG_BUILD_SHA;
  return sha
    ? { release: pkg.version, commit: sha, commit_source: 'env:SEA_DOG_BUILD_SHA' }
    : { release: pkg.version, commit: null, commit_source: 'unstamped-build' };
}

export function attribution(
  state: EconomyState,
  knowledge: { asOf?: string | null; mode?: 'best_known' | 'as_known_then' } = {},
  assembly: { providers?: string[]; issues?: Array<{ severity: string; message: string }> } = {},
): ResponseAttribution {
  const issues = (assembly.issues ?? []).filter(i => i.severity === 'warning').map(i => i.message);
  return {
    version: buildVersion(),
    state: {
      fingerprint: stateFingerprint(state),
      commodity: state.commodity,
      observations: state.observations.length,
      flows: state.flows.length,
    },
    knowledge: { as_of: knowledge.asOf ?? null, mode: knowledge.mode ?? 'best_known' },
    degradation: {
      providers: assembly.providers ?? [],
      issues,
      status: issues.length > 0 ? 'degraded' : 'nominal',
    },
  };
}
