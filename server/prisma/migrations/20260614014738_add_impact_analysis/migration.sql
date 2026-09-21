-- CreateTable
CREATE TABLE "requirement_code_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'semantic',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_code_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_code_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_code_mappings_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "impact_analyses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "sourceText" TEXT,
    "summary" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    "totalImpactedSymbols" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "impact_analyses_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "impact_analyses_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "impact_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "impactAnalysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "changeType" TEXT NOT NULL DEFAULT 'modified',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "impactScore" REAL NOT NULL DEFAULT 0.5,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "affectedFileCount" INTEGER NOT NULL DEFAULT 0,
    "affectedSymbolCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_items_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "impact_analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "impact_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "impact_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "impact_affected_symbols" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "impactItemId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "relation" TEXT NOT NULL DEFAULT 'direct',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    CONSTRAINT "impact_affected_symbols_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "impact_affected_symbols_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "requirement_code_mappings_requirementId_idx" ON "requirement_code_mappings"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_code_mappings_projectId_idx" ON "requirement_code_mappings"("projectId");

-- CreateIndex
CREATE INDEX "requirement_code_mappings_codeSymbolId_idx" ON "requirement_code_mappings"("codeSymbolId");

-- CreateIndex
CREATE INDEX "impact_analyses_documentId_idx" ON "impact_analyses"("documentId");

-- CreateIndex
CREATE INDEX "impact_analyses_startedById_idx" ON "impact_analyses"("startedById");

-- CreateIndex
CREATE INDEX "impact_analyses_status_idx" ON "impact_analyses"("status");

-- CreateIndex
CREATE INDEX "impact_items_impactAnalysisId_idx" ON "impact_items"("impactAnalysisId");

-- CreateIndex
CREATE INDEX "impact_items_projectId_idx" ON "impact_items"("projectId");

-- CreateIndex
CREATE INDEX "impact_items_requirementId_idx" ON "impact_items"("requirementId");

-- CreateIndex
CREATE INDEX "impact_affected_symbols_impactItemId_idx" ON "impact_affected_symbols"("impactItemId");

-- CreateIndex
CREATE INDEX "impact_affected_symbols_codeSymbolId_idx" ON "impact_affected_symbols"("codeSymbolId");
