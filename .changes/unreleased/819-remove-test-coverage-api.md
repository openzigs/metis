---
issue: 819
section: Removed
---

- The test-coverage API is removed: every `/api/projects/:id/test-coverage/*` endpoint (runs, reports, JUnit upload, imports, exports, mappings, suggestions) now returns 404.
- The test-management connector API is removed: every `/api/test-management/*` endpoint (Xray, Zephyr and TestRail connections: list, create, update, delete, test) now returns 404.
- The `testcoverage:run-update` and `testcoverage:run-finished` Socket.IO events are no longer declared or emitted.
- The `TEST_COVERAGE_RATE_LIMIT_MAX`, `TEST_COVERAGE_PREAUTH_RATE_LIMIT_MAX` and `TEST_COVERAGE_RATE_LIMIT_WINDOW_MS` environment variables and `TESTCOVERAGE_BUDGET_CENTS` are no longer read; remove them from your environment.
- The data stays for now: the `test_coverage_runs`, `test_case_imports`, `test_case_docs`, `coverage_mappings`, `test_coverage_gaps`, `test_coverage_suggestions` and `test_management_connections` tables are dropped in a later release (#821). Export any you want to keep before upgrading to that release.
- To export on Postgres: `pg_dump --data-only -t 'test_*' -t coverage_mappings "$DATABASE_URL" > test-coverage-export.sql`. On SQLite: `sqlite3 <db file> '.dump test_coverage_runs test_case_imports test_case_docs coverage_mappings test_coverage_gaps test_coverage_suggestions test_management_connections' > test-coverage-export.sql`.
- Until then, a vault secret still referenced by a leftover `test_management_connections` row counts as in use: it is not retired, and foreign-owner rotation still lists it.
