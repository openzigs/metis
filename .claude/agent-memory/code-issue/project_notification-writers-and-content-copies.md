---
name: notification-writers-and-content-copies
description: Every notification writer needs a projectId (structural test), copied user content outlives its source, emoji-safe truncation, and the test traps around socket payload types and mention mocks (#1440, #1450).
metadata:
  type: project
---

From #1440, #1450 and their reviews (2026-10-23).

**projectId is required in practice.** A notification with no `projectId` is redacted for
everyone (`server/src/lib/notifications/visibility.ts`); a project-less type needs an explicit
carve-out in `PROJECTLESS_NOTIFICATION_TYPES`. `server/tests/notification-writers-1447.test.ts`
parses every notification `create` / `createMany` / `upsert` in `server/src` and enforces it.

**Copied content outlives its source.** A notification that copies user-authored text (a
comment excerpt) survives the source's delete, edit and access changes, and
`GET /notifications` never re-checks access. Ask any PR adding body text to a notification how
it is scrubbed.

**Truncation.** Helpers using `String.prototype.slice` split emoji. Probe with
`"a".repeat(N-2) + "😀😀"` at the cut boundary ([[unicode-escapes-arrive-literal]]).

**Test traps.**
- Changing a `ServerToClientEvents` payload type breaks tests emitting the old shape, caught
  only by the server typecheck of `tsconfig.test.json`. Grep `server/tests` for
  `emit("<event>"` before pushing.
- `tests/comments.test.ts` and `tests/comments-live-997.test.ts` `vi.mock`
  `collaboration/mentions` with only `dispatchMentions`; a new export called from
  `routes/comments.ts` must be added to both mocks ([[whole-module-vi-mock-stubs-500-at-runtime]]).

Backfilling `notifications.payload` in a migration: see [[prisma-cross-database]].
