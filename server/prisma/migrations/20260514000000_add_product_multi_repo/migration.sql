-- Epic #544 — Multi-Repository Product Documentation
-- Adds Product entity, ProductRepo join table, ProductEdge cross-repo edges,
-- ProductAnalysis job tracking, ProductDocument generated docs,
-- and productId FK on projects table.

-- Product entity
CREATE TABLE "products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "slug" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "products_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");
CREATE INDEX "products_createdById_idx" ON "products"("createdById");

-- Product-Repo join table (many-to-many with role)
CREATE TABLE "product_repos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_repos_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_repos_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_repos_productId_repoConnectionId_key" ON "product_repos"("productId", "repoConnectionId");
CREATE INDEX "product_repos_repoConnectionId_idx" ON "product_repos"("repoConnectionId");

-- Cross-repo edges discovered by relationship detector
CREATE TABLE "product_edges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "sourceRepoId" TEXT NOT NULL,
    "targetRepoId" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "sourceFile" TEXT,
    "targetFile" TEXT,
    "commitSha" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "product_edges_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_sourceRepoId_fkey" FOREIGN KEY ("sourceRepoId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_edges_targetRepoId_fkey" FOREIGN KEY ("targetRepoId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_edges_productId_idx" ON "product_edges"("productId");
CREATE INDEX "product_edges_sourceRepoId_idx" ON "product_edges"("sourceRepoId");
CREATE INDEX "product_edges_targetRepoId_idx" ON "product_edges"("targetRepoId");
CREATE INDEX "product_edges_productId_edgeType_idx" ON "product_edges"("productId", "edgeType");

-- Product analysis job tracking
CREATE TABLE "product_analyses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "triggeredBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_analyses_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_analyses_productId_idx" ON "product_analyses"("productId");

-- Product-level generated documentation
CREATE TABLE "product_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "repoId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "product_documents_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_documents_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repo_connections" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "product_documents_productId_idx" ON "product_documents"("productId");
CREATE INDEX "product_documents_productId_docType_idx" ON "product_documents"("productId", "docType");
CREATE INDEX "product_documents_repoId_idx" ON "product_documents"("repoId");

-- Add productId FK to projects table
ALTER TABLE "projects" ADD COLUMN "productId" TEXT REFERENCES "products"("id") ON DELETE SET NULL;
