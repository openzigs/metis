---
name: shared-helper-semantics-cross-pr
description: A test pinning a shared helper's semantics breaks silently when a parallel PR changes it; main merges without up-to-date checks (#1347/#1348).
metadata:
  type: project
---

Reviewer finding on PR #1347: `analysis-matrix-rate-limit.test.ts` asserted that a 1970-expired token still keys to its user, through `signedAccessTokenUserId`. PR #1348 (#1117) changed that helper to a 15-minute expiry tolerance.

**Why:** `main` has no required checks and does not require branches to be up to date. Whichever PR merged second would land a red `server` with no CI run that ever combined the two.

**How to apply:**

- When a new test asserts the behaviour of a helper owned elsewhere, check open PRs touching that helper: `gh pr list --search "<file> in:path"` or read their diffs.
- Assert values that hold under both old and new semantics (e.g. expired ~60 s ago, not in 1970), or sequence behind the other PR and merge `origin/main` first.
- Prefer importing the shared helper over copying it, so the other PR's fix lands once.
