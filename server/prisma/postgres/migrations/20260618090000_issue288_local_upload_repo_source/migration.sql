-- Issue #288: ingest non-source-controlled code via local server path + folder upload.
-- See the SQLite mirror for full context. Postgres can DROP NOT NULL + ADD COLUMN
-- in place, so no table rebuild is needed.

-- AlterTable
ALTER TABLE "repo_connections" ALTER COLUMN "ownerOrOrg" DROP NOT NULL,
ALTER COLUMN "repoName" DROP NOT NULL,
ADD COLUMN     IF NOT EXISTS "localPath" TEXT,
ADD COLUMN     IF NOT EXISTS "uploadPath" TEXT;
