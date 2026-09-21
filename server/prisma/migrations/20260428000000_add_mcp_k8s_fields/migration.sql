-- Epic #272 — MCP containerisation Phase B: per-server k8s-sse fields.
-- All new columns are nullable / default values that preserve existing rows.
--
-- - egressAllowlist  : null → use global MCP_K8S_EGRESS_ALLOWLIST tunable
-- - k8sMemoryLimit   : null → use global MCP_K8S_MEMORY_LIMIT tunable
-- - k8sCpuLimit      : null → use global MCP_K8S_CPU_LIMIT tunable
-- - coldStart        : false → warm Deployment (legacy behaviour for k8s-sse)
ALTER TABLE "mcp_servers" ADD COLUMN "egressAllowlist" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "k8sMemoryLimit" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "k8sCpuLimit" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "coldStart" BOOLEAN NOT NULL DEFAULT false;
