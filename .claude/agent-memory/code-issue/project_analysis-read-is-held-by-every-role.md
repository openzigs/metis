---
name: analysis-read-is-held-by-every-role
description: Every role in packages/shared/src/rbac.ts holds analysis.read, so a 403 test for a route guarded by it cannot be written; test project and ownership scoping instead
metadata:
  type: project
---

Every role in `packages/shared/src/rbac.ts` holds `analysis.read`, so a 403 test
for such a route cannot be written: there is no role fixture that lacks it.
Removing `requirePermission("analysis.read")` from `routes/runs.ts` leaves every
suite green, and an adversarial panel on #1112 recorded that mutant as a survivor
it could not file (no fixture can exist).

**Why:** the permission is a formality on these routes; what actually separates
callers is project access (`assertProjectAccess`, `listAccessibleProjectIds`) and,
for chat data, session ownership (`ai_sessions.userId`).

**How to apply:**
- Do not spend a mutation budget on the permission check of an `analysis.read`
  route, and do not report its survival as a test gap. Say why it survives.
- Test what does discriminate, through the real router with real tokens and a
  real database: another member of the same project, a user in another
  workspace, a user in no workspace on a workspace-less project, an admin.
- A faked `project.findMany` that returns the caller's project whatever `where`
  it is given does not exercise the workspace rule (review of #1112); make the
  fake honour `where` or use the real-SQLite suite.
- Before writing any 403 test, check that some role lacks the permission:
  `grep -n "<permission>" packages/shared/src/rbac.ts`.
- By-id run routes use a DIFFERENT rule (`lib/scheduler/project-access.ts`: the
  project's creator and admins only) from the run list (workspace membership),
  so a member can be listed a run and get 404 opening it. Pre-existing; not
  changed in #1112.
