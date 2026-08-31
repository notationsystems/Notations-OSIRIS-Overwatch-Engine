# Sea Dog Terminal — the named defect classes

Every class here was found the same way: by a human or an audit asking a
question no test was asking, usually several rounds after the defect
started producing wrong answers. They are collected in one place because
they were previously scattered across ledger phases, and a doctrine you
have to reconstruct from a narrative is a doctrine that gets restated
slightly wrong — which is itself one of the classes below.

Each entry states the SIGNATURE (how to recognise it), the INSTANCES
(confirmed, with what each cost), the DOOR each arrived through, what
closed that door, and — the part that matters — what does NOT generalise
from the fix.

---

## 1. Silent filtering

**Signature.** A row leaves the pipeline without being counted. The
result is internally consistent, the accounting adds up over what
remains, and the missing population is invisible because nothing ever
represented it.

**Instances.**
- The world-file commodity filter discarded aluminium's data for
  **twenty rounds**. Every figure computed was correct about copper and
  silent about the other commodity in the file.
- Unmapped M49 and MCS identifiers vanished at the resolution gate — the
  rows never became candidate records, so they were not "rejected", they
  simply were not.
- **The coverage table dropped the rows that mattered most** (phase 42).
  `facilityCoverage` answers one question — how much of a compiled country
  total does the facility model account for — and it `continue`d past every
  country with no facility observation. The rows it discarded were exactly
  the 0% ones. Measured: 19 countries carry a compiled mine-production
  total and 9 rows were served; the 10 dropped included China (1800 kt/y),
  Russia (930), Australia (800), Kazakhstan (740), Canada (450) and Poland
  (410). For refined production the corpus holds NO refinery or smelter
  production observation at all, so all 17 were dropped and the table was
  EMPTY — reading as "no coverage question here" rather than "the facility
  model accounts for 0% of world refined output". The number the facility
  HHI travels with said its coverage floor was 21.8%; over the true
  population it is 0%. No test pinned the row count, so nothing tripped.
- **The evidence layer's own display caps** (phase 39). The standing
  refusal queue held 30 records; `searchEvidence` served 20; the search
  bar rendered 6 of those. None of the three surfaces said so. The
  function that truncates carries a comment explaining that the DIGEST
  passes `Infinity` "because a work queue that silently truncated would
  read as covered" — and then the interactive queue truncated silently.
  Worse than the count: the slice runs over a list built type-by-type, so
  a refusal TYPE can vanish entirely behind a fuller one, and the
  researcher reads "these are the refusals" with a mechanism absent.

**Door.** A predicate that returned fewer rows than it received — and,
in the phase-39 instance, a `.slice()`, which is the same predicate
written as presentation.

**Closed by.** Row accounting (round 26): every fetched row is accepted,
rejected with a reason, or filtered with the predicate NAMED and COUNTED.
A conservation test asserts every row lands in exactly one bucket. For
the display caps, `EvidenceCensus` (phase 39): the page carries
`total`/`shown`/`truncated` and a per-type census taken BEFORE the cut,
so no type can hide behind the cap; both surfaces state their own depth.

**Does not generalise.** Row accounting covers rows. The same shape
recurs wherever a population is narrowed without a counter — which is
why the class is stated in terms of POPULATIONS, not rows.

---

## 2. Scoped-check blindness

**Signature.** A check runs correctly somewhere, and is silent everywhere
else its condition holds. It passes, and its passing means less than it
appears to.

**Instances.** Three, each found by a human one to twenty rounds late —
guards evaluated on copper while aluminium was in scope; checks written
against one partition of a register that had grown a second.

**Door.** An evaluation scope narrower than the condition's domain.

**Closed by.** `guardEvaluationScope()` DERIVES the partition list from
the adapter register rather than listing it — a literal partition list is
subject to the exact defect it certifies. The standing runner reports the
full cross-product of partitions × predicates it actually evaluated, so
an uncovered cell is nameable rather than invisible.

**Does not generalise.** Deriving the scope fixes partitions the register
knows about. It says nothing about a dimension the register does not
model.

---

## 3. Vacuous examples

**Signature.** An assertion that cannot fail, or fixture data in which
the interesting case does not occur. The test is green because the
condition it checks is never exercised, not because the code is right.

**Instances.** Backtest assertions that held over an empty candidate set;
guard predicates whose planted condition was absent from the fixture.

**Door.** A test whose failing state was never constructed.

**Closed by.** Vacuity plants: every predicate carries a planted
condition proving it fires, and a DISCRIMINATING CASE — the state in
which it fails, named BEFORE the assertion is written. Applied one level
up in phase 34: a vacuity plant must itself be shown to be
discriminating, coarse and subtle.

**Does not generalise.** A plant proves the check can fire on the state
you imagined. It cannot prove the check fires on the state you did not.

---

## 4. Wrong-attribution refusals

**Signature.** The outcome is correct and the diagnosis is wrong. The
figure is honestly null, every test asserting "a refusal occurred"
passes, and the remedy on the explanation — and the TYPE on the exported
queue — point at the wrong mechanism.

**Instances.** Three, all found by audit rather than by a failing test:
the `kt gross/y` unit shadow (gross corridors refused on unit parse
before the grade lookup ran); regulatory basis-honesty notes firing at
predating dates (corridor-grade remedy pushed when the mechanism was
topology); and the compounding path — the evidence classifier keys on
that prose, so a mistyped explanation propagated into the QUEUE type:
wrong remedy, wrong bucket, wrong specialist, on the exact artifact the
researcher afternoon exports.

**Door.** Prose that a downstream classifier reads as data.

**Closed by (partly).** `refusalTypeCouplingIntact()` runs a planted
instance of every refusal mechanism through the real propagation
pipeline and the real classifier on every guard evaluation. The DURABLE
fix — each mechanism emits its own refusal type and the text is rendered
FROM it — is deferred under `typed-refusal-emission-unbuilt`.

**Does not generalise.** "Expect a refusal" is never a sufficient
assertion. The next instance will not look like this one.

---

## 5. Context severance — *a mechanism narrower than it appears, with nothing failing*

**Signature.** Every part reports success truthfully. No exception, no
red test, and each mechanism's self-description is accurate — about an
artifact that is not the one in use. Found only by asking: *does that
reach the thing I think it reaches?*

**Instances (phase 37, all in one afternoon, none of which failed
anything).**
- The boot report: the log said `boot ready in 2805ms` while
  `/api/health` answered `booting` **indefinitely**.
- The outbound rate limiter: it kept TWO per-host chains and spaced each
  perfectly — a throttle that exists to prevent compounding, defeated by
  a door it could not see.
- State warming: boot warmed a cache no request would ever read, silently
  voiding the whole item.
- Then, found by the sweep: `sessionTelemetry` (the counters that ARE the
  frozen S-7 demand evidence — a severed copy under-reports an afternoon
  while every write looks correct), `mcpSession` (route-around estimated
  over half its calls), and `COMTRADE_DA` (duplicate outbound load, and a
  `knownAt` that could differ between contexts for one record).

- **Instance 7, at a DATA seam rather than a module one (phase 38):** the
  map projection dropped the `basis` axis, so F-5's "one basis per
  width-scaled layer" ran on a single `unspecified` bucket — one width
  ramp for gross-weight and contained-metal alike, and a mixed-basis
  refusal that could never fire. Found by RENDERING the UI after the
  class said where to look. The mechanism, its unit tests and its
  documentation all agreed with each other and not with the world.

**Door.** Next.js runs the instrumentation hook in a DIFFERENT module
context from route handlers, so module-level state is not shared — and,
for instance 7, a projection that quietly omitted a field.

**Instance 8 (phase 40): the graph view answered every date the
same way.** `selectTopology` / `topologyValidity` — phase 13's machinery,
whose entire purpose is that a date outside every flow vintage yields
null rather than today's structure wearing a historical label — had the
MAP VIEW as its effective scope and "the instrument's flow topology" as
its apparent one. The graph branch read `state.flows`: every vintage at
once, identical at 1990 and today. Measured: at 1990-01-01 the map served
0 flows with status `predates` while the graph served the same 39 links
it serves now; at 2017 the map served 9 country corridors and the graph
served today's 39 facility links. And the graph view is the one that
displays an `AS OF <date>` chip over what it draws — the projection
asserting the knowledge state was the one ignoring it. Nothing failed.
Reachable by a researcher, not only by API: the time bar's leftmost
position is 2017-01, inside the country-vintage era, and the runbook's
move #2 sends them there.

Closing it surfaced a structural fact the old behaviour had been hiding:
this view excludes countries as AGGREGATES, and the historical vintages
are country↔country corridors, so at those dates it can draw none of the
topology. That is a third kind of zero — not "no topology covers this
date" and not "the network is empty" — and it is now counted and named
(`representable: {flowsInSelectedTopology, flowLinks, withheld, reason}`),
with the recorded deferral as its remedy rather than a widening of the
view.

### The instance roster — ordered by phase, because the ordinal was drifting

This table is the ONE place class-5 instances are counted, and the ordinal is
DERIVED from phase order rather than asserted.

It exists because the count had already drifted. `DEFECT_CLASSES.md` called the
phase-40 graph view the "ninth instance" while `ARCHITECTURE_LEDGER.md` titled
phase 48 "ninth instance" — two documents, two different ninths, and the
ledger's chain (38→7th, 46→8th, 48→9th, 50→10th) simply skipped phase 40.

That is class 6 — *the literal that agrees with itself and not with the world* —
arriving in the registry that catalogues it, by exactly the mechanism the ledger
names at phase 44: "a hand-maintained number describing something". A count
maintained in two prose documents will disagree; the only question was when.

Ordinals below are positions in this table. Adding an instance means adding a
row, and `defectClasses.test.ts` fails if a row names a phase the ledger does
not contain, if the ordinals are not contiguous, or if a ledger heading claims
an ordinal that contradicts this table.

| # | Phase | The mechanism, and what its effective scope really was |
|---|-------|--------------------------------------------------------|
| 1 | 37 | The boot report: log said `boot ready in 2805ms`, `/api/health` answered `booting` indefinitely |
| 2 | 37 | The outbound rate limiter kept TWO per-host chains — a throttle defeated by a door it could not see |
| 3 | 37 | State warming warmed a cache no request would read |
| 4 | 37 | `sessionTelemetry` — the counters that ARE the frozen S-7 demand evidence |
| 5 | 37 | `mcpSession` — route-around estimated over half its calls |
| 6 | 37 | `COMTRADE_DA` — duplicate outbound load, and a `knownAt` differing between contexts |
| 7 | 38 | A DATA seam, not a module one: the map projection dropped the `basis` axis |
| 8 | 40 | The graph view answered every date the same way — `selectTopology` had the MAP as its effective scope |
| 9 | 46 | The collection policy examined registration and was silent about the served route surface |
| 10 | 48 | "The shipped description" was more than one file |
| 11 | 50 | The door was an ENUMERATION: nine hand-written panel cascades, and three guards narrower than their titles |
| 12 | 52 | `isDiscriminating` accepted a distance-only probe, contradicting its own file's stated property |
| 13 | 53 | `degraded` was unreachable from every input; `strict:false` refused identically to `strict:true` |
| 14 | 54 | A test asserting the absence of the feature it was named for, and a "central" test that could not catch its own bug |
| 15 | 55 | A numeric type alias hid a type from the accounting guard that had just been widened to see it |
| 16 | 57 | An instance recorded in the wrong state of a distinction I had argued to preserve, from a summary, with the source in the scratchpad |
| 17 | 63 | A generator's transition chain walked its own private state table: 4,392 of 5,570 hops name a state the engine's `TRANSITIONS` refuses, reported as "zero illegal" |
| 18 | 63 | An identity renamed onto another's id: 18 carriers, 17 distinct, and the divergence scan's top offender was two carriers merged into one row |
| 19 | 63 | A defect described in a comment as already fixed, in the same file as the code causing it — the fallback misbinds on 3 of 16 seeds and did not fire at the one that was run |
| 20 | 63 | A detector whose named set was the whole population reported RECOVERED for two different plants: containment read as detection |
| 21 | 63 | A fixture that could not demonstrate its own finding — with the confound removed, a sound and an unsound estimator gave the same answer |
| 22 | 64 | A finding reported from one world: the estimator claim held at the seed that was run and in 7 of 16 worlds overall, with the single-world pin asserting it in the test file for the finding about it |
| 23 | 64 | An analysis that reported "the detector failed" when its input was empty — `not_recovered` where the lane carried zero loads |
| 24 | 64 | Two floors for one question: a generator guaranteeing 12 and an analysis requiring 15, so a planted signal was present and invisible |
| 25 | 64 | A confound that became the measurement — at ≥74% of the lane, the noise source was larger than the entire planted term |
| 26 | 64 | A parameter denominated wrong: a probability of forcing read as a target share, so 0.35 produced 62-75% |
| 27 | 64 | An assertion that grepped for a word and claimed to test a condition — `not.toContain('SOMETIMES')` against text that explains what a SOMETIMES is |
| 28 | 65 | A module that injected one clock correctly and read another silently — `atPickup` passed in, `Date.now()` called for the authority window |
| 29 | 65 | Two floors for one question, quoted in the same report: a carrier with 9 loads was above one and below the other simultaneously |
| 30 | 65 | The one figure that reaches an invoice was the one with no currency, while every type beside it carried one |
| 31 | 65 | A rate over an empty denominator reported as 0%: `Math.max(accepted, 1)` turned "no data" into "a clean record" |
| 32 | 65 | An integrity field taken as input and stored unchecked — a content hash nobody derives, on an artifact whose claim is third-party verifiability |
| 33 | 65 | A verifier whose effective scope was ZERO, with a passing negative test beside it reading as coverage — reproduced here after being reported |
| 34 | 65 | A benchmark measuring the operation nobody waits on: ~300k appends/sec quoted while one customer-facing proof cost 64-69 ms |

**What the roster shows that the prose did not.** Instances 12–16 are all in
CHECKING machinery — a probe arbiter, a selection branch, two tests, a scanner,
and a ledger entry. The class started in runtime state and has moved into the
apparatus built to catch it. That is not a coincidence and it is not irony: the
guards are the newest code, they are written fastest, and they are the least
often themselves checked.

**Closed by.** `processSingleton` anchors process-wide state on
`globalThis`; the map projection carries `basis` and the pin sits at the
route's own payload, against a measured discriminating topology (2017,
where the served set is genuinely mixed) rather than today's, where it
would be vacuous; `contextSeverance.test.ts` requires every mutable
module-level container to be either shared by construction or listed with
the argument for why severance is harmless. Vacuity proven at fixture
level and at file level (a planted severable module in the real tree
fails the check by name and line). For the ninth, the graph branch
selects its topology exactly as the map does, carries the topology block
in its payload, and accounts for what it cannot draw; three route-level
tests pin it, including one asserting the two projections AGREE about
which topology serves a date — the property whose absence was the
defect.

**Does not generalise — and this is the whole point.** The fix closes the
MODULE door. Each earlier class was also closed at its own door, and the
class produced a new instance anyway, through a mechanism none of those
fixes could have anticipated. What carries forward is the question, not
the remedy.

---

## 6. The literal that agrees with itself and not with the world

**Signature.** A number or name is restated in prose, drifts from the
thing it describes, and is then read back as authoritative — including by
people with no way to check it against the source.

**Instance.** Ledger phase 34 called a newly added guard "the seventh
deferred decision". The register already held seven, so it was the
eighth. That sentence — not a typo, a documented claim — propagated into
**two subsequent operator work orders**, written by someone reading these
documents rather than the register, which they could not see. Errors in
the system's account of itself become errors in the instructions given
to it.

**Second instance (phase 39): the runbook.** Move #3 of the operator
runbook — the only document in front of the researcher — instructed
"Search `refused:basis`". That type has no instances under today's
facility topology (the corpus's gross-weight corridors are
country-level), so the query returned an empty array, the dropdown never
opened, and a first contact with the refusal system was a blank screen
indistinguishable from a typo or a dead fetch. The prose was true when
written and the corpus moved underneath it. The same document printed
`refused:` as the name of the queue while the parser required at least
one type character after the colon, so the token the doc taught fell
through to the entity register and answered with a source-registry miss
note about copper. Found by EXECUTING the runbook against the running
instrument rather than reading it.

**Door.** A hand-maintained restatement of something the tree already
knows.

**Closed by.** The count is pinned against `DEFERRED_DECISIONS.length` in
a test. Generally: derive from the register, never restate it — the same
rule that closed class 2, applied to documentation instead of scope. For
the runbook, `runbookClaims.test.ts` (phase 39) EXTRACTS every evidence
query the document prints and runs each one: a printed query must return
records or come back with a note explaining the emptiness, and the one
deliberately invalid example must be refused by name. The runbook can no
longer send a researcher somewhere the instrument goes quiet.

**Does not generalise.** Only the counts someone thought to pin are
pinned, and only the runbook's *executable* claims are checked — its
prose about what a figure MEANS is still a restatement. The declared
evidence taxonomy is itself a literal, so it is not trusted either: a
tripwire runs every mechanism across five vintages and fails if any
emits a type the list does not declare, since a real refusal rejected as
a typo is the worse half of that failure.

---

## 7. The empty collection that carries no warrant

**Signature.** A collection comes back empty. It is truthful, internally
consistent, and answers a question the reader did not ask. Nothing
distinguishes *refused*, *the population is excluded here*, *genuinely
nil*, and *rows were dropped upstream* — all four render as blankness,
and the reader supplies the missing sentence themselves. Usually they
supply the most reassuring one.

**Why it took thirty-eight phases to see.** The project's oldest rule is
refuse-don't-default: null is not zero. That rule distinguishes UNKNOWN
from NONE at the level of a VALUE. A collection is a third thing, and it
had no rule. Every refusal in this system carries a remedy; an empty
array carries nothing at all.

> **Silence is not a value. An empty collection is a claim, and it
> requires a warrant like any other.**

**Instances (phases 39–43, all five on the researcher's actual path —
the first move, the first contact, the first click):**
- **Evidence search.** One empty array for four distinct states, including
  the exact query the runbook sends a first-time reader to. The dropdown
  did not open at all: first contact with the refusal system was a screen
  indistinguishable from a typo or a dead fetch.
- **The graph view.** Not empty but WORSE — it drew today's network at
  every historical date, under its own `AS OF <past date>` chip. Closing
  that produced a genuine empty (a country-granularity topology it cannot
  represent), which then needed a warrant of its own.
- **The bottleneck ranking.** `(0)` at every date the time bar can reach
  except the present — and it is the runbook's FIRST move. An empty
  ranked list reads as *"there were no bottlenecks in 2017"*: a claim
  about the world produced by a rendering artefact, and more dangerous
  than a blank canvas because it looks like an answer.
- **The coverage table.** The 0% rows were dropped, so the table's own
  worst cases were the ones it could not show; the refined table was
  empty because the answer was zero everywhere, and zero was the value
  being filtered out. Class 1 and class 7 compounding: a dropped row is
  not an absent row, it is a row that was REMOVED, and removal
  propagates — the map then drove smelter opacity from the mine table,
  invisible only because those rows were missing.
- **Corpus health.** The section did not render a zero; it did not render
  AT ALL. A health instrument that cannot distinguish *nothing is wrong*
  from *nothing was checked* has lost the distinction that is its
  product.

**Door.** A collection returned without the population it was drawn from.
Every one of these surfaces knew why it was empty at the moment it became
empty, and threw that away on the way out.

**Closed by.** `emptyWarrant.test.ts`: nine collection-returning surfaces
are fetched at four evaluation dates spanning the corpus's three topology
regimes, and any that comes back empty without a warrant fails BY NAME
AND DATE. Two vacuity guards — the sweep must actually produce empty
collections, and the warrants a researcher meets must be sentences rather
than status words. Proven to bite: with the bottleneck warrant removed,
the check fails naming the surface and three dates. Exempt surfaces are
listed WITH the argument (entity search, which has carried three warrants
since round 12 and is the model the rest are catching up to), because an
exemption someone can read is a decision and an exemption nobody wrote
down is the defect returning.

**Does not generalise.** The check covers the surfaces in its registry.
A new projection is not in it, and nothing forces a new one to be — the
same limitation every door in this document has. What carries forward is
the question: *if this comes back empty, which nothing is it, and does
the reader receive that?*

---

## The standing question

The first six reduce to one question, which no test asks on its own:

> **Does the thing this mechanism affects, and the thing actually in
> use, have the same identity?**

Row accounting, derived scopes, vacuity plants, refusal-type coupling,
the severance sweep, the pinned count, the evidence census and the
extracted runbook claims are eight places that question has been answered
permanently. There will be a ninth door.

**Class 7 asks a second question the first cannot reach.** Not *is this
the thing in use*, but *does what I am handing back say what it is*:

> **If this comes back empty, which nothing is it — and does the reader
> receive that?**

The corollary that produced it, stated where it was found, because it is
where the two questions meet: **an instrument that declines has to say
which kind of nothing it is returning.** "None of that type here", "not
at this date", "you named something that does not exist" and "the page
was cut" were one empty array, on three surfaces — the search bar, the
route, and the MCP tool an external model attaches to. Refuse-don't-
default was built into every mechanism and then discarded at the display.

Both questions have the same shape at bottom, and it is the shape of this
whole document: **a mechanism that is correct about what it examined, and
silent about what it handed on.**
