import { describe, it, expect } from 'vitest';
import { buildOperationsQueue, type PendingLoad } from './operationsQueue';
import { type LaneObservation } from './pricing';
import { attestationOf } from './attestation';

/**
 * THREE KINDS OF NOT-PRICED, KEPT APART (ledger phase 81).
 *
 * The screen's whole value is that BLOCKED and REFUSED are different work.
 * "We cannot price this lane" sends an operator to the lane; "this load has no
 * equipment type" sends them to the load, and it is a thirty-second fix. Every
 * freight tool renders both as an unpriced row.
 */

const REPRESENTATIVE = attestationOf('representative', 'low', 'unknown', 'test fixture');

function obs(n: number, laneId = 'TOR-DET', equipment = 'van_53'): LaneObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    loadId: `L${i}`,
    laneId,
    equipment,
    carrierRate: 900 + i,
    quotedToShipper: 1100 + i,
    carrierInvoice: 900 + i,
    accessorialsBilled: 0,
    detentionMinutes: 0,
    deliveredAt: new Date(Date.parse('2026-08-01T00:00:00Z') - i * 86_400_000).toISOString(),
    carrierId: `C${i % 9}`,
    won: true,
  }));
}

const ASOF = '2026-08-31T00:00:00Z';

const build = (pending: PendingLoad[], observations: LaneObservation[] = obs(40)) =>
  buildOperationsQueue({ pending, observations, asOf: ASOF, attestation: REPRESENTATIVE });

describe('a load missing a field is BLOCKED, not refused', () => {
  it('blocks a load with no equipment and names the field', () => {
    const q = build([{ loadId: 'P1', laneId: 'TOR-DET', equipment: null }]);
    expect(q.blocked).toHaveLength(1);
    expect(q.refused).toHaveLength(0);
    expect(q.blocked[0].missing).toEqual(['equipment type']);
    expect(q.blocked[0].remedy).toMatch(/Add equipment type to P1/);
  });

  it('names every missing field, so it is one trip and not three', () => {
    const q = build([{ loadId: 'P2' }]);
    expect(q.blocked[0].missing).toEqual(['lane', 'equipment type']);
  });

  /**
   * THE DISCRIMINATING PAIR, and the reason this module exists. The same load
   * is BLOCKED when its equipment is absent and REFUSED when the equipment is
   * present but the lane has no history — two different remedies, which a
   * single "unpriced" bucket would have made one.
   */
  it('separates the missing field from the missing history', () => {
    const blocked = build([{ loadId: 'P3', laneId: 'TOR-DET', equipment: '' }]);
    const refused = build([{ loadId: 'P3', laneId: 'NOWHERE-XX', equipment: 'van_53' }]);

    expect(blocked.blocked).toHaveLength(1);
    expect(blocked.refused).toHaveLength(0);
    expect(refused.refused).toHaveLength(1);
    expect(refused.blocked).toHaveLength(0);

    expect(blocked.blocked[0].renderedClaim).toMatch(/the quote was never attempted/);
    expect(refused.refused[0].quote.reason).toBeTruthy();
    expect(refused.refused[0].quote.remedy).toBeTruthy();
  });

  it('treats whitespace as absent rather than as a value', () => {
    expect(build([{ loadId: 'P4', laneId: '   ', equipment: 'van_53' }]).blocked).toHaveLength(1);
  });
});

describe('a refusal arrives with its clause', () => {
  it('carries the reason, the fallback and the remedy', () => {
    const q = build([{ loadId: 'P5', laneId: 'NOWHERE-XX', equipment: 'van_53' }]);
    const r = q.refused[0].quote;
    expect(r.status).toBe('refused');
    expect(r.fallback.length).toBeGreaterThan(10);
    expect(r.remedy.length).toBeGreaterThan(10);
    expect(r.renderedClaim.length).toBeGreaterThan(10);
  });
});

describe('a priced load carries its confidence', () => {
  it('prices a lane with enough recent history', () => {
    const q = build([{ loadId: 'P6', laneId: 'TOR-DET', equipment: 'van_53' }]);
    expect(q.priced).toHaveLength(1);
    expect(['confident', 'indicative']).toContain(q.priced[0].quote.confidence);
    expect(q.priced[0].quote.components.quote).toBeGreaterThan(0);
  });
});

describe('conservation — a queue that loses a load is worse than no queue', () => {
  /**
   * Row accounting, applied to the morning screen. The operator believes they
   * have seen the book; a silently dropped load makes that belief false, and
   * nothing on the page would look wrong.
   */
  it('lands every pending load in exactly one list', () => {
    const pending: PendingLoad[] = [
      { loadId: 'A', laneId: 'TOR-DET', equipment: 'van_53' },
      { loadId: 'B', laneId: 'NOWHERE-XX', equipment: 'van_53' },
      { loadId: 'C', laneId: 'TOR-DET' },
      { loadId: 'D' },
    ];
    const q = build(pending);
    expect(q.census.pending).toBe(4);
    expect(q.census.priced + q.census.blocked + q.census.refused).toBe(4);
    expect(q.census.conserved).toBe(true);

    const seen = [
      ...q.priced.map((e) => e.load.loadId),
      ...q.blocked.map((e) => e.load.loadId),
      ...q.refused.map((e) => e.load.loadId),
    ].sort();
    expect(seen).toEqual(['A', 'B', 'C', 'D']);
  });

  it('is conserved on an empty book, and says the book was empty', () => {
    const q = build([]);
    expect(q.census).toMatchObject({ pending: 0, priced: 0, blocked: 0, refused: 0, conserved: true });
  });
});

describe('nothing built on the simulated world is admissible', () => {
  /**
   * The queue rests on whatever evidence its observations rest on. Built from
   * the representative world it is a SHAPE, not the operator's book, and the
   * screen has to say so — a morning view that looks authoritative while
   * resting on a fixture is the most expensive possible version of this defect.
   */
  it('propagates the representative attestation and refuses admissibility', () => {
    const q = build([{ loadId: 'P7', laneId: 'TOR-DET', equipment: 'van_53' }]);
    expect(q.attestation.evidenceClass).toBe('representative');
    expect(q.admissible).toBe(false);
  });
});
