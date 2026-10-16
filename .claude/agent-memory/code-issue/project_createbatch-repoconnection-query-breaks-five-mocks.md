---
name: createbatch-repoconnection-query-breaks-five-mocks
description: Changing createBatch's prisma.repoConnection query breaks hand-written prisma mocks in five server test files; three fail only in the full pnpm test.
metadata:
  type: project
---

`createBatch` (`server/src/lib/publishing/publishing-service.ts`) runs the cross-project guard query (`server/src/lib/publishing/cross-project-guard.ts`, `findCrossProjectOwners`). Five server test files mock `prisma.repoConnection` by hand, with exactly the method the guard used to call:

- `server/tests/publishing-service.test.ts`
- `server/tests/publishing-routes.test.ts`
- `server/tests/publishing-batch-lifecycle.test.ts`
- `server/tests/publishing-promotion-guard.test.ts`
- `server/tests/publishing-cross-project-idor.test.ts`

When #1171 moved the query from `findFirst` to `findMany`, the first two broke in the targeted run. The last three broke only in the full `pnpm test` run: 8 tests failed with `findMany is not a function`, which surfaced as unrelated-looking lifecycle and promotion failures.

**Why:** these mocks are partial objects rather than `importOriginal` wrappers, so any change to the guard's Prisma method or shape is a mock-level break in every file that reaches `createBatch`.

**How to apply:** before changing the guard's query, update the `repoConnection` mock in all five files in the same commit: `server/tests/publishing-service.test.ts`, `server/tests/publishing-routes.test.ts`, `server/tests/publishing-batch-lifecycle.test.ts`, `server/tests/publishing-promotion-guard.test.ts` and `server/tests/publishing-cross-project-idor.test.ts`. A sixth that reaches `createBatch` later is found by running the full server suite (`pnpm --filter ./server test`), not just the publishing files you touched. A grep for `repoConnection` in `server/tests` also matches unrelated generated-doc and draft-generator files.
