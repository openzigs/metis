-- Epic #207: Requirement→Spec→Code traceability spine.
-- Two new models: requirement↔spec mappings (#226) and spec↔code mappings
-- (#227, mirroring requirement_code_mappings). The "spec" entity is an
-- existing generated_documents row.

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_spec_mappings" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "specDocumentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_spec_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "spec_code_mappings" (
    "id" TEXT NOT NULL,
    "specDocumentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spec_code_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_spec_mappings_requirementId_idx" ON "requirement_spec_mappings"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_spec_mappings_specDocumentId_idx" ON "requirement_spec_mappings"("specDocumentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_spec_mappings_projectId_idx" ON "requirement_spec_mappings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_spec_mappings_requirementId_specDocumentId_key" ON "requirement_spec_mappings"("requirementId", "specDocumentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spec_code_mappings_specDocumentId_idx" ON "spec_code_mappings"("specDocumentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spec_code_mappings_projectId_idx" ON "spec_code_mappings"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spec_code_mappings_codeSymbolId_idx" ON "spec_code_mappings"("codeSymbolId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_spec_mappings_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_spec_mappings" ADD CONSTRAINT "requirement_spec_mappings_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_spec_mappings_specDocumentId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_spec_mappings" ADD CONSTRAINT "requirement_spec_mappings_specDocumentId_fkey"
    FOREIGN KEY ("specDocumentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_spec_mappings_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_spec_mappings" ADD CONSTRAINT "requirement_spec_mappings_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spec_code_mappings_specDocumentId_fkey') THEN
    EXECUTE 'ALTER TABLE "spec_code_mappings" ADD CONSTRAINT "spec_code_mappings_specDocumentId_fkey"
    FOREIGN KEY ("specDocumentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spec_code_mappings_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "spec_code_mappings" ADD CONSTRAINT "spec_code_mappings_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spec_code_mappings_codeSymbolId_fkey') THEN
    EXECUTE 'ALTER TABLE "spec_code_mappings" ADD CONSTRAINT "spec_code_mappings_codeSymbolId_fkey"
    FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;
