---
name: embed-retrieval-corpus-limits-and-document-ab
description: What the embed-retrieval corpus cannot measure and how its regex-parsed spans inflate a document change; how to run a pre-registered document A/B on it; three traps met while measuring #1072.
metadata:
  type: project
---

`eval:embed-retrieval` (corpus `embedretrieval-02-nl-to-code`) is METIS's own TypeScript and Python, parsed by the REGEX parser with no lineage pass. Before proposing or measuring a change to symbol documents on it, know what it cannot see:

- **No `method` symbols, so no receiver; no `reads`/`writes` edges, so no tables.** A field with zero reach is a no-op in every arm. Print reach per field before scoring (`contextReach`, `contextual-ab.ts`) and do not ship a field the corpus could not carry.
- **153 of 671 symbols have a one-line span** (the regex parser ends a multi-line declaration on its first line), so their baseline embedding text is a header and one line where production (tree-sitter) has ten. A document change looks bigger here than it is: for #1072 the gain was +0.169 where a target had a one-line span and +0.077 where none had.
- **It is unusually well documented**: 57% of symbols and 73% of query targets have a doc comment (Miniflux: 26%). The #1072 gain was entirely in queries whose target has one (+0.161 against -0.006).

**Why:** #1072's issue text assumed the eval could measure tables, callers and receivers. It could measure callers only. The headline +0.116 nDCG@10 is real on this corpus and an upper estimate elsewhere.

**How to apply:**

- A document A/B is `--contextual-ab`: commit the bars, arms and a ship-rule FUNCTION first (`decideContextualShip`), then the harness, then run. Reuse `scoreLexicalArm` / `compareLexicalArm`; embed the corpus once per embedding variant through `withWiredCorpus`.
- `classifyDelta` is direction-blind: a CI wholly below zero also returns `DIRECTION-ESTABLISHED-MAGNITUDE-NOT`. Check the sign of the mean delta as well.
- The baseline arm must be a FROZEN builder (`name + qualifiedName`), never `buildSymbolDocumentText`: that one is production's and moves when the change ships.
- Needs no network: weights are read from `TRANSFORMERS_CACHE` (the developer's `server/.env` names the directory) with `EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1`.
- Timing an embed: the first set embedded in a process takes about twice as long as the same set later (152 s against 79 s for 3,533 texts). Warm up, or run the sets in two orders.
- `npx tsc --noEmit -p .` in `server/` does NOT compile the tests; `pnpm typecheck` does. A new non-optional Prisma column breaks every test fixture that builds the full model type.
- A stored field that other files can change (callers, tables) should be computed from edges when a document is built, not stored: an incremental ingest re-parses only changed files, so a stored caller list is stale the first time a caller changes.
