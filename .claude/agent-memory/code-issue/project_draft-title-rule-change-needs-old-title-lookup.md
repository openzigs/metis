---
name: draft-title-rule-change-needs-old-title-lookup
description: An issue draft's title is its dedup key and editDraft does not recompute dedupHash, so a changed title rule must look the existing draft up by the hash of the OLD generated title.
metadata:
  type: project
---

An issue draft's title is its dedup key and `editDraft` does not recompute `dedupHash`, so any change to a title rule must look up the existing draft by the hash of the OLD generated title (walking `(n)` suffixes) or it creates a second draft and, once published, a second issue.

**Why:** `computeDedupHash(owner, repo, title)` is the draft's identity in the generator (`claimTitle`) and the publisher recomputes it from the title at publish. #1064 changed how the epic is named (after the batch, not its first requirement); without a lookup under the previous rule, the next Generate would have made a new epic draft beside the old one, and a published epic a second GitHub issue. A reviewer-edited title does not move the hash (#776), so the lookup has to be by hash, not by the title text.

**How to apply:**

- Keep the previous rule as a function used only for lookup (`buildLegacyEpicTitle` in `server/src/lib/publishing/epic-title.ts`), and resolve it before the new title (`existingLegacyEpicTitle` in `draft-generator.ts`): same project, same analysis in `metadata.analysisId`, walking `title`, `title (2)`, … until a free hash.
- Changing the rule a second time before release needs no new lookup; after a release, every released rule needs one.
- A change to a draft BODY is not an identity change: published drafts are not selected by a publish run, so their issues are not rewritten; only a still-selectable draft matched to an issue is updated once, and the dry run lists it.
- Test it with a seeded draft in status `published` and assert one epic row, same id, title and `dedupHash` after Generate.

**Host is not in the key (#1298 review, 2026-10-20).** `loadExistingByHash` and `computeDedupHash` ignore the API host, so GHES and github.com repos with the same owner/name share dedup state. Re-check any host-aware publishing logic against it.
