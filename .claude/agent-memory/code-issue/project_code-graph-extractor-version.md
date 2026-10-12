---
name: code-graph-extractor-version
description: The code graph has an extractor version since #1071; a parser change needs a CODE_GRAPH_EXTRACTOR_VERSION bump plus an EXTRACTOR_UPGRADES entry, and an upgrade must not by itself trigger model spend.
metadata:
  type: project
---

The code graph has an extractor version since #1071. A parser change that alters what is stored for an UNCHANGED file needs a `CODE_GRAPH_EXTRACTOR_VERSION` bump plus an `EXTRACTOR_UPGRADES` entry naming the languages (both in `server/src/lib/code-graph/ingest.ts`). Without them an incremental ingest skips every file whose content hash matches, and the change reaches a stored graph only file by file as the repository is edited.

**What the upgrade does:** on the next incremental ingest of a graph recorded with an older version (`code_graphs.extractorVersion`, null before #1071), the files of the listed languages are re-parsed, their symbol rows kept (only a changed `qualifiedName` is rewritten, so ids and everything pointing at them survive), and their parser edges replaced one file at a time in a transaction. It covers a change that renames or re-binds. A change to WHICH symbols a file yields needs a full re-ingest.

**An upgrade must not by itself trigger model spend.** The scheduled `refreshRepoConnector` runs ingest and then `scheduleIncrementalRegeneration`, and the docs-gen inputs snapshot keys every symbol and edge by qualified name, so the first refresh after a deploy would regenerate every `autoUpdate` document with no repository change. The mechanism: the snapshot carries an `extractor` item, and `isExtractorOnlyChange` (`docs-gen/regeneration-plan.ts`) treats two snapshots as unchanged when that item differs and every item that is not a graph row (`symbol:` / `edge:` / `finding:`) is identical. It is applied in `checkIncrementalRegeneration`, in the automatic-run early return and in the mid-run and commit fences of `routes/generated-docs.ts`.

**How to apply when bumping the version:**

- Add the `EXTRACTOR_UPGRADES` entry and a line to the version history comment.
- Check the upgraded graph equals a full re-ingest row for row on a real project clone (compare by identity, never by id).
- Rewrite stored TEXT copies of anything renamed in `renameSymbolsInPlace` (`impact_affected_symbols.qualifiedName`, `impact_column_proposals.writerQualifiedName`).
- The version is stamped only when every file was brought up to it: a file that cannot be re-parsed is named in `IngestStats.filesUpgradeFailed` and the next ingest retries.
- Run `tests/generated-doc-regeneration.test.ts`: its `#1071` block fails if the new upgrade schedules a regeneration.
- Say what the first refresh after upgrading does in `docs/OPERATIONS.md` and the changelog fragment, not only in the PR body.
