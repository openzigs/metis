# METIS — code-issue Memory Archive

Retired pointers from `MEMORY.md`. This file is never loaded into context; the
memory files it points to stay in the store.

- [Green api ≠ server runs](project_green-api-job-does-not-run-server-image.md) — RESOLVED #39/#45: api smokes /healthz on SQLite + Postgres (retired 2026-10-15: resolved)
- [Go methods unresolved](project_go-methods-unresolved.md) — Go parser stores methods as file::M; 76% of Miniflux calls unresolved (retired 2026-10-15: superseded by #1071, Go method calls bind at ingest)
- [Commit before mutating](project_mutation-restore-must-not-use-git-checkout-uncommitted.md) — git checkout restore drops uncommitted edits (retired 2026-10-15: duplicate of "Never `git checkout --` to undo a mutation")
- [vitest retry masks failures](project_vitest-retry-masks-deterministic.md) — retry:2 hid 6 real failures; clearAllMocks keeps once-values (#963) (retired 2026-10-15: covered by "Once-mocks and retries" (retry:2, once-value leaks))
- [e2e runs in CI](project_e2e-runs-in-ci.md) — full e2e job runs on PRs; never claim it is off. Route-removal tests: check dynamic siblings too (retired 2026-10-15: the e2e shards are in CLAUDE.md's PR check set; route-test tip stays in the file)
