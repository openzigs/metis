-- Epic #295 Phase 4 (#307/#308) — Cross-project impact: DatabaseResource registry
-- + canonical SchemaObjectIdentity. Postgres mirror of the SQLite migration.
--
-- Postgres supports ALTER TABLE ... ADD COLUMN with a FK in place, so (unlike
-- the SQLite twin which rebuilds the tables) the two ADDITIVE/NULLABLE columns
-- are added directly. All existing rows get NULL for the new columns, so every
-- existing reader/writer is unaffected. The backfill is byte-equivalent logic to
-- the SQLite migration (the `||` concat + COALESCE are portable).

-- CreateTable
CREATE TABLE IF NOT EXISTS "database_resources" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "schema_object_identities" (
    "id" TEXT NOT NULL,
    "databaseResourceId" TEXT NOT NULL,
    "schemaName" TEXT,
    "objectName" TEXT NOT NULL,
    "objectType" TEXT NOT NULL DEFAULT 'table',
    "usageClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schema_object_identities_pkey" PRIMARY KEY ("id")
);

-- AlterTable (ADDITIVE/NULLABLE)
ALTER TABLE "database_connections" ADD COLUMN IF NOT EXISTS "databaseResourceId" TEXT;
ALTER TABLE "impact_affected_tables" ADD COLUMN IF NOT EXISTS "schemaObjectIdentityId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "database_resources_workspaceId_idx" ON "database_resources"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "database_resources_workspaceId_driver_host_port_databaseName_key" ON "database_resources"("workspaceId", "driver", "host", "port", "databaseName");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "schema_object_identities_databaseResourceId_idx" ON "schema_object_identities"("databaseResourceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "schema_object_identities_databaseResourceId_schemaName_objectName_objectType_key" ON "schema_object_identities"("databaseResourceId", "schemaName", "objectName", "objectType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "database_connections_databaseResourceId_idx" ON "database_connections"("databaseResourceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_affected_tables_schemaObjectIdentityId_idx" ON "impact_affected_tables"("schemaObjectIdentityId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'database_resources_workspaceId_fkey') THEN
    EXECUTE 'ALTER TABLE "database_resources" ADD CONSTRAINT "database_resources_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schema_object_identities_databaseResourceId_fkey') THEN
    EXECUTE 'ALTER TABLE "schema_object_identities" ADD CONSTRAINT "schema_object_identities_databaseResourceId_fkey" FOREIGN KEY ("databaseResourceId") REFERENCES "database_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'database_connections_databaseResourceId_fkey') THEN
    EXECUTE 'ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_databaseResourceId_fkey" FOREIGN KEY ("databaseResourceId") REFERENCES "database_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_affected_tables_schemaObjectIdentityId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_affected_tables" ADD CONSTRAINT "impact_affected_tables_schemaObjectIdentityId_fkey" FOREIGN KEY ("schemaObjectIdentityId") REFERENCES "schema_object_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- Backfill: one resource per distinct (workspace, driver, host, port, db) among
-- existing live connections with a workspace AND minimum identity (host + db).
INSERT INTO "database_resources" ("id", "workspaceId", "driver", "host", "port", "databaseName", "createdAt", "updatedAt")
SELECT DISTINCT
  'dbres:' || p."workspaceId" || ':' || c."driver" || ':' || c."host" || ':' || COALESCE(CAST(c."port" AS TEXT), '') || ':' || c."databaseName",
  p."workspaceId",
  c."driver",
  c."host",
  c."port",
  c."databaseName",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "database_connections" c
JOIN "projects" p ON p."id" = c."projectId"
WHERE c."deletedAt" IS NULL
  AND p."workspaceId" IS NOT NULL
  AND c."host" IS NOT NULL
  AND c."databaseName" IS NOT NULL;

-- Link the connections to the resource that matches their dedupe key.
UPDATE "database_connections"
SET "databaseResourceId" = 'dbres:' || (
    SELECT p."workspaceId" FROM "projects" p WHERE p."id" = "database_connections"."projectId"
  ) || ':' || "driver" || ':' || "host" || ':' || COALESCE(CAST("port" AS TEXT), '') || ':' || "databaseName"
WHERE "deletedAt" IS NULL
  AND "host" IS NOT NULL
  AND "databaseName" IS NOT NULL
  AND (SELECT p."workspaceId" FROM "projects" p WHERE p."id" = "database_connections"."projectId") IS NOT NULL;
