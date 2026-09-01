# Freight as discrete manufacturing

The framing: a load is not a transaction that happens and settles, it is **a unit
under process control** — individually identified, routed through stations,
conforming to a spec, with a genealogy reconstructible afterwards.

Every module maps onto a manufacturing primitive, and the mapping is not
decorative — it is why each module has the shape it has.

| freight module | manufacturing primitive | what the shape buys |
|---|---|---|
| `lifecycle.ts` — `TRANSITIONS` | **router** | defined operations in sequence; an illegal transition is refused at construction, not validated after |
| commitment vs outcome | **specification vs measurement** | you record what was supposed to happen AND what did; the delta is the finding |
| `evaluateException` | **statistical process control** | not every deviation is an alarm. Materiality and actionability decide, which is why a control chart has limits rather than flagging every wobble |
| `carrierTrust.ts` | **supplier qualification** | components with attestation classes, incoming quality, first-article inspection |
| `notary.ts` | **certificate of conformance** | the condition held, provably, over a stated interval |
| `transparencyLog.ts` | **lot genealogy** | the thing an automotive recall runs on |

**Why it transfers:** freight's core problem is *process capability*, not
throughput. A traditional brokerage optimises cost per load. A discrete
manufacturer optimises **variance**, because variance is what makes a promise
unkeepable and a cost unpredictable.

The fixture's own findings read straight off that: the underquoting carrier at
**+11.4%** is a supplier whose process is out of control. The slipping receiver
at **341 minutes mean / 378 median** is a station with a capability problem.
Neither is visible to anyone counting cost per load.

## Where the analogy breaks — and both are already handled

**A factory owns its stations; you rent yours.** Carriers have their own agendas,
which is why supplier qualification is *more* load-bearing here than in a plant,
and why the `Interest` axis (`disinterested | self_reported |
negotiating_position | unknown`) exists at all.

**A factory controls its own tempo; you don't.** Which is why `claimable.ts`
exists: bounding latency in the one direction you control is the freight
equivalent of decoupling a station with a buffer.

## The caution, and a correction to it

The warning is right in general: discrete manufacturing at its worst builds
enormous measurement apparatus around a process nobody has run enough times for
the statistics to mean anything.

The specific example no longer supports it, and the reason is worth keeping.
**PLANT-8 was cited as "a real signal, unmeasurable at n=9–12 per cell."** That
was true of the fixture as it stood. Phase 64 measured why, and the answer was
not n:

- the slipping receiver took **≥74%** of the seasonal lane, so the confound was
  larger than the planted term;
- the estimator was a **mean over a bimodal variable**;
- the partition was **calendar quarters against a Dec–Mar plant**;
- and one cell was **one winter**, which cannot distinguish a season from a
  strike whatever the n.

With those fixed, the effect is recovered in **16 of 16 worlds** at n = 13–29 per
cell. It was a *fixture* defect and an *estimator* defect wearing an n-limit.

**And the volume figure sharpens the original point rather than defeating it.**
The world runs 900 loads over 720 days — **8.7 loads per week**, almost exactly
the brokerage described. At that volume:

> the seasonal effect **is** recoverable, on the plant's own partition with a
> median and a rate-above-threshold — and the naive calendar-quarter mean
> **misses it in 9 of 16 worlds**.

So the honest version is not *the apparatus is ahead of the volume*. It is:

> **At real brokerage volume the apparatus works, but only if the estimator is
> denominated right — and the obvious estimator fails more often than it works.**

Which is a stronger argument for building the measurement layer, not a weaker
one: the layer is what makes the difference between those two queries visible.
Year one is still building the traceability. What it is not is waiting for
volume before the numbers mean anything.

## The commercial consequence

A manufacturer does not run one of everything. **Density per lane is what makes
the measurement layer pay, and spot variety is what starves it** — which is why
the fixture concentrates 62% of its loads on a six-lane spine, and why the first
version, spreading 469 loads across 62 lanes at ~7 each, could not support a
single per-lane statistic.

That is a lane-concentration argument that happens to be commercial rather than
technical, and it falls out of the framing rather than being argued for
separately.
