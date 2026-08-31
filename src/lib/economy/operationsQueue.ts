import { quoteLane, type LaneObservation, type PricingPolicy, type QuoteResult } from './pricing';
import { isAdmissible, type Attestation } from './attestation';

/**
 * Payload — the operations queue: what a broker looks at first.
 *
 * THE THREE LISTS ARE NOT A GROUPING OF ONE OUTCOME (ledger phase 81). They are
 * three DIFFERENT KINDS OF NOT-PRICED, and the whole value of the screen is
 * that they are not stacked together:
 *
 *   PRICED    — a number, with its confidence and its band.
 *   BLOCKED   — the pricer was never asked, because an input the quote requires
 *               is absent. The remedy is to go and get one field.
 *   REFUSED   — the pricer was asked, and declined with a clause. The remedy is
 *               a decision: price it another way, or build the history.
 *
 * Collapsing BLOCKED into REFUSED is the specific error this module exists to
 * prevent. "We cannot price this lane" sends an operator to look at the lane;
 * "this load has no equipment type" sends them to look at the load, and it is a
 * thirty-second fix. Both render as an unpriced row on every freight tool I
 * have seen, and the difference between them is the difference between a
 * morning of work and a morning of shrugging.
 *
 * The distinction is the same one the pricer already makes internally between
 * `stale_history` and `no_cost_data` — a lane with forty loads outside the
 * window is not a lane with no history — carried up one level to the load.
 *
 * CONSERVATION IS THE POINT. Every pending load lands in exactly one list, and
 * the census is computed from the lists rather than counted alongside them, so
 * a load cannot be dropped on the way through. A queue that silently loses a
 * load is worse than no queue: the operator believes they have seen the book.
 */

/** What the queue needs before it can ask for a quote. */
export interface PendingLoad {
  readonly loadId: string;
  readonly laneId?: string | null;
  readonly equipment?: string | null;
  readonly paymentTermsDays?: number | null;
  /** Free-form, carried through so the operator can find the load. */
  readonly reference?: string;
}

/**
 * The fields a quote cannot proceed without, named so the block can say which
 * one is missing rather than that something is.
 */
const REQUIRED_FIELDS = [
  { field: 'laneId', label: 'lane', get: (l: PendingLoad) => l.laneId },
  { field: 'equipment', label: 'equipment type', get: (l: PendingLoad) => l.equipment },
] as const;

export interface BlockedEntry {
  readonly load: PendingLoad;
  /** Every missing field, not just the first — one trip, not three. */
  readonly missing: readonly string[];
  readonly remedy: string;
  readonly renderedClaim: string;
}

export interface PricedEntry {
  readonly load: PendingLoad;
  readonly quote: Extract<QuoteResult, { status: 'priced' }>;
}

export interface RefusedEntry {
  readonly load: PendingLoad;
  readonly quote: Extract<QuoteResult, { status: 'refused' }>;
}

export interface QueueCensus {
  readonly pending: number;
  readonly priced: number;
  readonly blocked: number;
  readonly refused: number;
  /**
   * True when the three lists account for every pending load. Derived, not
   * asserted: it is computed from the lists themselves.
   */
  readonly conserved: boolean;
}

export interface OperationsQueue {
  readonly priced: readonly PricedEntry[];
  readonly blocked: readonly BlockedEntry[];
  readonly refused: readonly RefusedEntry[];
  readonly census: QueueCensus;
  readonly asOf: string;
  /**
   * Carried from the observations the quotes were computed from. A queue built
   * on the simulated world rests on representative evidence, so nothing on this
   * screen is admissible and the screen has to say so — the operator is looking
   * at a shape, not at their book.
   */
  readonly attestation: Attestation;
  readonly admissible: boolean;
}

export function buildOperationsQueue(args: {
  pending: readonly PendingLoad[];
  observations: readonly LaneObservation[];
  asOf: string;
  attestation: Attestation;
  defaultPaymentTermsDays?: number;
  policy?: PricingPolicy;
}): OperationsQueue {
  const priced: PricedEntry[] = [];
  const blocked: BlockedEntry[] = [];
  const refused: RefusedEntry[] = [];

  for (const load of args.pending) {
    const missing = REQUIRED_FIELDS.filter((f) => {
      const v = f.get(load);
      return v === undefined || v === null || String(v).trim() === '';
    }).map((f) => f.label);

    if (missing.length) {
      // NOT a refusal. The pricer was never asked, and saying "we cannot price
      // this" would describe the lane when the problem is the load.
      blocked.push({
        load,
        missing,
        remedy: `Add ${missing.join(' and ')} to ${load.loadId}, then it can be quoted.`,
        renderedClaim:
          `NOT EVALUATED — ${load.loadId} is missing ${missing.join(' and ')}. ` +
          `This is not a pricing refusal: the quote was never attempted.`,
      });
      continue;
    }

    const quote = quoteLane({
      obs: args.observations,
      laneId: load.laneId as string,
      equipment: load.equipment as string,
      asOf: args.asOf,
      paymentTermsDays: load.paymentTermsDays ?? args.defaultPaymentTermsDays ?? 30,
      policy: args.policy,
    });

    if (quote.status === 'priced') priced.push({ load, quote });
    else refused.push({ load, quote });
  }

  const census: QueueCensus = {
    pending: args.pending.length,
    priced: priced.length,
    blocked: blocked.length,
    refused: refused.length,
    conserved: priced.length + blocked.length + refused.length === args.pending.length,
  };

  return {
    priced,
    blocked,
    refused,
    census,
    asOf: args.asOf,
    attestation: args.attestation,
    admissible: isAdmissible(args.attestation),
  };
}
