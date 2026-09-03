import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTRACT_DIGEST, CONTRACT_ID, CONTRACT_VERSION,
  AXES_IMPLEMENTED, AXES_ABSENT, CONFORMANCE_LIMIT,
} from './contract';
import { EVIDENCE_RANK, INTEREST_RANK } from '../economy/attestation';

const CONTRACT_PATH = join(process.cwd(), 'src/lib/corpus/contract.json');
const RAW = readFileSync(CONTRACT_PATH);
const CONTRACT = JSON.parse(RAW.toString('utf8'));

describe('the vendored contract is the one this corpus was written against', () => {
  it('hashes to the pinned digest', () => {
    // Editing the local copy must fail here rather than silently redefining
    // what this corpus claims to conform to.
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(CONTRACT_DIGEST);
  });

  it('is the contract this module names, at the version it names', () => {
    expect(CONTRACT.contract).toBe(CONTRACT_ID);
    expect(CONTRACT.version).toBe(CONTRACT_VERSION);
  });
});

describe('the local vocabulary is the contract vocabulary', () => {
  it('claim_strength terms and ranks match attestation.ts exactly', () => {
    // attestation.ts owns the definition; this asserts the two agree rather
    // than restating it, which would be the two-lists-of-one-fact defect the
    // contract exists to close.
    const axis = CONTRACT.axes.claim_strength;
    expect(Object.keys(EVIDENCE_RANK).sort()).toEqual([...axis.terms].sort());
    expect(EVIDENCE_RANK).toEqual(axis.rank);
    expect(axis.ordered).toBe(true);
  });

  it('interest terms and ranks match attestation.ts exactly', () => {
    const axis = CONTRACT.axes.interest;
    expect(Object.keys(INTEREST_RANK).sort()).toEqual([...axis.terms].sort());
    expect(INTEREST_RANK).toEqual(axis.rank);
  });

  it('keeps `unknown` above `self_reported`, which is the whole point of it', () => {
    // Not established is not the same as established to be disinterested.
    // A contract that ranked them together would let an unestablished stake
    // be read as a measurement, which is the failure this axis exists for.
    expect(INTEREST_RANK.unknown).toBeGreaterThan(INTEREST_RANK.self_reported);
    expect(INTEREST_RANK.unknown).toBeLessThan(INTEREST_RANK.disinterested);
  });
});

describe('this corpus declares which axes it has and which it does not', () => {
  it('agrees with the contract about what it implements', () => {
    const me = CONTRACT.implementations['payload-terminal'];
    expect(me).toBeDefined();
    expect([...me.axes_implemented].sort()).toEqual(Object.keys(AXES_IMPLEMENTED).sort());
    expect([...me.axes_absent].sort()).toEqual(Object.keys(AXES_ABSENT).sort());
  });

  it('records production_class as an open gap, not a deliberate omission', () => {
    // The acquisition fabric's missing claim_strength IS deliberate — it does
    // not assess claims. This one is not. Filing them the same way would turn
    // a gap into a decision nobody made.
    expect(CONTRACT.implementations['payload-terminal'].absence_is_deliberate).toBe(false);
    expect(CONTRACT.implementations['data-acquisition-fabric'].absence_is_deliberate).toBe(true);
    expect(AXES_ABSENT.production_class).toContain('OPEN GAP');
  });

  it('names a file that exists for every axis it claims to implement', () => {
    // A conformance declaration pointing at a module that was deleted would
    // pass every other check here while claiming an axis nobody implements.
    for (const [axis, where] of Object.entries(AXES_IMPLEMENTED)) {
      const [file, symbol] = where.split(':');
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, `${axis} points at ${file}`).toContain(symbol);
    }
  });
});

describe('the contested terms, which is where a boundary corrupts a value', () => {
  it('refuses to translate `reported`, and says why', () => {
    // In claim_strength, `reported` is the HARDEST class. In the acquisition
    // fabric's presentation vocabulary it maps onto `asserted`, the class
    // with no instrument behind it. A value crossing as `asserted` and
    // arriving as `reported` would be promoted by nothing but a spelling.
    const t = CONTRACT.contested_terms.reported;
    expect(t.translation).toBe('refused');
    expect(t.refusal_reason).toContain('asserted');
    expect(EVIDENCE_RANK.reported).toBe(3); // the hardest — which is the hazard
  });

  it('allows `derived` in exactly one direction', () => {
    const t = CONTRACT.contested_terms.derived;
    expect(t.translation).toBe('one_way');
    expect(t.direction).toBe('production_class.derived -> claim_strength.derived');
    expect(EVIDENCE_RANK.derived).toBe(0); // the weakest — which is why it is safe downward
  });

  it('every contested term is resolved, one way or the other', () => {
    // A contested term with no resolution is the worst of the three states:
    // it looks handled. Same shape as a route in neither bucket.
    const ALLOWED = new Set(['refused', 'one_way', 'symmetric']);
    for (const [term, t] of Object.entries<Record<string, string>>(CONTRACT.contested_terms)) {
      if (term === 'note') continue;
      expect(ALLOWED.has(t.translation), `${term}: ${t.translation}`).toBe(true);
      const reason = t.refusal_reason ?? t.direction_reason;
      expect(reason, `${term} resolved without a reason`).toBeTruthy();
    }
  });
});

describe('the combination rule is stated once', () => {
  it('applies weakest-input-wins to the ordered axes and to nothing else', () => {
    const c = CONTRACT.combination;
    expect(c.rule).toBe('weakest_input_wins');
    expect([...c.applies_to].sort()).toEqual(['claim_strength', 'interest']);
    // production_class is unordered, so there is no weakest to take.
    expect(c.does_not_apply_to).toContain('production_class');
    for (const axis of c.applies_to) expect(CONTRACT.axes[axis].ordered).toBe(true);
    for (const axis of c.does_not_apply_to) expect(CONTRACT.axes[axis].ordered).toBe(false);
  });

  it('warns off the opposite rule rather than leaving it to be rediscovered', () => {
    // `strongestAttestingClass` is correct for entity existence and wrong for
    // quantities. Unifying them would launder a weak quantity through a
    // well-attested subject.
    expect(CONTRACT.combination.opposite_direction_warning).toContain('strongestAttestingClass');
  });
});

describe('what conformance does not prove', () => {
  it('says so, in production and not only here', () => {
    // The limit is a property of the arrangement, and a reader of the module
    // is exactly who needs it. A test-only caveat is a caveat nobody reads.
    expect(CONFORMANCE_LIMIT).toContain('stale');
    expect(CONTRACT.what_conformance_proves.join(' ')).toContain('does NOT prove');
  });
});
