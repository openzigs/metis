---
name: adversarial-panel-trigger-and-gate-scripts
description: Computing whether the adversarial panel is required (pnpm review:adversarial-required, exit 2, added import specifiers) and how diff-reading gate snippets fail open (#1482 and its review).
metadata:
  type: project
---

From #1482 and its review (2026-10-24).

- **Compute it with `pnpm review:adversarial-required [--base <ref>]`.** It exits 2 when git
  cannot give a readable diff, and exit 2 is never "not required".
- **The trigger reads newly added import specifiers** (`addedImportSpecifiers(diff)`). A
  caller that omits `addedImports` silently loses that signal: always pipe the diff.
  `node:crypto` and `auth/jwt` are excluded by measurement.
- **A git textconv driver rewrites hunk bodies but leaves headers intact**; only
  `--no-textconv` defends a diff reader against it.
- **Diff-reading gate snippets fail open.** A snippet shaped like `git diff … | node -e …`
  with `$(git diff --name-only …)` yields `{required:false}` exit 0 on a bad ref, an empty
  pipe or forced colour. Test every gate entry point with an unknown ref and empty stdin.

Older trigger gaps (credential reads outside auth/secrets paths):
[[pr-review-worker-budget-and-github-client]], [[secret-binding-fire-time-checks]].
