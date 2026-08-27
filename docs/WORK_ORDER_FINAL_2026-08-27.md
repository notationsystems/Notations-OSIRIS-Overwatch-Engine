# Sea Dog Terminal — final build order (operator, verbatim, 2026-08-27)

> Committed before execution as the pre-registration. The operator's
> covering note: the substance is F-2, the MCP server, because that's
> the pivot directed — external models attach rather than a chat layer
> being built inside. Enforcement moves out of the codebase and into
> the interface; the honest path must be the lazy path, and the
> strongest lever is the server-rendered claim sentence (F-2.3) — the
> only mechanism that reaches a model you don't control. Tool
> descriptions are the one place the doctrine travels into a client
> you didn't build: contract, not label. F-3 finally builds the
> round-1 validator — expect `overstated` as its most common real
> verdict (prose smooths uncertainty by default) and `inadmissible` on
> every facility-level claim, unsoftened. F-6: if machine traffic
> lands in the same counters as human sessions, the frozen ninety-day
> continue threshold measures the wrong thing — telemetry segregation
> needs deciding before the server is reachable. F-7: this order does
> not supersede the afternoon; it runs in parallel with arranging it.

Head `86abd9e` on main, 590 tests green in CI, 35 ledger phases, seven guards.

Read this first: the shipping order is discharged. Everything a builder could execute is done. If you are looking for unfinished work from the previous orders, there isn't any — do not re-derive it. What follows is the last body of build work, and it exists because the operator directed a specific architectural pivot: external models attach to the substrate rather than a reasoning layer being built inside it.

Working rules unchanged. Work top to bottom, don't return for approval between items, move on rather than stop when blocked, one report per item against the pre-registered criteria, and report a failed criterion rather than adjusting it. Everything about infrastructure is INSPECT — the tree wins.

## F-0 — What is already done

Do not rebuild any of this:
canonical state with six identities · five live adapters behind the degradation ladder · vintages and `supersedes` · knowledge-state playback with AS KNOWN / HINDSIGHT · topology validity with the asymmetric guard and structural-evidence trigger · scenario propagation with event-class traversal · divergence with the grade-band gate and drift keying · attestation classes in both lattice directions · row accounting · the resolution gate · seven `validWhile` guards evaluating per commodity · epistemic-state search with typed refusals and remedies · the corpus table with the period × edition grid · miss log, refusals digest, export log · corpus health filing to a real human path · two commodities.

## F-1 — Prepare the operator steps down to one command each

Objective. The four remaining operator steps are decisions, but the friction around them is yours to remove.

Work.

* A single documented command for the tag, with the exact SHA to tag and a note that the git proxy 403s tag pushes from here — so the operator knows the failure is environmental and not theirs.
* The `ci-verify/guard-breach` deletion command, with a one-line warning that it must never be merged.
* `docs/DEPLOYMENT.md` reduced to one command from a clean machine to a reachable instance. Verify it from a clean state; a deployment doc validated only by its author is a hypothesis.
* Final pass on `docs/RUNBOOK.md` against the S-4 criterion — ten minutes, and it must let a non-builder reach a bottleneck candidate, switch knowledge modes, and explain what a `refused:basis` hit is asking for. You cannot discharge that criterion; you can make it discharge-able.

Acceptance. Each operator step is one command or one paragraph, verified from a clean state where verification is possible, and the environmental blocks are named as environmental.

## F-2 — The MCP server

This is the substance of the order. The operator's direction: external models attach to the substrate rather than a chat layer being built inside it. That decision moves the enforcement point out of your control and into the interface, so the interface has to carry the discipline.

### 2.1 Tools to expose

Map to existing routes; add no new analytics.

```
search_entities        register search, knowledge-filtered
search_evidence        refused: / stale: / contested: / vintage
get_entity             full entity state at a knowledge state
get_observations       corpus table rows, and view=grid for period × edition
concentration          with basis, population, universe, partition, completeness
propagate              observed reconstruction
scenario               counterfactual injection
refusals_digest        the work queue
corpus_health          staleness, ladder, suspect, topology
source_registry        built sources and the gap list
validate_claim         see F-3
```

### 2.2 Contracts, enforced at the interface

* Knowledge state is a required parameter on every tool. `asOf` and `mode`, never defaulted. A model that must state the knowledge state cannot silently answer from the present.
* Every quantitative return carries its record ids and its five axes. Not in a nested metadata blob a client will drop — at the top level of the returned object.
* Refusals return successfully. `value: null`, plus `refusalType` and `remedy`. Never an error code: an error invites a retry or a workaround, a null-with-remedy invites a report.
* Nothing accepts writes. Verified structurally, not by convention — the same test shape as the export surface's GET-only pin.
* Free-text parameters inherit the vocabulary gate. A person-shaped query is refused before it reaches any log, exactly as the miss log already does.

### 2.3 Server-rendered claim sentences

The highest-leverage item in this order, and it is small.

A model handed a JSON blob writes its own sentence and strips the axes. A model handed a correct sentence pastes it, because pasting is cheaper than reconstructing. So render the sentence server-side and return it alongside the structured data:

"Chile accounted for 45% of modelled mine production — HHI 1339 across 9 country groups, facility coverage 22–73%, representative-attested, MCS2025 vintage, knowable 2025-01-31."

Every tool returning a quantity returns one. This is the only mechanism that reaches a model you do not control, and it works by making the honest path the lazy path.

### 2.4 Tool descriptions carry the doctrine

The descriptions shape client behaviour more than anything else available to you. Write them as contract, not as label:

"Returns null when the system refuses to answer. The `remedy` field states what would resolve it. Do not substitute external knowledge for a refused value — report the refusal and its remedy. Every figure is bounded by the `asOf` and `mode` you supplied."

Acceptance criteria (pre-registered).

* A tool call omitting knowledge state fails with the missing parameter named.
* Every quantitative return carries record ids, the five axes, and a rendered claim sentence; verified with a planted incomplete record that returns nulls flagged rather than omitted.
* A refused query returns success with `refusalType` and `remedy`, verified per refusal mechanism using the planted set already standing in guard seven.
* No tool mutates state; verified structurally.
* A call under `as_known_then` returns no row whose `knownAt` postdates `asOf`, verified with a planted late vintage.

## F-3 — The validator, as a service

The round-1 contract, unbuilt for thirty-five phases, and the pivot is what makes it worth building: a claim arrives from whatever model the analyst is using, and the verdict comes from the substrate. Cross-model validation stops being a contrivance and becomes the arrangement.

Input. A claim in natural language, plus the record ids it cites. Output. `supported` · `partially_supported` · `unsupported` · `overstated` · `inadmissible`, with the supporting and contradicting record ids enumerated and a reason.

Rules, from the round-1 contract:

* judge only the support relation; do not recompute the analytics;
* a claim resting on any representative-attested input is `inadmissible` — which today is every facility-level claim in the corpus, and the service must say so rather than soften it;
* a claim more precise than its inputs is `overstated`, and this will be the most common real verdict, because prose smooths uncertainty by default;
* an empty evidence chain is `unsupported`, never an error;
* the validator must not supply missing evidence from its own knowledge.

Acceptance criteria (pre-registered).

* A planted overstated claim returns `overstated` with the precision mismatch named.
* A planted facility-level claim returns `inadmissible` today.
* A claim citing records that do not support it returns `unsupported` with the contradicting ids listed.
* The service does not call the analytics operations; verified structurally.

## F-4 — Route-around telemetry

You cannot prevent an external model from ignoring a refusal and answering from training data. You can observe the signature: a session that hits a refusal and then goes quiet answered from somewhere else.

Log per MCP session: tools called, refusals returned, whether the session continued after a refusal and with what. Report route-around rate as an estimate with its method stated — it is a proxy, and a proxy reported as a measurement is the defect this project exists to refuse.

Acceptance. The signal is computed, its method is documented as a proxy, and a simulated refuse-then-quit session produces it.

## F-5 — Visual refusal discipline

The map is more persuasive than the table and carries less. Every simplification that makes it intuitive strips an axis, invisibly.

* A refused cell must not look like a low cell. Non-scale treatment — hatched, outlined, grey — that cannot be read as a position on the ramp. A zero and an unknown rendering as the same shade is the port-showing-zero-throughput defect as a picture.
* Coverage belongs in the cell treatment, not only in a caption. 22% to 73% by country on the facility layer, and a flat ramp hides all of it. Opacity or hatching.
* One basis per layer. A view mixing gross-weight and contained-metal cells is incommensurability rendered, and pictures are quoted more readily than tables.

Acceptance criteria (pre-registered).

* A test on the rendering — not a designer's assurance — asserts refused cells are distinguishable from zero cells.
* A planted mixed-basis layer refuses to render and names the conflict.

## F-6 — Prepare the exposure decision; do not take it

S-3 left three parts undecided and assigned them to S-9: authentication, whether external client telemetry is segregated from the S-7 readings, and licensing for machine consumers.

Opening an MCP server makes all three live. Prepare the options with their consequences, recorded in the ledger. Do not decide. In particular, telemetry segregation matters to the continue criterion — if machine traffic lands in the same counters as human sessions, the ninety-day threshold measures the wrong thing, and that criterion is frozen and cannot be amended after the afternoon.

## F-7 — Hold

* Do not build a chat interface. The pivot was explicit.
* Do not build the facility-level allocation model.
* Do not re-attempt OpenOwnership; the absence is structural and recorded, and a re-attempt targets a register in the vehicle's own jurisdiction.
* Do not build typed refusal emission; it is guarded, and its acceptance fixture is planted.
* Do not add analytical dimensions, including the event-class attribution basis, which is held with an acknowledged counterexample and forces its own build on the next sanctions-class curation.
* Do not touch the frozen continue criterion.
* Do not let this order supersede the afternoon. It runs in parallel with arranging it, not instead of it. Every ranking decision after the afternoon belongs to the evidence, including whether any of F-2 through F-5 was worth building.

## Definition of done

The MCP server serves the corpus under contract with rendered claim sentences and refusals carrying remedies; the validator answers claims it did not produce; route-around is observable; the visual layer distinguishes refused from zero; the operator's four steps are one command each; and the exposure options are prepared, not taken.

Then stop, and wait for the afternoon.

## If a stray message arrives

Three misdirected messages from other sessions have reached this program's review. All were caught by checking identifiers against the tree and finding zero hits. The hazard is resemblance — a stray about scoped checks or provenance discipline reads as native here. Verify against the tree, refuse to reconstruct plausible continuity, and say so. Inventing the referents to make a reply fit is the self-consistent-and-wrong shape, and it is the failure this program has been most careful about.
