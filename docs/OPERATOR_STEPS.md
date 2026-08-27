# Sea Dog Terminal — the operator's remaining steps (final order F-1)

Four steps, one command or one paragraph each. Everything a builder
could execute is done; these are decisions or acts requiring credentials
this build environment does not have. Where a step is blocked by the
environment rather than by you, it says so — an environmental failure
you mistake for your own costs an hour.

---

## 1. Tag the release

```bash
git fetch origin && git tag -a v0.1.0 -m "Sea Dog Terminal v0.1.0" <SHA> && git push origin v0.1.0
```

Use the head of `main` at the moment you tag (`git rev-parse origin/main`),
or pin the shipping-order release point `6f7a17e` if you want the tag to
predate the MCP work.

**This fails from inside the build environment, and that is not your
error**: the session's git proxy returns `HTTP 403` on `refs/tags` pushes
(four retries, same result). From a normal machine with push rights it
succeeds. The named version already exists as branch `release/v0.1.0` in
the meantime, so nothing depends on the tag except the `v*.*.*` image
trigger in `docker-publish.yml`.

## 2. Delete the CI-verification branch

```bash
git push origin --delete ci-verify/guard-breach
```

**Never merge this branch.** It carries a deliberately planted guard
breach (a mixed-granularity flow) used to prove the pipeline fails on a
real violation; merging it would put the plant on the mainline. Deleting
it from here also returns `HTTP 403` from the proxy — same environmental
block as the tag.

## 3. Stand up a reachable instance

```bash
docker run -d -p 3000:3000 --name sea-dog ghcr.io/notationsystems/sea-dog-osiris-terminal-v0:latest
```

That is the whole deployment: the image is built and published by CI on
every push to `main` (verified: the workflow succeeds and the image
exists). No environment variables are required — no built source needs a
credential today, and the configuration seams refuse loudly at boot if
you enable a tier without one (`docs/DEPLOYMENT.md`).

Then confirm it answers, from the same machine:

```bash
curl -s "http://localhost:3000/api/economy?commodity=copper&view=analytics" | head -c 200
```

**Verified from a clean state**: a fresh clone at the release point
installs, builds and serves with no undocumented step. The image path
itself is verified only as far as CI publishing it — pulling and running
it on a Docker host is the one step this environment cannot execute, and
it is reported as unverified rather than assumed.

If you would rather not use Docker: `npm ci && npm run build && npm start`
on any host with Node 22 serves the same instrument.

## 4. Run the researcher afternoon

Hand `docs/RUNBOOK.md` to someone who did not build this, give them the
URL, and leave them alone with it. The mechanics — one server process for
the session, what to save before shutdown, and why you must not coach —
are in that document's operator section. Note the time from handover to
their first self-directed query: that is the S-4 ten-minute measurement,
and it is the one criterion a builder structurally cannot discharge.

The continue criterion (`docs/CONTINUE_CRITERION.md`) is **frozen**. After
the afternoon runs, amending it is not legitimate — that freeze is what
makes the ninety-day result mean anything in either direction.

---

## Optional: attach a language model to the corpus

```bash
npm run mcp    # stdio MCP server; expects the terminal at SEA_DOG_URL (default http://localhost:3000)
```

Configure it in an MCP client as command `npm`, args `["run","mcp"]`,
`cwd` this repository. It exposes eleven read-only tools over the running
instrument. Stdio means attaching requires local access to the machine —
**no port is opened, and the external-exposure decision remains untaken**
(`docs/EXPOSURE_OPTIONS.md`).
