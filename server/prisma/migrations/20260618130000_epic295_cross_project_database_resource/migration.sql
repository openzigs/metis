-- Epic #295 Phase 4 (#307/#308) — Cross-project impact: DatabaseResource registry
-- + canonical SchemaObjectIdentity.
--
-- Adds two NEW workspace-scoped tables and two ADDITIVE/NULLABLE FK columns:
--   * database_resources          — dedupes the same physical DB across the
--                                   projects of a workspace (#307).
--   * schema_object_identities    — canonical per-resource object identity so
--                                   impact can reason across projects (#308).
--   * database_connections.databaseResourceId        (NULLABLE, SetNull) — #307
--   * impact_affected_tables.schemaObjectIdentityId   (NULLABLE, SetNull) — #308
--
-- SQLite cannot ADD a column with a FK in place, so Prisma rebuilds the two
-- existing tables (RedefineTables). All existing rows are copied verbatim; the
-- two new columns default to NULL, so every existing reader/writer is
-- unaffected. The Postgres mirror uses plain ALTER TABLE ADD COLUMN.
--
-- BACKFILL (best-effort, idempotent): existing connections whose project has a
-- workspace AND that carry the minimum identity (non-null host AND
-- databaseName) are grouped by (workspaceId, driver, host, port, databaseName)
-- into one resource and linked. Connections in a project with no workspace, or
-- missing host/databaseName, are LEFT UNLINKED — distinct physical DBs stay
-- separate; identical ones collapse to one resource. The resource id is built
-- deterministically from the dedupe key so the bulk insert is collision-free
-- and portable across SQLite + Postgres (no DB-specific uuid function). The
-- canonical grouping/dedupe decision is mirrored by a pure, unit-tested
-- function (resource-key.ts) which is the source of truth at runtime.

-- CreateTable
CREATE TABLE "database_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "database_resources_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "schema_object_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseResourceId" TEXT NOT NULL,
    "schemaName" TEXT,
    "objectName" TEXT NOT NULL,
    "objectType" TEXT NOT NULL DEFAULT 'table',
    "usageClass" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "schema_object_identities_databaseResourceId_fkey" FOREIGN KEY ("databaseResourceId") REFERENCES "database_resources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_database_connections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "username" TEXT,
    "secretId" TEXT,
    "options" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "lastTestedAt" DATETIME,
    "lastIngestAt" DATETIME,
    "createdById" TEXT,
    "databaseResourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "database_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "database_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "database_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "database_connections_databaseResourceId_fkey" FOREIGN KEY ("databaseResourceId") REFERENCES "database_resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_database_connections" ("createdAt", "createdById", "databaseName", "deletedAt", "driver", "errorMessage", "host", "id", "label", "lastIngestAt", "lastTestedAt", "options", "port", "projectId", "secretId", "status", "updatedAt", "username") SELECT "createdAt", "createdById", "databaseName", "deletedAt", "driver", "errorMessage", "host", "id", "label", "lastIngestAt", "lastTestedAt", "options", "port", "projectId", "secretId", "status", "updatedAt", "username" FROM "database_connections";
DROP TABLE "database_connections";
ALTER TABLE "new_database_connections" RENAME TO "database_connections";
CREATE INDEX "database_connections_secretId_idx" ON "database_connections"("secretId");
CREATE INDEX "database_connections_projectId_status_idx" ON "database_connections"("projectId", "status");
CREATE INDEX "database_connections_databaseResourceId_idx" ON "database_connections"("databaseResourceId");
CREATE UNIQUE INDEX "database_connections_projectId_label_key" ON "database_connections"("projectId", "label");
CREATE TABLE "new_impact_affected_tables" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "impactItemId" TEXT NOT NULL,
    "objectKind" TEXT NOT NULL DEFAULT 'table',
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "changeKind" TEXT NOT NULL DEFAULT 'reference',
    "suggestedDdl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'mybatis',
    "reconciliation" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "schemaObjectIdentityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_affected_tables_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "impact_affected_tables_schemaObjectIdentityId_fkey" FOREIGN KEY ("schemaObjectIdentityId") REFERENCES "schema_object_identities" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_impact_affected_tables" ("changeKind", "columnName", "columnType", "confidence", "createdAt", "id", "impactItemId", "objectKind", "reconciliation", "source", "suggestedDdl", "tableName") SELECT "changeKind", "columnName", "columnType", "confidence", "createdAt", "id", "impactItemId", "objectKind", "reconciliation", "source", "suggestedDdl", "tableName" FROM "impact_affected_tables";
DROP TABLE "impact_affected_tables";
ALTER TABLE "new_impact_affected_tables" RENAME TO "impact_affected_tables";
CREATE INDEX "impact_affected_tables_impactItemId_idx" ON "impact_affected_tables"("impactItemId");
CREATE INDEX "impact_affected_tables_schemaObjectIdentityId_idx" ON "impact_affected_tables"("schemaObjectIdentityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "database_resources_workspaceId_idx" ON "database_resources"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "database_resources_workspaceId_driver_host_port_databaseName_key" ON "database_resources"("workspaceId", "driver", "host", "port", "databaseName");

-- CreateIndex
CREATE INDEX "schema_object_identities_databaseResourceId_idx" ON "schema_object_identities"("databaseResourceId");

-- CreateIndex
CREATE UNIQUE INDEX "schema_object_identities_databaseResourceId_schemaName_objectName_objectType_key" ON "schema_object_identities"("databaseResourceId", "schemaName", "objectName", "objectType");

-- Backfill: create one resource per distinct (workspace, driver, host, port,
-- databaseName) among existing live connections that have a workspace AND the
-- minimum identity (host + databaseName). The deterministic id 'dbres:' || key
-- guarantees the same physical DB collapses to one resource and the INSERT is
-- idempotent. Port is coalesced to '' in the id so a NULL port is one bucket.
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
