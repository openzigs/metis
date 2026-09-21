-- CreateTable
CREATE TABLE "requirement_spec_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "specDocumentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_spec_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_spec_mappings_specDocumentId_fkey" FOREIGN KEY ("specDocumentId") REFERENCES "generated_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_spec_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "spec_code_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "specDocumentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "spec_code_mappings_specDocumentId_fkey" FOREIGN KEY ("specDocumentId") REFERENCES "generated_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "spec_code_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "spec_code_mappings_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "requirement_spec_mappings_requirementId_idx" ON "requirement_spec_mappings"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_spec_mappings_specDocumentId_idx" ON "requirement_spec_mappings"("specDocumentId");

-- CreateIndex
CREATE INDEX "requirement_spec_mappings_projectId_idx" ON "requirement_spec_mappings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_spec_mappings_requirementId_specDocumentId_key" ON "requirement_spec_mappings"("requirementId", "specDocumentId");

-- CreateIndex
CREATE INDEX "spec_code_mappings_specDocumentId_idx" ON "spec_code_mappings"("specDocumentId");

-- CreateIndex
CREATE INDEX "spec_code_mappings_projectId_idx" ON "spec_code_mappings"("projectId");

-- CreateIndex
CREATE INDEX "spec_code_mappings_codeSymbolId_idx" ON "spec_code_mappings"("codeSymbolId");
