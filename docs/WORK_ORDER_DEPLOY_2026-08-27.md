# Sea Dog Terminal — deployment hardening order (operator, verbatim, 2026-08-27)

> Committed before execution as the pre-registration.
>
> **INSPECT correction on receipt (the tree wins):** the order states head
> `86abd9e`, 590 tests. At receipt the tree is at `59ade61` with 619 tests
> green in CI — the final build order (F-1…F-7) landed between the order
> being written and being read. Nothing in this order depends on the
> difference except that F-6's exposure options already exist for D-12 to
> take, and machine-traffic telemetry segregation is already applied as
> an engineering default (see `docs/EXPOSURE_OPTIONS.md`).

Head `86abd9e`, 590 tests green in CI, ghcr image published, `docs/DEPLOYMENT.md` and `docs/RUNBOOK.md` in place.

**What this order is not.** The shipping order (S-1…S-9) is discharged and the final build order (F-1…F-7) covers the MCP surface, the validator, route-around telemetry and visual refusal discipline. Do not re-derive either. This order covers only the gap between *an image exists* and *an instrument runs unattended, with users, and is still true on a Tuesday*.

**Tiered deliberately.** Stop at the tier you need. Tier 1 is required before a researcher touches it. Tier 2 before it runs without someone watching. Tier 3 before an external client attaches.

Everything about infrastructure is INSPECT. The tree and the running instance win over anything stated here.

## Tier 1 — Before the afternoon

### D-1 — Guards must evaluate against deployed state, not only CI state

The most important item in this order. The seven guards run in CI against the repository's state. The deployed instance's state is not that state: different vintages fetched, different ladder rungs served, a different topology age, possibly a source degraded to snapshot. A guard that passes in CI and would fire in production is the split-commit hazard one layer over — two greens about two different artifacts, which this project already named as a standing rule.

**Work.** Expose guard evaluation as a runtime endpoint against live state. Include it in the health surface. A firing guard on a running instance is a first-class condition, not a test failure.

**Acceptance.** The deployed instance reports guard status against its own state; a planted breach in deployed state is visible at the endpoint; the CI verdict and the runtime verdict are reported as separate facts and never conflated.

### D-2 — Boot behaviour, and honest degradation at boot

**Work.** Determine by inspection what a cold start does: does state rebuild from adapters, from archive, or both? Then make each failure honest.

* A source unreachable at boot must bring the instance up degraded and saying so, never silently empty and never blocked indefinitely.
* A missing archive path fails loudly at startup with the path named — not at first request.
* Required configuration absent fails at startup with the key named.
* Boot duration is bounded and reported; a researcher waiting on a silent cold start assumes it is broken.

**Acceptance.** Three planted boot conditions — unreachable source, missing archive, missing config — each produce a distinguishable, named outcome, verified on the deployed image rather than in unit tests.

### D-3 — Every response carries build version and state fingerprint

**Work.** Extend `baseline_fingerprint` from exports to every API response, alongside the build version and the knowledge state that served it.

**Why.** A researcher reporting "this number looks wrong" is otherwise unattributable — you cannot tell which build, which vintage set, or which ladder rung produced it. During the afternoon this is the difference between a finding and an anecdote.

**Acceptance.** Every response carries version, fingerprint and knowledge state; a mutated state produces a different fingerprint on a live request.

### D-4 — Request-time failure behaviour

**Work.** Adapter failure during a request must not surface as a stack trace or a 500. It is a degradation, and the ladder already knows how to express it. Confirm the request path honours the same discipline as the ingest path: serve the best available rung and name it in the response.

**Acceptance.** A source forced to fail mid-request returns a served-from-snapshot response with the rung named, not an error.

### D-5 — Bounded returns, with truncation stated

**Work.** The corpus table and export are uncapped by design — correct for a work queue, a footgun over a decade of observations across two commodities. Add limits with the limit and the truncation in the header, in the same shape as the withheld-row count.

**Why.** A silent truncation is a claim that the omitted rows do not matter. This project has a standing position on unstated drops.

**Acceptance.** A query exceeding the limit returns the limit, the total, and the truncation count in the header; the row accounting conservation assertion still holds.

### D-6 — Post-deploy smoke check

**Work.** One command that hits the real endpoints on the running instance and asserts: corpus non-empty for both commodities, guards evaluated, corpus health reachable, export renders, search returns, refusals digest returns. Runnable by the operator after every deploy.

**Acceptance.** The check passes on the live instance and fails visibly against a deliberately broken one.

## Tier 2 — Before it runs unattended

### D-7 — Process observability

Data staleness is covered by corpus health; process health is not. Structured logs with the request fingerprint from D-3, error rates, boot events, adapter outcomes per rung. Enough that a failure at 3am is diagnosable at 9am without reproducing it.

### D-8 — Restart and persistence semantics

Determine and document what survives a restart: archive (must), TTL caches (need not), derived state (rebuilt). Then verify it, because a cold restart that silently re-fetches everything is a rate-limit incident with the SEC and a politeness problem with Westmetall.

### D-9 — Off-provider backup, and a real restore drill

The current off-repo copy is GitHub→GitHub — one provider incident takes both, and the Comtrade vintages are the unreconstructable set. Move the copy off-provider and execute a restore from it onto a clean machine. A backup that has not been restored is a hypothesis.

### D-10 — Outbound rate discipline in the long-running process

The SEC cap is 10 requests/second and a 403 block lengthens on immediate retry. Westmetall is a courtesy scrape. Confirm the throttles hold in a long-running process rather than only in a one-shot script, and that concurrent requests cannot compound.

### D-11 — A staging path

Deploying a change to an instrument a researcher has open mid-session, with no way to check the change first, is how a good instrument loses a user. One staging target, one promotion step.

## Tier 3 — Before an external client attaches

### D-12 — The exposure decision, taken

F-6 prepares the options; this takes them. Authentication, inbound rate limiting, and — the one with a deadline — telemetry segregation.

If machine traffic lands in the same counters as human sessions, the ninety-day continue threshold measures the wrong thing. That criterion is committed and frozen, and amendment after the afternoon is not legitimate. So segregation must be decided **before** the MCP server is reachable, not at S-9 with the rest.

### D-13 — Machine-consumer licensing posture

Westmetall republishes LME; USGS and Comtrade have their own terms. Serving that data onward to external clients is a different act from reading it internally. Record the posture per source in the registry alongside the existing `access_class`, and refuse to serve any source whose posture is unresolved rather than defaulting to permissive.

## Definition of done, per tier

**Tier 1.** A researcher can be handed a URL, and every number they see is attributable to a build, a state and a knowledge mode; every failure they hit is named rather than raw; and the guards report against the state actually serving them.

**Tier 2.** The instance can run for a month without supervision, and anything that goes wrong in that month is diagnosable afterwards and visible while it is happening.

**Tier 3.** An external model can attach without the firm having taken an undecided position on access, rate, or redistribution.

## Hold

* Do not build features. Nothing in this order adds capability.
* Do not touch the frozen continue criterion.
* Do not let Tier 2 or 3 delay the afternoon. Tier 1 is the only prerequisite for it, and if Tier 1 slips, hand the researcher a supervised session on a local instance rather than postponing — the evidence matters more than the polish.
* Three misdirected messages from other sessions have reached this program's review. Verify identifiers against the tree; refuse to reconstruct plausible continuity; say so.
