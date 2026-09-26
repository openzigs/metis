-- Epic #129 (#145, #146, #147) — one agent definition, progressive skills and
-- sub-agents (Postgres mirror). See the SQLite migration of the same name for
-- the full rationale. Additive only: every existing agent of either kind keeps
-- every field it had.
--
-- All DDL is idempotent (`IF NOT EXISTS`; FKs wrapped in pg_constraint
-- existence DO-blocks) so the full history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard).
--
-- Rollback (documentation; rehearse on a copy before relying on it):
-- `DROP TABLE "ai_subagent_runs"; DROP TABLE "skill_files";`
-- `ALTER TABLE "custom_agents" DROP COLUMN "version", DROP COLUMN "approvalPolicy", DROP COLUMN "skillKeys";`
-- `ALTER TABLE "agents" DROP COLUMN "approvalPolicy", DROP COLUMN "reasoningEffort";`.
-- Lossy: sub-agent transcripts, imported supporting files and any skills /
-- overrides set on agents after this migration are lost.

-- AlterTable
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "approvalPolicy" TEXT,
ADD COLUMN IF NOT EXISTS "reasoningEffort" TEXT;

-- AlterTable
ALTER TABLE "custom_agents" ADD COLUMN IF NOT EXISTS "approvalPolicy" TEXT,
ADD COLUMN IF NOT EXISTS "skillKeys" TEXT NOT NULL DEFAULT '[]',
ADD COLUMN IF NOT EXISTS "version" TEXT NOT NULL DEFAULT '1.0.0';

-- CreateTable
CREATE TABLE IF NOT EXISTS "skill_files" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ai_subagent_runs" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "parentCallId" TEXT NOT NULL,
    "agentRef" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL DEFAULT '',
    "depth" INTEGER NOT NULL DEFAULT 1,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "result" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "turns" TEXT NOT NULL DEFAULT '[]',
    "toolCalls" TEXT NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ai_subagent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "skill_files_skillId_path_key" ON "skill_files"("skillId", "path");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_subagent_runs_sessionId_createdAt_idx" ON "ai_subagent_runs"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_subagent_runs_parentRunId_idx" ON "ai_subagent_runs"("parentRunId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_files_skillId_fkey') THEN
    EXECUTE 'ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_subagent_runs_sessionId_fkey') THEN
    EXECUTE 'ALTER TABLE "ai_subagent_runs" ADD CONSTRAINT "ai_subagent_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
