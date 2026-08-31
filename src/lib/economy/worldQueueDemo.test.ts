import { describe, it, expect } from 'vitest';
import { buildDemoQueue, observationFromWorldLoad, BLOCKED_WARRANT_FIXTURE } from './worldQueueDemo';
import { makeFreightWorld } from './freightWorld';

const GEN = '2026-08-31T00:00:00.000Z';

describe('the demo queue is built from the world without the product knowing', () => {
  it('produces a conserved queue over the pending set', () => {
    const q = buildDemoQueue({ generatedAt: GEN, pendingCount: 14 });
    expect(q.census.pending).toBe(14);
    expect(q.census.conserved).toBe(true);
    expect(q.census.priced + q.census.blocked + q.census.refused).toBe(14);
  });

  it('is deterministic for a seed, so the screen does not change under the reader', () => {
    const a = buildDemoQueue({ generatedAt: GEN, pendingCount: 14 });
    const b = buildDemoQueue({ generatedAt: GEN, pendingCount: 14 });
    expect(a.census).toEqual(b.census);
    expect(a.priced.map((p) => p.load.loadId)).toEqual(b.priced.map((p) => p.load.loadId));
  });

  it('never reports itself admissible', () => {
    expect(buildDemoQueue({ generatedAt: GEN }).admissible).toBe(false);
  });

  /**
   * THE EMPTY COLUMN CARRIES ITS WARRANT. A blocked load is impossible in this
   * fixture — `WorldLoad` types lane and equipment as required — so the column
   * is empty as a property of the FIXTURE, not of the business. Filling it with
   * invented incomplete loads would make the screen demonstrate a feature by
   * lying about the book.
   */
  it('leaves BLOCKED empty and says why, rather than fabricating one', () => {
    const q = buildDemoQueue({ generatedAt: GEN, pendingCount: 14 });
    expect(q.blocked).toHaveLength(0);
    expect(q.blockedWarrant).toBe(BLOCKED_WARRANT_FIXTURE);
    expect(q.blockedWarrant).toMatch(/property of the fixture, not of the business/);
  });

  it('draws every quote from history that excludes the pending set', () => {
    const q = buildDemoQueue({ generatedAt: GEN, pendingCount: 14 });
    const pendingIds = new Set([
      ...q.priced.map((e) => e.load.loadId),
      ...q.refused.map((e) => e.load.loadId),
      ...q.blocked.map((e) => e.load.loadId),
    ]);
    expect(pendingIds.size).toBe(14);
    for (const { quote } of q.priced) expect(quote.stat.nUsed).toBeGreaterThan(0);
  });
});

describe('the adapter carries what the pricer needs and claims nothing more', () => {
  it('maps a world load into a lane observation', () => {
    const world = makeFreightWorld({ generatedAt: GEN });
    const l = world.loads[0];
    const o = observationFromWorldLoad(l);
    expect(o.loadId).toBe(l.loadId);
    expect(o.laneId).toBe(l.laneId);
    expect(o.deliveredAt).toBe(l.actualDeliveryAt);
    expect(o.carrierInvoice).toBe(l.carrierInvoice);
    // A book of settled loads is all `true` by construction; winCurve refuses
    // on exactly that, and this does not pretend otherwise.
    expect(o.won).toBe(true);
  });
});
