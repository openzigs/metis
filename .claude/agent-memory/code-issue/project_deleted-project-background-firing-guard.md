---
name: deleted-project-background-firing-guard
description: Soft-deleting a project has two halves — request guards and background firing paths; where the firing-time guard lives, why it keys on more than task.projectId, and the test-mock fallout of adding it (#1434, #1438, #1444).
metadata:
  type: project
---

Collected from #1434 / #1444 and their reviews (2026-10-23). #1430 and #1438 are closed.

**Two halves.** Request guards (`assertLiveProjectAccess`, `custom-agents/authz.ts`, now used
by `requireProjectAccess`) close one half. Background paths never consult that seam: webhook
triggers, `fireScheduledJob` and the PR webhook's `findProjectForRepo`
(`routes/webhooks-github.ts`). `deleteProject` disables nothing but RAG, so the guard is at
**firing time** (`server/src/lib/projects/deleted-project-guard.ts`), and a restore keeps the
owner's enabled triggers and jobs.

**Key on the owner, not just the column.** `ScheduledJob.projectId` and `Task.projectId` are
optional. Rerun-analysis, connector refresh tasks and publish-batch take their project from
the payload or from a connector/batch id. A gate keyed on `task.projectId` alone is
bypassable. Any per-project scheduler/task gate must use `deletedProjectOfTask`, which
resolves the column, `payload.projectId`, and the connector/batch/import-source owner.

**Test fallout of adding the guard.**
- A new Prisma call inside `AsyncRunner.execute`, the bootstrapped `TaskQueue` or
  `POST /runs/background` breaks ~8 test files whose prisma mocks lack it. Add
  `project.findMany` to the async-runner, async-routes, scheduler-bootstrap,
  generated-doc-regeneration, connector-local-upload-routes, background-runs-authz and
  background-runs-rate-limit-1116 mocks.
- Adding a `where` key to `checkIncrementalRegeneration`'s `generatedDocument.findMany` fails
  ~40 tests (their mocks match the exact `where` shape). Gate regeneration at the task queue
  instead.
- `workspaceScopeWhere` (`lib/auth/project-scope.ts`) now carries `deletedAt: null` for
  non-admins; tests asserting its exact shape (project-scope, run-authz, background-runs-authz)
  must include it.
- Real-SQLite tests of `/api/mcp` list routes need
  `setMCPRegistry(new MCPRegistryService(new MCPLifecycleManager({...})))`, or the route
  returns 503 `MCP_NOT_READY`.
- Teams, PagerDuty and provider-watcher hook tests use a fake db whose `findFirst` ignores
  `where`. Read a `deletedAt` filter from the selected row, or the test cannot fail.

**Classifying hooks.** PagerDuty and Teams notification hooks (`lib/pagerduty/*`,
`lib/teams/notification-hooks.ts`) are external writes; never class them "internal-only".

Related: [[membership-access-widening-checklist]], [[workspace-delete-is-soft]],
[[test-falsifiability-traps]].
