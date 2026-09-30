---
name: stale-blocked-on-pr-deferrals
description: 'Blocked on open PR #X' goes stale during parallel waves
metadata:
  type: project
---

PR #559 skipped an acceptance criterion because the spec it touched lived on open PR #538; #538 merged while #559 was in CI.

**Why:** A deferral that was true at implementation time can be false at review time.

**How to apply:** Before accepting such a deferral, check gh pr view <X> --json state,mergedAt; if merged, update the branch and do the work.
