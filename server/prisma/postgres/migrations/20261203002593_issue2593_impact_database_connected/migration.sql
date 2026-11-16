-- Issue #2593 — whether an impact run read each project's database.
--
-- "impact_analysis_projects"."databaseConnected" (BOOLEAN, nullable): true when
-- the run read the project's database schema through a database connector,
-- false when it did not (no connector, or it could not be read). NULL for a
-- project the run did not search, and on every existing row.
--
-- Rollback: server/prisma/postgres/rollbacks/20261203002593_issue2593_impact_database_connected.sql
-- (applied and re-applied over a seeded run by the postgres-migrate-deploy CI job).

ALTER TABLE "impact_analysis_projects" ADD COLUMN IF NOT EXISTS "databaseConnected" BOOLEAN;
