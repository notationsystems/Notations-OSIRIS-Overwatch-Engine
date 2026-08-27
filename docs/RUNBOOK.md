# Sea Dog Terminal — operator runbook

Ten minutes. This is the document in front of the researcher; nothing
else is. Everything here is about reading the instrument correctly —
the instrument's job is to tell you what it knows, how it knows it, and
what it refuses to say.

## The one rule that reframes everything else

**`refused:` is a work queue, not an error.** This instrument declines
to answer whenever an honest answer isn't available — a tonnage whose
mass basis can't be converted, a date its flow map doesn't cover, an
identifier its register can't resolve. Every refusal carries a typed
reason and a REMEDY: what would make it answer. A screen full of
refusals is the system working, and exporting them is how you leave with
a work list instead of a shrug.

## Two knowledge modes

- **BEST KNOWN** (default): everything the corpus holds today, latest
  revision of every figure.
- **AS KNOWN** (`knowledge=as_known_then` with a date): only what was
  knowable on that date — later revisions, later-reported events, and
  later-captured data are withheld and *counted* ("N further entities
  match but were not knowable then"). Switching modes changes answers;
  that is the point. Use AS KNOWN to ask "what could someone have
  concluded at the time?"

## The banners

| Banner | Meaning |
|---|---|
| `AS OF <date>` | The evaluation date every figure is selected against |
| `AS KNOWN` | You are in the historical knowledge mode above |
| `TOPOLOGY EXTRAPOLATED +N months` | The flow map is older than your date and serves as latest-known structure — labeled, quantified |
| `STRUCTURE HAS MOVED` | Curated events contradict that extrapolation at named entities — figures continue only because nothing better is modeled |
| `TOPOLOGY OUT OF PERIOD` | No flow map can describe your date; flow-derived tonnage is null (unknown), never zero |
| `COUNTRY-granularity vintage YYYY` | Historical dates are served by country-level trade corridors; facility detail refuses at these dates (the allocation model is the recorded remedy) |

## The search box speaks two languages

Ordinary text finds entities: `escondida`, `chile`, `glencore`. A first
token with a colon searches the instrument's *epistemic state*:

- `refused:` — everything declined, typed: `refused:basis` (tonnage
  needs a corridor grade or stage constant), `refused:topology` (date or
  granularity the flow map can't carry), `refused:scope` (regulatory
  event with no jurisdiction), `refused:attribution` (no operator
  edges), `refused:resolution` (a source identifier the register can't
  resolve — with the raw identifier and the fix)
- `stale:` — sources gone quiet, snapshot rungs, plausibility rejections,
  contradicted extrapolation
- `contested:` — where independent observers disagree about the same
  quantity, typed by mechanism
- `vintage` — which source editions the corpus actually holds

A miss is recorded (see below). A refusal is work. Neither is a bug.

## What the numbers are, plainly

- Every **facility** exists here on curation (representative-attested);
  country figures come from live official sources. The panel's
  attestation label says which you are looking at.
- **No index is reported-class end-to-end** — every analytical result
  carries `weakestInputClass`, and the structural layer (who owns what,
  what capacity exists) is 0% publisher-sourced by tonnage on
  attribution and capacity.
- **Historical structure exists at country granularity only** (trade
  corridors for 2017/2019/2020/2022); facility events at those dates
  refuse their tonnage with the reason named.
- **Five of six curated disruption events do not propagate at facility
  level** — three are facility-shaped and honestly refuse under
  historical dates; reach shows, tonnage declines.
- **Recall on mine and logistics events is structurally zero**: nothing
  here reads news. An event exists in this system only if it was
  curated. Absence of an alert is not absence of a disruption.

## Taking findings away

`GET /api/economy/refusals?commodity=copper[&asOf=...]` exports the
refusal queue grouped by type with remedies — most-blocking first,
uncapped. `?view=session` returns the session digest (queries, misses,
refusals served, entities inspected — counters and canonical ids only).
Your misses accumulate in `data-archive/search-misses.jsonl`: a query
the corpus can't answer is a demand signal that re-ranks the roadmap,
so ask what you actually want to know, not what you think it can answer.

`GET /api/economy/table?commodity=copper[&metric=...][&subject=ent:...]
[&format=md|json]` exports the corpus as a table — every row carries
its axes (unit, basis, value kind, source, period, known-at,
attestation), a header with the `baseline_fingerprint` of the state it
came from, and a ready-to-paste claim sentence per row. Add
`view=grid&subject=...&metric=...` for the period × edition grid: down
a column is one edition's account of history, across a row the
revision history of one fact; a dash is a period that edition did not
cover — not a zero. Markdown and JSON only: if you need a spreadsheet,
paste the markdown and own the conversion knowingly. Take the claim
sentences, not bare numbers — a value separated from its basis is
incommensurable in your own deck a month from now, and the fingerprint
is how a number in that deck gets checked against the state that
produced it.

---

## Operator section (not for the researcher's copy)

**Session mechanics** (work order 3.7 / S-6): one server process for the
whole afternoon (`npm run build && npx next start`) — telemetry is
per-process. Before shutdown, save: `data-archive/search-misses.jsonl`,
`/api/economy/refusals?commodity=copper` (and `aluminium`, and any
`asOf` they scrubbed to), `/api/economy/refusals?view=session`. Give no
guidance mid-session; a miss log shaped by coaching measures the
coaching. Whether they return the next day unprompted is a finding only
you can record — one dated line suffices.

**Do not** tune the instrument mid-session or curate a source overnight
to make a miss go away. The miss is the finding.
