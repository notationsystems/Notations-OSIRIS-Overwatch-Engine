//
// THE PANEL REGISTRY — one declaration of where each surface renders, and
// exclusion DERIVED from that rather than hand-maintained at each call site.
//
// ── WHY THIS EXISTS (measured, not supposed) ─────────────────────────────────
//
// Before this module the terminal toggled panels with inline cascades: each
// button called the setters it happened to remember. Nine handlers, nine
// different answers. Extracted from the source and simulated:
//
//   showSpaceCam      closed  alerts, markets
//   showEconomy       closed  alerts, markets, spaceCam
//   showMarkets       closed  alerts, economy, spaceCam
//   showAlerts        closed  drawing, markets          <- not spaceCam, not economy
//   showDirections    closed  alerts, search, drawing, markets, spaceCam
//   showDesktopSearch closed  alerts, drawing, markets, spaceCam
//   showArcGIS        closed  remote                    <- and nothing else
//   showRemote        closed  alerts, arcgis, search, drawing, markets, spaceCam
//   showDrawing       closed  alerts, markets, spaceCam
//
// 19 ASYMMETRIC PAIRS (A closes B while B leaves A open) and 24 TWO-CLICK
// SEQUENCES that left two panels open on the identical anchor
// `absolute right-12 top-1/2 -translate-y-1/2` — physically stacked on top of
// each other. Which one you saw depended on the ORDER you clicked.
//
// This is the defect class this repository tracks, in the UI layer: A MECHANISM
// WHOSE EFFECTIVE SCOPE IS NARROWER THAN ITS APPARENT SCOPE, WITH NOTHING
// FAILING. Each handler LOOKS like "open this panel exclusively". Each one
// actually closed a hand-listed subset, and no test could tell, because the
// intent lived in nine places and was written down in none.
//
// The fix is not a better-maintained list. It is removing the list: a panel
// declares the SLOT it occupies, exclusion follows from two panels wanting the
// same slot, and a new panel cannot be added without answering that question.
//

/** Every panel the terminal can show. Adding one here forces a slot below. */
export type PanelId =
  | 'layers'
  | 'spaceCam'
  | 'economy'
  | 'markets'
  | 'alerts'
  | 'drawing'
  | 'directions'
  | 'search'
  | 'arcgis'
  | 'remote'
  | 'spatial'
  | 'econGraph';

/**
 * Where a panel physically renders. Two panels in the same slot cannot both be
 * visible — not as a policy choice, but because they are positioned at the same
 * coordinates and would overlap.
 *
 * `independent` is for surfaces with their own space (the left sidebar) or their
 * own layer (a full-screen modal). It is NOT a way to opt out of the question.
 */
export type PanelSlot =
  /** Left sidebar. Coexists with everything. */
  | 'left_sidebar'
  /** `absolute right-12 top-1/2 -translate-y-1/2` — the contended one. */
  | 'right_rail'
  /** `absolute top-3` — the route planner and the command bar want this. */
  | 'top_bar'
  /** Full-screen, above everything. */
  | 'modal';

/**
 * THE DECLARATION. Verified against the render sites in `src/app/page.tsx`:
 * every `right_rail` entry below renders inside a container anchored
 * `right-12 top-1/2 -translate-y-1/2` (economy uses `fixed right-12 top-16`,
 * which overlaps the same column). A test asserts this correspondence, so a
 * panel moved in the JSX without being moved here fails.
 */
export const PANEL_SLOT: Record<PanelId, PanelSlot> = {
  layers: 'left_sidebar',
  spaceCam: 'right_rail',
  economy: 'right_rail',
  markets: 'right_rail',
  alerts: 'right_rail',
  drawing: 'right_rail',
  search: 'right_rail',
  arcgis: 'right_rail',
  remote: 'right_rail',
  spatial: 'right_rail',
  directions: 'top_bar',
  econGraph: 'modal',
};

export const ALL_PANELS = Object.keys(PANEL_SLOT) as PanelId[];

/** Slots where opening one panel closes the others. Derived, never listed. */
const EXCLUSIVE_SLOTS: ReadonlySet<PanelSlot> = new Set<PanelSlot>(['right_rail', 'top_bar']);

export type PanelState = Record<PanelId, boolean>;

export const CLOSED_PANELS: PanelState = ALL_PANELS.reduce(
  (acc, id) => ({ ...acc, [id]: false }),
  {} as PanelState,
);

/**
 * The panels that opening `id` must close. Derived from the slot, so it is
 * correct by construction and symmetric by construction: if A displaces B then
 * B displaces A, because they are the same predicate evaluated twice.
 */
export function displacedBy(id: PanelId): PanelId[] {
  const slot = PANEL_SLOT[id];
  if (!EXCLUSIVE_SLOTS.has(slot)) return [];
  return ALL_PANELS.filter((other) => other !== id && PANEL_SLOT[other] === slot);
}

export type PanelCommand =
  | { kind: 'toggle'; panel: PanelId }
  | { kind: 'open'; panel: PanelId }
  | { kind: 'close'; panel: PanelId }
  | { kind: 'closeSlot'; slot: PanelSlot };

/**
 * The whole panel behaviour of the terminal, as a pure function. Being pure is
 * the point: the previous logic could only be checked by clicking, which is why
 * nine inconsistent versions of it survived.
 */
export function applyPanelCommand(state: PanelState, command: PanelCommand): PanelState {
  const next: PanelState = { ...state };

  if (command.kind === 'closeSlot') {
    for (const id of ALL_PANELS) if (PANEL_SLOT[id] === command.slot) next[id] = false;
    return next;
  }

  const { panel } = command;
  const willOpen =
    command.kind === 'open' ? true : command.kind === 'close' ? false : !state[panel];

  if (willOpen) for (const other of displacedBy(panel)) next[other] = false;
  next[panel] = willOpen;
  return next;
}

/** True when any panel in the slot is open — for surfaces that must yield it. */
export function slotOccupied(state: PanelState, slot: PanelSlot): boolean {
  return ALL_PANELS.some((id) => PANEL_SLOT[id] === slot && state[id]);
}

/**
 * The invariant the old code violated 24 different ways. Exported so it can be
 * asserted over reachable states rather than only over hand-picked ones.
 */
export function overlappingPanels(state: PanelState): PanelId[] {
  const bad: PanelId[] = [];
  for (const slot of EXCLUSIVE_SLOTS) {
    const open = ALL_PANELS.filter((id) => PANEL_SLOT[id] === slot && state[id]);
    if (open.length > 1) bad.push(...open);
  }
  return bad;
}
