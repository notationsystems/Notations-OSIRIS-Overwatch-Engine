import { describe, it, expect } from 'vitest';
import { syntheticState, fixtureMonth } from './fixtures';

/**
 * THE FIXTURE IS A TEST INPUT, SO A DEFECT IN IT IS INVISIBLE BY CONSTRUCTION.
 *
 * Ten test files read `syntheticState()`. A malformed date in it fails nothing
 * here — it changes what every one of those files is asserting about, quietly,
 * and each of them still passes.
 *
 * MEASURED, on a twelve-element version of this series that briefly reached the
 * tree: `2024-0${i + 1}` produced `2024-010-01` for October, `Date.parse`
 * accepted it and returned the correct instant, and `.slice(0, 7)` returned
 * `'2024-01'`. October, November and December all keyed as JANUARY.
 * `extractSeries` returned four points labelled `2024-01`, and the planted
 * structural break moved from position 8 to position 11 of 12.
 *
 * The series is eight elements today, so the defect is LATENT. These tests pin
 * the FORMATTER at lengths the fixture does not yet use, because the pin has to
 * outlive the length that currently makes the bug invisible.
 */
describe('the synthetic fixture is well-formed, because ten files rest on it', () => {
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  it('every period bound and knownAt is a strict ISO day', () => {
    const bad: string[] = [];
    for (const o of syntheticState().observations) {
      for (const [label, v] of [
        ['period.start', o.period.start], ['period.end', o.period.end], ['knownAt', o.knownAt],
      ] as const) {
        if (v !== undefined && v !== null && !ISO_DAY.test(v)) bad.push(`${o.id}.${label}=${v}`);
      }
    }
    expect(bad, 'malformed date strings parse correctly and sort wrongly').toEqual([]);
  });

  it('the inventory series sorts lexically into calendar order', () => {
    const inv = syntheticState().observations
      .filter(o => o.metric === 'inventory')
      .map(o => o.period.start);
    expect(inv.length).toBeGreaterThan(0);
    expect([...inv].sort()).toEqual(inv);
  });

  it('lexical order agrees with instant order — the two must not diverge', () => {
    const inv = syntheticState().observations.filter(o => o.metric === 'inventory');
    const lexical = [...inv].sort((a, b) => a.period.start.localeCompare(b.period.start));
    const byInstant = [...inv].sort((a, b) => Date.parse(a.period.start) - Date.parse(b.period.start));
    expect(lexical.map(o => o.id)).toEqual(byInstant.map(o => o.id));
  });

  it('period keys are distinct — no two months collapse onto one', () => {
    // The actual mechanism of the measured defect: slice(0,7) collision.
    const keys = syntheticState().observations
      .filter(o => o.metric === 'inventory')
      .map(o => o.period.start.slice(0, 7));
    expect(new Set(keys).size, `colliding period keys: ${keys.join(' ')}`).toBe(keys.length);
  });

  it('the planted structural break is at 2024-08, where the series says', () => {
    const inv = syntheticState().observations
      .filter(o => o.metric === 'inventory')
      .sort((a, b) => a.period.start.localeCompare(b.period.start));
    const trough = inv.reduce((lo, o) => (o.value < lo.value ? o : lo), inv[0]);
    expect(trough.period.start).toBe('2024-08-01');
    expect(trough.value).toBe(60);
  });
});

describe('THE LATENT PIN: the formatter survives lengths the fixture has not reached', () => {
  // The bug is invisible at eight elements. Pinning only the current series
  // would be a check calibrated for the failure that does not happen — it
  // would pass unchanged on the day someone adds a ninth month and breaks it.
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  it('produces a strict two-digit month for all twelve, not just the first nine', () => {
    const bad: string[] = [];
    for (let i = 0; i < 12; i++) {
      const day = `2024-${fixtureMonth(i)}-01`;
      if (!ISO_DAY.test(day)) bad.push(`i=${i} -> ${day}`);
    }
    expect(bad, 'the tenth element is where the unpadded form breaks').toEqual([]);
  });

  it('and those twelve keys are distinct — the collision cannot recur', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `2024-${fixtureMonth(i)}-01`.slice(0, 7));
    expect(new Set(keys).size).toBe(12);
  });

  it('sorting twelve lexically matches sorting them by instant', () => {
    const days = Array.from({ length: 12 }, (_, i) => `2024-${fixtureMonth(i)}-01`);
    expect([...days].sort()).toEqual(
      [...days].sort((a, b) => Date.parse(a) - Date.parse(b)));
  });
});
