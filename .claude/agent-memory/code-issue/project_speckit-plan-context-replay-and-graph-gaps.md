---
name: speckit-plan-context-replay-and-graph-gaps
description: How to measure what /speckit.plan retrieves offline (no model), why its misses are a ranking problem and not top-k or query length, and three code-graph gaps that bite any walk from retrieved symbols.
metadata:
  type: project
---

A Spec Kit plan's retrieved context can be rebuilt and scored offline, and its misses are files that similarity cannot rank: no cut-off or query change reaches them.

**Why:** #1060 ("plan retrieval misses storage, migration and query-builder files") came with two suggested fixes and no cause. The first hour went on the obvious suspects (the 2,048-character query cap, top-k 8 chunks / 12 symbols), which a ten-minute measurement would have ruled out.

**How to apply — the replay** (extends [[project_impact-offline-replay-and-pinned-shapes]]):

- The specs of a walkthrough run are stored: `spec_kit_feature_artifacts` (`key = 'spec.md'`) joined to `spec_kit_features` on `projectId`. Run 7's project `cmv2nx3ad000bjm9kv6om3q8o` has seven, `001-` to `007-` (#4478, #4511, #4336, #4479, #4386, #4456, and #4336 again from journey 2).
- Copy BOTH Lance tables of the project: `p_<id>__symbols.lance` (code symbols) and `p_<id>.lance` (document chunks, 31 MB). Without the second the knowledge service returns nothing and the replay is not the plan's context.
- Call `buildSpecKitRagContext(projectId, extractRequirementText(spec), { includeCode: true, expandDocuments: PINNED_REQUIREMENT_DOCUMENTS, siblings: {}, callers: {}, localise: {} })` — the options `runPlanExpanded` passes — and score `result.files` against the reference sets in `docs/walkthroughs/TEST_PLAN.md`.
- **Before comparing any number, assert that no sentence of `result.dropped` contains `skipped`.** The walk has two wall-clock limits (5 s for the walk, 1.5 s for its twin step); on a loaded machine a replay can lose the twin rows or the whole block and score lower for a reason unrelated to the change under test (#1094 cycle 2). Pass `localise: { timeBudgetMs: Infinity, twinTimeBudgetMs: Infinity }` in the replay, which switches both off, and still make the assertion: the call-edge limits produce a `skipped` sentence too.
- To rank one file in the plan's own two retrievals, call `getKnowledgeService().search(id, q, { k: 200 })` and `createDefaultCodeSearcher().search(q, id, { limit: 500 })` and take the file's first position. On run 7: the query builders ranked 19th to 94th among symbols and 23rd to 43rd among chunks, `client/model.go` 48th to 101st, and `internal/database/migrations.go` in neither list. Sending the whole spec instead of its first 2,048 characters did not move them.

**Three graph gaps** that any walk from retrieved symbols has to handle:

- A file-level hit is a `module` symbol, and a module symbol has no `calls` edge. Half the symbol hits for a spec are modules; expand each to the functions its file declares before walking.
- SQL assembled from fragments (`fmt.Sprintf`, a query builder) has no lineage edge. `internal/storage/*_query_builder.go` reads its table and the graph does not say so; it is reachable only as a callee of a function that does have lineage, or of a retrieved handler.
- A migrations file may hold nothing but `table` / `column` symbols (kind `sql`). It is found from the table (`getDataModelSymbols`), never by search.

Two of the 24 reference files of those seven specs (an HTML template, a README) were never ingested: context recall tops out at 22/24.
