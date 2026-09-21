-- Epic #701 / Issue #704 — PR #707 review backfill (PostgreSQL).
--
-- Mirrors the SQLite migration. Postgres unique constraints treat NULLs
-- as distinct, so pre-existing SuggestedConnector rows with NULL
-- host / port / database would never match the upsert lookup which now
-- normalises those columns to ''/0. Backfill brings legacy rows in line
-- with the canonical sentinels so re-ingest is idempotent.

UPDATE "suggested_connectors"
  SET "host"     = COALESCE("host", ''),
      "port"     = COALESCE("port", 0),
      "database" = COALESCE("database", '')
WHERE "host" IS NULL
   OR "port" IS NULL
   OR "database" IS NULL;
