-- CreateTable
CREATE TABLE IF NOT EXISTS "schema_usage_overrides" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "usageClass" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'reads',
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schema_usage_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "schema_usage_overrides_projectId_idx" ON "schema_usage_overrides"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "schema_usage_overrides_projectId_tableName_columnName_access_key" ON "schema_usage_overrides"("projectId", "tableName", "columnName", "access");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schema_usage_overrides_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "schema_usage_overrides" ADD CONSTRAINT "schema_usage_overrides_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
