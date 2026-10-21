---
name: docs-gen-section-reuse-and-regenerate
description: Docs-gen traps from PR #1317 (#1132, cut-off sections and Regenerate) — checkpoint timing of carried sections, the section-reuse fixture's stand-in warning, one-child trimming, cancel-restore after a regenerate, and what a DocWarning `stage` field means.
metadata:
  type: project
---

From PR #1317 and its two review cycles (2026-10-21). Checked against `main` at 2021a607.

**Section reuse and the checkpoint (`server/src/lib/docs-gen/holistic-synthesizer.ts`).**
- When a run reaches a section whose stored record it will not reuse, it drops that record from the checkpoint BEFORE the model call (`carried.delete(group.id)`). A test asserting a record is carried must read the checkpoint while an EARLIER section is being written, not after the run.
- `section-reuse.test.ts`'s shared fixture used `section-truncated` as a stand-in warning (now `section-ungrounded`). Any rule that treats one warning kind specially for reuse must check that fixture first, or the fixture silently exercises the special case.

**Trimming a cut-off section (`cut-off-section.ts`).** A "nothing complete would remain, return unchanged" fallback brings the original symptom back. Always test a one-child block (`## X` / `### 1` / `**Purpose**`) beside the many-child case.

**Regenerate and cancel (`generation-checkpoint.ts`, `routes/generated-docs.ts`).**
- A cancel during a manual regenerate over a published version ends `ready` with its warnings cleared (`restoreOnCancel ?? { status: "ready" }`) unless the reset is recognised as a section redraft (`isSectionRedraftReset`). A failed or cancelled row's prior status cannot be recovered once POST `/regenerate`'s first reset has cleared `errorMessage`.
- A `DocWarning` field named `stage` means a whole-run stop cause; only `generationFailureWarning` emits one. `hasFailedSections` and `isSectionRedraftReset` key on it, so a new warning shape that adds `stage` silently changes regenerate eligibility and cancel-restore.

Related: [[docs-gen-drop-retry-and-ledger]], [[brd-plan-tests-and-docs-gen-offline-replay]].
