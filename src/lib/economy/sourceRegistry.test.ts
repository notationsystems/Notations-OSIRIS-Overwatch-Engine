import { describe, it, expect } from 'vitest';
import { SOURCE_REGISTRY, matchRegistryGaps } from './sourceRegistry';

describe('source registry', () => {
  it('sourceIds are unique and every entry is a real, described source', () => {
    const ids = SOURCE_REGISTRY.map(s => s.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SOURCE_REGISTRY) {
      expect(s.note.length, s.sourceId).toBeGreaterThan(10);
      expect(s.keywords.length, s.sourceId).toBeGreaterThan(0);
    }
  });

  it('policy: yields name canonical identity kinds only — no source is registered for natural-person data', () => {
    const CANONICAL = ['entity', 'observation', 'flow', 'event', 'dependency'];
    for (const s of SOURCE_REGISTRY) {
      expect(s.yields.length, s.sourceId).toBeGreaterThan(0);
      for (const y of s.yields) expect(CANONICAL, s.sourceId).toContain(y);
      // The ownership sources are registered for company identity and parent
      // chains, never person records — pin the registration text itself.
      const text = `${s.name} ${s.note} ${s.keywords.join(' ')}`.toLowerCase();
      expect(text, s.sourceId).not.toMatch(/natural person|person of significant control|passport|date of birth|residential/);
    }
  });

  it('matchRegistryGaps returns only adapter-null sources, ranked, capped at 5', () => {
    const gaps = matchRegistryGaps('lme warehouse stocks inventory');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.length).toBeLessThanOrEqual(5);
    expect(gaps.every(s => s.adapter === null)).toBe(true);
    // Westmetall covers this ground but is BUILT — never a gap.
    expect(gaps.map(s => s.sourceId)).not.toContain('westmetall-lme');
    expect(gaps.map(s => s.sourceId)).toContain('lme-licensed');
  });

  it('a query outside every declared coverage matches nothing', () => {
    expect(matchRegistryGaps('xylophone quarterly')).toEqual([]);
  });
});
