---
name: repo-clone-preflight-and-health
description: Since #1322 (PR #1354) docs-gen checks and restores a git connector's clone before any model spend; what that breaks in tests, and how to judge clone health and the ingest lease correctly.
metadata:
  type: project
---

`ensureConnectorClone` / `inspectClone` live in
`server/src/lib/connectors/repo/clone-health.ts`; docs-gen calls them through
`server/src/lib/docs-gen/source-preflight.ts` from `captureGenerationInputs`
(`server/src/lib/docs-gen/generation-inputs.ts`).

**Why:** macOS purged a temp-dir clone to empty directories and a paid BRD was generated
from no source. The fixes and their review produced these rules.

**How to apply:**

- **A new full- or repository-scope docs-gen test with a git connector and no clone on disk
  must `vi.mock` `.../docs-gen/source-preflight.js`.** The first `captureGenerationInputs`
  runs the clone preflight and fails the run otherwise.
- **A module-level default holding an imported function breaks at import time** for every
  test that `vi.mock`s that module without the export. Wrap it:
  `restore: (...args) => restoreCloneAtCommit(...args)` (as `clone-health.ts` does). See
  [[whole-module-vi-mock-stubs-500-at-runtime]].
- **"Lease held" is not terminal on a reader path.** A reader taking the non-blocking ingest
  lease (`tryAcquireConnectorIngest`, `server/src/lib/connectors/ingest-guard.ts`) waits a
  bounded time (`CLONE_RESTORE_LEASE_WAIT_MS`), re-checks the clone meanwhile, and reports
  `busy` on timeout. Test two concurrent callers.
- **"Any one file present" is not a health check.** The temp cleaner deletes files one by one
  by last access. Compare the working tree's file count with the git index's entry count
  (index header bytes 8-11); `inspectClone` requires 95%.
- **A test that needs a real repo at a known commit copies one template repo** (`cpSync`) made
  once per file. Each fresh init and commit gets a new SHA, so a restore stub can never hit
  the recorded commit (`clone-health.test.ts`).
