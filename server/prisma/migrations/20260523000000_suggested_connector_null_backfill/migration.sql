-- Epic #701 / Issue #704 — PR #707 review backfill.
--
-- The upsert lookup in connection-discovery.ts coerces undefined host /
-- port / database to ''/0 so it can hit the
-- (projectId, driverType, host, port, database) unique index. SQLite (and
-- Postgres) treat NULL as distinct in unique constraints, so any
-- SuggestedConnector rows that were created before commit 20260517000000
-- with NULL host / port / database would never match the upsert lookup
-- and the next re-ingest would silently insert a duplicate row next to
-- the legacy one.
--
-- Backfill those legacy NULLs to the same canonical sentinels the
-- application uses ('' / 0) so the upsert is idempotent.

UPDATE "suggested_connectors"
  SET "host"     = COALESCE("host", ''),
      "port"     = COALESCE("port", 0),
      "database" = COALESCE("database", '')
WHERE "host" IS NULL
   OR "port" IS NULL
   OR "database" IS NULL;
