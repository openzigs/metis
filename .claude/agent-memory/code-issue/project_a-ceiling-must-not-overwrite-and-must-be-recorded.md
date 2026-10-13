---
name: a-ceiling-must-not-overwrite-and-must-be-recorded
description: A wall-clock or step ceiling on an ingest step is not a safe degradation by itself; check what the degraded result overwrites and whether anything records it.
metadata:
  type: project
---

A wall-clock or step ceiling on an ingest step is not a safe degradation by itself: check what the degraded result OVERWRITES and whether anything records it; re-run any new ceiling forced tiny on an already-complete graph and diff the stored edges.

PR #1104 (#1071) added `GO_BINDING_MAX_MS` (30 s) so a slow Go resolver could not hold an ingest. Forced to 12 ms on the Miniflux graph (review cycle 3): the extractor upgrade was stamped complete with 12,430 of 21,100 calls skipped; a later ingest with no ceiling did nothing; and on a fully bound graph, touching one file rewrote 1,599 correct `receiver-type` bindings as name guesses and stripped about 7,000 decided verdicts. Only a log line said so.

**Why:** "leave the rest undecided" was written as if the step produced a fresh result. An incremental ingest re-binds unchanged files IN PLACE, so the weaker answer replaced a better stored one, and a version stamp said the work was done.

**How to apply:**

- A unit the step did not resolve this run leaves its stored row alone. Only something with no stored answer (a re-parsed file) takes the fallback.
- Record what was left on the entity (`CodeGraph.goBindingIncomplete`: file → index of the first unresolved call), do not stamp "complete" while it is set, and resume it first on the next run even when nothing changed.
- Guarantee progress without the clock (a minimum number of units per run), or a ceiling below the setup cost never converges.
- Put the state where the user sees results (`IngestStats`, the Sync panel), not only in a log.
- Test with a ceiling that trips MID-run through an injectable clock (`IngestOptions.goBindingNow`); `-1` only tests "everything skipped" and lets "the ceiling never trips" survive as a mutant.
- Deterministic give-ups (a step budget, a throw) are not resumable work: keep the stored row, count them, do not record them as pending.
