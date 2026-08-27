import { describe, it, expect } from 'vitest';
import { GET as economyGet } from '@/app/api/economy/route';
import { GET as searchGet } from '@/app/api/economy/search/route';
import { GET as refusalsGet } from '@/app/api/economy/refusals/route';

/**
 * DEFECT CLASS 7 — the empty collection that carries no warrant.
 *
 * The operator's naming, after five instances found in one sweep: the
 * null-versus-zero rule distinguished UNKNOWN from NONE, and was incomplete
 * for thirty-eight phases. Five surfaces were returning a third thing — an
 * empty result set, internally consistent and truthful about a question the
 * researcher had not asked. Empty because refused, empty because the
 * population is aggregates-only, empty because it is genuinely nil, empty
 * because rows were dropped: all rendering identically as blankness.
 *
 *   Every refusal in this system carries a remedy. An empty array carries
 *   nothing at all. Silence is not a value, and an empty collection is a
 *   claim requiring a warrant like any other.
 *
 * This is the standing check. Each collection-returning surface is fetched
 * at several evaluation dates; wherever one comes back EMPTY, the response
 * must carry a warrant — a sentence saying which nothing it is. Surfaces
 * exempt from the rule are listed with the argument, never omitted.
 */

const req = (url: string) => new Request(`http://localhost${url}`);
const json = async (res: Response) => await res.json() as Record<string, unknown>;

/** Evaluation dates spanning the corpus's three topology regimes. */
const DATES: Array<{ label: string; qs: string }> = [
  { label: 'today', qs: '' },
  { label: '2022 (country vintage)', qs: '&asOf=2022-06-30' },
  { label: '2017 (earliest vintage)', qs: '&asOf=2017-06-30' },
  { label: '1990 (pre-topology)', qs: '&asOf=1990-01-01' },
];

interface Surface {
  name: string;
  /** Returns the collection and the warrant that must accompany an empty one. */
  probe: (qs: string) => Promise<{ items: unknown[]; warrant: unknown }>;
}

const SURFACES: Surface[] = [
  {
    name: 'map flows',
    probe: async qs => {
      const b = await json(await economyGet(req(`/api/economy?commodity=copper&view=map${qs}`)));
      return { items: b.econ_flows as unknown[], warrant: (b.topology as { status?: string })?.status };
    },
  },
  {
    name: 'graph flow links',
    probe: async qs => {
      const b = await json(await economyGet(req(`/api/economy?commodity=copper&view=graph${qs}`)));
      const links = (b.links as Array<{ kind: string }>).filter(l => l.kind === 'flow');
      const rep = b.representable as { reason: string | null } | undefined;
      return { items: links, warrant: rep?.reason ?? (b.topology as { status?: string })?.status };
    },
  },
  {
    name: 'bottleneck ranking',
    probe: async qs => {
      const b = await json(await economyGet(req(`/api/economy?commodity=copper&view=analytics${qs}`)));
      const block = b.bottlenecks as { result: unknown[]; emptyBecause?: string };
      return { items: block.result, warrant: block.emptyBecause };
    },
  },
  {
    name: 'facility coverage (mine)',
    probe: async qs => {
      const b = await json(await economyGet(req(`/api/economy?commodity=copper&view=analytics${qs}`)));
      const cov = (b.coverage as { result: Record<string, { result: unknown[]; emptyBecause?: string }> }).result.mineProduction;
      return { items: cov.result, warrant: cov.emptyBecause };
    },
  },
  {
    name: 'facility coverage (refined)',
    probe: async qs => {
      const b = await json(await economyGet(req(`/api/economy?commodity=copper&view=analytics${qs}`)));
      const cov = (b.coverage as { result: Record<string, { result: unknown[]; emptyBecause?: string }> }).result.refinedProduction;
      return { items: cov.result, warrant: cov.emptyBecause };
    },
  },
  {
    name: 'corpus health',
    probe: async qs => {
      const b = await json(await economyGet(req(`/api/economy?commodity=copper&view=analytics${qs}`)));
      return { items: b.corpusHealth as unknown[], warrant: (b.corpusHealthAccounting as { emptyBecause?: string })?.emptyBecause };
    },
  },
  {
    name: 'evidence search (refused:basis)',
    probe: async qs => {
      const b = await json(await searchGet(req(`/api/economy/search?commodity=copper&q=refused%3Abasis${qs}`)));
      return { items: b.evidenceResults as unknown[], warrant: b.evidenceNote };
    },
  },
  {
    name: 'evidence search (stale)',
    probe: async qs => {
      const b = await json(await searchGet(req(`/api/economy/search?commodity=copper&q=stale${qs}`)));
      return { items: b.evidenceResults as unknown[], warrant: b.evidenceNote };
    },
  },
  {
    name: 'refusals digest',
    probe: async qs => {
      const b = await json(await refusalsGet(req(`/api/economy/refusals?commodity=copper${qs}`)));
      return { items: b.byType as unknown[], warrant: b.note };
    },
  },
];

/**
 * Collections exempt from the warrant rule, each with the argument. Listed
 * rather than omitted: an exemption someone can read is a decision, an
 * exemption nobody wrote down is the defect returning.
 */
const EXEMPT_WITH_ARGUMENT: Record<string, string> = {
  'entity search results':
    'An entity query that matches nothing already carries THREE warrants by construction — withheld + withheldNote (the knowledge state is holding matches back), missNote + registryGaps (registered-but-unbuilt sources that could have answered), and the miss log entry. It was the first surface in the project to treat an empty result as a claim, and it is the model the rest are catching up to.',
  'econ_events':
    'The curated event record is an inventory, not an answer to a question asked at a date: an empty list means the corpus holds no events, which is a fact about curation the SOURCES panel already states. Recall on events is structurally zero outside the curated record and every surface carrying them says so.',
};

describe('class 7: an empty collection is a claim, and carries its warrant', () => {
  it('every collection-returning surface warrants its own emptiness, at every date', async () => {
    const empties: string[] = [];
    const unwarranted: string[] = [];
    for (const s of SURFACES) {
      for (const d of DATES) {
        const { items, warrant } = await s.probe(d.qs);
        if (items.length > 0) continue;
        empties.push(`${s.name} @ ${d.label}`);
        const ok = typeof warrant === 'string' && warrant.trim().length > 0;
        if (!ok) unwarranted.push(`${s.name} @ ${d.label} returned an empty collection with no warrant (got ${JSON.stringify(warrant)})`);
      }
    }
    expect(unwarranted, unwarranted.join('\n')).toEqual([]);
    // VACUITY: the sweep must actually have produced empty collections, or
    // this check passes by never testing its own rule.
    expect(empties.length, 'no surface came back empty — the sweep proves nothing').toBeGreaterThan(3);
  });

  it('a warrant is a SENTENCE, not a status word — it says which nothing', async () => {
    // A one-word status satisfies "carries a warrant" while telling a reader
    // nothing they can act on. The surfaces whose emptiness a researcher
    // actually meets must explain it.
    const explained: Array<{ name: string; qs: string }> = [
      { name: 'bottleneck ranking', qs: '&asOf=2017-06-30' },
      { name: 'evidence search (refused:basis)', qs: '' },
      { name: 'corpus health', qs: '&asOf=2017-06-30' },
    ];
    for (const e of explained) {
      const s = SURFACES.find(x => x.name === e.name)!;
      const { items, warrant } = await s.probe(e.qs);
      expect(items.length, `${e.name} is no longer empty here — re-pick the date or drop the case`).toBe(0);
      expect(String(warrant).length, `${e.name}: a warrant must be a sentence`).toBeGreaterThan(60);
      expect(String(warrant)).toMatch(/[a-z]{3,} [a-z]{3,}/i);
    }
  });

  it('the exemptions are stated, not assumed', () => {
    // The list is the point: an exemption someone can read is a decision.
    expect(Object.keys(EXEMPT_WITH_ARGUMENT).length).toBeGreaterThan(0);
    for (const [name, argument] of Object.entries(EXEMPT_WITH_ARGUMENT)) {
      expect(argument.length, `${name}: an exemption without an argument is an omission`).toBeGreaterThan(120);
      expect(SURFACES.some(s => s.name === name), `${name} is both exempt and swept — decide which`).toBe(false);
    }
  });
});
