---
name: requirement-history-writers-and-resync
description: Writers of requirement rows (enrichment, import re-sync, source decisions) must respect version history, the #769 guard and expectedVersion; traps from #1216, #1220/#1222.
metadata:
  type: project
---

Collected from #1216 (cycles 2–3), #1220 / PR #1222 and their reviews (2026-10-16/17).

**System writes and the #769 guard.**
- `reviewedRequirementWhere` counts version rows as human review work.
- A system writer that creates a version must write `actorId: null`, which the guard ignores. Otherwise one automated write freezes an analysis's requirement set against re-synthesis.
- A null `actorId` does not mean no person was involved: clarification enrichment writes analyst answers with `actorId: null`. A "was this edited by a person" rule must:
  - treat non-import `reason`s as edits;
  - identify re-sync's own rows by `IMPORT_RESYNC_VERSION_REASON`.

**Decisions that must not bump `version`.** A decision like "Keep mine" would make pinned approvals stale if it bumped `version`, and it is invisible to a guard that reads version rows. Record its actor in a column, and add a separate `reviewedRequirementWhere` clause for it (#1220: `sourceDecisionActorId`).

**Write from what you decided on.** Since #1216, `updateRequirementWithHistory` without `expectedVersion` retries on whatever row it re-reads. Every caller that decides from a snapshot and then writes (import re-sync, Take source) must pass the version it decided from. Otherwise a concurrent analyst edit is silently overwritten.

**"Source wins" is wider than it sounds.** Import re-sync's "source wins" rewrote every imported row whose local text differed from the source, not only rows in conflict. Check any writer described as "overwrites on conflict" against the case with no upstream change, using a real-DB probe.

**Marker-managed blocks.**
- "Body untouched" tests must re-apply the same input on every shape: CRLF, text after the block, and block position. Every round's regression was an identical re-run that still rewrote the body and minted a version.
- Assert answer and heading counts, not just presence.
- Prefix checks for "is this generated" mistake analyst edits for METIS output. Prefer "malformed → leave untouched and report" over recovery heuristics.

**Test setup traps.**
- A `*.sqlite.test.ts` that checks the approval gate must set `requireApprovedReview: true` on its project. The default is false and `approval-gate.ts` returns early, so assertions that "review stays current" pass vacuously.
- A test calling `persistRequirements` must add `resolveDatabaseProvider` to its `prisma.js` mock.
- `requirement-writes-guard.test.ts` rejects `requirement.update/updateMany` whose `data` is a spread or a variable, even for untracked columns. Write named keys, and use `undefined` to skip a column; Prisma ignores it.

**`RequirementSnapshot` field changes** touch four UI places that nothing type-checks against the server:
- `RequirementHistoryTab` `FIELD_ORDER`;
- `ReviewItemCard` `META_FIELDS`;
- `BaselineItemSnapshot` in `ui/src/lib/baselines-api.ts`;
- the history CSV header.

Related: [[metis-marker-matchers-grep-exact-strings]], [[requirement-version-history-is-incomplete]].

**Added 2026-10-18 (#1254):**
- Drafts can be generated before promotion (`loadOrPromoteRequirements` in `draft-generator.ts`). A promotion write that adds metadata must be re-read after the rows load.
- No app path soft-deletes a `Requirement` row; re-runs hard-delete (`analysis-service.ts:986`). Don't rate a missing `deletedAt` filter on requirement reads above Low without finding a soft-delete writer.
- `promoteApprovedRequirements` writes clarification answers only when it creates rows. On a set that is already promoted it returns before `applyClarificationsToRequirements`, so Promote is not a way to retry answers (#1266).
- In analyst copy, "approved" is ambiguous. Approve on the Approvals panel promotes the requirement and runs the clarification pass. Approve on a hub card (a `reviewStatus` PUT) does neither. Say which one you mean.

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[requirement-version-history-is-incomplete]] — Version history has gaps: some writers skip rows; reversed≠pinned (#1162)
