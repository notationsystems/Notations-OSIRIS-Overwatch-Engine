// src/lib/economy/simulatedExtractor.ts
//
// A DETERMINISTIC EXTRACTOR, so the intake path runs end to end with no network
// and no vendor. Same role as `simulated.ts` for spatial and
// `simulatedProver.ts` for the notary: the refusal that blocked the path was a
// MISSING ACTOR, and this is what the abstraction was built to accept.
//
// It is regex over a freight email, not a language model, and it does not
// pretend otherwise — `vendor: 'simulated'` is what every boundary and
// validation decision downstream will see. In particular a review by this
// extractor against a real model reads as `cross_vendor`, which is correct: it
// shares no priors with anything.
//
// WHAT IT IS FOR: exercising the shape. A real provider replaces it by
// implementing one method, and nothing else in the pipeline changes — which is
// the property `ModelProvider` exists to have.

import type { ModelProvider, RawEmail, ExtractedFields } from './intake';

const CITY_CODES: Record<string, string> = {
  toronto: 'TOR', tor: 'TOR', mississauga: 'MIS', mis: 'MIS',
  hamilton: 'HAM', ham: 'HAM', windsor: 'WIN', win: 'WIN',
  montreal: 'MTL', mtl: 'MTL', detroit: 'DET', det: 'DET',
  chicago: 'CHI', chi: 'CHI', cleveland: 'CLE', cle: 'CLE',
  buffalo: 'BUF', buf: 'BUF',
};

const EQUIPMENT: Record<string, string> = {
  reefer: 'reefer_53', refrigerated: 'reefer_53', temp: 'reefer_53',
  van: 'van_53', dry: 'van_53', flatbed: 'flatbed_48', deck: 'flatbed_48',
  stepdeck: 'stepdeck_48',
};

const COMMODITY = [
  'auto parts', 'packaged food', 'pharma', 'building materials',
  'consumer goods', 'machinery', 'produce', 'beverages',
];

/** `TOR-DET`, `TOR to DET`, `Toronto -> Detroit`. */
function lane(text: string): { origin?: string; destination?: string } {
  const pair = /\b([A-Za-z]{3,12})\s*(?:-|–|—|to|→|->)\s*([A-Za-z]{3,12})\b/i.exec(text);
  if (!pair) return {};
  const o = CITY_CODES[pair[1].toLowerCase()];
  const d = CITY_CODES[pair[2].toLowerCase()];
  return { origin: o, destination: d };
}

export class SimulatedExtractor implements ModelProvider {
  constructor(readonly id = 'simulated-extractor-v1', readonly vendor = 'simulated') {}

  extract(email: RawEmail): ExtractedFields {
    const text = `${email.subject}\n${email.body}`;
    const out: ExtractedFields = {};

    const { origin, destination } = lane(text);
    if (origin) out.origin = origin;
    if (destination) out.destination = destination;

    for (const [word, eq] of Object.entries(EQUIPMENT)) {
      if (new RegExp(`\\b${word}`, 'i').test(text)) { out.equipment = eq; break; }
    }
    for (const c of COMMODITY) {
      if (new RegExp(`\\b${c}\\b`, 'i').test(text)) { out.commodity = c; break; }
    }

    // The weight phrase is captured VERBATIM, hedge included. Stripping "~"
    // here would defeat the hedge check in `readValue` entirely — the guard is
    // downstream, so the extractor must not pre-clean the thing it guards.
    const w = /((?:~|about|approx\w*|around|roughly|up to|at least)?\s*[\d,.]+\s*k?\s*(?:lbs?|pounds|kg))/i.exec(text);
    if (w) out.weightLbs = w[1].trim();

    const pickup = /(?:pickup|pick up|pu)\b[^.\n]{0,40}/i.exec(text);
    if (pickup) out.pickupWindow = pickup[0].trim();

    const delivery = /(?:deliver|delivery|drop|dropoff)\b[^.\n]{0,40}/i.exec(text);
    if (delivery) out.deliveryWindow = delivery[0].trim();

    const rate = /(?:\$\s*[\d,]+(?:\.\d+)?)/.exec(text);
    if (rate) out.targetRate = rate[0].trim();

    return out;
  }
}

/**
 * A second instance with a different id, for exercising the self-validation
 * gate. Deliberately slightly different: it does NOT read a target rate, so a
 * review against it disagrees on that field — a review where everything always
 * agrees tests nothing.
 */
export class SimulatedReviewer extends SimulatedExtractor {
  constructor() { super('simulated-reviewer-v1', 'simulated-alt'); }
  extract(email: RawEmail): ExtractedFields {
    const { targetRate: _dropped, ...rest } = super.extract(email);
    void _dropped;
    return rest;
  }
}
