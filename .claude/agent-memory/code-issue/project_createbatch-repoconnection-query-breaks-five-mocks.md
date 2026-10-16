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

**How to apply:** before changing the guard's query, run
`grep -rln "repoConnection" server/tests | xargs grep -l "createBatch\|publishing"` and update every hit in the same commit. Then run the full server suite, not just the publishing files you touched.
