# Payload Terminal V0 — UX/UI System

## Product surface

Payload Terminal is an operator instrument for a provenance-preserving world state, not a conventional analytics dashboard. The interface must therefore make **state, evidence, uncertainty and action** legible before decoration.

## Spatial hierarchy

The terminal is organised into three persistent zones:

1. **Command layer** — global search, primary operating surfaces, world-state status.
2. **World workspace** — MapLibre is the spatial canvas; map controls remain secondary to the state itself.
3. **Context layer** — evidence, markets, economy, exceptions, routing and selected-entity detail appear as bounded panels rather than competing dashboards.

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

## Command bar

`PayloadCommandBar` establishes the first reusable command-surface primitive. It intentionally exposes the existing application state through callbacks rather than owning domain state. This preserves the existing page controller and keeps the UI layer from becoming a second source of truth.

### Primary commands

- Search
- Layers
- Markets
- Economy
- Exceptions

### Persistent status

- world-state entity count
- backend connection state

## Visual language

The existing Payload design tokens remain authoritative:

- void/near-black workspace
- restrained gold for primary state/action
- cyan for information/telemetry
- green for confirmed healthy state
- red/orange for exceptions
- JetBrains Mono for operational/HUD values
- Inter for readable explanatory text
- glass surfaces only where they preserve map visibility

Do not introduce a competing colour system or generic SaaS card aesthetic.

## Interaction rules

- Map remains the primary spatial context.
- Panels open from explicit operator intent and should not permanently obscure the world state.
- Selected entities should establish a clear focus state while preserving provenance context.
- Search should become the universal entry point to entity/lane/port/carrier retrieval.
- Keyboard and pointer interactions should converge on the same command model.
- Mobile uses the same information architecture with progressive disclosure, not a separate product model.

## Architecture constraint

UI components may read canonical/application state through explicit props and callbacks. They must not mutate canonical state, evidence records, provenance, or domain storage directly.

The intended flow remains:

`Canonical/Application State → UI representation → operator action → domain command → state transition → UI observation`

The renderer is never authoritative.

## Initial implementation

Phase 1 establishes the command surface as a reusable component. Subsequent work should wire it into the existing page controller, then progressively refactor duplicated controls into the command model while retaining current functionality.
