---
name: never-dropped-silently-needs-a-fixture-per-cap
description: A "nothing is dropped silently" claim is only tested for caps applied where the output is rendered. Caps applied upstream (ranking, seed expansion, a reused helper) cut before anything is counted. One fixture per MAX_* constant.
metadata:
  type: project
---

A "never dropped silently" claim is only tested for caps applied where the output is rendered; caps applied upstream (ranking/selection such as `rankTables`, seed expansion, or a reused helper like `findStructuralTwins`) cut before anything is counted — so for each `MAX_*` constant, build a fixture that exceeds it and assert the cut items appear in `dropped`.

**Why:** PR #1094 (#1060, plan localisation) said in its body, in `ARCHITECTURE.md` and in the setting's description that everything a cap removed was named. The review found three caps that were silent, and the fix sweep found more of the same kind: `MAX_TABLES` / `MIN_TABLE_SHARE` (`rankTables` returned names only), `MAX_FUNCTIONS_PER_SEED_FILE` (the 13th function of a retrieved file), and the three caps inside the reused `findStructuralTwins` (60 seeds, 4 per seed, 24 in all), which cut before the caller's own "N more twins not listed" counted anything. The existing test did exceed a cap — the four applied at render time — which is why the claim looked tested. Related shape: [[project_capped-list-filter-must-share-the-fits-function]].

**How to apply:**

- `grep -n "MAX_\|slice(0," <the path's files>` and list EVERY cap, including the ones in helpers the path reuses and plain `slice(0, N)` with no named constant. A cap in a helper you did not write is still your claim's cap.
- For each, one fixture that exceeds it and an assertion on the sentence in `dropped` (count and kind at least) AND on its presence in every place `dropped` is rendered. Put the per-constant table in the PR body, with the test for each.
- A helper that cuts needs a way to say what it cut: an optional out-parameter (`TwinCapReport`) costs its other callers nothing.
- A section with nothing to list can still have something to report (a step skipped altogether). Check that the renderer does not filter out a section because it has no rows before it reads the section's "left out" sentences.
- Depth bounds are different in kind: past them nothing is enumerated, so there is nothing to count. Say how far the walk goes in the output's header, and say in the PR that they are not reported per item.
- `slice(0, IN_CHUNK)` in a query is a silent cap too, of a different sort: chunk it.
- A cap or scoping test that mocks the query to return `[]` cannot see an excluded item re-entering through that query — give each scoped read at least one test against a real `createMigratedSqlite` database. #1094 cycle 2: a seed deleted from the callee-name pool was handed back by the candidate `groupBy` (it shares names with the pool) and compared after all, under a note saying it was not; the unit test mocked `groupBy` to `[]`. The real-database cases are in `server/tests/plan-localisation-scoped-reads-1060.sqlite.test.ts`. Symbol ids are a global primary key there: two fixtures in one database need distinct ids.
- "In hand" is the test for whether a depth bound owes a count: if the rows were fetched and then discarded (the callee step's second hop, outside the data layer), count them; if the read was never made, the bound is stated in the header and that is enough.

**And, from the same PR:** do not ship a check that states what an English sentence in model output is 'about' as fact; #1094's claim check was wrong in two review cycles and was removed in favour of the stored file list. It matched the phrase "not in the retrieved context" to the nearest backticked path with clause and list rules; each review found correct plan lines it flagged (`Unlike `b.go`, `zz.go` is not …`, two paths in one table cell, an aside between dashes) and one shape where it named the wrong file and missed the real one. Record what the model was given (`plan-context.md`) and tell the reader how to look; a regex is not a reader.
