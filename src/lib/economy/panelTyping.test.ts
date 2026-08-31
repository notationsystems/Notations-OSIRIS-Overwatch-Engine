import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NO PANEL TAKES `any` (ledger phase 46, amendment A-3).
 *
 * The deleted `ScmPanel` is why this exists. It took `data: any`, read
 * `data.scm_suppliers`, filtered on `risk_level === 'CRITICAL'` and
 * counted — a risk badge with nothing behind it. No provenance, no basis,
 * no `knownAt`, no refusal. It is the general-purpose base's idea of a
 * supply chain, and it is exactly what the substrate exists to replace.
 * (It was also imported, given a toggle and a keyboard shortcut, and
 * never rendered — the `c` key drove a state nothing read.)
 *
 * `any` on a panel prop is not a typing inconvenience. It is the door
 * through which a figure reaches the screen with its provenance stripped:
 * once the compiler stops checking, nothing distinguishes an
 * `Observation` carrying a source and a `knownAt` from an object literal
 * with a `risk_level` string, and the panel renders both the same way.
 *
 * THE RULE IS A RATCHET, NOT A CLEAN SHEET. Eight components inherited
 * from the base still take `any` props. Failing on all of them today
 * would mean deleting or rewriting eight working components in a change
 * about something else, so instead they are LISTED — and the list may
 * only shrink. A component not on the list may not introduce an `any`
 * prop, which is the half that matters: every freight panel is new, so
 * every freight panel is typed by construction.
 */

const COMPONENTS = join(process.cwd(), 'src/components');

/**
 * Inherited from the general-purpose base. Each renders a feed the
 * substrate does not own yet. THIS LIST MAY ONLY SHRINK — a new entry is
 * a new instance of the defect A-3 deleted.
 */
const ANY_PROPS_INHERITED: Readonly<Record<string, string>> = {
  'PayloadMap.tsx': 'The map shell, taking a layer payload per general-purpose feed. Types arrive with the feeds themselves as each is retired or converted.',
  'LiveAlerts.tsx': 'Aggregates alerts across every general-purpose feed; the union is only knowable once those feeds are retired (A-1).',
  'LayerPanel.tsx': 'Toggles the general-purpose layers by id.',
  'MarketsPanel.tsx': 'Quote payload from /api/markets, still the base shape.',
  'IntelFeed.tsx': 'The inherited general-purpose event stream, carrying one shape per feed it aggregates.',
  'CameraViewer.tsx': 'CCTV descriptor from the inherited camera registry.',
  'ArcGISPanel.tsx': 'ArcGIS layer descriptors, shaped by the remote service.',
  'AiOverview.tsx': 'Free-form model output, which has no schema until the prompt contract has one.',
  'DrawingToolbar.tsx': 'The live entity store, swept for whatever falls inside each drawn polygon — arbitrary by construction, since it holds every enabled layer at once.',
};

/**
 * A prop declared `any`.
 *
 * SCANNED PER DECLARATION, NOT PER LINE. The first draft tested whole
 * lines and reported MarketsPanel clean — its props are written
 * `interface MarketsPanelProps { data: any; spaceWeather?: any; }`, all on
 * one line, so a line-anchored pattern could not see them. A guard that
 * misses a declaration because of where the author put a newline is
 * narrower than it appears, which is the class this repository keeps
 * finding; it was found here by the list and the scan disagreeing.
 *
 * So the source is split on the delimiters that END a property
 * declaration — `;`, `{`, `}`, newline — and each fragment is tested.
 * A fragment beginning with `(` is a parameter list rather than a
 * property, which is what keeps `.map((row: any) => …)` out of a rule
 * about props.
 */
const ANY_PROP = /^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\??\s*:\s*(?:any\b|any\[\]|Record<[^>]*,\s*any\s*>)/;

interface Finding { file: string; line: number; decl: string }

function scan(): Finding[] {
  const out: Finding[] = [];
  for (const file of readdirSync(COMPONENTS)) {
    if (!file.endsWith('.tsx')) continue;
    const src = readFileSync(join(COMPONENTS, file), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      for (const fragment of line.split(/[;{}]/)) {
        if (ANY_PROP.test(fragment)) {
          out.push({ file, line: i + 1, decl: fragment.trim() });
          break;
        }
      }
    });
  }
  return out;
}

describe('no panel takes `any`', () => {
  const findings = scan();

  it('finds components to check (the guard must not pass by being empty)', () => {
    expect(readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx')).length).toBeGreaterThan(10);
  });

  it('introduces no new `any` prop outside the inherited list', () => {
    const fresh = findings.filter((f) => !(f.file in ANY_PROPS_INHERITED));
    expect(
      fresh,
      'These components declare an `any` prop and are not on the inherited list.\n' +
        'A panel that takes `any` renders a figure with its provenance stripped: the\n' +
        'compiler stops distinguishing an Observation carrying a source and a knownAt\n' +
        'from an object literal with a risk_level string. Type the prop against the\n' +
        'record it actually renders — EconEntity, Observation, Divergence, Commitment —\n' +
        'the way CommodityPanel already does:\n' +
        fresh.map((f) => `  ${f.file}:${f.line}  ${f.decl}`).join('\n'),
    ).toEqual([]);
  });

  it('keeps the inherited list a ratchet — every entry still earns its place', () => {
    // An entry that no longer has an `any` prop has been fixed, and the
    // list must lose it: a debt list that keeps paid-off entries stops
    // measuring the debt.
    const withAny = new Set(findings.map((f) => f.file));
    const paidOff = Object.keys(ANY_PROPS_INHERITED).filter((f) => !withAny.has(f));
    expect(
      paidOff,
      'These components no longer take an `any` prop. Remove them from ' +
        'ANY_PROPS_INHERITED so the list keeps measuring the remaining debt.',
    ).toEqual([]);
  });

  it('ScmPanel is gone and does not come back', () => {
    expect(readdirSync(COMPONENTS)).not.toContain('ScmPanel.tsx');
  });

  it('every inherited entry carries the reason it is still there', () => {
    for (const [file, reason] of Object.entries(ANY_PROPS_INHERITED)) {
      expect(reason.length, `${file} needs an argument, not a placeholder`).toBeGreaterThan(30);
    }
  });
});
