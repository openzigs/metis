-- Issue #480 — an MCP server's vault references are bound to secret ids
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale. `IF NOT EXISTS` keeps the full chain idempotent (issue #556).
--
-- Rollback (documentation): `ALTER TABLE "mcp_servers" DROP COLUMN "secretBindings";`
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "secretBindings" TEXT;
