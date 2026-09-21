-- CreateTable
CREATE TABLE IF NOT EXISTS "schema_usage_classifications" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "usageClass" TEXT NOT NULL,
    "uncertainReason" TEXT,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "overriddenClass" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_usage_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "schema_usage_classifications_projectId_usageClass_idx" ON "schema_usage_classifications"("projectId", "usageClass");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "schema_usage_classifications_projectId_tableName_idx" ON "schema_usage_classifications"("projectId", "tableName");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schema_usage_classifications_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "schema_usage_classifications" ADD CONSTRAINT "schema_usage_classifications_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
