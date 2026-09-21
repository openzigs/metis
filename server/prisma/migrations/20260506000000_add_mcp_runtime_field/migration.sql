-- Epic #271 / Issue #279 — MCP containerisation Phase A: runtime field.
-- Adds a string `runtime` column to `mcp_servers`. Existing rows default to
-- 'native' so the legacy spawn() path is preserved unchanged.
--
-- Accepted values at the application layer:
--   - 'native'        — spawn() the configured command directly (today's behaviour)
--   - 'docker-stdio'  — wrap into `docker run -i --rm <image> <args>` (#280)
--   - 'k8s-sse'       — Phase B (#272), reserved for forward-compat
ALTER TABLE "mcp_servers" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'native';
