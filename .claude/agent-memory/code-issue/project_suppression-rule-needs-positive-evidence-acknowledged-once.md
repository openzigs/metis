---
name: suppression-rule-needs-positive-evidence-acknowledged-once
description: A suppression rule ("skip X when only Y changed") needs positive evidence that Y happened in THIS run and must acknowledge it once; a rule inferred from "the old record lacks the new field" applies to every old record forever.
metadata:
  type: project
---

A suppression rule ("skip X when only Y changed") needs positive evidence that Y happened in THIS run and must acknowledge it once; a rule inferred from "the old record lacks the new field" applies to every old record forever.

#1071 (PR #1104) had to stop a code-graph extractor upgrade from regenerating every auto-updating document. The first rule added an `extractor` item to the docs-gen input snapshot and treated two snapshots as unchanged when that item differed and everything else that differed was a graph row. Every snapshot published before the deploy had no such item, the item was stamped on every graph of every language, and a skipped check never moved the baseline. So for every existing document in every project, any later change confined to graph rows — a lineage backfill, a schema re-introspection, new rationale findings — was skipped as "only the extractor changed", indefinitely, and again at every future version bump. The cycle-2 review and all three lenses of the second panel found it.

**Why:** "the old record lacks the field" is true of every old record, not of the ones Y touched; and a suppression that leaves the baseline where it was repeats on every later comparison.

**How to apply:**

- The thing that DOES Y leaves the evidence: the ingest that rewrites a graph for an upgrade moves `CodeGraph.extractorUpgradedAt`, in the same transaction as each write, and only then (`code-graph/ingest.ts`).
- The rule reads that evidence and nothing else: a difference is put down to Y only when it is of the right kind AND the mark is newer than what this record has already seen (`docs-gen/extractor-upgrade.ts`).
- Acknowledge once: record the new state as the baseline to compare against (`GeneratedDocumentVersion.acknowledgedInputs`), without doing X. The next difference of the same kind has no new mark and is NOT suppressed.
- Do not add the evidence to the compared record itself: an item that every record gains makes every legacy baseline differ. A project Y never touched must behave exactly as before.
- Tests, through the real handler: Y → suppressed and acknowledged; next change of the same kind → not suppressed; a record Y never touched with an old-format baseline → not suppressed; Y a second time → suppressed once more; evidence that predates the record, or belongs to another scope, → not evidence.
- Ask of every suppression: what closes the window, and what does a record look like that existed before this code did?
