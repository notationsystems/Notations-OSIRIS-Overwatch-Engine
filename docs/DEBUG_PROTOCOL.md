# Payload — Debug Protocol

For the failure this system actually has. Not a crash — **a believable wrong answer.**

A crash tells you where it is. A wrong number that typechecks, runs, and returns a
correctly-shaped object tells you nothing, and every serious defect in this codebase has
had that profile. This protocol is ordered by how often each step has been the answer.

---

## 0. Before anything: what kind of wrong is it?

Three failures look identical from the outside and have nothing in common. Decide which
before you open a file, because the wrong branch wastes the session.

| Symptom | Class | Go to |
|---|---|---|
| A number that is defensible and false | **incommensurability** | §1 |
| A verdict that is correct with the wrong reason attached | **wrong attribution** | §2 |
| A blank, a zero, or a silent pass | **which kind of nothing** | §3 |
| Green locally, wrong in production | **artifact mismatch** | §4 |
| A check that never fires | **reachability / vacuity** | §5 |

---

## 1. Incommensurability — the number is defensible and false

**Every serious defect in this codebase has been this.** Mud tonnage read as copper.
Gross weight against contained metal. An index over 24 groups against one over 9. A
control index over 84.5% of tonnage against a country index over 100%.

Ask the five axes in order. The first one that differs between the two sides is the bug:

1. **Basis** — contained metal or gross weight? Millidegrees or degrees? Chargeable or actual?
2. **Population** — mines *and* refineries pooled into one "production"?
3. **Universe** — a partial modeled set read as a market?
4. **Partition** — indices over group counts that differ, compared as if they don't?
5. **Completeness** — one side 100% attributed, the other 84.5% renormalized?

**The tell:** the number is *plausible*. An implausible number gets caught. A defensible
one ships and gets quoted.

**The fix is never a correction factor.** State the basis, carry it with the number, and
refuse when it's unknown. A conversion applied to make two numbers comparable, without
recording that it was applied, recreates the defect one layer down.

---

## 2. Wrong attribution — right verdict, wrong reason

A refusal correct in outcome and wrong in its stated cause sends the work to the wrong
place, and **every "expect a refusal" test passes.**

Measured instances: a 403 recorded as `UNREACHABLE` (a claim about our request written as
a claim about the source); a `predates` refusal typed `basis` because the classifier keyed
on explanation text; unit-parse failure firing the corridor-grade remedy.

**Procedure:**
1. Find the assertion. If it's `expect(status).toBe('refused')` with no reason check, that
   test would pass under any refusal — it documented the bug rather than catching it.
2. Check whether the *remedy* is actionable for the *actual* cause. A remedy pointing at
   corridor grades when the real cause is a unit parse sends someone to the wrong file.
3. Check whether anything downstream keys on the reason — a work queue, a classifier, a
   digest. Wrong attribution propagates into the bucket, not just the message.

**Rule:** name the observable, not the inferred cause. *The ordering cannot be checked* is
a fact; *the test was written late* is an inference.

---

## 3. Which kind of nothing — a blank, a zero, a silent pass

Four different states render identically and mean opposite things:

- **refused** — we declined, and there's a remedy
- **empty population** — genuinely nothing there
- **rows dropped** — something was removed, and removal propagates
- **not evaluated** — the check never ran

**Procedure:**
1. Is it `0` or `null`? A zero where the answer is unknown is the single most common
   silent defect here. An index over an empty set is `null`. Coverage over zero
   denominator is `undefined`, not 1.0.
2. Is the empty collection carrying a *warrant*? An empty array carries nothing; a
   sentence-length warrant says which nothing it is. A one-word status satisfies "has a
   warrant" and tells a reader nothing.
3. If rows were dropped: is the drop **accounted**? Accepted, rejected-with-reason, or
   filtered-with-the-predicate-named. A commodity filter discarded a second commodity for
   twenty rounds because filtering was free while rejection was reported.
4. Is it "checked and found nothing" or "had nothing to check"? `refusals == ()` over zero
   inputs reads as success.

---

## 4. Artifact mismatch — green here, wrong there

Two greens about two different artifacts.

**Measured instances:** local suite green while CI ran a different tree (uncommitted work);
guards evaluating in CI against fixture state while production served different vintages;
`:latest` deploying a tree five commits behind the tag.

**Procedure:**
1. Does the **pushed** tree agree? Local green is a hypothesis until it does.
2. Is the deployed artifact the tagged one? Check `version.commit` on the running instance
   — if it reads `unstamped-build`, attribution is impossible and the finding is
   unattributable.
3. Do the guards evaluate against **deployed state** or CI state? Same guard, different
   state, different verdict.
4. Was the check scoped to a subset the failure lives outside? A guard running on one
   commodity is correct and silent about the other.

---

## 5. Reachability and vacuity — the check never fires

**The most expensive class, because it looks like coverage.**

Measured: twenty correct, mutation-tested refusals with a **0% rejection rate** — and 0%
over an unreachable branch is evidence about nothing. A coupling check that caught total
breakage but missed the partial rewording, which is how the class actually arrives.

**Procedure:**
1. **Plant the defect.** Not "does the test pass" — apply the mutation the check exists to
   catch and watch it fail *by name*. If it doesn't, the check is decoration.
2. **Plant the subtle one too.** Nobody breaks a classifier entirely; they reword one
   sentence. A check calibrated for total breakage is calibrated for the failure that
   doesn't happen.
3. **Trace a real input path.** Is there a route by which production data reaches this
   branch, or has it only ever been called directly from a test?
4. **Check the scope is derived, not enumerated.** A literal list of files, commodities or
   routes is silent about whatever isn't in it — and the enumeration itself is the defect.

---

## 6. Self-application — always, and it usually finds something

Run the class you just diagnosed **over the instrument that diagnosed it.**

This has landed on first run, repeatedly: the deployment check asserted the very class it
existed to catch (`"empty is the healthy state"`); the shipped-description gate read
`README.md` while `layout.tsx` advertised the prohibited capability harder; the
empty-warrant sweep failed on itself.

It's a step, not an insight. **Naming class N forces the sweep.**

---

## 7. Before you close it

- [ ] The fix has a **revert pin** — apply the reversion, watch a named test fail. A fix
      that can be silently undone has been made once, not made permanent.
- [ ] If the fix isn't behaviourally observable, the pin is **structural and labelled as
      such** — a structural pin titled as behavioural reads as coverage it doesn't have.
- [ ] The **ledger** carries what was measured, the verdict, what the work revealed that
      wasn't anticipated, and every self-correction.
- [ ] A phase report with **no self-correction** is a phase where nothing was probed. Say
      so rather than presenting it as clean.
- [ ] If a deferral's premise moved, the **`validWhile` guard** fires — re-take the
      decision or acknowledge it with a new trigger. Never exempt it.

---

## 8. What not to do

- **Don't adjust a threshold to make a test pass.** A number decided after seeing the data
  isn't a measurement. Report the failed criterion.
- **Don't reconstruct plausible continuity.** Work referencing identifiers absent from the
  tree belongs to another session. Grep, refuse, say so. Resemblance is the hazard — a
  stray about provenance discipline reads as native here.
- **Don't `git checkout` to undo a plant** if there's uncommitted work in the file. It
  reverts to HEAD and takes the work with it. Stash or copy first.
- **Don't fix six things at once.** One cycle, one item, one pin. Six simultaneous changes
  that all typecheck is exactly the profile of the reversion set that shipped.
