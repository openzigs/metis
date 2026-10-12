---
name: identifier-shape-change-rerun-other-features-probes
description: When a PR changes the shape of a stored identifier, tests that pin other features keep passing because their fixtures still carry the old shape; re-run those probes on a real upgraded graph.
metadata:
  type: project
---

When a PR changes the shape of a stored identifier, tests that pin OTHER features' behaviour keep passing because their fixtures still use the old shape. Re-run those probes on a real upgraded graph.

#1071 renamed a Go method from `<file>::<name>` to `<file>::<ReceiverType>::<name>`. PR #1095's two-shared-name-terms rule (`symbolNameTerms` in `server/src/lib/traceability/requirement-code-mapping.ts`) counts an enclosing type as part of what a symbol is called, so after the rename a type whose NAME shared two words with a requirement linked every one of its methods: "OIDC provider display name" gained seven `oidcProvider::*` methods and lost the right symbol from the ten links kept, and a probe #1095 had pinned as "links nothing" linked `Client::Users`. All 34 of #1095's tests stayed green: their corpus was hand-written in the old shape. `eval:reqmap` could not see it either, because its fixture has no Go.

**Why:** a fixture is a snapshot of the identifier's shape at the time it was written. Nothing connects it to the parser, so a shape change cannot fail it.

**How to apply:**

- `grep` for every reader of the identifier (84 non-test files mention `qualifiedName`), and for each one that tokenises, splits or ranks by it, find its tests and look at what shape their fixtures use.
- Run the feature's probes through the real code on a pre-upgrade `cp -c` clone and on the upgraded one, and diff the outputs (links unchanged / added / removed). For the mapper: `mapRequirementToCode` with `minSharedTerms: 2` over the stored requirements.
- Move the fixtures to the new shape in the same PR, with names read off the upgraded graph, and say in the fixture's header why.
- Stored TEXT copies of the identifier need the rename too: `impact_affected_symbols.qualifiedName` and `impact_column_proposals.writerQualifiedName` are rewritten in `renameSymbolsInPlace`; `generated_document_versions.changedSymbols` and scan-finding fingerprints are history and are not.

The rule that came out of it: a member links only when at least one shared term comes from its own name; the enclosing type may supply the rest, never all (`symbolOwnNameTerms`).
