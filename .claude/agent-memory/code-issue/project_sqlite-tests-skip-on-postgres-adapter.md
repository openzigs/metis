---
name: sqlite-tests-skip-on-postgres-adapter
description: *.sqlite.test.ts is skipped on postgres-unit (the Postgres-client unit run); mocked siblings must assert the controls, and raw SQL needs a Postgres twin actually run.
metadata:
  type: project
---

`*.sqlite.test.ts` files use `describe.skipIf` on the generated client's provider, so the `postgres-unit` CI legs (the Postgres-client unit run, in `postgres-adapter` before #1365) never run them.
- On #595 (#579) the only live-invite control that asserted `valid: true` lived in the SQLite file; the mocked sibling checked `workspace.name` alone, so an always-invalid route passed on Postgres.
- On #587 (#552) a raw `$executeRaw` Date write compared later against a Prisma-typed Date was "reasoned fine" by two reviewers but never run on Postgres. A local `pgvector/pgvector:pg16` twin (`RUN_INTEGRATION_TESTS=1`, like the #479 suite) settled it, and was then wired into the postgres-adapter job.

**Why:** green `postgres-unit` / `postgres-adapter` checks say nothing about behaviour only a SQLite file or an unrun twin exercises.

**How to apply:** give the mocked sibling the control's key assertions; for raw SQL, Date/timestamp equality or row-lock semantics, add a Postgres integration twin, run it locally, and add it as a step of the `postgres-adapter` job (which holds the integration proofs). Links: [[vitest-once-mocks-and-retries-hide-leaks]].
