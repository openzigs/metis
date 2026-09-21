-- Epic #270 / Issue #277 — MCP scope hardening: optional user scope.
-- Adds a nullable `userId` foreign key column and `lastToolInvocationAt`
-- timestamp on `mcp_servers`. The `scope` column itself stays a string
-- (SQLite has no enum type) — accepted values widen from `global|project`
-- to `global|project|user` at the application layer.

-- SQLite cannot ALTER TABLE add NOT NULL columns without defaults, but
-- both new columns are nullable so plain ALTERs are fine.
ALTER TABLE "mcp_servers" ADD COLUMN "userId" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "lastToolInvocationAt" DATETIME;

-- Index supports the per-user concurrency cap query
-- `SELECT count(*) FROM mcp_servers WHERE userId = ? AND scope='user' AND enabled=1 AND deletedAt IS NULL`.
CREATE INDEX "mcp_servers_userId_idx" ON "mcp_servers"("userId");
