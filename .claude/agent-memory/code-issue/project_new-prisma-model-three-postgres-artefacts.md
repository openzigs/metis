---
name: new-prisma-model-three-postgres-artefacts
description: What a new Prisma model must add on the Postgres side, and which test catches the one that is easy to miss. From #1059 (spec_kit_jobs), where the third artefact was missing until the full server suite ran.
metadata:
  type: project
---

A new Prisma model needs three Postgres artefacts: the dated idempotent migration, the regenerated `postgres/schema.prisma`, and a `CREATE TABLE` appended to the cumulative `postgres/migrations/00000000000000_init/migration.sql`; `tests/schema-parity.test.ts` fails on the third, only in the full server suite. Run `bash scripts/gen-postgres-schema.sh` from the repo root.

**Why:** the baseline `00000000000000_init` is what a fresh Postgres database is built from, so a table that exists only in the dated migration is missing on a new install. The parity test compares the baseline with the schema; a targeted run of the feature's own tests never loads it.

**How to apply:**

- Add the model to `server/prisma/schema.prisma` (the single source of truth), then `bash scripts/gen-postgres-schema.sh` from the ROOT — `pnpm --filter @metis/server db:gen-postgres` resolves its paths from the wrong directory and fails.
- Write the SQLite migration and its Postgres twin under the same dated name; the Postgres one idempotent (`IF NOT EXISTS`).
- Append the same `CREATE TABLE` and indexes to the Postgres baseline.
- Run `tests/schema-parity.test.ts` by name before pushing: it is the only thing that fails on a missing baseline entry.
- A comment-only change to a `///` field doc still needs the regeneration (the two schemas must stay byte-identical apart from the datasource) but no migration.
- If `main` gains a later-dated migration before merge, rename BOTH twins and the baseline entry to sort after it.
- A new `*-postgres.integration.test.ts` needs its own step in `ci.yml`'s `postgres-adapter` job, and every `src/` file it imports listed in `POSTGRES_PATTERNS` (`scripts/lib/ci-changes-core.mjs`); `ci-changes-repo.test.mjs` checks the list.
