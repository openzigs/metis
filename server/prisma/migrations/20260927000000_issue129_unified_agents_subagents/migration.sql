-- Epic #129 (#145, #146, #147) — one agent definition, progressive skills and
-- sub-agents.
--
--   * `agents` (the library) gains the two definition fields it lacked:
--     `reasoningEffort` and an `approvalPolicy` override (JSON, tighten-only);
--   * `custom_agents` gains the three it lacked: `skillKeys` (JSON array of
--     library skill keys), `approvalPolicy` and `version`;
--   * `skill_files` stores an imported Agent Skills directory's supporting files
--     (served only by exact path through the `load_skill` tool);
--   * `ai_subagent_runs` stores each sub-agent run's transcript, linked from the
--     caller's tool call.
--
-- Additive only: every new column is nullable or carries a constant default, so
-- every existing agent of either kind keeps every field it had (no row is
-- rewritten) and reads as "no skills, no override, version 1.0.0".
--
-- Rollback (documentation; rehearsed on a scratch database built by
-- `migrate deploy`, 2026-09-27 — rehearse again on a copy before relying on it):
-- `DROP TABLE "ai_subagent_runs"; DROP TABLE "skill_files";` then (SQLite 3.35+)
-- `ALTER TABLE "custom_agents" DROP COLUMN "version";`,
-- `ALTER TABLE "custom_agents" DROP COLUMN "approvalPolicy";`,
-- `ALTER TABLE "custom_agents" DROP COLUMN "skillKeys";`,
-- `ALTER TABLE "agents" DROP COLUMN "approvalPolicy";`,
-- `ALTER TABLE "agents" DROP COLUMN "reasoningEffort";`.
-- Lossy: sub-agent transcripts, imported supporting files and any skills /
-- overrides set on agents after this migration are lost.

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "reasoningEffort" TEXT;
ALTER TABLE "agents" ADD COLUMN "approvalPolicy" TEXT;

-- AlterTable
ALTER TABLE "custom_agents" ADD COLUMN "skillKeys" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "custom_agents" ADD COLUMN "approvalPolicy" TEXT;
ALTER TABLE "custom_agents" ADD COLUMN "version" TEXT NOT NULL DEFAULT '1.0.0';

-- CreateTable
CREATE TABLE "skill_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_files_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_subagent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ai_subagent_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "skill_files_skillId_path_key" ON "skill_files"("skillId", "path");

-- CreateIndex
CREATE INDEX "ai_subagent_runs_sessionId_createdAt_idx" ON "ai_subagent_runs"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_subagent_runs_parentRunId_idx" ON "ai_subagent_runs"("parentRunId");
