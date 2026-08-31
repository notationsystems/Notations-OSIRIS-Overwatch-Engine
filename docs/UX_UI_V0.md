# Payload Terminal V0 — UX/UI System

## Product surface

Payload Terminal is an operator instrument for a provenance-preserving world state, not a conventional analytics dashboard. The interface must make state, evidence, uncertainty and action legible before decoration.

## Spatial hierarchy

The terminal is organised into three persistent zones:

1. **Command layer** — global search, primary operating surfaces, world-state status.
2. **World workspace** — MapLibre is the spatial canvas; map controls remain secondary to the state itself.
3. **Context layer** — evidence, spatial state, markets, economy, exceptions, routing and selected-entity detail appear as bounded panels rather than competing dashboards.

## Spatial state surface

Payload treats geography as an operational state surface rather than a map-only visualization. `PayloadSpatialRail` exposes five conceptual layers:

- Network
- Facilities
- Corridors
- Restrictions
- Temporal network state

Each layer may expose count, source and `asOf` context. Unknown values remain unknown; the UI never fabricates zeroes.

Spatial computation is presented as a semantic operation rather than a vendor feature:

- Route
- OD Matrix
- Isochrone
- Service Area

The UI may request these operations, but does not select or encode a backend implementation. Backend selection remains a domain/computation concern.

## Information hierarchy

Every important value should answer, where applicable:

- **What** is being observed?
- **Where** is it?
- **When** was it true?
- **When did we know it?**
- **Where did it come from?**
- **How certain/admissible is it?**
- **What can the operator do next?**

A missing value is rendered as unknown/null, never as a fabricated zero. Refusals are actionable states and should expose the missing prerequisite/remedy.

## Visual language

The existing Payload design tokens remain authoritative: void/near-black workspace; restrained gold for primary state/action; cyan for information/telemetry; green for confirmed healthy state; red/orange for exceptions; JetBrains Mono for operational/HUD values; Inter for readable explanatory text; and glass surfaces only where they preserve map visibility.

Do not introduce a competing colour system or generic SaaS card aesthetic.

## Interaction rules

- Map remains the primary spatial context.
- Panels open from explicit operator intent and should not permanently obscure the world state.
- Selected entities should establish a clear focus state while preserving provenance context.
- Search is the universal entry point to entity/lane/port/carrier retrieval.
- Spatial compute commands describe intent; they do not expose vendor-specific backend names.
- Keyboard and pointer interactions converge on the same command model.
- Mobile uses the same information architecture with progressive disclosure, not a separate product model.

## Architecture constraint

UI components may read canonical/application state through explicit props and callbacks. They must not mutate canonical state, evidence records, provenance, or domain storage directly.

The intended flow remains:

`Canonical/Application State → UI representation → operator action → domain command → state transition → UI observation`

The renderer is never authoritative.

## Spatial corpus direction

The operational spatial substrate is expected to sit behind the terminal as a versioned corpus rather than being recreated in the UI. Candidate infrastructure includes PostGIS/pgRouting for persistent spatial state and graph computation, with ORS/VROOM and future accelerated solvers behind semantic interfaces. QGIS remains a research/inspection client.

The corpus should preserve provenance and temporal epistemics so historical operations can distinguish the state that was true from the state that was knowable at the time.

## Current implementation

Phase 1 established reusable command and context primitives. Phase 2 adds the spatial-state control rail and formalises semantic spatial operations. Next work wires these surfaces into the existing page controller and validates interaction behaviour without changing domain authority.
