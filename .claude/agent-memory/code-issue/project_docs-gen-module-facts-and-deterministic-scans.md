---
name: docs-gen-module-facts-and-deterministic-scans
description: Docs-gen Phase-1 module facts and deterministic scans over repo files (#1405) — test files are in by default, two entry builders, the Module path cache key, attempt caps, and where to escape markdown.
metadata:
  type: project
---

From #1405 and its three review cycles (2026-10-22). Paths checked on `main` at 704868d0.

**Test files are module sources by default.** `DOCS_GEN_PHASE1_INCLUDE_TESTS` defaults to
true (`server/src/lib/config/key-registry.ts`), so docs-gen module sources include `_test`
files. A deterministic scan that presents its results as product behaviour must exclude
tests itself: Miniflux `internal/locale` gave 13 fake messages from its tests.

**Two builders for one module's facts entry.** In
`server/src/lib/docs-gen/holistic-synthesizer.ts`, `batchedModuleEntries` builds entries
separately from `factsModuleParts`. Anything added to a module's facts entry must be added
in both, or sections that run batched miss it.

**`Module path:` is a cache key.** The Phase-1 `Module path:` text
(`buildPhase1UserMessage`'s `moduleName`) is part of the Phase-1 chunk cache key, so
changing it re-extracts every project's facts on the next run. To change what readers see,
rename only `ModuleFacts.moduleName`.

**Keep an attempt cap when you filter.** Turning "read N files" into "read N usable files"
unbounds the number of attempts: 8 reads became ~540 MB over 600 decoy files. Keep a cap on
attempts or bytes as well as on the files you keep.

**Escape markdown where it is rendered, not where a name is built.** Escaping at the source
leaks backslashes into React text, prompts and titles that never render markdown.

Related: [[reader-brd-traps]], [[docs-gen-section-reuse-and-regenerate]].
