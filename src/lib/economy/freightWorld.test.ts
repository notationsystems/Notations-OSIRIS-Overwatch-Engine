// src/lib/economy/freightWorld.test.ts
//
// Every pin here exists because the property was MEASURED ABSENT in the
// predecessor design, and the run that lacked it reported success.

import { describe, it, expect } from 'vitest';
import {
  makeFreightWorld, rng, PlantNotBound, PLANT_NOT_BOUND,
  SEASONAL_LANE, SEASONAL_MONTHS, SLIPPING_RECEIVER_CITY,
  UNDERQUOTE_CARRIER_INDEX, worldAttestation, haversineKm,
} from './freightWorld';
import { ALL_LOAD_STATES, TRANSITIONS } from './lifecycle.types';
import { isLegalTransition, detectionLatencySeconds } from './lifecycle';
import { isAdmissible } from './attestation';

const GEN_AT = '2026-08-31T00:00:00.000Z';
const world = makeFreightWorld({ generatedAt: GEN_AT });

describe('freightWorld - population', () => {
  it('produces loads, and accounts for every one not produced', () => {
    const m = world.meta;
    expect(m.loadsProduced).toBeGreaterThan(300);
    expect(m.loadsProduced + m.loadsDroppedNoFacility).toBe(m.loadsRequested);
    // Lanes are pre-filtered to the servable ones, so nothing should drop at all.
    expect(m.loadsDroppedNoFacility).toBe(0);
  });

  it('allocates every carrier id exactly once', () => {
    const ids = world.carriers.map(c => c.carrierId);
    expect(new Set(ids).size).toBe(ids.length);
    // MEASURED ON THE PREDECESSOR: 18 carriers, 17 distinct ids, CX-012 issued
    // to nobody, and the divergence scan's top offender was two carriers merged.
    for (let i = 0; i < world.carriers.length; i++) {
      expect(ids).toContain(`CX-${String(i + 1).padStart(3, '0')}`);
    }
  });

  it('gives the underquote plant the id it was allocated, not another id', () => {
    const c = world.carriers[UNDERQUOTE_CARRIER_INDEX];
    expect(c.quoteBiasPct).toBeCloseTo(-0.11, 5);
    expect(world.meta.plants.find(p => p.id === 'PLANT-1')!.boundTo).toEqual([c.carrierId]);
    expect(world.carriers.filter(x => x.carrierId === c.carrierId)).toHaveLength(1);
  });
});

describe('freightWorld - the transitions are the ENGINE transitions', () => {
  const all = world.loads.flatMap(l => l.transitions);

  it('emits only states the LoadState union actually has', () => {
    const used = new Set(all.flatMap(t => (t.from ? [t.from, t.to] : [t.to])));
    expect(used.size).toBeGreaterThan(6);
    for (const s of used) expect(ALL_LOAD_STATES).toContain(s);
  });

  it('every hop is legal under TRANSITIONS - and there are hops to check', () => {
    // VACUITY PIN: an empty or tiny population would make the loop below pass
    // for free, which is exactly how "5,570 transitions, zero illegal" was
    // reported over 4,392 transitions the real table refuses.
    expect(all.length).toBeGreaterThan(2000);
    const illegal = all.filter(t => t.from !== null && !isLegalTransition(t.from, t.to));
    expect(illegal).toEqual([]);
  });

  it('REFUSES the predecessor chain - so the pin above is not trivially true', () => {
    // Measured: these nine pairs accounted for all 4,392 refused transitions.
    const predecessor: Array<[string, string]> = [
      ['quoted', 'booked'], ['booked', 'assigned'], ['assigned', 'accepted'],
      ['accepted', 'en_route_pickup'], ['en_route_pickup', 'at_pickup'],
      ['at_pickup', 'loaded'], ['in_transit', 'at_delivery'],
      ['at_delivery', 'delivered'], ['delivered', 'invoiced'],
    ];
    for (const [from, to] of predecessor) {
      const legal = (TRANSITIONS as Record<string, readonly string[]>)[from];
      expect(legal === undefined || !legal.includes(to)).toBe(true);
    }
  });

  it('starts at booked with a null predecessor and ends terminal', () => {
    for (const l of world.loads) {
      expect(l.transitions[0].from).toBeNull();
      expect(l.transitions[0].to).toBe('booked');
      expect(l.transitions[l.transitions.length - 1].to).toBe('delivered');
    }
  });

  it('carries invoicing as a FIELD, because delivered is terminal', () => {
    expect(TRANSITIONS.delivered).toEqual([]);
    for (const l of world.loads.slice(0, 20)) {
      expect(l.transitions.some(t => (t.to as string) === 'invoiced')).toBe(false);
      expect(Date.parse(l.invoicedAt)).toBeGreaterThan(Date.parse(l.actualDeliveryAt));
    }
  });

  it('is non-decreasing in occurredAt', () => {
    for (const l of world.loads) {
      let prev = -Infinity;
      for (const t of l.transitions) {
        const at = Date.parse(t.occurredAt);
        expect(at).toBeGreaterThanOrEqual(prev);
        prev = at;
      }
    }
  });

  it('marks geofence-derived instants inferred, so latency refuses to average them', () => {
    const geo = all.filter(t => t.reportedBy === 'geofence');
    expect(geo.length).toBeGreaterThan(500);
    for (const t of geo) {
      expect(t.occurredAtBasis).toBe('inferred');
      expect(detectionLatencySeconds(t)).toBeNull();
    }
    const observed = all.filter(t => t.occurredAtBasis === 'observed');
    expect(observed.every(t => detectionLatencySeconds(t) !== null)).toBe(true);
  });
});

describe('freightWorld - plants bind to things that exist', () => {
  const facIds = new Set(world.facilities.map(f => f.facilityId));
  const carIds = new Set(world.carriers.map(c => c.carrierId));
  const loadIds = new Set(world.loads.map(l => l.loadId));
  const laneIds = new Set(world.lanes.map(l => l.laneId));

  it('every boundTo names a real entity', () => {
    expect(world.meta.plants).toHaveLength(9);
    for (const p of world.meta.plants) {
      expect(p.boundTo.length).toBeGreaterThan(0);
      for (const id of p.boundTo) {
        const known = facIds.has(id) || carIds.has(id) || loadIds.has(id) || laneIds.has(id);
        expect(known, `${p.id} bound to unknown ${id}`).toBe(true);
      }
    }
  });

  it('no two load-bound plants share a load', () => {
    // MEASURED ON THE PREDECESSOR at seed 8: the double-brokering plant and the
    // telemetry-gap plant both fell back onto L-0520, and a runner asking "is
    // this flag present anywhere" reported both found.
    const loadBound = world.meta.plants.flatMap(p => p.boundTo).filter(id => loadIds.has(id));
    expect(new Set(loadBound).size).toBe(loadBound.length);
  });

  it('each flag lands on exactly one load, and that load is the one recorded', () => {
    const byFlag = new Map<string, string[]>();
    for (const l of world.loads) for (const f of l.flags) {
      byFlag.set(f, [...(byFlag.get(f) ?? []), l.loadId]);
    }
    for (const [flag, ids] of byFlag) expect(ids, flag).toHaveLength(1);
    const expectFlag = (plant: string, flag: string) => {
      const p = world.meta.plants.find(x => x.id === plant)!;
      expect(byFlag.get(flag)!.every(id => p.boundTo.includes(id))).toBe(true);
    };
    expectFlag('PLANT-4', 'insurance_lapse_in_window');
    expectFlag('PLANT-5', 'bol_carrier_mismatch');
    expectFlag('PLANT-6', 'reefer_excursion');
    expectFlag('PLANT-7', 'telemetry_gap');
    expectFlag('PLANT-9', 'commitment_retroactive');
  });

  it('binds cleanly across seeds - the predecessor misbound on 3 of 16', () => {
    for (const seed of [20260831, 1, 2, 3, 7, 8, 9, 10, 42, 99, 555, 777, 1234, 31337, 20250101, 20260101]) {
      const w = makeFreightWorld({ seed, generatedAt: GEN_AT });
      const ids = new Set(w.loads.map(l => l.loadId));
      const loadBound = w.meta.plants.flatMap(p => p.boundTo).filter(id => /^L-\d+$/.test(id));
      expect(loadBound.length, `seed ${seed}`).toBe(5);
      for (const id of loadBound) expect(ids.has(id), `seed ${seed} -> ${id}`).toBe(true);
      expect(new Set(loadBound).size, `seed ${seed} collision`).toBe(loadBound.length);
    }
  });

  it('refuses to build rather than emit a world missing its own signal', () => {
    // A world too small to contain a notarized load cannot carry PLANT-6.
    let threw: unknown = null;
    try { makeFreightWorld({ seed: 20260831, loadCount: 1, generatedAt: GEN_AT }); }
    catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(PlantNotBound);
    expect((threw as Error).message).toContain(PLANT_NOT_BOUND);
    expect((threw as Error).message).toContain('look like a pass');
  });
});

describe('freightWorld - determinism', () => {
  it('is byte-identical at one seed, meta included', () => {
    const a = makeFreightWorld({ seed: 4242, generatedAt: GEN_AT });
    const b = makeFreightWorld({ seed: 4242, generatedAt: GEN_AT });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('holds no clock - generatedAt is required and echoed verbatim', () => {
    const w = makeFreightWorld({ seed: 4242, generatedAt: '1999-01-01T00:00:00.000Z' });
    expect(w.meta.generatedAt).toBe('1999-01-01T00:00:00.000Z');
    // MEASURED ON THE PREDECESSOR: two calls at one seed differed in exactly
    // this field, while the file header claimed byte-identical output.
    const twice = [
      makeFreightWorld({ seed: 4242, generatedAt: '1999-01-01T00:00:00.000Z' }).meta.generatedAt,
      makeFreightWorld({ seed: 4242, generatedAt: '1999-01-01T00:00:00.000Z' }).meta.generatedAt,
    ];
    expect(new Set(twice).size).toBe(1);
  });

  it('differs at different seeds', () => {
    const a = makeFreightWorld({ seed: 1, generatedAt: GEN_AT });
    const b = makeFreightWorld({ seed: 2, generatedAt: GEN_AT });
    expect(JSON.stringify(a.loads)).not.toBe(JSON.stringify(b.loads));
  });

  it('rng is the documented mulberry32 and is pure', () => {
    const r1 = rng(7), r2 = rng(7);
    const a = [r1(), r1(), r1()], b = [r2(), r2(), r2()];
    expect(a).toEqual(b);
    expect(a.every(x => x >= 0 && x < 1)).toBe(true);
  });
});

describe('freightWorld - geographic coherence', () => {
  it('delivers every load to a facility in the destination city of its lane', () => {
    // MEASURED ON THE PREDECESSOR: 75 of 488 loads delivered outside the lane's
    // destination city, because the slipping receiver was injected after the
    // lane was chosen. That is what manufactured the PLANT-2/PLANT-8 confound.
    const city = new Map(world.facilities.map(f => [f.facilityId, f.cityCode]));
    for (const l of world.loads) {
      expect(city.get(l.destFacilityId), l.loadId).toBe(l.laneId.split('-')[1]);
      expect(city.get(l.originFacilityId), l.loadId).toBe(l.laneId.split('-')[0]);
    }
  });

  it('keeps the slipping receiver in one city, and CONFOUNDS the seasonal lane', () => {
    const slip = world.meta.plants.find(p => p.id === 'PLANT-2')!.boundTo[0];
    const f = world.facilities.find(x => x.facilityId === slip)!;
    expect(f.cityCode).toBe(SLIPPING_RECEIVER_CITY);
    const lanesIntoSlip = new Set(world.loads.filter(l => l.destFacilityId === slip).map(l => l.laneId));
    expect(lanesIntoSlip.size).toBeGreaterThan(0);
    // Coherent: it only receives freight bound for its own city.
    for (const id of lanesIntoSlip) expect(id.split('-')[1]).toBe(SLIPPING_RECEIVER_CITY);
    // AND CONFOUNDED, ON PURPOSE. This pin previously asserted the opposite.
    // With the seasonal plant on a clean lane, the run showed BOTH the naive
    // calendar-quarter mean and the plant-basis median recovering it, so the
    // fixture could not separate a sound estimator from an unsound one and
    // could not demonstrate the failure it exists to demonstrate. The
    // predecessor's error was manufacturing the confound by delivering loads to
    // a facility in the WRONG CITY, not by having a confound at all.
    expect(lanesIntoSlip.has(SEASONAL_LANE)).toBe(true);
  });

  it('separates the duplicate yard by metres, not kilometres', () => {
    const [a, b] = world.meta.plants.find(p => p.id === 'PLANT-3')!.boundTo
      .map(id => world.facilities.find(f => f.facilityId === id)!);
    const metres = haversineKm(a, b) * 1000;
    expect(metres).toBeGreaterThan(0);
    expect(metres).toBeLessThan(50);
    const norm = (s: string) => s.toLowerCase()
      .replace(/\bdrive\b/g, 'dr').replace(/\bunit \d+\b/g, '').replace(/\s+/g, ' ').trim();
    expect(norm(a.addressRaw)).toBe(norm(b.addressRaw));
  });
});

describe('freightWorld - notary material is ingestible', () => {
  it('emits integer milli readings in non-decreasing time', () => {
    const notarized = world.loads.filter(l => l.readings !== null);
    expect(notarized.length).toBeGreaterThan(30);
    for (const l of notarized) {
      let prev = -Infinity;
      for (const rd of l.readings!) {
        expect(Number.isInteger(rd.valueMilli), `${l.loadId} ${rd.valueMilli}`).toBe(true);
        const at = Date.parse(rd.at);
        expect(at).toBeGreaterThanOrEqual(prev);
        prev = at;
      }
    }
  });

  it('puts the excursion above 8.0 C and the gap at five hours', () => {
    const p6 = world.loads.find(l => l.flags.includes('reefer_excursion'))!;
    expect(p6.readings!.filter(x => x.valueMilli > 8000).length).toBe(5);
    const p7 = world.loads.find(l => l.flags.includes('telemetry_gap'))!;
    const gaps = p7.readings!.slice(1)
      .map((x, i) => Date.parse(x.at) - Date.parse(p7.readings![i].at));
    expect(Math.max(...gaps)).toBe(31 * 10 * 60_000);
  });

  it('posts the retroactive commitment after the interval it covers', () => {
    const p9 = world.loads.find(l => l.flags.includes('commitment_retroactive'))!;
    expect(Date.parse(p9.commitmentPostedAt!) - Date.parse(p9.actualDeliveryAt)).toBe(3 * 86_400_000);
  });
});

describe('freightWorld - nothing here is admissible', () => {
  it('stamps the world representative, so isAdmissible is false', () => {
    expect(world.meta.attestation.evidenceClass).toBe('representative');
    expect(world.meta.attestation.restsOnRepresentative).toBe(true);
    expect(isAdmissible(world.meta.attestation)).toBe(false);
    expect(isAdmissible(worldAttestation('anything'))).toBe(false);
  });
});

describe('freightWorld - the seasonal plant is present in the data', () => {
  it('fires only on the seasonal lane, in the declared months', () => {
    const seasonal = world.loads.filter(l => l.laneId === SEASONAL_LANE);
    expect(seasonal.length).toBeGreaterThan(20);
    const inSeason = seasonal.filter(l =>
      SEASONAL_MONTHS.includes(new Date(l.promisedPickupAt).getUTCMonth()));
    const outSeason = seasonal.filter(l =>
      !SEASONAL_MONTHS.includes(new Date(l.promisedPickupAt).getUTCMonth()));
    expect(inSeason.length).toBeGreaterThan(3);
    expect(outSeason.length).toBeGreaterThan(3);
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    expect(med(inSeason.map(l => l.detentionMinutes)))
      .toBeGreaterThan(med(outSeason.map(l => l.detentionMinutes)));
  });
});
