-- Epic #159: Multi-project requirement-change → code-impact analysis.
-- Four new models: requirement→code mappings, impact-analysis runs, per-project
-- impact items, and affected-symbol rows (direct matches + blast-radius).

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_code_mappings" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'semantic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_code_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_analyses" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "sourceText" TEXT,
    "summary" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "totalImpactedSymbols" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "impact_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_items" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "changeType" TEXT NOT NULL DEFAULT 'modified',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "affectedFileCount" INTEGER NOT NULL DEFAULT 0,
    "affectedSymbolCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_affected_symbols" (
    "id" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "relation" TEXT NOT NULL DEFAULT 'direct',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,

    CONSTRAINT "impact_affected_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_code_mappings_requirementId_idx" ON "requirement_code_mappings"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_code_mappings_projectId_idx" ON "requirement_code_mappings"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_code_mappings_codeSymbolId_idx" ON "requirement_code_mappings"("codeSymbolId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_analyses_documentId_idx" ON "impact_analyses"("documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_analyses_startedById_idx" ON "impact_analyses"("startedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_analyses_status_idx" ON "impact_analyses"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_items_impactAnalysisId_idx" ON "impact_items"("impactAnalysisId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_items_projectId_idx" ON "impact_items"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_items_requirementId_idx" ON "impact_items"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_affected_symbols_impactItemId_idx" ON "impact_affected_symbols"("impactItemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_affected_symbols_codeSymbolId_idx" ON "impact_affected_symbols"("codeSymbolId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_code_mappings_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_code_mappings_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_code_mappings_codeSymbolId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_codeSymbolId_fkey"
    FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_analyses_documentId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_analyses" ADD CONSTRAINT "impact_analyses_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_analyses_startedById_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_analyses" ADD CONSTRAINT "impact_analyses_startedById_fkey"
    FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_items_impactAnalysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_items" ADD CONSTRAINT "impact_items_impactAnalysisId_fkey"
    FOREIGN KEY ("impactAnalysisId") REFERENCES "impact_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_items_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_items" ADD CONSTRAINT "impact_items_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_items_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_items" ADD CONSTRAINT "impact_items_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_affected_symbols_impactItemId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_affected_symbols" ADD CONSTRAINT "impact_affected_symbols_impactItemId_fkey"
    FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_affected_symbols_codeSymbolId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_affected_symbols" ADD CONSTRAINT "impact_affected_symbols_codeSymbolId_fkey"
    FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;
