-- Epic #770: Requirement Version History & Per-Row Audit Trail.
-- Append-only requirement_versions table storing compact per-edit diffs.

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_versions" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changedFields" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_versions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_versions_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_versions" ADD CONSTRAINT "requirement_versions_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_versions_requirementId_idx" ON "requirement_versions"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_versions_actorId_idx" ON "requirement_versions"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_versions_requirementId_version_key" ON "requirement_versions"("requirementId", "version");
