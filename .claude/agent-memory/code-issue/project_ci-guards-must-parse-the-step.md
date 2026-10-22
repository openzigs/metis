---
name: ci-guards-must-parse-the-step
description: CI guard tests built on extractPnpmCommands see only command text; a step `if:` or `|| true` passes them.
metadata:
  type: project
---

On PR #458 (#456), the guard asserting that CI runs the real-Chromium suite used `extractPnpmCommands` (`scripts/lib/ci-test-ownership-core.mjs`), which splits run lines on `&&`. Two edits left it green: appending `|| true` to the step, and adding `if: github.event_name == 'push'`, which skips the suite on every PR. It rejected only `continue-on-error`.

**Why:** a guard can be satisfied by a command that never runs, or that never fails.

**How to apply:** a ci.yml guard must parse the step block itself. Reject job- and step-level `if:`, `||` on the run line, and `continue-on-error`. When reviewing one, apply those mutations to the real ci.yml. Links: [[permission-mock-hides-removed-gate]].

## Sharded jobs and matrix pins (#1406, #1411/#1415)

- **`continue-on-error` is the mutation ci.yml regex pins most often miss.** A pin asserting
  "must fail when a test fails" has to reject it at BOTH job and step level: job-level makes
  `needs.<job>.result` read `success` and blinds `nightly-report`. Check the whole job with
  `continueOnErrorKeys` (`scripts/lib/ci-test-ownership-core.mjs`), not a regex on one step,
  and share one helper across the matrix pin tests (#1415 and its review).
- **Verify a sharded job by its totals.** Sum each leg's `Test Files` and `Tests`
  passed/skipped/todo/total and compare with the single run on the PR's merge base
  (`gh api repos/<o>/<r>/actions/jobs/<id>/logs`, then grep `Test Files` and `Tests `)
  (#1406 review).
- **`new RegExp(`…${var}`)` in a repo test trips Semgrep's blocking
  `detect-non-literal-regexp`** (#1406). Collect with a literal-regex `matchAll` into a
  `Set` instead.
