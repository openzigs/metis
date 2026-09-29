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
- [Socket guard half-checks](project_socket-contract-guard-half-checks.md) — prove it with a typo copy beside the real name (#91/#113)
- [Row matchers drop scope](project_row-matchers-drop-scope-assertions.md) — the columns the matcher omits stop being asserted (#94)
- [Filter the capped list](project_capped-list-filter-must-share-the-fits-function.md) — filter and render share one fits() or items vanish (#163)
- [Splitter fixtures](project_splitter-fixtures-need-real-sections-and-fences.md) — test on a real dev.db section + an unclosed fence (#162)
- [CodeQL limiter goes BEFORE requireAuth](project_codeql-rate-limit-must-precede-requireauth.md) — a per-user limiter after auth still alerts (291)
- [Object ACL side channels](project_object-acl-side-channels.md) — #349: owner-only routes leaked via tool list, socket room, error text, 409
- [Socket rooms fixed at handshake](project_socket-rooms-fixed-at-handshake.md) — JWT-claim rooms change on reconnect, not refresh (#353)
- [Local UI walkthrough setup](project_local-ui-walkthrough-setup.md) — mock login is `password`; port overrides; Playwright upload root; quarantine
- [Shared scratch/stash/browser](project_parallel-agents-share-scratch-and-browser.md) — unique temp names; verify closing refs
- [Squash title closes issues](project_squash-title-closes-issues.md) — "Resolve #N" in a PR title closes N even if the body says Refs
- [Commit before mutating](project_mutation-restore-must-not-use-git-checkout-uncommitted.md) — git checkout restore drops uncommitted edits
