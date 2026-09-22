# METIS — code-issue Memory Index

Entries are capped at 150 bytes and the whole file at 17,500 (`pnpm agents:verify`).
Retire, do not delete: move a superseded pointer to `ARCHIVE.md`, which is never loaded.

- [Green api ≠ server runs](project_green-api-job-does-not-run-server-image.md) — RESOLVED #39/#45: api smokes /healthz on SQLite + Postgres
- [Tag-ref caches are unreadable](project_tag-ref-gha-cache-is-write-only.md) — only that tag can restore it; check per-ref size
- [Budget rationale in 3 places](project_image-budget-rationale-lives-in-three-places.md) — docs + 2 comments; grep the tree when correcting one
- [Probe real default paths](project_storage-probes-must-target-real-default-paths.md) — a /tmp probe passed while <cwd>/data was EACCES (#54)
- [Module wiring needs the smoke](project_module-wiring-needs-the-image-smoke.md) — import-time / registration-order bugs pass unit tests (#55, #60)
- [Never `git checkout --` to undo a mutation](project_mutation-restore-must-not-use-git-checkout.md) — it restores HEAD, wiping uncommitted work
- [A run outruns its service](project_coverage-run-spans-more-phases-than-the-service.md) — bill from `task-runner.ts` phases (#72)
- [Whole-module vi.mock 500s later](project_whole-module-vi-mock-stubs-500-at-runtime.md) — one-export stub rots; use `importOriginal` (#67)
- [Sanitise the superseded field too](project_sanitise-the-superseded-field-too.md) — UI legacy parsers still read the old column (#67/#86)
- [Socket guard half-checks](project_socket-contract-guard-half-checks.md) — a misspelled consumer passes; check the §7.6.4 row by hand (#91)
- [Row matchers drop scope](project_row-matchers-drop-scope-assertions.md) — the columns the matcher omits stop being asserted (#94)
