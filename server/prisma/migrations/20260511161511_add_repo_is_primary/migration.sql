-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_repo_connections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "ownerOrOrg" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "apiBaseUrl" TEXT,
    "secretId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "lastTestedAt" DATETIME,
    "lastIngestAt" DATETIME,
    "lastCommitSha" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "repo_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "repo_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "repo_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_repo_connections" ("apiBaseUrl", "createdAt", "createdById", "defaultBranch", "deletedAt", "errorMessage", "id", "label", "lastCommitSha", "lastIngestAt", "lastTestedAt", "ownerOrOrg", "projectId", "provider", "repoName", "secretId", "status", "updatedAt") SELECT "apiBaseUrl", "createdAt", "createdById", "defaultBranch", "deletedAt", "errorMessage", "id", "label", "lastCommitSha", "lastIngestAt", "lastTestedAt", "ownerOrOrg", "projectId", "provider", "repoName", "secretId", "status", "updatedAt" FROM "repo_connections";
DROP TABLE "repo_connections";
ALTER TABLE "new_repo_connections" RENAME TO "repo_connections";
CREATE INDEX "repo_connections_secretId_idx" ON "repo_connections"("secretId");
CREATE INDEX "repo_connections_projectId_status_idx" ON "repo_connections"("projectId", "status");
CREATE UNIQUE INDEX "repo_connections_projectId_label_key" ON "repo_connections"("projectId", "label");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
