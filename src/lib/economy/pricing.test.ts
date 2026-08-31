import { describe, it, expect } from 'vitest';
import {
  laneStat, quoteLane, laneDensity, winCurve, capitalProfile, observationsFrom,
  DEFAULT_PRICING, type LaneObservation,
} from './pricing';
import { makeFreightWorld } from './freightWorld';

const NOW = '2026-09-05T00:00:00.000Z';
const world = makeFreightWorld({ generatedAt: NOW });
// The world spans 24 months; the pricer's window is 270 days, so evaluate at the
// end of the book rather than after it — otherwise every observation is stale,
// which is a real refusal and not the one under test here.
const ASOF = world.loads.map(l => l.actualDeliveryAt).sort().reverse()[0];
const obs = observationsFrom(world.loads);
const loads = obs;

const densest = laneDensity(obs, ASOF).inWindow.densest[0];
const q = (o: readonly LaneObservation[], laneId: string, equipment: string) =>
  quoteLane({ obs: o, laneId, equipment, asOf: ASOF, paymentTermsDays: 45 });

describe('pricing - density is the commercial argument, measured', () => {
  const d = laneDensity(obs, ASOF);

  it('accounts for every pair, on BOTH populations', () => {
    for (const t of [d.allTime, d.inWindow]) {
      expect(t.atConfidentFloor + (t.atIndicativeFloor - t.atConfidentFloor) + t.unpriceable)
        .toBe(d.pairs);
    }
  });

  it('reports the in-window population, not only the flattering all-time one', () => {
    // MEASURED on this book: all-time says 18 pairs price confidently; in-window
    // says NONE do. An earlier version of laneDensity counted all-time while
    // quoteLane refused anything stale — the report and the quoter answering one
    // question over two populations, with the report always the optimistic half.
    expect(d.allTime.atConfidentFloor).toBeGreaterThan(d.inWindow.atConfidentFloor);
    expect(d.inWindow.unpriceable).toBeGreaterThanOrEqual(d.allTime.unpriceable);
  });

  it('shows that currency, not volume alone, is what is missing', () => {
    // At ~8.7 loads/week over 206 pairs, no pair reaches 20 inside 270 days. The
    // remedy is fewer lanes or more volume, NOT a longer window.
    expect(d.inWindow.atConfidentFloor).toBe(0);
    expect(d.inWindow.atIndicativeFloor).toBeGreaterThan(0);
    expect(d.maxAgeDays).toBe(DEFAULT_PRICING.maxAgeDays);
  });
});

describe('pricing - the statistic names every denominator', () => {
  const s = laneStat(obs, densest.laneId, densest.equipment, ASOF);

  it('accounts for what the age filter dropped, rather than leaving a difference', () => {
    expect(s.n).toBe(s.nUsed + s.droppedStale + s.droppedUnsettled);
    expect(s.droppedStale).toBeGreaterThan(0);   // a 24-month book, a 270-day window
  });

  it('separates HOW MUCH history from HOW CURRENT it is', () => {
    // "from 37 loads over 676 days" reads as depth and can equally mean the most
    // recent load settled a year ago. An earlier version of this module reported
    // only the span, and rendered a 676-day window as a virtue.
    expect(s.windowDays).toBeLessThanOrEqual(DEFAULT_PRICING.maxAgeDays);
    expect(s.stalenessDays).toBeGreaterThanOrEqual(0);
    expect(s.stalenessDays).toBeLessThan(DEFAULT_PRICING.maxAgeDays);
  });

  it('carries BOTH accessorial figures, because they are denominated differently', () => {
    // MEASURED on TOR-DET van_53, n=37, $5,070 billed: expected per load is
    // $137.03 and `perLoad x incidence` gives $44.44 — understating 3.1x,
    // because perLoad already averages over the zeros.
    expect(s.accessorialWhenIncurred).toBeGreaterThan(s.accessorialPerLoad);
    expect(s.accessorialPerLoad).toBeCloseTo(s.accessorialWhenIncurred * s.accessorialIncidence, 6);
  });

  it('measures concentration as a share, not a count', () => {
    expect(s.maxCarrierShare).toBeGreaterThan(0);
    expect(s.maxCarrierShare).toBeLessThanOrEqual(1);
    expect(s.distinctCarriers).toBeGreaterThan(1);
  });
});

describe('pricing - three outcomes, and the refusals are the product', () => {
  it('prices the densest lane and states everything behind it', () => {
    const r = q(obs, densest.laneId, densest.equipment);
    expect(r.status).toBe('priced');
    if (r.status !== 'priced') return;
    for (const t of ['settled', 'carriers', 'spanning', 'current to', 'IQR',
                     'incur one', 'Work within', 'Ties up']) {
      expect(r.renderedClaim, t).toContain(t);
    }
    expect(r.band.low).toBeLessThan(r.components.quote);
    expect(r.band.high).toBeGreaterThan(r.components.quote);
  });

  it('prices the accessorial exposure at the per-load figure, not the double discount', () => {
    const r = q(obs, densest.laneId, densest.equipment);
    if (r.status !== 'priced') throw new Error('expected priced');
    expect(r.components.accessorialExposure)
      .toBe(Math.round(r.stat.accessorialPerLoad));
    const doubleDiscounted = Math.round(r.stat.accessorialPerLoad * r.stat.accessorialIncidence);
    expect(r.components.accessorialExposure).toBeGreaterThan(doubleDiscounted);
  });

  it('refuses a lane with no history at all', () => {
    const r = q(obs, 'ZZZ-YYY', 'van_53');
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no_cost_data');
    expect(r.fallback.length).toBeGreaterThan(20);
  });

  it('says STALE rather than "insufficient" when the history exists but is old', () => {
    // WHICH KIND OF NOTHING. A lane with 40 loads all beyond the window is not a
    // lane with no history, and telling an operator to go build history they
    // already have is the wrong remedy.
    const r = quoteLane({
      obs, laneId: densest.laneId, equipment: densest.equipment,
      asOf: '2030-01-01T00:00:00.000Z', paymentTermsDays: 45,
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('stale_history');
    expect(r.remedy).toContain('STALE, not absent');
  });

  it('refuses below the indicative floor, and names a fallback', () => {
    const thin = obs.filter(o => o.laneId === densest.laneId && o.equipment === densest.equipment)
      .sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1)).slice(0, 4);
    const r = q(thin, densest.laneId, densest.equipment);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('insufficient_lane_history');
    expect(r.remedy).toContain('noise wearing a number');
  });

  it('widens the band for low confidence, holding spread constant', () => {
    // ISOLATE THE VARIABLE. A first version compared the full lane against a
    // 6-load slice and asserted the slice's band was wider — but the slice can
    // have a NARROWER IQR, so the test conflated confidence with spread and
    // failed for a correct reason. Identical costs give zero spread, leaving
    // only the confidence adder.
    const flat = (n: number): LaneObservation[] =>
      Array.from({ length: n }, (_, i) => ({
        ...obs[0], loadId: `F-${i}`, laneId: 'FLAT', equipment: 'van_53',
        carrierRate: 1000, quotedToShipper: 1200, carrierInvoice: 1000,
        accessorialsBilled: 0, carrierId: `CX-${i % 5}`, deliveredAt: ASOF,
      }));
    const confident = q(flat(DEFAULT_PRICING.confidentFloor), 'FLAT', 'van_53');
    const indicative = q(flat(DEFAULT_PRICING.indicativeFloor + 1), 'FLAT', 'van_53');
    if (confident.status !== 'priced' || indicative.status !== 'priced') {
      throw new Error(`both should price: ${confident.status}/${indicative.status}`);
    }
    expect(confident.confidence).toBe('confident');
    expect(indicative.confidence).toBe('indicative');
    expect(confident.stat.spreadPct).toBe(0);
    expect(indicative.stat.spreadPct).toBe(0);
    const w = (r: typeof confident) => (r.band.high - r.band.low) / r.components.quote;
    expect(w(indicative)).toBeGreaterThan(w(confident));
  });

  it('widens the band for observed spread, holding confidence constant', () => {
    const withSpread = (hi: number): LaneObservation[] =>
      Array.from({ length: DEFAULT_PRICING.confidentFloor }, (_, i) => ({
        ...obs[0], loadId: `S-${i}`, laneId: 'SPREAD', equipment: 'van_53',
        carrierRate: 1000, quotedToShipper: 1200,
        carrierInvoice: i % 2 === 0 ? 1000 : hi,
        accessorialsBilled: 0, carrierId: `CX-${i % 5}`, deliveredAt: ASOF,
      }));
    const tight = q(withSpread(1010), 'SPREAD', 'van_53');
    const wide = q(withSpread(1600), 'SPREAD', 'van_53');
    if (tight.status !== 'priced' || wide.status !== 'priced') throw new Error('both should price');
    expect(wide.stat.spreadPct).toBeGreaterThan(tight.stat.spreadPct);
    const w = (r: typeof tight) => (r.band.high - r.band.low) / r.components.quote;
    expect(w(wide)).toBeGreaterThan(w(tight));
  });

  it('refuses a margin plus financing that leaves no price', () => {
    expect(() => quoteLane({
      obs, laneId: densest.laneId, equipment: densest.equipment, asOf: ASOF,
      paymentTermsDays: 45,
      policy: { ...DEFAULT_PRICING, targetMarginPct: 0.8, financingCostPct: 0.25 },
    })).toThrow(/no price that satisfies/);
  });
});

describe('pricing - the refusal that looks like a false negative and is not', () => {
  const all = obs.filter(o => o.laneId === densest.laneId && o.equipment === densest.equipment);

  it('REFUSES a long history that sits on one carrier', () => {
    const one = all.map(o => ({ ...o, carrierId: 'CX-001' }));
    const r = q(one, densest.laneId, densest.equipment);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('carrier_concentration');
    expect(r.remedy).toContain('whether you are paying market');
  });

  it('ALSO refuses a history merely DOMINATED by one carrier', () => {
    // `distinctCarriers > 1` passes 15-of-17, which is not meaningfully better
    // than 17-of-17.
    const dom = all.map((o, i) => ({ ...o, carrierId: i === 0 ? 'CX-002' : 'CX-001' }));
    const r = q(dom, densest.laneId, densest.equipment);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('carrier_concentration');
    expect(r.remedy).toContain('ceiling');
  });
});

describe('pricing - capital is an amount AND a duration', () => {
  it('ties up one carrier cost, for the days it is outstanding', () => {
    // Both earlier versions were a hybrid: one gave `cost x terms/30`, which at
    // 45-day terms is 1.5x the carrier cost for a single load — an amount nobody
    // ever finances.
    const c = capitalProfile(1000, 45, 5);
    expect(c.perLoad).toBe(1000);
    expect(c.outstandingDays).toBe(40);
  });

  it('derives working capital from a RATE, and refuses without one', () => {
    const c = capitalProfile(1000, 45, 5);
    expect(c.atRate(10)).toBe(Math.round(1000 * 10 * (40 / 7)));
    expect(() => c.atRate(0)).toThrow(/undefined question/);
  });

  it('never goes negative when the carrier is paid after the shipper', () => {
    expect(capitalProfile(1000, 15, 30).outstandingDays).toBe(0);
  });
});

describe('pricing - the win curve refuses a book that records only wins', () => {
  it('REFUSES with no_loss_records, and says why more data will not help', () => {
    const r = winCurve(obs, densest.laneId);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no_loss_records');
    expect(r.remedy).toContain('SELECTION defect');
    expect(r.remedy).toContain('more quotes will not fix');
    expect(r.renderedClaim).toContain('100% by construction');
  });

  it('is NOT rescued by adding more won quotes', () => {
    const more: LaneObservation[] = Array.from({ length: 5000 }, (_, i) => ({
      ...obs[0], loadId: `X-${i}`, won: true,
    }));
    expect(winCurve(more, obs[0].laneId).status).toBe('refused');
  });

  it('withholds below the quote floor once losses ARE recorded', () => {
    const few: LaneObservation[] = [
      { ...obs[0], laneId: 'L', won: true },
      { ...obs[0], laneId: 'L', won: false },
    ];
    const r = winCurve(few, 'L');
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('insufficient_quotes');
  });

  it('MEASURES once both outcomes are on record - so the refusal is not vacuous', () => {
    const mixed: LaneObservation[] = [];
    for (let i = 0; i < 60; i++) {
      const marginPct = [0.10, 0.14, 0.18, 0.23][i % 4];
      mixed.push({
        ...obs[0], loadId: `M-${i}`, laneId: 'L',
        carrierRate: 1000, quotedToShipper: Math.round(1000 / (1 - marginPct)),
        won: marginPct < 0.18,
      });
    }
    const r = winCurve(mixed, 'L');
    expect(r.status).toBe('measured');
    if (r.status !== 'measured') return;
    expect(r.points.length).toBeGreaterThan(1);
    expect(r.renderedClaim).toContain('not fitted');
    expect(r.points[0].winRate).toBeGreaterThan(r.points[r.points.length - 1].winRate);
  });
});
