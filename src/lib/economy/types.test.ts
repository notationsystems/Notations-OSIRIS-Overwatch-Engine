import { describe, it, expect } from 'vitest';
import { validateState, toKtPerYear } from './types';
import { syntheticState, FIXTURE_PROV } from './fixtures';

describe('validateState', () => {
  it('accepts the synthetic fixture with no errors', () => {
    const issues = validateState(syntheticState());
    expect(issues.filter(i => i.severity === 'error')).toEqual([]);
  });

  it('rejects duplicate entity ids', () => {
    const s = syntheticState();
    s.entities.push({ ...s.entities[2] });
    const errors = validateState(s).filter(i => i.severity === 'error');
    expect(errors.some(e => e.message.includes('Duplicate entity id'))).toBe(true);
  });

  it('rejects flows referencing unknown entities', () => {
    const s = syntheticState();
    s.flows[0] = { ...s.flows[0], fromEntityId: 'ent:mine:ghost' };
    const errors = validateState(s).filter(i => i.severity === 'error');
    expect(errors.some(e => e.message.includes('unknown entity ent:mine:ghost'))).toBe(true);
  });

  it('rejects self-loop and negative-quantity flows', () => {
    const s = syntheticState();
    s.flows.push({ ...s.flows[0], id: 'flow:self', fromEntityId: 'ent:port:gate', toEntityId: 'ent:port:gate' });
    s.flows.push({ ...s.flows[1], id: 'flow:neg', quantity: -5 });
    const msgs = validateState(s).filter(i => i.severity === 'error').map(e => e.message).join('\n');
    expect(msgs).toContain('self-loop');
    expect(msgs).toContain('negative quantity');
  });

  it('rejects records without provenance', () => {
    const s = syntheticState();
    // @ts-expect-error deliberately corrupting provenance
    s.observations[0] = { ...s.observations[0], provenance: {} };
    const errors = validateState(s).filter(i => i.severity === 'error');
    expect(errors.some(e => e.message.includes('lacks provenance'))).toBe(true);
  });

  it('rejects out-of-range coordinates and half-set lat/lng', () => {
    const s = syntheticState();
    s.entities[2] = { ...s.entities[2], lat: 123 };
    s.entities[3] = { ...s.entities[3], lng: undefined };
    const msgs = validateState(s).filter(i => i.severity === 'error').map(e => e.message).join('\n');
    expect(msgs).toContain('lat out of range');
    expect(msgs).toContain('only one of lat/lng');
  });

  it('rejects non-finite observation values', () => {
    const s = syntheticState();
    s.observations[0] = { ...s.observations[0], value: NaN, provenance: FIXTURE_PROV };
    const errors = validateState(s).filter(i => i.severity === 'error');
    expect(errors.some(e => e.message.includes('non-finite'))).toBe(true);
  });
});

describe('toKtPerYear', () => {
  it('converts supported units and refuses unknown ones', () => {
    expect(toKtPerYear(2, 'Mt/y')).toBe(2000);
    expect(toKtPerYear(500, 'kt/y')).toBe(500);
    expect(toKtPerYear(3000, 't/y')).toBe(3);
    expect(toKtPerYear(10, 'bushels')).toBeNull();
  });
});
