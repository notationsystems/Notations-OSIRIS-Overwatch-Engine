import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  PANEL_SLOT, ALL_PANELS, CLOSED_PANELS, displacedBy, applyPanelCommand,
  overlappingPanels, slotOccupied, type PanelId, type PanelState,
} from './panels';

const PAGE = fs.readFileSync(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8');

describe('exclusion is derived, so it cannot drift out of symmetry', () => {
  it('displacement is symmetric for every pair', () => {
    // THE PROPERTY THE HAND-WRITTEN CASCADES BROKE 19 TIMES: spaceCam closed
    // alerts while alerts left spaceCam open, so which panel you ended up
    // looking at depended on the order you clicked.
    for (const a of ALL_PANELS) {
      for (const b of displacedBy(a)) {
        expect(displacedBy(b), `${a} displaces ${b} but not the reverse`).toContain(a);
      }
    }
  });

  it('a panel never displaces itself', () => {
    for (const id of ALL_PANELS) expect(displacedBy(id)).not.toContain(id);
  });

  it('the non-contended slots displace nothing', () => {
    expect(displacedBy('layers')).toEqual([]);
    expect(displacedBy('econGraph')).toEqual([]);
  });
});

describe('no reachable state stacks two panels on one anchor', () => {
  // Exhaustive over every click sequence up to length 4 across every panel in
  // the registry. The old logic failed this at length 2, in 24 distinct ways.
  //
  // The expected count is DERIVED from ALL_PANELS rather than written down.
  // It used to read `1 + 12 + 144 + 1728 + 20736`, and deleting one panel in
  // phase 69 turned that into a failure with nothing wrong: a hand-maintained
  // number describing something the registry already knows, which is the class
  // this file's own header is about.
  it('holds over every sequence of up to four toggles', () => {
    let checked = 0;
    const walk = (state: PanelState, depth: number) => {
      const bad = overlappingPanels(state);
      expect(bad, `overlap reachable: ${bad.join(' + ')}`).toEqual([]);
      checked++;
      if (depth === 0) return;
      for (const panel of ALL_PANELS) {
        walk(applyPanelCommand(state, { kind: 'toggle', panel }), depth - 1);
      }
    };
    walk({ ...CLOSED_PANELS, layers: true }, 4);
    const n = ALL_PANELS.length;
    expect(checked).toBe(1 + n + n ** 2 + n ** 3 + n ** 4);
  });

  it('and the pin: the OLD cascades do fail this, so the test is not vacuous', () => {
    // The exclusion sets exactly as they were written inline in page.tsx,
    // minus `remote` and `arcgis`'s reference to it: the World Remote panel was
    // deleted in phase 69 (BLE device capture and a localhost port scan), so the
    // pin can no longer name it. The remaining pairs still overlap, which is all
    // this pin claims.
    const OLD: Partial<Record<PanelId, PanelId[]>> = {
      spaceCam: ['alerts', 'markets'],
      economy: ['alerts', 'markets', 'spaceCam'],
      markets: ['alerts', 'economy', 'spaceCam'],
      alerts: ['drawing', 'markets'],
      directions: ['alerts', 'search', 'drawing', 'markets', 'spaceCam'],
      search: ['alerts', 'drawing', 'markets', 'spaceCam'],
      drawing: ['alerts', 'markets', 'spaceCam'],
    };
    const applyOld = (s: PanelState, panel: PanelId): PanelState => {
      const n = { ...s };
      const open = !s[panel];
      if (open) for (const c of OLD[panel] ?? []) n[c] = false;
      n[panel] = open;
      return n;
    };
    const overlaps: string[] = [];
    for (const a of ALL_PANELS) {
      for (const b of ALL_PANELS) {
        const st = applyOld(applyOld({ ...CLOSED_PANELS }, a), b);
        const bad = overlappingPanels(st);
        if (bad.length) overlaps.push(`${a}+${b}`);
      }
    }
    expect(overlaps.length).toBeGreaterThan(0);
  });
});

describe('the declaration matches where the panels actually render', () => {
  // A slot claimed here but not honoured in the JSX is the same defect one
  // level up: a registry whose apparent scope is the real layout.
  const RAIL_ANCHOR = /right-12 top-1\/2 -translate-y-1\/2/;

  it('every right_rail panel renders in the right-rail column', () => {
    const railCount = (PAGE.match(new RegExp(RAIL_ANCHOR.source, 'g')) ?? []).length;
    const declared = ALL_PANELS.filter((id) => PANEL_SLOT[id] === 'right_rail');
    // economy is the one that uses `fixed right-12 top-16` over the same column.
    expect(PAGE).toContain('fixed right-12 top-16');
    expect(railCount).toBeGreaterThanOrEqual(declared.length - 1);
  });

  it('every panel in the registry has a state variable in the controller', () => {
    const NAME: Record<PanelId, string> = {
      layers: 'showLayers', spaceCam: 'showSpaceCam', economy: 'showEconomy',
      markets: 'showMarkets', alerts: 'showAlerts', drawing: 'showDrawing',
      directions: 'showDirections', search: 'showDesktopSearch',
      arcgis: 'showArcGIS', econGraph: 'showEconGraph',
      spatial: 'showSpatial',
    };
    for (const id of ALL_PANELS) {
      expect(PAGE, `${id} has no state`).toMatch(new RegExp(`\\b${NAME[id]}\\b`));
    }
  });

  it('THE RATCHET: no inline exclusion cascade survives in the controller', () => {
    // The regression this whole module exists to prevent — a new handler that
    // hand-lists the panels it closes instead of declaring a slot.
    const cascades = [...PAGE.matchAll(/onClick=\{\(\) => \{([^}]*)\}\}/g)]
      .map((m) => m[1])
      .filter((body) => (body.match(/setShow\w+\(false\)/g) ?? []).length >= 2);
    expect(cascades, `inline cascade(s) reintroduced:\n${cascades.join('\n')}`).toEqual([]);
  });
});

describe('the command surface', () => {
  it('open is idempotent and toggle is not', () => {
    const once = applyPanelCommand(CLOSED_PANELS, { kind: 'open', panel: 'markets' });
    expect(applyPanelCommand(once, { kind: 'open', panel: 'markets' }).markets).toBe(true);
    expect(applyPanelCommand(once, { kind: 'toggle', panel: 'markets' }).markets).toBe(false);
  });

  it('closing a panel does not reopen what it displaced', () => {
    // Closing markets must not resurrect the alerts panel it replaced. The
    // state is what is open, not a stack of what was.
    let s = applyPanelCommand(CLOSED_PANELS, { kind: 'open', panel: 'alerts' });
    s = applyPanelCommand(s, { kind: 'open', panel: 'markets' });
    s = applyPanelCommand(s, { kind: 'close', panel: 'markets' });
    expect(s.alerts).toBe(false);
    expect(s.markets).toBe(false);
  });

  it('closeSlot clears a whole slot without touching the others', () => {
    let s = applyPanelCommand({ ...CLOSED_PANELS, layers: true }, { kind: 'open', panel: 'markets' });
    s = applyPanelCommand(s, { kind: 'open', panel: 'directions' });
    s = applyPanelCommand(s, { kind: 'closeSlot', slot: 'right_rail' });
    expect(s.markets).toBe(false);
    expect(s.directions).toBe(true);
    expect(s.layers).toBe(true);
  });

  it('slotOccupied reports the top bar, which the command bar must yield', () => {
    expect(slotOccupied(CLOSED_PANELS, 'top_bar')).toBe(false);
    const s = applyPanelCommand(CLOSED_PANELS, { kind: 'open', panel: 'directions' });
    expect(slotOccupied(s, 'top_bar')).toBe(true);
  });
});
