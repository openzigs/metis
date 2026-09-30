---
name: permission-mock-hides-removed-gate
description: A route suite that mocks requirePermission as a pass-through cannot notice the gate being removed; a CodeQL alert on a stale branch can be main's.
metadata:
  type: project
---

On PR #454 (#423), the new code-search route's tests mocked `requirePermission` as `() => next()`. Deleting `requirePermission("project.read")` from the route, or dropping its rate limiter, left all 14 tests green. The fix was a mock that refuses listed permissions (403 test), plus a `*_RATE_LIMIT_MAX=1` test expecting 429. Separately, CodeQL reported `js/missing-rate-limiting` "in code changed by this PR". It was really main's open alert #286: the branch was 16 lines behind, so main's line landed inside the branch diff in the merge ref.

**Why:** a pass-through mock tests the handler, not its wiring. CodeQL maps an alert by line in the merge ref.

**How to apply:** every new route needs a test that fails when its permission gate or limiter is removed from the chain. Before fixing a CodeQL alert on a stale branch, merge main and re-run.
