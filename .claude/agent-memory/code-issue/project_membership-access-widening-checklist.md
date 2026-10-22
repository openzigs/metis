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

**The creator-only predicates are gone (#1232).**
- `listAccessibleProjectIds` in `scheduler/project-access.ts` and `listAccessibleProjectsInWorkspace` were removed. Products, impact detail, runs and cross-project impact now use the member rule.
- `listAccessibleProjectIds` in `acp/authz.ts` still exists. It admits members, but it reads the token's workspace claim, not the live membership.
- Mocked-prisma suites (`socket.test.ts`, `products-multi.authz.test.ts`) need `project.findMany` to honour `accessibleProjectWhere`'s `OR[].workspaceId.in`, and `workspaceMember.findMany` for the live read.
- A test asserting "a non-creator member gets 404" is now pinning the old bug.

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

**Foreign ids behind a widened guard (#1248 review, #1250).** Widening a by-id guard to members widens every attach/associate write behind it. A write that takes a caller-supplied foreign id (`addProductRepo`'s `repoConnectionId`) must check that id against its *own* project, not only the product's.

## `assertProjectAccess` ignores `project.deletedAt` (#1288, fixed for socket rooms in #1290)

`assertProjectAccess` reads live membership and the workspace's `deletedAt`, but not the project's `deletedAt`. Any rule built only on it still admits members to a soft-deleted project. The socket rooms used it through `canReachProject` until #1290. They now use `canReadProject` (`room-access.ts`, which is `canAccessProjectDiscussions`). Use that rule whenever deleting a project must close access.

**Still open after #1413 (2026-10-22).** A soft-deleted project is closed by
`accessibleProjectWhere` (lists) and `canAccessProjectDiscussions` (by id), but not by
`assertProjectAccess` (`server/src/lib/custom-agents/authz.ts`). #1413 closed run and
chat-turn lists (#1122). Any route gated only by `assertProjectAccess` still admits members
to a soft-deleted project: look for a `deletedAt` term. `loadAuthorizedSession`
(`ai/conversation/session-access.ts`) is gated only by it, so a chat session in a
soft-deleted project still opens for a non-admin (#1412, open on 2026-10-22).
