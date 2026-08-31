import { describe, it, expect } from 'vitest';
import { classifyRelation, isEscalatable, ClaimRelationError, RELATION_UNDECIDABLE, type Claim } from './claims';
import { attestationOf } from './attestation';

const att = attestationOf('reported', 'high', 'negotiating_position');

function claim(over: Partial<Claim>): Claim {
  return {
    claimId: 'C-1', claimantId: 'carrier-01', subjectKey: 'lane:TOR-DAL:rate',
    knownAt: '2026-08-01', value: 2100, attestation: att, ...over,
  };
}

describe('three merge outcomes, three edge types', () => {
  it('SUPERSEDES: one carrier requoting the same lane on a new day', () => {
    // The category error this prevents: a requote landing in a conflicts
    // table as though the carrier disagreed with itself. Nobody is wrong.
    const monday = claim({ claimId: 'C-1', knownAt: '2026-08-01', value: 2100 });
    const friday = claim({ claimId: 'C-2', knownAt: '2026-08-05', value: 2250 });
    const r = classifyRelation(monday, friday, { sameFact: true });
    expect(r.kind).toBe('supersedes');
    if (r.kind === 'supersedes') {
      expect(r.laterClaimId).toBe('C-2');
      expect(r.earlierClaimId).toBe('C-1');
      expect(r.byKnownAt).toBe('2026-08-05');
    }
    expect(isEscalatable(r)).toBe(false);
  });

  it('supersession is keyed on knownAt and nothing else', () => {
    const a = claim({ claimId: 'C-1', knownAt: '2026-08-05', value: 1 });
    const b = claim({ claimId: 'C-2', knownAt: '2026-08-01', value: 2 });
    const r = classifyRelation(a, b, { sameFact: true });
    if (r.kind === 'supersedes') expect(r.laterClaimId).toBe('C-1');
  });

  it('refuses when one claimant states two values at the same knownAt', () => {
    const a = claim({ claimId: 'C-1', knownAt: '2026-08-01', value: 1 });
    const b = claim({ claimId: 'C-2', knownAt: '2026-08-01', value: 2 });
    expect(() => classifyRelation(a, b, { sameFact: true })).toThrowError(ClaimRelationError);
  });

  it('UNDER_DETERMINED: two carriers quoting the same lane differently', () => {
    // Not a conflict and not a supersession. Two prices, both true.
    const one = claim({ claimId: 'C-1', claimantId: 'carrier-01', value: 2100 });
    const two = claim({ claimId: 'C-2', claimantId: 'carrier-02', value: 2400 });
    const r = classifyRelation(one, two, { sameFact: false });
    expect(r.kind).toBe('under_determined');
    if (r.kind === 'under_determined') {
      expect(r.claimantIds).toEqual(['carrier-01', 'carrier-02']);
      expect(r.note).toContain('two prices are two prices');
    }
    expect(isEscalatable(r)).toBe(false);
  });

  it('CONTRADICTS/resolvable: the certificate against the insurer', () => {
    // One of them is wrong and it can be established. This escalates.
    const cert = claim({ claimId: 'C-1', claimantId: 'carrier-13', subjectKey: 'carrier-13:insured_through', value: '2026-12-31' });
    const insurer = claim({ claimId: 'C-2', claimantId: 'insurer-acme', subjectKey: 'carrier-13:insured_through', value: '2026-08-06' });
    const r = classifyRelation(cert, insurer, { sameFact: true, resolvability: 'resolvable' });
    expect(r.kind).toBe('contradicts');
    if (r.kind === 'contradicts') {
      expect(r.resolvability).toBe('resolvable');
      expect(r.remedy).toContain('one of them is wrong');
    }
    expect(isEscalatable(r)).toBe(true);
  });

  it('CONTRADICTS/world_under_determined: two rate indices — the spread is the answer', () => {
    const a = claim({ claimId: 'C-1', claimantId: 'index-a', subjectKey: 'lane:TOR-DAL:market_rate', value: 2100 });
    const b = claim({ claimId: 'C-2', claimantId: 'index-b', subjectKey: 'lane:TOR-DAL:market_rate', value: 2350 });
    const r = classifyRelation(a, b, { sameFact: true, resolvability: 'world_under_determined' });
    expect(r.kind).toBe('contradicts');
    if (r.kind === 'contradicts') {
      expect(r.remedy).toContain('report the spread');
      expect(r.remedy).toContain('manufacture precision');
    }
    // The quiet-alert failure: escalating this trains the reader to approve past alerts.
    expect(isEscalatable(r)).toBe(false);
  });
});

describe('the classifier refuses rather than picking the nearest relation', () => {
  it('refuses an incompatible pair with no declared resolvability', () => {
    const a = claim({ claimId: 'C-1', claimantId: 'x' });
    const b = claim({ claimId: 'C-2', claimantId: 'y' });
    expect(() => classifyRelation(a, b, { sameFact: true })).toThrowError(ClaimRelationError);
    try {
      classifyRelation(a, b, { sameFact: true });
    } catch (e) {
      expect((e as ClaimRelationError).code).toBe(RELATION_UNDECIDABLE);
      expect((e as Error).message).toContain('do not let the classifier guess');
    }
  });

  it('refuses claims about different subjects', () => {
    const a = claim({ claimId: 'C-1', subjectKey: 'lane:A' });
    const b = claim({ claimId: 'C-2', claimantId: 'other', subjectKey: 'lane:B' });
    expect(() => classifyRelation(a, b, { sameFact: true, resolvability: 'resolvable' }))
      .toThrowError(ClaimRelationError);
  });

  it('refuses a claim compared to itself', () => {
    const a = claim({ claimId: 'C-1' });
    expect(() => classifyRelation(a, a, { sameFact: true })).toThrowError(ClaimRelationError);
  });
});
