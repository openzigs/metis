---
name: runbatch-batch-row-decides-dry-run
description: runBatch used to trust its caller's dryRun; the batch row is now authoritative via the BATCH_IS_DRY_RUN guard (#1171).
metadata:
  type: project
---

`runBatch` (`server/src/lib/publishing/publisher.ts`) used to take `dryRun` from its caller and never read the batch row's own `dryRun`. The scheduler's `publish-batch` handler (`server/src/lib/scheduler/handler-overrides.ts`) always passes `dryRun: false`.

Dry runs are exempt at creation from the approval gate (#619) and, since #1171, from the cross-project confirmation. That made a dry-run batch publishable live through the scheduler. The only thing in the way was that the handler holds no credential (#504), so the run failed with `TOKEN_REQUIRED`. The PR #1178 review found this.

**Now:** the batch row is authoritative. `runBatch` refuses `!input.dryRun && batch.dryRun` with `PublishError(409, "BATCH_IS_DRY_RUN")`, before any draft read or write. It is tested through the real scheduler handler in `server/tests/lib/publishing/scheduled-dry-run-batch.test.ts`.

**Why:** an exemption granted at creation ("it writes nothing") holds only if nothing later turns that batch into a write. Grepping found no legitimate flow that promotes a dry-run batch to a live run. `executeBatch` passes `batch.dryRun`, and `publish-batch` is documented as "re-run a publish".

**How to apply:** if you add a dry-run exemption to any publish gate, rely on this guard rather than on the scheduler lacking a credential. Do not remove the guard to "promote" a dry run. Create a live batch instead.
