/**
 * Sea Dog Terminal — form-level stage-conversion constants (work order 3.5).
 *
 * The scope gap round 25 recorded unbuilt: the corridor-grade machinery
 * converts gross COPPER CONCENTRATE via mirror-implied per-corridor grades,
 * and the aluminium chain has no concentrate — gross bauxite and alumina
 * flows had no path to contained metal and refused wholesale. These are
 * FORM-level constants in the same epistemic shape as the corridor grade:
 * a conversion carries its factor, its provenance, and its error band, and
 * where no constant exists the conversion REFUSES rather than defaulting.
 *
 * Two properties, held structurally:
 *
 *   NEVER CROSS-COMMODITY. The table is keyed (commodity, form) and the
 *   lookup consults exactly one commodity's sub-table — a copper flow can
 *   never pick up a bauxite constant, and the aluminium constants can
 *   never leak into copper's concentrate path (which stays per-corridor,
 *   mirror-implied, because concentrate grades genuinely vary by corridor;
 *   a form-level concentrate constant would erase exactly the variance the
 *   mirror system measures).
 *
 *   VARIANCE CAPTURED, NOT JUST MIDPOINT. Both aluminium ratios are
 *   published industry ranges with real spread (bauxite grade varies by
 *   deposit; smelter alumina consumption varies by practice); the band is
 *   the conversion's uncertainty and travels with every converted edge.
 */

export interface FormConversion {
  /** Contained-metal mass fraction applied to the gross quantity. */
  factor: number;
  /** [low, high] factor band — the published variance, not a guess. */
  band: [number, number];
  /** Where the constant comes from — a documented ratio, never a mirror
   *  observation (that is the corridor grade's provenance shape). */
  source: string;
}

/**
 * commodity → form → constant. Copper is DELIBERATELY absent: its one
 * gross form (concentrate) converts per-corridor via mirror-implied
 * grades, and a form-level fallback would silently erase corridor
 * variance. Adding a commodity here is a curation act with a source.
 */
const STAGE_CONVERSION_CONSTANTS: Record<string, Record<string, FormConversion>> = {
  aluminium: {
    // Bauxite moves as 'ore' (MaterialForm). Industry rule: 4–5 t of
    // metallurgical bauxite per tonne of primary aluminium, grade varying
    // by deposit (Guinean trihydrate vs Jamaican/Australian blends).
    ore: {
      factor: 0.222,
      band: [0.20, 0.25],
      source: 'Industry ratio 4–5 t metallurgical bauxite per t primary Al (USGS MCS bauxite & alumina chapter; ~2.0–2.5 t bauxite per t alumina × ~1.93 t alumina per t Al). Deposit grade drives the spread.',
    },
    // Calcined alumina: stoichiometry caps the Al share of Al2O3 at
    // 2·26.98 / 101.96 = 0.529; smelting practice consumes 1.91–1.94 t
    // alumina per t Al (handling and electrolysis losses).
    alumina: {
      factor: 0.520,
      band: [0.515, 0.529],
      source: 'Stoichiometric Al share of Al2O3 = 0.529 (ceiling); industry smelter consumption 1.91–1.94 t alumina per t Al (International Aluminium Institute practice).',
    },
  },
};

/**
 * The lookup: exact (commodity, form) or nothing. No fallback across
 * commodities, no fallback across forms — a miss means the flow's tonnage
 * REFUSES through the existing `refused:basis` path, visibly.
 */
export function formConversionFor(commodity: string, form: string): FormConversion | undefined {
  return STAGE_CONVERSION_CONSTANTS[commodity]?.[form];
}
