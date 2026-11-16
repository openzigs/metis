-- Issue #2593 — whether an impact run read each project's database.
--
-- "impact_analysis_projects"."databaseConnected" (BOOLEAN, nullable): true when
-- the run read the project's database schema through a database connector,
-- false when it did not (no connector, or it could not be read). The result
-- page then says "Database impact not checked (no database connection)" where a
-- requirement lists no table, instead of leaving "no tables" to read as "no
-- database change". NULL for a project the run did not search, and on every
-- existing row: such a run reads exactly as before.
--
-- Rollback: server/prisma/rollbacks/20261203002593_issue2593_impact_database_connected.sql
-- (exercised by server/tests/impact-database-connected-2593.sqlite.test.ts).

-- AlterTable
ALTER TABLE "impact_analysis_projects" ADD COLUMN "databaseConnected" BOOLEAN;
