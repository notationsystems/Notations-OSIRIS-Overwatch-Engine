import { describe, it, expect } from 'vitest';
import {
  styleEconEntity, rampRadius, coverageOpacity, UNQUANTIFIED_COLOR, UNQUANTIFIED_RADIUS,
  splitFlowsByBasis, buildEconFlowLayerStyles, flowWidth,
} from './mapStyle';

/**
 * Final order F-5 — visual refusal discipline, tested on the RENDERING
 * logic (the one place the econ layers compute their treatment), not
 * asserted by a designer.
 */

describe('F-5: refused cells are distinguishable from zero cells', () => {
  it('an unquantified entity gets a non-scale treatment a zero entity does not', () => {
    const zero = styleEconEntity({ production: 0, capacity: null });
    const unknown = styleEconEntity({ production: null, capacity: null });
    // Zero is a VALUE: it stays on the ramp, in the stage colour.
    expect(zero.treatment).toBe('quantified');
    expect(zero.radiusPx).toBe(rampRadius(0));
    expect(zero.color).toBeNull(); // stage ramp colours it
    // Unknown is NOT a small zero: fixed radius, grey, heavy white stroke.
    expect(unknown.treatment).toBe('unquantified');
    expect(unknown.color).toBe(UNQUANTIFIED_COLOR);
    expect(unknown.radiusPx).toBe(UNQUANTIFIED_RADIUS);
    expect(unknown.strokeColor).not.toBe(zero.strokeColor);
    expect(unknown.strokeWidth).toBeGreaterThan(zero.strokeWidth);
    // The pre-F-5 defect stays dead: the old ramp coalesced null to 100,
    // so an unquantified node rendered exactly like a 100 kt/y producer.
    expect(unknown.radiusPx).not.toBe(rampRadius(100));
    expect(unknown.treatment).not.toBe(styleEconEntity({ production: 100, capacity: null }).treatment);
  });

  it('capacity-only entities are quantified; the ramp is monotone', () => {
    expect(styleEconEntity({ production: null, capacity: 400 }).treatment).toBe('quantified');
    expect(rampRadius(1600)).toBeGreaterThan(rampRadius(100));
    expect(rampRadius(0)).toBe(3); // the ramp's own floor, still ON the ramp
  });
});

describe('F-5: coverage rides in the ink', () => {
  it('opacity is monotone in coverage, unknown coverage is not full coverage, and zero coverage stays visible', () => {
    expect(coverageOpacity(0.73)).toBeGreaterThan(coverageOpacity(0.22));
    expect(coverageOpacity(1)).toBeGreaterThan(coverageOpacity(null));
    expect(coverageOpacity(null)).not.toBe(coverageOpacity(1)); // unknown ≠ fully modeled
    expect(coverageOpacity(0)).toBeGreaterThan(0); // invisible ink would be an omission
  });
});

describe('F-5: one basis per width-scaled layer', () => {
  type F = { basis?: string | null; quantity: number };
  const metal: F = { basis: 'metal_content', quantity: 500 };
  const gross: F = { basis: 'gross_weight', quantity: 500 };
  const unspecified: F = { quantity: 500 };

  it('a planted mixed-basis layer refuses to render and names the conflict', () => {
    expect(() => buildEconFlowLayerStyles([metal, gross])).toThrow(/mixed-basis flow layer refused/);
    expect(() => buildEconFlowLayerStyles([metal, gross])).toThrow(/gross_weight, metal_content/);
    expect(() => buildEconFlowLayerStyles([metal, unspecified])).toThrow(/mixed-basis/);
  });

  it('single-basis layers build; non-metal-content bases render dashed (non-commensurate on sight)', () => {
    const m = buildEconFlowLayerStyles([metal]);
    expect(m[0].style.dashed).toBe(false);
    expect(m[0].style.lineWidth).toBe(flowWidth(500));
    const g = buildEconFlowLayerStyles([gross]);
    expect(g[0].style.dashed).toBe(true);
    const u = buildEconFlowLayerStyles([unspecified]);
    expect(u[0].style.basis).toBe('unspecified');
    expect(u[0].style.dashed).toBe(true);
  });

  it('splitFlowsByBasis partitions a mixed set so each group passes the refusing builder', () => {
    const groups = splitFlowsByBasis([metal, gross, unspecified, metal]);
    expect(groups.get('metal_content')!.length).toBe(2);
    expect(groups.get('gross_weight')!.length).toBe(1);
    expect(groups.get('unspecified')!.length).toBe(1);
    for (const group of groups.values()) {
      expect(() => buildEconFlowLayerStyles(group)).not.toThrow();
    }
  });
});

describe('F-5 at the SEAM: the basis axis survives the map projection', () => {
  const mapFlows = async (q = '') => {
    const { GET } = await import('@/app/api/economy/route');
    const res = await GET(new Request(`http://localhost/api/economy?commodity=copper&view=map${q}`));
    const body = await res.json() as { econ_flows: Array<{ basis: string | null; quantity: number }> };
    return body.econ_flows;
  };

  it('the map payload carries basis at every topology', async () => {
    // THE DEFECT THIS PINS (found by rendering the UI, not by unit tests):
    // canonical state holds 48 metal_content and 14 gross_weight flows,
    // and the map projection dropped `basis` entirely — so every flow
    // arrived 'unspecified', the layer never saw two bases, and the
    // mixed-basis refusal could never fire. Nothing failed: the unit
    // tests above passed because they hand `basis` to the function
    // directly. A mechanism correct about its input while the axis was
    // stripped upstream — the context-severance class at a data seam.
    for (const q of ['', '&asOf=2017-06-30', '&asOf=2022-06-30']) {
      const flows = await mapFlows(q);
      expect(flows.length, `no flows served at ${q || 'today'}`).toBeGreaterThan(0);
      for (const f of flows) expect('basis' in f, `map flow lost its basis axis at ${q || 'today'}`).toBe(true);
    }
  });

  it('the DISCRIMINATING topology: at 2017 the served set is genuinely mixed, and the split does work', async () => {
    // Measured, not assumed. Today's facility topology serves 39 flows,
    // ALL metal_content — so the dashing correctly never fires there and
    // a test written against today would be vacuous. The 2017 country
    // vintage serves BOTH (5 metal_content, 4 gross_weight): before the
    // fix those nine rendered on ONE width ramp, gross-weight beside
    // metal-content, which is the incommensurability F-5 exists to
    // prevent — at a date the researcher can scrub to.
    const flows = await mapFlows('&asOf=2017-06-30');
    const groups = splitFlowsByBasis(flows);
    expect(groups.size, '2017 must serve more than one basis or this pin is vacuous').toBeGreaterThan(1);
    expect(groups.has('metal_content')).toBe(true);
    expect(groups.has('gross_weight')).toBe(true);

    // The mixed set REFUSES; each single-basis group builds.
    expect(() => buildEconFlowLayerStyles(flows)).toThrow(/mixed-basis/);
    for (const g of groups.values()) expect(() => buildEconFlowLayerStyles(g)).not.toThrow();

    // And the dashing DISTINGUISHES here rather than marking everything.
    expect(buildEconFlowLayerStyles(groups.get('metal_content')!).every(f => f.style.dashed === false)).toBe(true);
    expect(buildEconFlowLayerStyles(groups.get('gross_weight')!).every(f => f.style.dashed === true)).toBe(true);
  });

  it('today\'s facility topology is single-basis, so nothing is falsely marked non-commensurate', async () => {
    const flows = await mapFlows();
    const groups = splitFlowsByBasis(flows);
    expect([...groups.keys()]).toEqual(['metal_content']);
    expect(buildEconFlowLayerStyles(flows).every(f => f.style.dashed === false)).toBe(true);
  });
});
