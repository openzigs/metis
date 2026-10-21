---
name: sqlite-adapter-999-bind-values-in-list-needs-batching
description: Prisma's better-sqlite3 adapter refuses a statement binding more than 999 values (P2029) and does not chunk a findMany that has orderBy or take; an id IN (...) list from an unbounded per-user or per-project set needs batching and a test above the limit
metadata:
  type: project
---

On the Prisma better-sqlite3 adapter a `findMany` whose bind values exceed 999
fails with "The query parameter limit supported by your database is exceeded"
(P2029) rather than being chunked, so any `id IN (...)` list built from an
unbounded per-user or per-project set needs batching or a cap under roughly 900,
and a test above the cap; Postgres-sized caps (thousands) pass every
small-fixture test and 500 in production on SQLite.

**Measured (Prisma 7.10, PR #1112 cycle 2), not assumed.** The limit is exactly
999 bound values per statement, and EVERY bound value counts: 993 session ids +
1 project id + 3 steps + LIMIT + OFFSET = 999 passes, 994 ids fails. `take`
binds two values (LIMIT and OFFSET). The limits are in the client runtime:
`sqlite` 999, `postgresql` 32766.

**When Prisma does chunk, and when it does not.** One long `IN` list with no
`orderBy` and no `take` IS split by Prisma into statements of 999 binds (2,500
ids: three statements), other short lists and equalities included. It is NOT
split, and throws P2029, when the read has an `orderBy`, or a `take`, or two
lists that are each over the limit. So a paged, ordered read over a long list is
the shape that breaks, and it is the usual shape of a list endpoint.

**Why:** `GET /api/runs/chat-turns` named every chat session of the caller in
one `IN` list under a cap of 5,000 "well inside the parameter limit on both
engines". 985 sessions answered 200 and 1,000 answered 500. Every fixture had a
handful of sessions. A per-user `projectId IN (reachable projects)` on the same
route had the same fault from about 996 projects.

**How to apply:**
- Batch the ids (400 a statement in `chat-turn-ledger.ts`), and count the other
  lists and LIMIT/OFFSET when sizing the batch.
- For an ordered page across batches: give every batch the same total order
  (`createdAt desc, id desc`) and the same `take`, then merge, sort by that
  order and slice. A row of the true page is always in its own batch's page.
- A per-user set used only to FILTER (reachable projects) can be applied in
  code instead of bound.
- Test on real SQLite with well over 1,000 rows of the set (2,500 here), compare
  the page with one raw SQL statement, and assert the largest statement's bind
  count from the client's `query` log event (`JSON.parse(e.params).length`).
- `listRuns` (`runs-service.ts`) bound `projectId IN (accessible projects)` with
  `orderBy` + `take`: reproduced as a 500 through the route at 1,101 reachable
  projects (workspace-less projects are open to every non-admin, so a fixture is
  just 1,100 `createMany` rows) and fixed in #1121 by 400-project batches
  (`RUN_LIST_PROJECT_BATCH`). The ACP agents/skills lists have the same shape: #1346.
