# Sea Dog Terminal — exposure options, prepared not taken (final order F-6)

S-3's access decision (internal, operator-controlled) left three parts
undecided and assigned them to S-9. Opening an MCP tool surface makes all
three live. This document lays out the options and their consequences so
the decision can be made on evidence after the afternoon. **Nothing here
is decided, and one of the three has an engineering default already
applied — stated as such below, not smuggled in as a decision.**

## What the MCP server does today

Stdio transport only. `npm run mcp` starts a server that speaks the
protocol over standard input and output to a client on the same machine,
and talks to the running terminal over `SEA_DOG_URL`. **It opens no port
and accepts no network connection.** Attaching therefore requires the
same access standing up the instance already requires. This is the
deliberately narrow default: it makes the tool surface real and testable
without taking the exposure decision.

---

## 1. Authentication — undecided

| Option | What it costs | What it buys | Consequence for the demand instruments |
|---|---|---|---|
| **Stdio only** (today) | Nothing to build. Every model client needs local machine access. | The exposure question stays closed. | None. Machine traffic is one operator-launched process. |
| **HTTP + bearer token** | A token store, rotation, one middleware. | Remote clients; per-token attribution of machine traffic. | Per-token identity would let route-around be measured per client rather than per process. |
| **HTTP, unauthenticated, network-restricted** | Nothing to build; a firewall or VPN does the work. | Simplest remote access. | Anything that can reach the port can read the corpus; no client attribution at all. |

The instrument holds no person data and no credentials, so this is not a
privacy question. It is an attribution question — you cannot tell two
model clients apart without something to tell them apart by — and a
licensing question (below).

## 2. Telemetry segregation — DEFAULT APPLIED, decision still open

**Applied now, as engineering, because the alternative silently corrupts
a frozen measurement**: requests carrying the machine-client header are
served identically but never counted in the human demand instruments.
They do not increment session telemetry, do not write the miss log, and
do not write the export log; they are recorded instead in
`data-archive/mcp-sessions.jsonl` (`src/lib/economy/machineClient.ts`,
`src/lib/economy/mcpSession.ts`).

The reason this could not wait for S-9: the S-7 continue criterion is
frozen and its thresholds — three unprompted return days, one finding in
someone's work product, ten distinct non-builder miss queries — were
written to describe *researchers*. A model probing the corpus can
generate ten misses in a second. Folding machine traffic into those
counters would not be a measurement error at the margin; it would make
the ninety-day threshold trivially satisfiable by a script, and the
criterion cannot be amended after the afternoon to repair it.

**What remains the operator's**: whether machine traffic should count
*at all*, and toward what. Three positions, none taken here:

- **Segregated permanently** (today's default): machine use is evidence
  about the MCP surface, never about researcher demand. Clean, and it
  means a corpus heavily used by models but by no humans reads as
  unused — which may be the honest reading, or may be the wrong one.
- **Counted separately, weighed at day 90**: the operator reads two sets
  of numbers and judges. Requires no code change; only a decision to
  look at both.
- **Folded in**: only defensible with per-client authentication and a
  new threshold, and the threshold cannot be rewritten now — so this
  position implies waiting for a *second* evaluation window rather than
  amending the frozen one.

## 3. Licensing for machine consumers — undecided

The Westmetall rung is a republisher scrape carried for internal research
with the licensed feed recorded as the remedy. S-3 already declined to
evaluate public *re-serving*. A model client is a third posture again:
not a person reading a page, not a public API, but an automated consumer
that may copy figures into work products elsewhere.

- **Narrowest**: exclude republisher-derived series from tool results,
  and say so in the tool description (a refusal with a remedy, which the
  surface already knows how to express).
- **Status quo**: machine clients see what a researcher sees; the
  posture is the same internal-research posture, unevaluated for
  automated consumers.
- **Resolve upstream**: license the feed, and the question disappears.

The claim sentences make this sharper rather than softer: every exported
figure now travels with its source id attached, so a Westmetall-derived
number pasted into someone's deck is *attributable* in a way it was not
before. That is good for provenance and it is exactly what a licensing
conversation would be about.

---

## What would settle these

The afternoon, then the S-9 re-rank. Specifically: whether anyone wants
remote access at all (option 1 is moot if not), whether machine traffic
materialises in volume (option 2's second position is cheap if it does),
and whether any exported figure leaves the building (option 3 becomes
concrete the first time one does). Deciding now would be deciding without
the evidence the whole ninety-day design exists to collect.
