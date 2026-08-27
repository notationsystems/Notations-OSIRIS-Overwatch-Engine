# Sea Dog Terminal — standing work order (received 2026-08-27, verbatim)

> Operator-authored pre-registration, committed so the work is judgeable
> in-repo. Judge each item against its acceptance criteria as written; report
> disagreements with the pre-registration rather than adjusting criteria.
> Per-item reports live in the architecture ledger, phases 26+.

Branch `claude/osiris-physical-economy-7o9g2w`, base commit `e65555f`, 555 tests passing.

## 1. How to work this order

**Autonomy.** Every item below is decided. Reversible implementation choices are yours.
Surface a decision only if executing an item would require changing a declared invariant, a
canonical schema in a backwards-incompatible way, or a deferral recorded in the ledger with a
`validWhile` guard — and if a guard fires, the acknowledge-and-hold branch from round 26 is
available and does not need permission.

**Recon-first still holds.** Any item touching an external source begins with a live probe
from the sandbox and verbatim captures committed. Build against proven-parseable, never
against imagined shapes. If a probe fails at a tier you cannot honestly cross, record the
constraint with the block page captured and move on.

**Pre-registration.** Each item below carries acceptance criteria written before the work.
Judge the result against them. If the result disagrees with the pre-registration, report the
disagreement rather than adjusting the criteria — the round-6 rule: pin the procedure, not the
number.

**Reporting.** One report per completed item, not per commit. Each report states: what was
built, what was measured, which pre-registered criteria passed or failed, what the work
revealed that wasn't anticipated, and which guards moved. A negative or null result is a
result — report it as the finding, not as a shortfall.

**Scope discipline.** No new analytical dimensions until this order clears. No third
commodity — two was the experiment and it returned its answer. No re-ranking. If an
attractive analytical idea appears mid-work, put it in the ledger as an unbuilt entry with a
`validWhile` predicate and keep moving. This rule exists because good ideas were repeatedly
the most effective way to erode a deliberate decision.

## 2. Standing doctrine

These were learned empirically across twenty-six rounds, each from a defect that shipped.
They are not style preferences.

**Incommensurability is the defect species.** Every serious defect in this project has been a
quantity compared against something it wasn't commensurable with — mud tonnage against copper
output, gross weight against contained metal, mine production pooled with refinery production,
a partial universe read as a market, an index over 24 groups against one over 9, a control
index over 84.5% against a country index over 100%. There are five axes and every comparison
must state all of them: **basis, population, universe, partition, completeness**. State them,
carry them with the number, and refuse rather than default when one is unknown.

**Refuse, don't default.** Zero is a value; the absence of a computable answer is not. An
index over an empty set is null. A propagation against out-of-period topology is null. A score
missing components is null and sorts first with its remedy named. A node whose shares can't be
computed stays in the map and declines to answer — it never vanishes, because vanishing is how
things go dark silently.

**Account for everything you drop.** Rejection was reported and filtering was free, which is
how a commodity filter discarded aluminium for twenty rounds. Every fetched row is accepted,
rejected with a reason, or filtered with the predicate named and counted. A drop is a claim
that the data doesn't matter, and claims get stated.

**A check must be evaluated everywhere its condition holds.** Guards that ran only on copper
were correct and silent about the region they didn't cover. This is item 3.1 below.

**Vacuity.** A test that cannot fail is not validation. Every predicate gets a planted
condition proving it fires. Where two modes are asserted to agree, assert first that their
inputs differ, or the agreement proves nothing.

**Knowledge versus world.** `knownAt` is when a value became available; the period is what it
describes. `firstReportedAt` is when an event entered the evidence base; `occurredAt` is when
it happened. Under `as_known_then` filter on the former; under `best_known` on the latter.
Hindsight leakage is the failure this machinery exists to prevent.

**Attestation direction is not uniform.** For a derived quantity the weakest input class wins,
because contamination propagates. For entity existence the strongest attesting class wins,
because one good witness suffices. `weakestInputClass` and `strongestAttestingClass` stay
distinct names; never a bare `sourceClass`.

**Deferrals are conditions, not memories.** Every deferred decision carries a `validWhile`
predicate evaluated on every test pass, and a firing guard means a decision needs re-taking,
with the original reason printed. A pre-registration aged into archaeology is re-taken, not
obeyed.

## 3. Work items, in order

### 3.1 — Guard evaluation-scope certification

**Objective.** A standing check that every `validWhile` predicate is evaluated at every site
where its condition can hold.

**Why now.** Three instances of the same blindness have been found — the copper-only guard
runner, the `!== 'Copper'` filter, and the general shape. Each was found by a human noticing,
one to twenty rounds late. The vacuity plants prove each predicate *can* fire; nothing proves
each is *evaluated everywhere its condition applies*. Commodity was the axis that bit twice;
the next one will be something else.

**Design.** Derive the evaluation scope from state rather than declaring it. Enumerate the
partitions the state actually contains — commodity today, whatever exists tomorrow — and
assert that guard evaluation covers the cross-product of partitions and predicates. A new
partition value that no guard run covers fails the suite, naming the uncovered cell.

**The trap to avoid.** This check is subject to the defect it certifies. If its partition list
is a literal, it will be silent about the axis nobody added. The enumeration must come from
the register.

**Acceptance criteria (pre-registered).**
- Adding a third commodity to the register without touching the guard runner fails a test
  that names the uncovered partition and the predicates not evaluated over it.
- The partition enumeration is derived from state; a test plants a novel partition value and
  asserts the check notices without code change.
- The existing six guards report their evaluation scope in the failure message.

### 3.2 — Country-level flow vintages

**Objective.** Restore propagation across the historical timeline at country granularity.

**Why now.** Five of six curated events — Escondida 2017, Grasberg 2017, Chuquicamata 2019,
Peru 2020, Las Bambas 2022 — currently null their propagation because the flow topology is a
single 2024 snapshot. This is the largest capability gap that is not blocked on anything. The
material is already in the building: Comtrade annual bilateral trade, ingested, archived and
`knownAt`-stamped.

**Scope.** Country-level only. Facility-level vintages require the country↔facility allocation
model, which stays deferred — do not build it, and do not let the country work quietly become
it. Facility-level propagation at historical dates remains refused with its remedy naming the
allocation model.

**Hazards, from prior rounds.**
- **Basis.** Comtrade quantities may be gross weight or contained metal depending on reporter
  — the Chile/China corridor is the known case. Every vintage flow carries its `QuantityBasis`
  and the graph's basis firewall applies unchanged. Do not convert without a corridor grade.
- **Mirror.** Reporter-declared and partner-declared are two claims about one flow. Choose one
  as the topology source, state the choice on the vintage, and emit the other as `Divergence`
  rather than discarding it.
- **Granularity.** The result carries its granularity explicitly. A country-granularity
  propagation must never render indistinguishably from a facility one.

**Acceptance criteria (pre-registered).**
- A 2017 evaluation returns non-null country-level propagation, with granularity stated on the
  result and on the panel.
- The topology guard resolves to the vintage at or before `asOf`; `predates` now fires only
  before the earliest vintage, not before 2024.
- The extrapolation clock re-grounds against the newest vintage rather than the 2024 snapshot.
- At least three of the five currently-nulling curated events propagate.
- Facility-level propagation at those dates still refuses, with the allocation model named.
- The `flow vintages deferred` guard fires on the second distinct flow period and is re-taken
  in the ledger — expected and correct, not a failure.

### 3.3 — Entity resolution gate

**Objective.** The deterministic gate the resolver contract has assumed since round 1:
proposals in, accept / reject / unresolved out, nothing silently dropped.

**Why now.** Round 25 found unmapped M49 and MCS identifiers being silently discarded at the
resolution layer. Row accounting made them countable; it did not make them resolvable. A
counted drop is better than an invisible one and still not an answer. This gap will widen with
every new source, and both remaining acquisition items add identifier vocabularies.

**Design.** Unresolved identifiers become typed records, not counts. They surface through the
epistemic-state search as `refused:resolution` with the remedy naming what would resolve them
— a mapping entry, a new entity, or a decision that the identifier is out of scope. Near
matches produce both candidates and never merge; name similarity alone is never sufficient,
and a match below the confidence floor is `unresolved`, not a forced assignment.

**Acceptance criteria (pre-registered).**
- An unmapped identifier produces a searchable `refused:resolution` hit carrying the raw
  identifier, its source, and the remedy.
- No code path merges two entities on name similarity alone; a test plants a near-collision
  and asserts both candidates survive.
- The gate is deterministic: same proposals and same register produce the same decisions.
- Row accounting's resolution-layer filtered counts reconcile against the unresolved records
  — every counted drop has a record, and the conservation assertion holds.

### 3.4 — OpenOwnership parent chains

**Objective.** Backlog slot 3. Parent chains behind the operating companies, closing the
question the JV vehicle curation left open — who stands behind Compañía Minera Antamina S.A.
and Compañía Minera Doña Inés de Collahuasi SCM.

**Recon first.** Probe reachability, auth requirements, licensing posture and coverage from
the sandbox with verbatim captures, exactly as the EDGAR recon did. Record what the source
cannot cover as carefully as what it can.

**Measure the class change.** This is the point of doing it, and the reason to be careful.
Parent chains over curated operator attribution are curated structure on curated structure; if
the source is reported-class, the structural profile moves and that is the finding. Report
`structuralClassProfile` before and after, by record and by tonnage.

**Acceptance criteria (pre-registered).**
- The two JV vehicles gain parents, or the source's inability to supply them is recorded with
  evidence.
- `strongestAttestingClass` on those edges is measured and reported, not assumed.
- `structuralClassProfile` is re-measured; if it stays at 0% by tonnage, that is the finding
  and it is reported as such.
- The two-purposes split holds: this is the ownership-structure purpose, and it does not
  silently become the operator-of-record purpose EDGAR owns.

### 3.5 — Alumina and bauxite stage conversion

**Objective.** The scope gap recorded unbuilt in round 25: gross bauxite and alumina flows need
form-level stage-conversion constants, since the corridor-grade machinery assumes
mirror-implied concentrate grades and the aluminium chain has no concentrate.

**Design.** Form-level constants with documented sources and uncertainty bands, in the same
shape as the copper corridor grade: a conversion carries its factor, its provenance and its
error, and where no constant exists the conversion refuses rather than defaulting. Bauxite to
alumina and alumina to primary metal are both published industry ratios with real variance —
capture the variance, not just the midpoint.

**Acceptance criteria (pre-registered).**
- A gross bauxite or alumina flow converts with a stated factor, source and uncertainty, or
  refuses visibly through the existing `refused:basis` path.
- The conversion never uses a copper constant; a test plants a cross-commodity constant lookup
  and asserts it fails.
- Aluminium flows curated in contained metal continue to work unchanged.

### 3.6 — Rename entry and User-Agent name

**Objective.** Record the rename to Sea Dog Terminal.

**Shape.** Additive only. A new ledger entry recording the rename and its date; the new name
forward. Historical phase entries are historical statements and stay as written — rewriting
them to match the present is the archaeology problem inverted, and it is the same reason you
don't rewrite the 2024 vintage when 2025 lands. Provenance records naming the retrieving
system also stay: they were true when written.

The SEC User-Agent string should carry the new name when the identity is set. That is the one
place the rename touches something outbound, and it should not go to a regulator under a
retired name.

### 3.7 — Researcher-session readiness

**Objective.** Ensure the operator's afternoon produces evidence rather than an impression.

**Why.** `search-misses.jsonl` has never existed. Every interaction on record across
twenty-six rounds is builder validation. The one experiment that can return a result no amount
of building will produce is a real researcher with a real question, and the instrument that
measures it must actually be armed when they sit down.

**Work.**
- Verify the miss log writes in the running configuration, not only in principle. Under test
  it is suppressed by design; confirm the production path is live and the file's parent
  directory exists.
- Make the `refused:*` queue exportable as a digest — what the system declined to answer during
  a session, grouped by type with remedies, is a work queue and the most useful artifact the
  afternoon can produce.
- Add a session digest: queries issued, misses logged, refusals hit, entities inspected. No
  personal data — this is instrument telemetry, and the miss log's vocabulary gate already
  governs what query text is retained.

**Acceptance criteria (pre-registered).**
- A simulated session produces a non-empty miss log and a refusal digest.
- The vocabulary gate still holds: a person-shaped query is counted and its string discarded.

## 4. Definition of done for this order

All seven items complete or explicitly recorded as blocked with evidence; the suite green;
`structuralClassProfile` re-measured and reported whatever it says; every guard that fired
during the work re-taken in the ledger with its reason; and one report per item written
against the pre-registered criteria above.

## 5. Explicitly out of scope

- The EDGAR parser. Blocked; see §6. Do not build against imagined tables.
- The facility-level allocation model.
- A third commodity.
- Any new analytical dimension, including the event-class attribution basis, which is held with
  an acknowledged counterexample and forces its own build on the next sanctions-class curation.
- `RegulatoryScope`'s entity dimension, held with the Alunorte acknowledgment and its trigger.
- The modality programme — news and filings event extraction, AIS. Separately funded, and the
  modality-freeze guard governs it.
- Re-ranking this order.

## 6. Blocked, with what unblocks each

| Item | Blocked on | Who decides |
|---|---|---|
| EDGAR structural ingest | SEC contact identity for the User-Agent — an organization name and role email the firm controls | Operator |
| Researcher session | One researcher, one real question, one afternoon | Operator |

Neither is an engineering block. The first is procurement-shaped; the second costs an
afternoon and is the highest-information act available to this project.

## 7. If a stray message arrives

Two messages in this program's review have been misdirected from other sessions. Both were
caught by checking identifiers against the repository and finding zero hits. The hazard is
resemblance: a stray about scoped checks or provenance discipline reads as native here,
because that is this project's doctrine. Verify against the tree, refuse to reconstruct
plausible continuity, and say so. Inventing the referents to make a reply fit is the
self-consistent-and-wrong shape, and it is the failure this program has been most careful
about.
