---
name: review-semantics-prs-skip-the-docs
description: PRs changing review/notify semantics in server/src/lib/reviews update code comments but leave ARCHITECTURE and USER_GUIDE describing the old behaviour.
metadata:
  type: project
---

PRs that change review or notification semantics in `server/src/lib/reviews` update the code comments but not the docs (#2518 review). The stale places were the reviews endpoint table in `docs/ARCHITECTURE.md`, the "an edit of approved wording reopens it" rule, and the review section of `docs/USER_GUIDE.md`.

**Why:** the docs describe review behaviour in prose far from the code, so a grep for the changed function finds nothing there.

**How to apply:** on any review/notify change, grep `docs/ARCHITECTURE.md` and `docs/USER_GUIDE.md` for "review", "reopen" and "notify" and update each sentence the change falsifies, in the same PR.
