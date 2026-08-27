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

- **A seventh, at a DATA seam rather than a module one (phase 38):** the
  map projection dropped the `basis` axis, so F-5's "one basis per
  width-scaled layer" ran on a single `unspecified` bucket — one width
  ramp for gross-weight and contained-metal alike, and a mixed-basis
  refusal that could never fire. Found by RENDERING the UI after the
  class said where to look. The mechanism, its unit tests and its
  documentation all agreed with each other and not with the world.

**Door.** Next.js runs the instrumentation hook in a DIFFERENT module
context from route handlers, so module-level state is not shared — and,
for the seventh instance, a projection that quietly omitted a field.

**Closed by.** `processSingleton` anchors process-wide state on
`globalThis`; the map projection carries `basis` and the pin sits at the
route's own payload, against a measured discriminating topology (2017,
where the served set is genuinely mixed) rather than today's, where it
would be vacuous; `contextSeverance.test.ts` requires every mutable
module-level container to be either shared by construction or listed with
the argument for why severance is harmless. Vacuity proven at fixture
level and at file level (a planted severable module in the real tree
fails the check by name and line).

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

## The standing question

All six reduce to one question, which no test asks on its own:

> **Does the thing this mechanism affects, and the thing actually in
> use, have the same identity?**

Row accounting, derived scopes, vacuity plants, refusal-type coupling,
the severance sweep, the pinned count, the evidence census and the
extracted runbook claims are eight places that question has been answered
permanently. There will be a ninth door.

Phase 39 added a corollary worth stating on its own, because it is where
two of these classes meet: **an instrument that declines has to say which
kind of nothing it is returning.** "None of that type here", "not at this
date", "you named something that does not exist" and "the page was cut"
were one empty array, on three surfaces — the search bar, the route, and
the MCP tool an external model attaches to. Refuse-don't-default was
built into every mechanism and then discarded at the display.
