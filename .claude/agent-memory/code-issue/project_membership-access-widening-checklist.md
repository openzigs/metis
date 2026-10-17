---
name: membership-access-widening-checklist
description: Widening access from creator-only to workspace members (sockets, routes, lists) — every revocation point, live-user checks, audit names; from #1212/#1219 and #1221/#1233.
metadata:
  type: project
---

Collected from #1212 / PR #1219 and #1221 / PR #1233 and their reviews (2026-10-16/17).

**One rule.** Admit members through `assertProjectAccess` / `canAccessProjectDiscussions`. For a single project, `actorHasProjectAccess` in `server/src/lib/scheduler/project-access.ts` wraps it. Never add a second rule.

**A live-user check is required on list paths.**
- Most REST routes mount only `requireAuth`, which checks the token signature and does not refresh from the database.
- `actorIsWorkspaceMember` and `assertWorkspaceAccessible` do not check that the user is still active.
- So a new list path that admits members must go through `readLiveWorkspaceIds` + `accessibleProjectWhere`. Its tests need disabled, soft-deleted and removed-member cases.
- On #1233, `listMemberProjectsInWorkspace` missed this, which let a disabled user with an unexpired token search the whole workspace.

**Two functions share a name but apply different rules.**
- `listAccessibleProjectIds` in `scheduler/project-access.ts` is creator-only.
- `listAccessibleProjectIds` in `acp/authz.ts` admits members.
- Check the import path. #1232 tracks removing the creator-only one.

**Socket rooms.**
- Membership-gated rooms need their own eviction, hooked into `routes/workspaces.ts` and the shared eviction epoch; `project-room-eviction.ts` is the template.
- Re-judge membership at every point where access can be lost:
  - member removal;
  - workspace delete;
  - a project's `workspaceId` change;
  - project soft-delete.
- Each room also needs a branch in `revalidateUserSockets`.
- A fail-closed re-judgement should close the transport. The UI re-subscribes only on reconnect (`ui/src/lib/socket-subscription.ts`).
- A fallback that runs on a failed DB lookup must not fan out across all sockets. That case fires when the DB is sick, which is #659's reconnect storm. Route it through the bounded, single-flight `revalidateLocalSockets`.

**Audit names.** Route-level audit rows that reuse the queue's action names (`task.cancel`, `task.retry` in `scheduler/task-store.ts`) make one action name two events, and one cancel becomes two rows (#1239). Use a distinct suffix such as `.requested`.

**Test seam.** `TaskQueue.cancel` (`scheduler/task-queue.ts`) cancels only tasks in the in-memory queue. A `pending` Task row inserted straight into the DB answers 409. Enqueue through `getSchedulerBootstrap().queue.enqueue({..., scheduledFor: <future>})`.

**Tests authenticate as non-admin members.** Admin bypasses the check. Mutation-check by restoring the creator-only rule: on #1233 this failed 18, 3 and 2 tests across the three helpers.
