---
name: prisma-cross-database
description: Writing Prisma code that runs on both SQLite (default, unit tests) and Postgres (postgres-adapter, production); case-insensitive lookups, provider checks, integration-suite wiring. Links the older SQLite/Postgres entries.
metadata:
  type: project
---

From #1210 (2026-10-16). Checked against `main` at b16dcc30.

- **Case-insensitive lookups: tagged `$queryRaw` with `LOWER()` on both sides.** Prisma's
  `mode: "insensitive"` exists only in the Postgres-generated client, so it does not compile
  against the SQLite one. Every value stays a bound parameter in the tagged template.
  `LOWER` folds ASCII only on SQLite. Example: `findCrossProjectOwners` in
  `server/src/lib/publishing/cross-project-guard.ts`.
- **Importing `resolveDatabaseProvider` from `lib/prisma.ts` breaks test mocks.** Every
  `vi.mock` of `prisma.js` that returns only `{ prisma, Prisma }` then lacks the export
  ("No export defined on the mock"; recurred on PR #1314). Grep the importers' tests and add
  the export to each factory. Prefer SQL both databases accept over branching on the provider.
- **A new `*-postgres.integration.test.ts`** needs its own `pnpm test:integration <name>` step
  in `ci.yml`'s `postgres-adapter` job; nothing checks that, so a suite with no step never
  runs. Every `../src/` import **and every `vi.mock` target** must be in `POSTGRES_PATTERNS`
  (`scripts/lib/ci-changes-core.mjs`), which `scripts/lib/ci-changes-repo.test.mjs` does
  check (PR #1314).

## Re-read after the lock; SQLite cannot test it (PR #1314)

- In `server/src/lib/reviews/review-service.ts`, a value read by `loadReviewOr404` BEFORE the
  transaction (e.g. an item's saved prior status) is safe only while no other transaction
  writes it. Once another review can write those rows, re-read them inside the transaction,
  after the lock.
- `lockScopeRequirements` / `lockRequirementSet` are no-ops on SQLite, so no SQLite test can
  tell "read after the lock" from "read before it": moving the read above the lock still
  passes. Prove such a fix with a forced-interleave Postgres integration test.

Older entries, folded here (retired from the index 2026-10-16; files unchanged):

- [[sqlite-tests-skip-on-postgres-adapter]] — `*.sqlite.test.ts` skips on postgres-adapter;
  raw SQL needs a Postgres twin that actually runs.
- [[sqlite-adapter-999-bind-values-in-list-needs-batching]] — better-sqlite3 refuses more
  than 999 binds and does not chunk with `orderBy`/`take`; batch `IN` lists, test >1,000
  (#1112).
- [[new-prisma-model-three-postgres-artefacts]] — dated migration, regenerated Postgres
  schema, and a `CREATE TABLE` in the baseline; run `tests/schema-parity.test.ts` (#1059).
- `server/tests/generated-doc-outbox.test.ts` builds `scheduled_jobs` by hand: a new
  ScheduledJob column goes there too. `pnpm db:gen-postgres:check` fails from `server/`;
  run `bash scripts/gen-postgres-schema.sh` from the repo root and check `git diff` (#1235).

## Date guards in front of SQLite `julianday(?)` (#1281)

A CLI date guard using JS `Date.parse` lets `October 15, 2026` through to SQLite `julianday(?)`, which yields NULL: the comparison matches zero rows with no error. Normalise with `new Date(x).toISOString()` before binding.

## A new `users` column breaks pre-migration fixtures (#1400)

Every test that writes users with today's Prisma client into a pre-migration (`stopBefore`) database, or into a hand-built `CREATE TABLE users`, fails once a column is added. Seed those rows with raw SQL, or add the column to the hand-built table.

The same break hits any `stopBefore` test that then uses Prisma on a table a later migration
adds a column to. `apply()` just the new migration, not `applyRemaining()`, which can change
pinned behaviour (`repo-primary-unique-457.sqlite.test.ts` vs #492) (#1480). Interactive
transactions on SQLite: [[prisma-sqlite-interactive-transactions]].

## Testing hand-written migrations and backfills (#1440, #1450, 2026-10-23)

- **Verify a hand-written SQLite migration:** `prisma migrate deploy` into a scratch DB, then
  `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`;
  empty output means it matches.
- **SQLite backfill against old rows:** `createMigratedSqlite(prefix, { stopBefore })` then
  `.apply(name)` (`server/tests/helpers/sqlite-migrated-db.ts`). A Postgres backfill needs its
  own `*-postgres.integration.test.ts` (scratch schema, `search_path`, run the migration file
  as-is) plus a `postgres-adapter` CI step.
- **Prove "unresolvable rows are never rewritten".** Postgres: compare each row's `xmin::text`
  before and after. SQLite: an `AFTER UPDATE` logging trigger created before
  `sqlite.apply(MIGRATION)` (`stopBefore` keeps it through the migration).
- **Never `::json`-cast a text column in a Postgres migration** (`notifications.payload`): one
  malformed row aborts it. Use `substring(payload from '"key":"([^"]+)"')`, which is safe
  because payloads are `JSON.stringify`'d.
