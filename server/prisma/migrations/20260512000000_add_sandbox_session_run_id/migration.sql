-- Epic #395 P2 (#419) — link sandbox sessions to their parent AgentRun.
--
-- Adds a soft FK column `runId` on `sandbox_sessions` so the new
-- Run-detail surface (`GET /api/runs/:id/sandbox-sessions`) can list
-- the sandboxes spawned by a single agent run. Soft FK (no foreign
-- key constraint) because: (a) the sandbox-session writer is not
-- transactionally coupled to the AgentRun writer, and (b) some test
-- harnesses spawn sandboxes without first creating an AgentRun row.
--
-- Index `(runId, createdAt)` so the listing query (`WHERE runId = ?
-- ORDER BY createdAt ASC LIMIT 50`) is index-only.

ALTER TABLE "sandbox_sessions" ADD COLUMN "runId" TEXT;

CREATE INDEX "sandbox_sessions_runId_createdAt_idx"
  ON "sandbox_sessions" ("runId", "createdAt");
