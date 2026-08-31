import { describe, it, expect } from 'vitest';
import {
  laneStats, quoteLane, laneDensity, winCurve,
  INDICATIVE_FLOOR, CONFIDENT_FLOOR, MAX_CARRIER_SHARE, WIN_CURVE_FLOOR,
  type QuoteOutcome,
} from './pricing';
import { makeFreightWorld, type WorldLoad } from './freightWorld';

const NOW = '2026-09-05T00:00:00.000Z';
const world = makeFreightWorld({ generatedAt: NOW });
const loads = world.loads;

const densest = laneDensity(loads).densest[0];

describe('pricing - density is the commercial argument, measured', () => {
  const d = laneDensity(loads);

  it('counts what the book can and cannot price', () => {
    expect(d.pairs).toBeGreaterThan(50);
    expect(d.atConfidentFloor + d.unpriceable).toBeLessThanOrEqual(d.pairs);
    // The spine concentration is what makes ANY pair priceable.
    expect(d.atConfidentFloor).toBeGreaterThan(0);
    expect(d.unpriceable).toBeGreaterThan(0);
  });

  it('accounts for every pair', () => {
    const mid = d.atIndicativeFloor - d.atConfidentFloor;
    expect(d.atConfidentFloor + mid + d.unpriceable).toBe(d.pairs);
  });
});

describe('pricing - three outcomes, and the refusals are the product', () => {
  it('prices the densest lane and states everything behind it', () => {
    const q = quoteLane(loads, densest.laneId, densest.equipment);
    expect(q.status).toBe('priced');
    if (q.status !== 'priced') return;
    for (const s of ['settled', 'carriers', 'IQR', 'spread', 'Work within', 'Ties up']) {
      expect(q.renderedClaim).toContain(s);
    }
    expect(q.workingBand.low).toBeLessThan(q.quoted.amount);
    expect(q.workingBand.high).toBeGreaterThan(q.quoted.amount);
    expect(q.quoted.currency).toBe('CAD');
  });

  it('refuses a lane with no history at all', () => {
    const q = quoteLane(loads, 'ZZZ-YYY', 'van_53');
    expect(q.status).toBe('refused');
    if (q.status !== 'refused') return;
    expect(q.reason).toBe('no_lane_history');
    expect(q.fallback.length).toBeGreaterThan(20);
  });

  it('refuses below the indicative floor, and names a fallback', () => {
    const thin = loads.filter(l => l.laneId === densest.laneId && l.equipment === densest.equipment).slice(0, 4);
    const q = quoteLane(thin, densest.laneId, densest.equipment);
    expect(q.status).toBe('refused');
    if (q.status !== 'refused') return;
    expect(q.reason).toBe('insufficient_lane_history');
    expect(q.renderedClaim).toContain('do not make a median');
  });

  it('widens the band for low confidence AND for observed spread', () => {
    const all = loads.filter(l => l.laneId === densest.laneId && l.equipment === densest.equipment);
    expect(all.length).toBeGreaterThanOrEqual(CONFIDENT_FLOOR);
    const confident = quoteLane(all, densest.laneId, densest.equipment);
    const indicative = quoteLane(all.slice(0, INDICATIVE_FLOOR + 2), densest.laneId, densest.equipment);
    if (confident.status !== 'priced' || indicative.status !== 'priced') throw new Error('both should price');
    expect(confident.confidence).toBe('confident');
    expect(indicative.confidence).toBe('indicative');
    const width = (q: typeof confident) => (q.workingBand.high - q.workingBand.low) / q.quoted.amount;
    expect(width(indicative)).toBeGreaterThan(width(confident) - 1e-9);
  });
});

describe('pricing - the refusal that looks like a false negative and is not', () => {
  const all = loads.filter(l => l.laneId === densest.laneId && l.equipment === densest.equipment);

  it('REFUSES a long history that sits on one carrier', () => {
    // n over one carrier is ONE OBSERVATION REPEATED. Most pricing tools quote
    // confidently here.
    const oneCarrier: WorldLoad[] = all.map(l => ({ ...l, carrierId: 'CX-001' }));
    expect(oneCarrier.length).toBeGreaterThanOrEqual(CONFIDENT_FLOOR);
    const q = quoteLane(oneCarrier, densest.laneId, densest.equipment);
    expect(q.status).toBe('refused');
    if (q.status !== 'refused') return;
    expect(q.reason).toBe('carrier_concentration');
    expect(q.renderedClaim).toContain('whether you are paying market');
  });

  it('ALSO refuses a history merely dominated by one carrier', () => {
    // The generalisation. A rule keyed on `distinctCarriers > 1` passes 15-of-17
    // on one carrier, which is not meaningfully better than 17-of-17.
    const dominated: WorldLoad[] = all.map((l, i) => ({ ...l, carrierId: i === 0 ? 'CX-002' : 'CX-001' }));
    const q = quoteLane(dominated, densest.laneId, densest.equipment);
    expect(q.status).toBe('refused');
    if (q.status !== 'refused') return;
    expect(q.reason).toBe('carrier_concentration');
    expect(q.observed).toContain('ceiling');
  });

  it('measures concentration as a share, not a count', () => {
    const s = laneStats(all, densest.laneId, densest.equipment)!;
    expect(s.maxCarrierShare).toBeGreaterThan(0);
    expect(s.maxCarrierShare).toBeLessThanOrEqual(1);
    expect(s.maxCarrierShare).toBeLessThanOrEqual(MAX_CARRIER_SHARE);
    expect(s.distinctCarriers).toBeGreaterThan(1);
  });
});

describe('pricing - the win curve refuses a book that records only wins', () => {
  it('REFUSES with no_loss_records, and says why more data will not help', () => {
    // THE LOAD-BEARING REFUSAL. A win rate over won loads is 100% by
    // construction at every margin. Selection defect, not small-n.
    const wonOnly: QuoteOutcome[] = Array.from({ length: 60 }, (_, i) => ({
      laneId: 'TOR-DET', marginPct: 0.12 + (i % 4) * 0.04, won: true,
    }));
    const v = winCurve(wonOnly, 'TOR-DET');
    expect(v.status).toBe('refused');
    if (v.status !== 'refused') return;
    expect(v.reason).toBe('no_loss_records');
    expect(v.remedy).toContain('SELECTION defect');
    expect(v.remedy).toContain('more loads will not fix');
    expect(v.renderedClaim).toContain('100% by construction');
  });

  it('is NOT rescued by adding more won quotes', () => {
    const more: QuoteOutcome[] = Array.from({ length: 5000 }, () => ({
      laneId: 'TOR-DET', marginPct: 0.16, won: true,
    }));
    expect(winCurve(more, 'TOR-DET').status).toBe('refused');
  });

  it('withholds below the quote floor once losses ARE recorded', () => {
    const few: QuoteOutcome[] = [
      { laneId: 'L', marginPct: 0.12, won: true },
      { laneId: 'L', marginPct: 0.2, won: false },
    ];
    const v = winCurve(few, 'L');
    expect(v.status).toBe('refused');
    if (v.status !== 'refused') return;
    expect(v.reason).toBe('insufficient_quotes');
  });

  it('MEASURES once both outcomes are on record - so the refusal is not vacuous', () => {
    // Without this, "refuses" could be all the function ever does.
    const mixed: QuoteOutcome[] = [];
    for (let i = 0; i < WIN_CURVE_FLOOR * 2; i++) {
      const marginPct = 0.12 + (i % 4) * 0.04;
      mixed.push({ laneId: 'L', marginPct, won: marginPct < 0.2 });
    }
    const v = winCurve(mixed, 'L');
    expect(v.status).toBe('measured');
    if (v.status !== 'measured') return;
    expect(v.buckets.length).toBeGreaterThan(1);
    expect(v.highestMarginStillWinning).not.toBeNull();
    expect(v.renderedClaim).toContain('not fitted');
    // The curve must actually slope: high margin wins less.
    const lo = v.buckets[0], hi = v.buckets[v.buckets.length - 1];
    expect(lo.winRate).toBeGreaterThan(hi.winRate);
  });
});
