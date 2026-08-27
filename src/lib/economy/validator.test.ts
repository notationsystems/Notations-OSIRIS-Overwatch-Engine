import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateClaim, extractClaimNumbers } from './validator';
import { getEconomyState } from './store';
import { GET as validateGet } from '@/app/api/economy/validate/route';
import type { EconomyState, Observation } from './types';

/**
 * Final order F-3 — the validator, against its pre-registered criteria.
 * The claim comes from whatever model produced it; the verdict comes
 * from the substrate.
 */

const req = (path: string) => new Request(`http://localhost${path}`);

describe('F-3: the claim validator (pre-registered criteria)', () => {
  let state: EconomyState;
  let hard: Observation; // a non-representative record to cite

  beforeAll(async () => {
    ({ state } = await getEconomyState('copper'));
    hard = state.observations.find(o => o.valueKind === 'reported' || o.valueKind === 'estimated')!;
    expect(hard).toBeDefined();
  });

  // ── Criterion 1: a planted overstated claim returns `overstated` with
  //    the precision mismatch named. ──
  it('a claim more precise than its input is overstated, with the mismatch named', () => {
    const inflated = Number((hard.value * 1.002).toFixed(1)); // within 0.5% but NOT the record's number
    const res = validateClaim(state, `Production reached ${inflated} ${hard.unit}.`, [hard.id]);
    expect(res.verdict).toBe('overstated');
    expect(res.mismatches.length).toBe(1);
    expect(res.mismatches[0].record_id).toBe(hard.id);
    expect(res.mismatches[0].record_value).toBe(hard.value);
    expect(res.reason).toContain('more precise than its inputs');
    expect(res.reason).toContain(String(inflated));
  });

  // ── Criterion 2: a planted facility-level claim returns `inadmissible`
  //    today — every facility-level quantity is representative-class. ──
  it('a facility-level claim is inadmissible today, and the verdict says why without softening', () => {
    const facilityFlow = state.flows.find(f => f.valueKind === 'representative')!;
    expect(facilityFlow).toBeDefined();
    const res = validateClaim(state, `The corridor carries ${facilityFlow.quantity} ${facilityFlow.unit}.`, [facilityFlow.id]);
    expect(res.verdict).toBe('inadmissible');
    expect(res.reason).toContain(facilityFlow.id);
    expect(res.reason).toContain('every facility-level claim is inadmissible today');
    // Admissibility is PRIOR to numeric support: the exact-match number
    // does not rescue a representative-class evidence chain.
  });

  // ── Criterion 3: a claim citing records that do not support it returns
  //    `unsupported` with the contradicting ids listed. ──
  it('a claim its citations contradict is unsupported, with the contradicting ids listed', () => {
    const res = validateClaim(state, 'Production reached 999999999 kt.', [hard.id]);
    expect(res.verdict).toBe('unsupported');
    expect(res.contradicting).toContain(hard.id);
    expect(res.reason).toContain(hard.id);
    // An EMPTY evidence chain is also unsupported — never an error.
    const empty = validateClaim(state, 'Production reached 42 kt.', []);
    expect(empty.verdict).toBe('unsupported');
    expect(empty.reason).toContain('empty evidence chain');
  });

  // ── Criterion 4: the service does not call the analytics operations —
  //    verified structurally on the module source, the same shape as the
  //    export surface's GET-only pin. ──
  it('the validator module imports nothing from the analytics operations', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/economy/validator.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports).toEqual(["./types"]);
    for (const banned of ['engine', 'graph', 'propagation', 'analytics', 'alerts', 'divergence', 'horizon']) {
      expect(src.includes(`./${banned}`), `validator must not import ./${banned}`).toBe(false);
    }
  });

  it('an exactly-carried claim is supported — and "supported" is scoped to the citation relation', () => {
    const res = validateClaim(state, `Production was ${hard.value} ${hard.unit} that year.`, [hard.id]);
    expect(res.verdict).toBe('supported');
    expect(res.supporting).toEqual([hard.id]);
    expect(res.reason).toContain('not that the claim is true');
  });

  it('under as_known_then, hindsight evidence cannot support a claim', () => {
    // A record known only after asOf resolves to nothing at that date.
    const late = state.observations.find(o => (o.knownAt ?? '') > '2019-01-01' && (o.valueKind === 'reported' || o.valueKind === 'estimated'))!;
    const res = validateClaim(state, `The figure was ${late.value}.`, [late.id], { knowableBy: '2018-01-01' });
    expect(res.verdict).toBe('unsupported');
    expect(res.contradicting).toContain(late.id);
  });

  it('extracts quantities but not bare years', () => {
    expect(extractClaimNumbers('In 2024, output hit 5,300 kt (up 4.5%)')).toEqual([5300, 4.5]);
  });

  it('the service route refuses malformed citations and serves the rest GET-only', async () => {
    const bad = await validateGet(req(`/api/economy/validate?claim=x+is+5&records=${encodeURIComponent('jane doe')}`));
    expect(bad.status).toBe(400);
    const ok = await validateGet(req(`/api/economy/validate?claim=${encodeURIComponent(`Production was ${1}`)}&records=`));
    expect(ok.status).toBe(200);
    expect((await ok.json()).verdict).toBe('unsupported'); // empty chain: a verdict, not an error
    const routeModule = await import('@/app/api/economy/validate/route');
    const handlers = Object.keys(routeModule).filter(k => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
    expect(handlers).toEqual(['GET']);
  });
});
