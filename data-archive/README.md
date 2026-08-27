# OSIRIS data archive

Vintage archive for sources that revise in place.

## comtrade/

UN Comtrade keeps **one version** of each dataset: revisions overwrite the
published figures and no prior-version archive exists anywhere upstream (both
Chilean annual copper datasets have already been revised in place — see
`src/data/economy/snapshots/comtrade-da.json`). The adapter therefore writes
every successful live retrieval here, keyed by retrieval date and request key,
before parsing it. **These files are unreconstructable once the upstream
revises: commit them.** Every day a retrieval goes unarchived is a vintage
lost permanently.

The committed snapshots under `src/data/economy/snapshots/` are the vintages
the engine currently serves from; this directory accumulates the history that
lets future vintages be diffed and `as_known_then` stay honest. For Comtrade,
`as_known_then` is blind before the release date of the held version — the
data-availability snapshot records both `firstReleased` and `lastReleased` so
that blindness is labeled, not silent.

## Durability labels (shipping order S-2)

Every file under this directory and `src/data/economy/snapshots/` is
indexed in `MANIFEST.json` with a sha256 and a DURABILITY CLASS — the
label a pruner needs in a year. The suite verifies the manifest against
the tree in CI (hash match both directions; an unclassified file is
refused loudly). Regenerate after any archival:

    node scripts/archive-manifest.mjs

- **unreconstructable** — the upstream revises in place and keeps no
  prior version; a lost file is a knowledge state gone permanently.
  ALL Comtrade captures: `comtrade/` here, and the `comtrade-*` snapshots
  the engine serves from. Never prune. These are the files the
  off-repository mirror exists for.
- **refetchable_at_risk** — re-fetchable today from a source that could
  plausibly disappear or change shape: `openownership/` (a frozen 2023
  S3 export of a retired product) and the Westmetall scrape snapshot
  (single republisher).
- **refetchable** — the upstream retains editions; loss costs a re-fetch,
  not a vintage (MCS editions on ScienceBase, CFTC, Yahoo, the EDGAR
  recon capture).

Off-repository copy: `sea-dog-archive-mirror` (same GitHub account — a
second repository protects against repo-level accidents: a bad
force-push, history rewrite, or deletion of this repo. It does NOT
protect against account/provider loss; a provider-independent copy is an
operator step). Restore path, executed once and documented in ledger
phase 36: clone the mirror, verify hashes against its MANIFEST, copy
into place, run the archiveManifest suite.
