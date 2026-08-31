# Sea Dog Terminal — deployment and access (shipping order S-3)

## Inspection results (2026-08-27, corrected against assumptions)

Nothing is deployed today. What exists:

- A `Dockerfile` and a `docker-publish` workflow (inherited with the
  substrate) publishing multi-arch images to
  `ghcr.io/notationsystems/sea-dog-payload-terminal-v0` on pushes to
  `main` and on `v*.*.*` tags. The workflow's branch trigger referenced a
  `master` that never existed; corrected to `main` in S-1.
- `next build && next start` serves the full instrument from any host
  with Node 22 (verified from a fresh clone at `release/v0.1.0`: install
  → build → serve → answer, no undocumented step).
- No hosting target, no credentials to one, in this build environment —
  standing a public URL up is the operator's step, deliberately (see the
  access decision below). One command on any Docker host:

  ```
  docker run -p 3000:3000 ghcr.io/notationsystems/sea-dog-payload-terminal-v0:0.1.0
  ```

  **PIN THE VERSION TAG, do not deploy `:latest`.** `latest` is published
  from `main` only. The working branch runs ahead of `main` between
  merges, so `:latest` can be an older instrument than the one a session
  was prepared against — the split-commit hazard at the deploy layer, and
  the same shape as every other "two greens about two different artifacts"
  in this project. Before a session, confirm the running instance is the
  intended tree: `/api/economy/guards` reports `version.commit`, which the
  image now carries. A `commit_source` of `unstamped-build` means the
  image was built outside the publish workflow; pass the SHA explicitly
  (`--build-arg SEA_DOG_BUILD_SHA=<sha>` at build, or
  `-e SEA_DOG_BUILD_SHA=<sha>` at run) rather than accepting a baseline
  that cannot be attributed to a tree.

## Configuration seams (fail loudly, never degrade)

`src/lib/economy/config.ts`, asserted at server boot via the Next.js
instrumentation hook: a missing REQUIRED key kills startup with the key
NAMED. The degradation ladder exists for the network failing, not for
the operator forgetting a key — a source quietly serving snapshot
because a credential is absent is the fresh-but-wrong failure at the
configuration layer.

| Key | Required when | Meaning |
|---|---|---|
| `SEA_DOG_EDGAR_ENABLED=1` | — | Enables the EDGAR document tier (unbuilt; operator-blocked) |
| `SEA_DOG_SEC_UA_ORG` | EDGAR enabled | SEC User-Agent organization — never fabricated |
| `SEA_DOG_SEC_UA_CONTACT` | EDGAR enabled | SEC User-Agent role email — never fabricated |
| `SEA_DOG_MISS_LOG_DIR` | optional | Miss-log directory (default `<cwd>/data-archive`) |
| `OSIRIS_DISABLE_LIVE=1` | optional | Force snapshot rungs — visible in provenance, never silent |

No built source requires a credential today; the gate is the socket the
first credentialed source plugs into, and it is tested (including the
partial-identity refusal).

## Access decision (recorded, not implicit)

**The deployed instance is internal: operator-controlled access, no
public exposure.** Reasons, in order:

1. **The collection policy governs what the instrument ingests; this
   decision governs what it emits.** Everything served is a projection of
   canonical state — sourced observations, curated structure, typed
   refusals. No person data is held (the person-name policy is pinned at
   three surfaces), so exposure is not a privacy hazard; it is an
   EVIDENCE hazard:
2. **The demand instruments assume the users are researchers.** The miss
   log, refusals digest and session telemetry are the project's only
   evidence of use, and the S-7 continue decision reads them. A public
   instance fills them with crawler and passerby noise, and the
   afternoon's experiment — already the only non-self-generated evidence
   available — becomes unreadable.
3. **Licensing posture.** Westmetall is a republisher scrape carried for
   internal research with the licensed feed recorded as the remedy;
   public re-serving is a different posture than internal use and has not
   been evaluated. Until it is, non-public is the honest default.

Consequence: the corpus health surface, refusals digest and session
telemetry are reachable to whoever can reach the instance — which is
exactly the population whose use they are meant to measure.

**Open item — external-client exposure (recorded 2026-08-27, decided at
S-9):** the operator has directed that language-model clients plug into
the instrument from outside (e.g. via an MCP tool surface) rather than a
model being built into it. That surface would be a THIRD population with
access — neither operator nor invited researcher — and it changes this
decision's terms: reasons 2 and 3 above were argued against crawler
noise and public re-serving, not against a small number of authenticated
tool clients whose queries ARE legitimate demand signal (the export log
records them like any other). What is already done ahead of that
decision: every export row carries a server-rendered `claim` sentence so
a client that copies the sentence carries the axes with it, and the
export/table surface is GET-only with canonical-vocabulary boundaries,
so a tool client cannot write or free-text anything into the corpus or
its logs. What is NOT decided: authentication mechanism, whether tool
traffic is segregated in telemetry (it should be distinguishable from
the S-7 readings or it contaminates them), and the Westmetall posture
for machine consumers. This item is to be resolved as part of the S-9
re-rank, with the S-6 evidence in hand.

## Corpus health in the deployed instance

`GET /api/economy?commodity=<c>&view=analytics` → `corpusHealth`:
an array of signals, EMPTY on a healthy corpus — silence is the healthy
state, so a monitoring hook is cheap (alert on non-empty, see S-5).

**Measured nuance (running-configuration verification):** on a refused
boot, Next 16 logs "Failed to prepare server" with every missing key
named and serves 500s on all routes — but HOLDS the process rather than
exiting. A supervisor watching exit codes sees nothing; watch the
health endpoint (or the log line) instead. The refusal is loud in the
two places that matter — the log and every request — and silent in the
one place a process manager would prefer; recorded rather than papered
over.
