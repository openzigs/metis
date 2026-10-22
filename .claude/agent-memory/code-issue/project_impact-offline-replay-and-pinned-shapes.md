---
name: impact-offline-replay-and-pinned-shapes
description: How to measure impact-analysis precision/recall offline with no model (dev.db + Lance copy), and the pinned-shape tests an impact change breaks outside its own directory.
metadata:
  type: project
---

Impact analysis can be measured offline, with no provider call, by replaying its deterministic stages on a copy of a walkthrough project — and a change to its shapes fails tests far from `server/src/lib/impact-analysis/`.

**Why:** #1036/#791/#1051 (one PR) needed before/after file precision and recall on the six run-7 Miniflux issues. Nothing in the repo said how; three false starts cost more than the measurement. Separately, the first full `pnpm test` found four failures that every targeted run had missed.

**How to apply — the replay:**

- Copy, never open, the dev database: `server/dev.db` (1.5 GB) and the project's symbol vectors `server/data/lancedb/p_<projectId>__symbols.lance` (12 MB) into a scratch directory.
- Run a `.mts` script (a `.ts` one is compiled as CJS and rejects top-level `await`) with `server/node_modules/.bin/tsx` and `DATABASE_URL=file:<copy>`, `LANCEDB_PATH=<copy dir>`, `TRANSFORMERS_CACHE=~/.cache/metis-transformers`, `HF_HUB_OFFLINE=1`, `EMBED_MODEL=Alibaba-NLP/gte-modernbert-base`, `EMBED_BACKEND=xenova`. The embedder is local; that is hybrid search with no network.
- Call `extractChangesByShape` → `computeProjectImpact` with `seedChange: defaultSeedChange(prisma)`, `dataSourceFor: () => await loadProjectGraph(prisma, id)`, `schemaDataSourceFor: (id) => new PrismaSchemaImpactDataSource(prisma, id)`. An LLM stage is replayed by injecting a fake that returns what production persisted (`impact_affected_tables` rows with `changeKind = 'add-column'`).
- Score files as `docs/walkthroughs/TEST_PLAN.md` "Scoring a change plan" says: test files excluded from both sides, neutral files count neither way. Calibrate first: scoring the PERSISTED run's `impact_affected_symbols` must reproduce the `tp/fp/fn` in `.playwright-mcp/walkthrough-706-run<N>/run.json` `changePlanAccuracy`. It did, exactly, for all six.
- The verbatim issue texts are `impact_analyses.sourceText`. Use them as fixtures unparaphrased (`__fixtures__/miniflux-*.md`; `*.md` is prettier-ignored, so they stay verbatim). #1045 passed on a condensed text and regressed 3 runs in 3.
- Two of the 19 reference files (an HTML template, a README) are not in the code graph: file recall tops out at 89%.

**How to apply — the pinned shapes** (run the whole `pnpm test` before the first commit, not after the last):

- `packages/shared/tests/impact.test.ts` pins `IMPACT_AFFECTED_RELATIONS` as a literal array.
- `server/src/lib/impact-analysis/impact-analysis-access.test.ts` pins the exact `include` of the detail query.
- `ImpactItemView` is built by hand in eleven fixtures across `server/src`, `server/tests`, `ui/src` and `ui/tests`; a new required field needs all of them, and `tsc` only reports the typed ones (`as unknown as` casts fail at runtime instead).
- `server/tests/impact-miniflux-791.sqlite.test.ts` runs `executeImpactAnalysis` with NO injected mapper, so it exercises whatever the default seeding is.
- A new Prisma model needs three SQL edits, not two: the SQLite migration, an idempotent Postgres migration, and an append to the cumulative `prisma/postgres/migrations/00000000000000_init` baseline (`tests/schema-parity.test.ts` counts its `CREATE TABLE`s). Regenerate the Postgres schema with `bash scripts/gen-postgres-schema.sh` from the repo root.

**Prompt values and citation gates (#1373 reviews, 2026-10-21).**
- Tightening a citation gate from file-only to line-range: code-graph excerpts begin with a
  `name (kind) — path:start-end` head line, so models land one past `endLine`. Probe
  `start-1` and `end+1` before shipping a zero-slack gate.
- A "quote every value" fix in impact prompts must also cover model-repair echoes
  (`additiveRepairMessage` in `additive-column-proposer.ts`) that rebuild quoted strings from
  rejection text; a grep for `key="${` misses them.

Links: [[go-methods-unresolved]], [[project_go-call-resolver-binds-by-bare-name]].

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[go-call-resolver-binds-by-bare-name]] — Go resolver binds by bare name: false positives for claims (#1086)
