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
  `vi.mock` of `prisma.js` that returns only `{ prisma, Prisma }` then lacks the export.
  Prefer SQL both databases accept over branching on the provider.
- **A new `*-postgres.integration.test.ts`** needs its own `pnpm test:integration <name>` step
  in `ci.yml`'s `postgres-adapter` job; nothing checks that, so a suite with no step never
  runs. Its `src/` imports must be in `POSTGRES_PATTERNS` (`scripts/lib/ci-changes-core.mjs`),
  which `scripts/lib/ci-changes-repo.test.mjs` does check.

Older entries, folded here (retired from the index 2026-10-16; files unchanged):

- [[sqlite-tests-skip-on-postgres-adapter]] — `*.sqlite.test.ts` skips on postgres-adapter;
  raw SQL needs a Postgres twin that actually runs.
- [[sqlite-adapter-999-bind-values-in-list-needs-batching]] — better-sqlite3 refuses more
  than 999 binds and does not chunk with `orderBy`/`take`; batch `IN` lists, test >1,000
  (#1112).
- [[new-prisma-model-three-postgres-artefacts]] — dated migration, regenerated Postgres
  schema, and a `CREATE TABLE` in the baseline; run `tests/schema-parity.test.ts` (#1059).
