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
