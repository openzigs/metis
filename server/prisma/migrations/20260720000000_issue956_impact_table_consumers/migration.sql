-- Issue #956 (Epic #954) — surface cross-project shared-table CONSUMERS in
-- impact-analysis results.
--
-- 1. `impact_affected_tables.consumerResolution` records HOW the physical
--    table's cross-project consumer set was resolved: identity | string-match |
--    unverifiable. NULLABLE — null ⇒ consumers were not computed (single-
--    project / no-workspace context) and the row reads exactly as before.
-- 2. `impact_affected_table_consumers` holds ONE row per sibling project that
--    reads/writes the shared table, with read/write attribution. Read-only
--    provenance derived from METIS's own usage classifications — never by
--    touching a customer database.
ALTER TABLE "impact_affected_tables" ADD COLUMN "consumerResolution" TEXT;

CREATE TABLE "impact_affected_table_consumers" (
    "id" TEXT NOT NULL,
    "affectedTableId" TEXT NOT NULL,
    "consumerProjectId" TEXT NOT NULL,
    "consumerProjectName" TEXT NOT NULL,
    "usage" TEXT NOT NULL DEFAULT 'readBy',
    "objectQualifiedName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_affected_table_consumers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "impact_affected_table_consumers_affectedTableId_fkey" FOREIGN KEY ("affectedTableId") REFERENCES "impact_affected_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "impact_affected_table_consumers_affectedTableId_idx" ON "impact_affected_table_consumers"("affectedTableId");
