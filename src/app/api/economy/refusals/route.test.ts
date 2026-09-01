import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET as refusalsGet } from './route';
import { GET as searchGet } from '../search/route';
import { GET as entityGet } from '../entity/route';
import { resetSessionTelemetry } from '@/lib/economy/sessionTelemetry';

const req = (path: string) => new Request(`http://localhost${path}`);

/**
 * Work order 3.7: the simulated researcher session. The criteria are
 * pre-registered: a session produces a NON-EMPTY MISS LOG (through the
 * REAL write path — the env seams force it out of test suppression and
 * into a scratch directory) and a REFUSAL DIGEST; and the vocabulary
 * gate still holds — a person-shaped query is counted, its string
 * discarded.
 */
describe('researcher-session readiness (work order 3.7)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sea-dog-miss-log-'));
    process.env.PAYLOAD_FORCE_MISS_LOG = '1';
    process.env.PAYLOAD_MISS_LOG_DIR = dir;
    resetSessionTelemetry();
  });

  afterAll(() => {
    delete process.env.PAYLOAD_FORCE_MISS_LOG;
    delete process.env.PAYLOAD_MISS_LOG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a simulated session produces a non-empty miss log, a refusal digest, and an honest telemetry digest', async () => {
    // — The session —
    // 1. A hit: the researcher finds an entity and inspects it.
    const hit = await (await searchGet(req('/api/economy/search?q=escondida'))).json();
    expect(hit.results[0].id).toBe('ent:mine:escondida');
    await entityGet(req('/api/economy/entity?commodity=copper&id=ent:mine:escondida'));
    // 2. A true miss with register vocabulary: logged with its string.
    const miss = await (await searchGet(req('/api/economy/search?q=vessel shipping movements'))).json();
    expect(miss.results).toEqual([]);
    // 3. A person-shaped miss: counted, string discarded.
    await searchGet(req('/api/economy/search?q=jane doe'));
    // 4. An evidence query.
    const refusedQ = await (await searchGet(req('/api/economy/search?q=refused:basis'))).json();
    expect(refusedQ.evidenceKind).toBe('refused');

    // — Criterion: the miss log wrote through the REAL path, non-empty —
    const logPath = join(dir, 'search-misses.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.length).toBe(2);
    const vocab = lines.find(l => l.q === 'vessel shipping movements');
    expect(vocab).toBeDefined();
    expect(vocab.gapIds).toContain('maritime-ais');
    // — Criterion: the vocabulary gate holds at the log —
    const person = lines.find(l => l.queryWithheld === true);
    expect(person).toBeDefined();
    expect(person.q).toBeUndefined(); // the string is nowhere
    expect(JSON.stringify(lines)).not.toContain('jane');

    // — Criterion: the refusal digest is non-empty and grouped by remedy —
    const digest = await (await refusalsGet(req('/api/economy/refusals?commodity=copper'))).json();
    expect(digest.totalRefusals).toBeGreaterThan(0);
    expect(digest.byType.length).toBeGreaterThan(0);
    for (const g of digest.byType) {
      expect(g.count).toBe(g.items.length);
      expect(typeof g.remedy).toBe('string');
    }
    // The resolution gate's residue is in the queue (3.3 feeding 3.7).
    expect(digest.byType.map((g: { type: string }) => g.type)).toContain('resolution');

    // — The session digest: telemetry, no personal data —
    const session = (await (await refusalsGet(req('/api/economy/refusals?view=session'))).json()).session;
    expect(session.queries).toBe(3); // register searches (evidence query counted separately)
    expect(session.misses).toBe(2);
    expect(session.personShapedCounted).toBe(1);
    expect(session.evidenceQueriesByKind.refused).toBe(1);
    expect(session.refusalDigestsServed).toBe(1); // the session view itself is not a digest export
    expect(session.entitiesInspected).toContain('ent:mine:escondida');
    expect(JSON.stringify(session)).not.toContain('jane');
  });
});
