# Sea Dog Terminal — shipping work order

> Received 2026-08-27, after the 3.1–3.7 order was discharged at `c1a60f5`.
> Committed verbatim as the pre-registration all S-items are judged
> against. The operator's covering note: this is deliberately not feature
> work — it is the gap between "the code is correct" and "someone opens it
> on a Tuesday and it is still true." Archive durability (S-2) carries a
> genuine deadline property (Comtrade revises in place; a lost snapshot is
> an unrecoverable knowledge state); S-7 pre-registers the continue
> criterion BEFORE the researcher afternoon, because thirty-four phases of
> investment make continuation the default no matter what the afternoon
> says. Everything infrastructure-related is INSPECT: the operator cannot
> see hosting, CI or the access model — measure first and correct the
> assumption in the report.

Branch `claude/payload-physical-economy-7o9g2w`, head `c1a60f5`, 574 tests, 34 ledger phases, seven `validWhile` guards.

This order takes the system from a green branch to an instrument that is deployed, used, maintained and — if it earns it — kept. It is not feature work. Every item is about the gap between "the code is correct" and "someone opens it on a Tuesday and it is still true."

Same working rules as the previous order: work top to bottom, don't return for approval between items, move on rather than stop when blocked, one report per item against the pre-registered criteria, and report a failed criterion rather than adjusting it.

Everything stated here about infrastructure is INSPECT. I cannot see the deployment target, the CI configuration, the hosting or the access model. Where this order assumes, measure first and correct the assumption in the report.

## S-0 — Standing doctrine

Unchanged from the previous order and the ledger. In brief, because shipping is where these get quietly dropped:

* Five axes on every comparison: basis, population, universe, partition, completeness.
* Refuse, don't default. Null is not zero. A node that can't answer stays visible and declines.
* Account for every drop. Accepted, rejected with a reason, or filtered with the predicate named and counted.
* A check must run everywhere its condition holds.
* Vacuity: every predicate has a planted condition proving it fires; a discriminating case names the state in which it fails before it is written.
* Deferrals are conditions, not memories.
* No new analytical dimensions. Shipping is where scope creep is most attractive and most expensive.

## S-1 — Release the branch

Objective. Get thirty-four phases of work onto the mainline under a version.

Why now. Everything since round 1 has lived on a working branch. A system nobody can check out at a named version is not shippable regardless of test count.

Work.

* Inspect the repository's existing release convention before inventing one — branch protection, CI configuration, whether main is protected, whether a tag convention exists.
* Merge to main. Tag a version. The ledger is the release note; do not write a second narrative that can drift from it.
* Ensure CI runs the full suite including the seven guards on every push to main. The guards are the system's self-check and are worthless if they only run locally.

Acceptance criteria (pre-registered).

* Main carries the work at a named tag, suite green in CI, not only locally.
* All seven `validWhile` guards evaluate in CI, per commodity, and a deliberately planted guard breach fails the pipeline.
* A fresh clone at the tag installs, builds and serves without an undocumented step.

## S-2 — Archive durability

Objective. Make the unreconstructable data survive an accident.

Why now, and why this is first among the operational items. `data-archive/comtrade/` holds vintages UNSD cannot reproduce — Comtrade keeps one version per dataset and revises in place, so a snapshot lost is a knowledge state permanently unrecoverable. The same property does not apply to MCS editions or EDGAR filings, both of which are retrievable retrospectively. Everything else in this order can be redone; this cannot.

Work.

* Inventory what is unreconstructable versus what is re-fetchable, and label each archive directory accordingly. Someone pruning the repository in a year needs to be able to tell.
* Verify the archive against itself: every index entry resolves to bytes whose hash matches, and every file is indexed. The artifact-store verification shape already exists; apply it to the whole archive.
* Establish an off-repository copy with a documented restore path. Committed-to-git is one location, not a backup.
* Confirm the Comtrade adapter still archives on every successful live retrieval, including when the parse subsequently fails — the archive rung is upstream of parsing for exactly this reason.

Acceptance criteria (pre-registered).

* Archive verification passes and runs in CI.
* A restore from the off-repository copy is executed once and documented, not assumed.
* The unreconstructable set is labelled and its count reported.

## S-3 — Deployment and access

Objective. A running instance a researcher can reach.

Work.

* Inspect what exists: hosting, environment configuration, whether anything is deployed today.
* Configuration seams, never hardcoded and never defaulted: the SEC User-Agent (`SeaDogTerminal/<version> OrgName role@org`), any source credentials, the archive path. A missing credential should refuse loudly at startup rather than degrade silently — a source that quietly serves snapshot because a key is absent is the fresh-but-wrong failure at the configuration layer.
* Access model: this is an internal research instrument and the collection policy governs what it ingests. Deployment raises the question the policy has never had to answer — what it exposes, and to whom. Record the decision; do not leave it implicit.

Acceptance criteria (pre-registered).

* A researcher can reach a running instance from a URL without a build step.
* Startup fails visibly on missing required configuration, with the missing key named.
* Corpus health is reachable in the deployed instance and is silent on a healthy corpus.

## S-4 — Operator runbook

Objective. The document that makes the afternoon produce evidence rather than confusion.

Why now. The system refuses in many typed ways, carries four banner states, distinguishes two knowledge modes and holds seven guards. A researcher who doesn't know that `refused:` is a work queue rather than an error will read the instrument as broken, and the afternoon will measure the runbook's absence instead of the instrument.

Contents, kept short enough to be read in ten minutes.

* The two knowledge modes and what switching does.
* The banner vocabulary: AS OF, AS KNOWN, TOPOLOGY EXTRAPOLATED +N months, TOPOLOGY OUT OF PERIOD, STRUCTURE HAS MOVED.
* The epistemic search grammar — `refused:`, `stale:`, `contested:`, `vintage` — and the point that a refusal carries a remedy and is therefore work, not failure.
* Known limitations, stated plainly and without softening: every facility is representative-attested; no index is reported-class end-to-end; the structural layer is 0% sourced by tonnage on attribution and capacity; historical structure exists at country granularity only; five of six curated events do not propagate at facility level; recall on mine and logistics events is structurally zero.
* What to do with a finding: the refusals digest is exportable and is the queue.

Acceptance criteria (pre-registered).

* Someone who has not worked on the system reads it and can, unaided, reach a bottleneck candidate, switch knowledge modes, and explain what a `refused:basis` hit is asking for.

## S-5 — Maintenance ownership and cadence

Objective. Name who keeps it true, and make the system say so when they don't.

Why now. The extrapolation clock stands at roughly 604 days against a 730-day ceiling. The flow snapshot ages, MCS publishes annually, Comtrade revises in place, Westmetall is a scrape one markup change from degrading. Guards firing into an empty room are not a safety property.

Work.

* Write the cadence: annual flow-snapshot refresh, MCS vintage ingest when each edition lands, Comtrade archival continuing, Westmetall plausibility gate monitored.
* Model the flow snapshot as a source with a cadence so corpus health reports it aging, rather than the extrapolation clock being the only thing that notices.
* Route corpus health somewhere a human sees — a scheduled digest is sufficient; silence on a healthy corpus means the digest is cheap.
* Name an owner per source in the registry. An unowned source is a source that will be stale before anyone notices.

Acceptance criteria (pre-registered).

* Every registered source with a built adapter has a named owner and a stated cadence.
* The flow snapshot appears in corpus health with its age.
* A simulated staleness produces a digest a human receives.

## S-6 — The researcher afternoon

Objective. The first evidence about this system that the system did not generate about itself.

Protocol, because an unstructured session measures the wrong thing.

* One researcher who did not build it. One real question they actually have — not a scripted tour, not a question chosen because the instrument can answer it.
* No guidance during the session. Answering "how do I..." mid-session converts the experiment into a demo.
* The runbook from S-4 in front of them, and nothing else.
* Afterwards: the miss log, the refusals digest, the session telemetry, and fifteen minutes of their unfiltered reaction.

What gets recorded, and this is pre-registration for a result nobody controls.

* Queries issued; misses logged, with what they were reaching for.
* Refusals hit, by type — these are the instrument telling them what it can't do.
* Whether they came back the following day unprompted.

Do not tune the instrument mid-session, and do not curate a source overnight to make a miss go away. The miss is the finding. A miss log filled with things one registered source could answer re-ranks the backlog on evidence. A miss log filled with things no source could answer moves the modality programme from deferred-on-principle to deferred-against-measured-demand, which is a far stronger position to fund from.

## S-7 — Pre-register the continue criterion

Objective. Decide, before the afternoon, what would justify keeping this running — and what would justify stopping.

Why this is an item and not an afterthought. Thirty-four phases of investment make continuation the default regardless of what the afternoon says. The whole discipline of this project is that a number decided after seeing the data isn't a measurement. Apply it here.

Write down, before S-6 runs:

* What use in the first ninety days would justify the maintenance cadence in S-5 — sessions, distinct users, findings that changed a decision. Pick the criterion, state the threshold.
* What result would justify stopping, or reducing it to a frozen artifact that is kept but not maintained.
* Who takes that decision, and when.

A system that nobody opens is not a failed system if it is honestly retired. It becomes one when it is maintained indefinitely because retiring it would look like a loss.

## S-8 — EDGAR, when the identity lands

Unblocks on one operator decision. The build sequence is already pre-registered in ledger Phase 22 with four requirements and the diagnosis rule.

Before executing it, apply the standing instruction in that phase: a pre-registration aged into archaeology is re-taken, not obeyed. Re-read the four requirements against the register as it stands then — two commodities, country flow vintages, the resolution gate, typed refusals — not as it stood when they were written.

The residual prediction is on record from Phase 33 and should be judged rather than explained: when EDGAR lands, attribution edges and capacities move together and flows stay where Comtrade put them.

## S-9 — Re-rank on evidence

After S-6, re-rank the backlog against the miss log and the refusals digest rather than against reasoning. This is the first time the ranking can be evidence-led, and it supersedes every ordering I have given.

Current standing order, to be replaced: EDGAR, OpenOwnership (recorded structurally unavailable from BO registers — a re-attempt targets a register in the vehicle's own jurisdiction), facility-level flow vintages via the allocation model, typed refusal emission (guarded, with its acceptance fixture already planted).

## Definition of done

The system is deployed, reachable, documented, owned, backed up, running its guards in CI, and has been used once by someone who did not build it — with the continue criterion written down before that use rather than after it.

Everything after that is decided by evidence rather than by this order.

---

## Addendum A (operator, mid-execution) — corpus table and export surface

Received while the order was executing; the operator placed it **before
S-6**: "it makes the researcher afternoon substantially more likely to
produce evidence, because browsing a corpus surfaces questions that
entity-by-entity navigation does not."

A projection over canonical state — no new acquisition, no new
analytics, no new consumer of analytics. The two-axis form (period ×
edition/knownAt) is the one only this system can produce: reading down a
column is one publication's account of history; across a row, the
revision history of one fact. Degenerate cases render, never collapse: a
single-vintage row is a fact never revised; an empty cell is a period an
edition did not cover — different from zero and must not look like one.
Every row carries the axes or it does not export; an unknown axis
exports null AND flagged. Header block with `baseline_fingerprint`,
knowledge state, row accounting and caveats on every export. Refusals
export as null-valued rows with their remedy. Markdown and JSON only —
no CSV/XLSX (spreadsheet coercion destroys exactly what this system
preserves). The export never round-trips back in. Export telemetry is
the third demand signal — the only positive one — and feeds S-7.

Acceptance criteria (pre-registered, operator's words):

* Every exported row carries all mandatory columns; a row with an
  unknown axis exports null and flagged, verified by a planted
  incomplete record.
* Markdown and JSON exports of the same query contain identical values
  and identical headers.
* An export under `as_known_then` contains no row whose `known_at`
  postdates `as_of`, verified by a planted late-vintage record.
* `baseline_fingerprint` on the export matches the state that produced
  it, and a mutated state produces a different fingerprint.
* The two-axis grid renders single-vintage rows and empty cells
  distinguishably from zero.
* Export telemetry writes in the running configuration, not only under
  test.
* No export path accepts input — verified structurally, not by
  convention.

Identifier reconciliation against this codebase, recorded at receipt:
the spec's `mine_production` is this corpus's `production` (with
`refined_production` / `intermediate_production` as the other physical
metrics); the spec's `vintage` column is carried as `source_id`
(editions are distinct sources here, e.g. `usgs-mcs2024`); `INV-6` has
no referent in this ledger — the operative doctrine is "a projection of
canonical state, never authoritative, never re-importable". The Zambia
refined-revision example is real in kind (revision_lag records exist
for `ent:country:zm`) but the −41.6% magnitude was not confirmed
against the corpus and is not repeated as a figure.

## Addendum B (operator, mid-execution) — external model clients, not an internal model

Decision recorded, not built mid-order: language-model clients plug
into the instrument from outside (e.g. an MCP tool surface over the
existing API) rather than a model being built into the system. Slotted
into the S-9 re-rank, to be judged against the S-6 evidence like every
other backlog item. Two consequences taken immediately because they
were cheap and belonged to the export item anyway: every export row
carries a server-rendered `claim` sentence (the value with its axes
attached — a client that copies the sentence carries the epistemics
with it), and the exposure question is appended to the S-3 access
decision in `docs/DEPLOYMENT.md` as an open item with its undecided
parts named (authentication, telemetry segregation from the S-7
readings, Westmetall posture for machine consumers).
