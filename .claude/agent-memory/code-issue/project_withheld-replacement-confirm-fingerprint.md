---
name: withheld-replacement-confirm-fingerprint
description: A review-then-confirm flow over a recomputed multi-row plan needs a fingerprint of row ids, versions, reviewStatus and step kinds; plus the bookkeeping any requirement writer outside persistRequirements must redo, and the fixture that makes such tests vacuous (#1436 and its reviews).
metadata:
  type: project
---

From #1436 and its review and re-review (2026-10-23): confirming a withheld requirement
replacement.

**Fingerprint what the user confirmed.** If the server recomputes the plan at write time, a
confirm that sends only the proposal timestamp does not protect what the user saw. Fingerprint
the planned changes and 409 on mismatch. The fingerprint needs all of:
- row ids and `Requirement.version`;
- the step kind: gaining review work (a comment, a link) does not bump `version`, it flips the
  step from replace/delete to update/keep;
- `reviewStatus`: it is in `UNTRACKED_WRITABLE_FIELDS`
  (`requirements/requirement-version-service.ts`), so changing it never bumps `version`.

**Index alignment is load-bearing.** Withheld-replacement proposal row index == synthesis
index == `approvedIndex`, because `withheldProposalRows` (`analysis/analysis-service.ts`) maps
`synthesis.requirements` unfiltered. Filtering there would misattach the #1203/#1204 matching
notes.

**Writers outside `persistRequirements`** must redo its post-persist bookkeeping
(`promotedStructuredIds` / `promotedStructuredRunId`, `promotionMatching`), or a later
approval falls through to a full replace that gets withheld.

**Vacuous fixture.** In the #780 SQLite fixtures a requirement targeted by a `RequirementLink`
already counts as reviewed (incoming links). A test where an unreviewed row "gains" review
work must pick a row with no links.

**UI gate.** UI actions gated server-side by `project.update` are often rendered for
developer and reader roles, who then get 403. Check the component reads
`user.permissions.includes("project.update")`.

Related: [[requirement-history-writers-and-resync]], [[analysis-run-claims-and-citation-salvage]],
[[test-falsifiability-traps]].
