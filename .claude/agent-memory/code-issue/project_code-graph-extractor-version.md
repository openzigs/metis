---
name: code-graph-extractor-version
description: The code graph has an extractor version since #1071; a parser change needs a CODE_GRAPH_EXTRACTOR_VERSION bump plus an EXTRACTOR_UPGRADES entry, and an upgrade must not by itself trigger model spend (it marks the graph; documents acknowledge the mark once).
metadata:
  type: project
---

The code graph has an extractor version since #1071. A parser change that alters what is stored for an UNCHANGED file needs a `CODE_GRAPH_EXTRACTOR_VERSION` bump plus an `EXTRACTOR_UPGRADES` entry naming the languages (both in `server/src/lib/code-graph/ingest.ts`). Without them an incremental ingest skips every file whose content hash matches, and the change reaches a stored graph only file by file as the repository is edited.

**What the upgrade does:** on the next incremental ingest of a graph recorded with an older version (`code_graphs.extractorVersion`, null before #1071), the files of the listed languages are re-parsed, their symbol rows kept (only a changed `qualifiedName` is rewritten, so ids and everything pointing at them survive), and their parser edges replaced one file at a time in a transaction. It covers a change that renames or re-binds. A change to WHICH symbols a file yields needs a full re-ingest.

**An upgrade must not by itself trigger model spend.** The scheduled `refreshRepoConnector` runs ingest and then `scheduleIncrementalRegeneration`, and the docs-gen inputs snapshot keys every symbol and edge by qualified name, so the first refresh after a deploy would regenerate every `autoUpdate` document with no repository change. The mechanism (`docs-gen/extractor-upgrade.ts`): the upgrading ingest moves `CodeGraph.extractorUpgradedAt` with every write of the rewrite; a check that finds a difference confined to graph rows (`symbol:` / `edge:` / `finding:`) under a mark newer than the document's latest version (and than the last mark acknowledged for it) records the current inputs beside that version (`GeneratedDocumentVersion.acknowledgedInputs`) and regenerates nothing. It is acknowledged ONCE: the next graph-only change regenerates. The snapshot itself carries nothing about the extractor — the first version of this rule added an `extractor` item and so suppressed every later graph-only change for every legacy document in every project (see `project_suppression-rule-needs-positive-evidence-acknowledged-once.md`). `settleExtractorUpgrade` is applied in `checkIncrementalRegeneration` and at the start of an automatic run; the mid-run and commit fences of `routes/generated-docs.ts` use `isUnseenExtractorUpgrade` against the mark as it stood when the run captured its inputs.

**How to apply when bumping the version:**

- Add the `EXTRACTOR_UPGRADES` entry and a line to the version history comment.
- Check the upgraded graph equals a full re-ingest row for row on a real project clone (compare by identity, never by id).
- Rewrite stored TEXT copies of anything renamed in `renameSymbolsInPlace` (`impact_affected_symbols.qualifiedName`, `impact_column_proposals.writerQualifiedName`).
- The version is stamped once the tree was upgraded. A file that cannot be re-parsed is named in `IngestStats.filesUpgradeFailed` and remembered in `CodeGraph.extractorUpgradeFailed` with the hash of the content that failed; it is retried only when that content changes, so one broken file does not make every ingest redo the upgrade.
- Run `tests/generated-doc-regeneration.test.ts`: its `#1071` block fails if the new upgrade schedules a regeneration, and if a graph-only change AFTER it does not.
- Say what the first refresh after upgrading does in `docs/OPERATIONS.md` and the changelog fragment, not only in the PR body.
