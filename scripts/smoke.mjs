#!/usr/bin/env node
/**
 * Sea Dog Terminal — post-deploy smoke check (deployment order D-6).
 *
 *   node scripts/smoke.mjs [base-url]        # default http://localhost:3000
 *
 * One command the operator runs after every deploy. It hits the REAL
 * endpoints on the RUNNING instance and asserts the instrument is
 * actually answering — not that the process is up, which is what a
 * liveness probe tells you and is not the same thing.
 *
 * Exit 0 = every assertion held. Exit 1 = at least one failed, with the
 * failure named. Nothing here is silent: each check prints its own
 * verdict, and a check that could not run at all is a failure, never a
 * skip.
 */

const base = process.argv[2] ?? process.env.SEA_DOG_URL ?? 'http://localhost:3000';
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`  FAIL  ${name} — ${e.message}`);
  }
}

async function json(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return res.json();
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log(`Sea Dog Terminal smoke check → ${base}\n`);

// 1. Corpus non-empty for BOTH commodities. One commodity answering is
//    exactly the failure the second-commodity work exists to catch.
for (const commodity of ['copper', 'aluminium']) {
  await check(`corpus non-empty (${commodity})`, async () => {
    const d = await json(`/api/economy?commodity=${commodity}&view=analytics`);
    assert(d.attribution, 'response carries no attribution block');
    assert(d.attribution.state.observations > 0, 'zero observations');
    assert(d.attribution.state.fingerprint?.length === 16, 'no state fingerprint');
    const deg = d.attribution.degradation;
    return `${d.attribution.state.observations} obs, fingerprint ${d.attribution.state.fingerprint}, ${deg.status}${deg.issues.length ? ` (${deg.issues.length} named)` : ''}`;
  });
}

// 2. Guards evaluated against DEPLOYED state (D-1).
await check('guards evaluated at runtime', async () => {
  const d = await json('/api/economy/guards');
  assert(d.verdict_of === 'runtime', 'endpoint does not declare itself the runtime verdict');
  assert(Array.isArray(d.scope) && d.scope.length > 0, 'empty guard scope');
  assert(d.guardCount > 0, 'no guards registered');
  assert(d.evaluatedCells.length === d.scope.length, 'not every partition evaluated');
  return `${d.guardCount} guards × ${d.scope.length} commodities: ${d.status}` +
    (d.failures.length ? ` — ${d.failures.map(f => `${f.commodity}/${f.id}`).join(', ')}` : '');
});

// 3. Corpus health reachable (empty is healthy — reachable is the assertion).
await check('corpus health reachable', async () => {
  const d = await json('/api/economy?commodity=copper&view=analytics');
  assert(Array.isArray(d.corpusHealth), 'corpusHealth is not an array');
  return `${d.corpusHealth.length} signal(s) (empty is the healthy state)`;
});

// 4. Export renders, in both formats, with the bound stated (D-5).
await check('export renders (json) with stated bound', async () => {
  const d = await json('/api/economy/table?commodity=copper&metric=production&limit=5');
  assert(d.header.baseline_fingerprint, 'export carries no fingerprint');
  assert(d.rows.length <= 5, 'limit not honoured');
  assert(d.header.total_rows >= d.header.row_count, 'total_rows below row_count');
  assert(d.header.row_count + d.header.truncated === d.header.total_rows, 'row accounting does not conserve');
  assert(d.rows.every(r => typeof r.claim === 'string'), 'a row carries no claim sentence');
  return `${d.header.row_count}/${d.header.total_rows} rows, ${d.header.truncated} truncated`;
});
await check('export renders (markdown)', async () => {
  const res = await fetch(`${base}/api/economy/table?commodity=copper&metric=production&format=md&limit=5`);
  assert(res.ok, `HTTP ${res.status}`);
  const md = await res.text();
  assert(md.includes('baseline_fingerprint'), 'markdown header lacks the fingerprint');
  assert(md.includes('## Claims'), 'markdown lacks the claims section');
  return `${md.length} bytes`;
});

// 5. Search returns.
await check('search returns', async () => {
  const d = await json('/api/economy/search?q=escondida');
  assert(d.results.length > 0, 'no results for a known entity');
  return `${d.results.length} hit(s), first ${d.results[0].id}`;
});

// 6. Refusals digest returns — the work queue is the most useful artifact.
await check('refusals digest returns', async () => {
  const d = await json('/api/economy/refusals?commodity=copper');
  assert(typeof d.totalRefusals === 'number', 'no refusal count');
  assert(Array.isArray(d.byType), 'no refusal grouping');
  for (const g of d.byType) assert(typeof g.remedy === 'string' && g.remedy.length > 0, `refusal type ${g.type} carries no remedy`);
  return `${d.totalRefusals} refusal(s) in ${d.byType.length} type(s)`;
});

// 7. Boot report present and honest about degradation (D-2).
await check('boot report present', async () => {
  const d = await json('/api/health');
  const boot = d.seaDogTerminal?.boot;
  assert(boot, 'health carries no boot report');
  assert(boot.status !== 'booting' || boot.ms === null, 'boot report is inconsistent');
  return `boot ${boot.status}${boot.ms !== null ? ` in ${boot.ms}ms` : ''}, archive ${boot.archive?.status ?? 'unknown'}`;
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('FAILED: ' + failed.map(f => f.name).join(', '));
  process.exit(1);
}
console.log('Instrument is answering.');
