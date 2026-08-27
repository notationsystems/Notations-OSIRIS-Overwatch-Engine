/**
 * Sea Dog Terminal — visual refusal discipline (final order F-5).
 *
 * The map is more persuasive than the table and carries less: every
 * simplification that makes it intuitive strips an axis, invisibly.
 * These functions are the SINGLE place the econ layers compute their
 * visual treatment, so the discipline is testable on the rendering
 * logic rather than asserted by a designer:
 *
 *   1. A refused/unknown cell must not look like a low cell. An entity
 *      with NO stated production and NO stated capacity gets a
 *      NON-SCALE treatment (fixed radius, grey, dashed-look stroke)
 *      that cannot be read as a position on the size ramp. Zero is a
 *      value and stays ON the ramp; unknown is not a small zero.
 *      (Before this module, the ramp coalesced null to 100 — an
 *      unquantified node silently rendered as if it produced 100 kt/y.)
 *   2. Coverage belongs in the cell treatment: facility dots carry
 *      their country's facility-model coverage as opacity, so a 22%-
 *      modeled country visibly carries less ink than a 73% one.
 *      Unknown coverage is NOT rendered as full coverage.
 *   3. One basis per layer: a width-scaled flow layer mixing
 *      gross-weight and metal-content quantities is incommensurability
 *      rendered — the layer builder REFUSES mixed input and names the
 *      conflict; callers split by basis first (splitFlowsByBasis).
 */

export type QuantTreatment = 'quantified' | 'unquantified';

export interface EconDotStyle {
  treatment: QuantTreatment;
  /** Position on the size ramp (quantified) or the fixed non-scale radius. */
  radiusPx: number;
  /** Fill opacity from coverage (1 only when coverage says so). */
  opacity: number;
  /** Grey for unquantified — never a ramp colour. */
  color: string | null;
  strokeColor: string;
  strokeWidth: number;
}

/** The ramp the map used, reproduced exactly for quantified values —
 *  sqrt scale through (5,3) (15,5) (25,7.5) (35,10), clamped. */
export function rampRadius(value: number): number {
  const s = Math.sqrt(Math.max(value, 0));
  const stops: Array<[number, number]> = [[5, 3], [15, 5], [25, 7.5], [35, 10]];
  if (s <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (s <= stops[i][0]) {
      const [x0, y0] = stops[i - 1];
      const [x1, y1] = stops[i];
      return y0 + ((s - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return stops[stops.length - 1][1];
}

export const UNQUANTIFIED_RADIUS = 3.5;
export const UNQUANTIFIED_COLOR = '#8A8A8A';

/** Opacity from facility-model coverage. Null coverage is UNKNOWN, not
 *  full: it renders at a flagged mid value, distinguishable from both a
 *  fully-modeled country and a barely-modeled one. Zero coverage keeps a
 *  visible floor — invisible ink would be an omission, not a statement. */
export function coverageOpacity(ratio: number | null | undefined): number {
  if (ratio === null || ratio === undefined) return 0.55;
  const r = Math.min(Math.max(ratio, 0), 1);
  return Number((0.3 + 0.65 * r).toFixed(3));
}

export function styleEconEntity(
  e: { production: number | null; capacity: number | null },
  coverageRatio: number | null | undefined = null,
): EconDotStyle {
  const value = e.production ?? e.capacity;
  if (value === null || value === undefined) {
    // NON-SCALE: fixed radius off the ramp's interpolation, grey fill,
    // heavy dashed-look stroke. Cannot be read as a small value.
    return {
      treatment: 'unquantified',
      radiusPx: UNQUANTIFIED_RADIUS,
      opacity: coverageOpacity(coverageRatio),
      color: UNQUANTIFIED_COLOR,
      strokeColor: '#FFFFFF',
      strokeWidth: 1.5,
    };
  }
  return {
    treatment: 'quantified',
    radiusPx: rampRadius(value),
    opacity: coverageOpacity(coverageRatio),
    color: null, // the kind/stage colour ramp stays the layer's own
    strokeColor: 'rgba(0,0,0,0.35)',
    strokeWidth: 0.5,
  };
}

/* ── One basis per width-scaled layer ── */

export type FlowBasisLabel = 'metal_content' | 'gross_weight' | 'unspecified';

export function flowBasisOf(f: { basis?: string | null }): FlowBasisLabel {
  return f.basis === 'metal_content' || f.basis === 'gross_weight' ? f.basis : 'unspecified';
}

export function splitFlowsByBasis<T extends { basis?: string | null }>(flows: T[]): Map<FlowBasisLabel, T[]> {
  const out = new Map<FlowBasisLabel, T[]>();
  for (const f of flows) {
    const b = flowBasisOf(f);
    const arr = out.get(b) ?? [];
    arr.push(f);
    out.set(b, arr);
  }
  return out;
}

/** The width ramp the flow layer used, reproduced for single-basis layers. */
export function flowWidth(quantity: number): number {
  const stops: Array<[number, number]> = [[100, 0.8], [500, 2], [1000, 3.2], [1600, 4.5]];
  if (quantity <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (quantity <= stops[i][0]) {
      const [x0, y0] = stops[i - 1];
      const [x1, y1] = stops[i];
      return Number((y0 + ((quantity - x0) / (x1 - x0)) * (y1 - y0)).toFixed(2));
    }
  }
  return stops[stops.length - 1][1];
}

export interface FlowLineStyle {
  lineWidth: number;
  /** gross_weight and unspecified render dashed — the width is stated on a
   *  different (or unstated) mass basis and must not read as commensurate
   *  with metal-content widths on sight. */
  dashed: boolean;
  basis: FlowBasisLabel;
}

/**
 * Build per-feature line styles for ONE basis group. A width-scaled layer
 * mixing bases is incommensurability rendered — pictures are quoted more
 * readily than tables — so mixed input REFUSES with the conflict named.
 * Callers split with splitFlowsByBasis() first.
 */
export function buildEconFlowLayerStyles<T extends { basis?: string | null; quantity: number }>(flows: T[]): Array<T & { style: FlowLineStyle }> {
  const bases = new Set(flows.map(flowBasisOf));
  if (bases.size > 1) {
    throw new Error(
      `mixed-basis flow layer refused: one width-scaled layer cannot carry [${[...bases].sort().join(', ')}] — ` +
      'a gross-weight kt and a metal-content kt are different quantities, and rendering them on one width ramp is the incommensurability defect as a picture. Split with splitFlowsByBasis() and render one layer per basis.',
    );
  }
  const basis = bases.size === 1 ? [...bases][0] : 'unspecified';
  return flows.map(f => ({
    ...f,
    style: { lineWidth: flowWidth(f.quantity), dashed: basis !== 'metal_content', basis },
  }));
}
