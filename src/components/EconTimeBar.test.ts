import { describe, it, expect } from 'vitest';
import { monthRange, monthEnd } from './EconTimeBar';

describe('EconTimeBar month arithmetic', () => {
  it('builds an inclusive month range across a year boundary', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('returns a single month when min equals max', () => {
    expect(monthRange('2026-08', '2026-08')).toEqual(['2026-08']);
  });

  it('returns empty when min is after max', () => {
    expect(monthRange('2026-09', '2026-08')).toEqual([]);
  });

  it('computes month-end including leap years', () => {
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2025-12')).toBe('2025-12-31');
    expect(monthEnd('2025-04')).toBe('2025-04-30');
  });
});
