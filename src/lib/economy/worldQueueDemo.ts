import { makeFreightWorld, type WorldLoad } from './freightWorld';
import { buildOperationsQueue, type OperationsQueue, type PendingLoad } from './operationsQueue';
import { type LaneObservation } from './pricing';

/**
 * Payload — wiring the simulated world into the operations queue, FOR DEMO.
 *
 * WHY THIS IS A SEPARATE FILE (ledger phase 82). Phase 67 reconciled two
 * versions of `pricing.ts` and adopted the one taking `LaneObservation` rather
 * than `WorldLoad`, on the grounds that the second *"makes the fixture
 * generator a dependency of the product"*. `operationsQueue` inherits that
 * rule: it knows nothing about `freightWorld`, and the adapter that joins them
 * lives here, where it can be deleted the day a real book arrives without
 * touching the product.
 *
 * Everything this module produces rests on representative evidence, and the
 * attestation says so all the way to the screen.
 */

/** One settled world load, in the shape the pricer actually takes. */
export function observationFromWorldLoad(l: WorldLoad): LaneObservation {
  return {
    loadId: l.loadId,
    laneId: l.laneId,
    equipment: l.equipment,
    carrierRate: l.carrierRate,
    quotedToShipper: l.quotedToShipper,
    carrierInvoice: l.carrierInvoice,
    accessorialsBilled: l.accessorialsBilled,
    detentionMinutes: l.detentionMinutes,
    deliveredAt: l.actualDeliveryAt,
    carrierId: l.carrierId,
    // A book of settled loads is all `true` by construction. `winCurve`
    // refuses on exactly that, and this does not pretend otherwise.
    won: true,
  };
}

export interface DemoQueue extends OperationsQueue {
  /**
   * WHY THE BLOCKED LIST IS EMPTY HERE, carried so the screen can say it.
   *
   * A blocked load is one whose booking is incomplete — no equipment type, no
   * lane. That is an ordinary event in a real book and an IMPOSSIBLE one in
   * this fixture: `WorldLoad` types `equipment` and `laneId` as required, so
   * the generator cannot emit a load missing either.
   *
   * So the empty BLOCKED column is a fact about the FIXTURE, not about the
   * business, and the two are different claims. Filling it with invented
   * incomplete loads would make the screen demonstrate a feature by lying
   * about the book — which is the one thing this project does not do to make
   * a demo look complete.
   */
  readonly blockedWarrant: string;
}

export const BLOCKED_WARRANT_FIXTURE =
  'No load in this book is missing a required field, because the simulated world types ' +
  'lane and equipment as mandatory and cannot generate an incomplete booking. This column ' +
  'is empty as a property of the fixture, not of the business — a real book blocks loads here.';

/**
 * Build the queue the demo screen renders.
 *
 * The pending set is the most recent bookings, treated as awaiting a quote.
 * They are drawn from the same world as the history, so the queue is answering
 * about lanes it has some record of — which is the realistic case, and the one
 * where the priced/refused split is informative rather than uniform.
 */
export function buildDemoQueue(opts: {
  generatedAt: string;
  asOf?: string;
  pendingCount?: number;
}): DemoQueue {
  const world = makeFreightWorld({ generatedAt: opts.generatedAt });
  const asOf = opts.asOf ?? opts.generatedAt;
  const pendingCount = opts.pendingCount ?? 12;

  const settled = [...world.loads].sort(
    (a, b) => Date.parse(a.actualDeliveryAt) - Date.parse(b.actualDeliveryAt),
  );

  // The most recent loads stand in for today's unquoted bookings; the rest are
  // the history the quote is computed from. Splitting rather than reusing keeps
  // a load from pricing itself.
  const pendingSource = settled.slice(-pendingCount);
  const historySource = settled.slice(0, Math.max(0, settled.length - pendingCount));

  const pending: PendingLoad[] = pendingSource.map((l) => ({
    loadId: l.loadId,
    laneId: l.laneId,
    equipment: l.equipment,
    reference: `${l.shipperId} · ${l.commodity}`,
  }));

  const queue = buildOperationsQueue({
    pending,
    observations: historySource.map(observationFromWorldLoad),
    asOf,
    attestation: world.meta.attestation,
  });

  return { ...queue, blockedWarrant: BLOCKED_WARRANT_FIXTURE };
}
