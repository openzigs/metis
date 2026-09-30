---
name: ci-guards-must-parse-the-step
description: CI guard tests built on extractPnpmCommands see only command text; a step `if:` or `|| true` passes them.
metadata:
  type: project
---

On PR #458 (#456), the guard asserting that CI runs the real-Chromium suite used `extractPnpmCommands` (`scripts/lib/ci-test-ownership-core.mjs`), which splits run lines on `&&`. Two edits left it green: appending `|| true` to the step, and adding `if: github.event_name == 'push'`, which skips the suite on every PR. It rejected only `continue-on-error`.

**Why:** a guard can be satisfied by a command that never runs, or that never fails.

**How to apply:** a ci.yml guard must parse the step block itself. Reject job- and step-level `if:`, `||` on the run line, and `continue-on-error`. When reviewing one, apply those mutations to the real ci.yml. Links: [[permission-mock-hides-removed-gate]].
