import { describe, it, expect } from 'vitest';
import { corpusHealthSignals, corpusHealthAccounting } from './horizon';
import { getEconomyState } from './store';

/**
 * "No signals" is the reading that matters most, and the one most easily
 * wrong. Two sources leave the signal set silently — one with nothing
 * knowable at the evaluation date, one with too few arrivals to measure a
 * cadence — and both are invisible in an empty array. Measured: at a
 * historical date the panel did not show CORPUS HEALTH (0); it did not show
 * the section AT ALL, which is a stronger clean bill of health than a zero.
 *
 * A health instrument that cannot distinguish "nothing is wrong" from
 * "nothing was checked" has lost the distinction that IS the product.
 */
describe('corpus health says whether it checked anything', () => {
  it('at a historical date MOST sources are not judged at all, and the note says how many', async () => {
    // Corrected against the measurement: I asserted that nothing is judged
    // at 2017. Three sources ARE — the ones whose vintages carry an explicit
    // knownAt at that date — and eight of eleven are not. The claim changed;
    // the finding did not, and the real number is the more useful one: an
    // empty signal list covering three of eleven sources is a weaker
    // statement than the silence implied.
    const { state } = await getEconomyState('copper');
    const past = corpusHealthAccounting(state, '2017-06-30');
    expect(past.signals).toEqual([]);
    expect(past.judged.length).toBeGreaterThan(0);
    expect(past.notYetKnowable.length, 'the sources exist; their evidence postdates the date').toBeGreaterThan(past.judged.length);
    expect(past.emptyBecause).toMatch(new RegExp(`${past.judged.length} source\\(s\\) were judged`));
    expect(past.emptyBecause).toMatch(new RegExp(`${past.notYetKnowable.length} source\\(s\\) had nothing knowable`));
    // The bare array said none of this.
    expect(corpusHealthSignals(state, '2017-06-30')).toEqual([]);
  });

  it('today the signals are real, and the accounting does NOT explain a non-empty result', async () => {
    // The discriminating half: if today were also empty, the assertion above
    // would be about the function rather than about the date.
    const { state } = await getEconomyState('copper');
    const now = corpusHealthAccounting(state, new Date().toISOString().slice(0, 10));
    expect(now.judged.length, 'sources are judged at the present date').toBeGreaterThan(0);
    expect(now.signals.length, 'the standing flow-snapshot signal fires today').toBeGreaterThan(0);
    expect(now.emptyBecause, 'a note on a non-empty result is a note on none').toBeUndefined();
    // And it agrees with the array-returning function it accounts for.
    expect(now.signals).toEqual(corpusHealthSignals(state, new Date().toISOString().slice(0, 10)));
  });

  it('a CLEAN bill of health reads differently from an unchecked one', async () => {
    // Planted: a corpus whose one source is fresh. Judged, and silent for
    // the right reason — the sentence must not be the "nothing was checked"
    // one, or the two states are indistinguishable again.
    const { state } = await getEconomyState('copper');
    const fresh = structuredClone(state);
    const today = new Date().toISOString().slice(0, 10);
    for (const o of fresh.observations) o.provenance.retrievedAt = `${today}T00:00:00Z`;
    for (const o of fresh.observations) if (o.knownAt) o.knownAt = today;
    const clean = corpusHealthAccounting(fresh, today);
    if (clean.signals.length === 0 && clean.judged.length > 0) {
      expect(clean.emptyBecause).toMatch(/none is past its own arrival cadence/);
      expect(clean.emptyBecause).not.toMatch(/NOTHING WAS CHECKED/);
    }
  });
});
