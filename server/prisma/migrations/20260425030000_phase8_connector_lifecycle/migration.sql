-- Phase 8 — Repo + Database connector lifecycle columns
-- Adds status / lastTestedAt / lastIngestAt / errorMessage / lastCommitSha / apiBaseUrl
-- to repo_connections and database_connections.

-- RepoConnection -------------------------------------------------------------
ALTER TABLE "repo_connections" ADD COLUMN "apiBaseUrl" TEXT;
ALTER TABLE "repo_connections" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "repo_connections" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "repo_connections" ADD COLUMN "lastTestedAt" DATETIME;
ALTER TABLE "repo_connections" ADD COLUMN "lastIngestAt" DATETIME;
ALTER TABLE "repo_connections" ADD COLUMN "lastCommitSha" TEXT;

CREATE INDEX "repo_connections_projectId_status_idx" ON "repo_connections"("projectId", "status");

-- DatabaseConnection ---------------------------------------------------------
ALTER TABLE "database_connections" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "database_connections" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "database_connections" ADD COLUMN "lastTestedAt" DATETIME;
ALTER TABLE "database_connections" ADD COLUMN "lastIngestAt" DATETIME;

CREATE INDEX "database_connections_projectId_status_idx" ON "database_connections"("projectId", "status");
