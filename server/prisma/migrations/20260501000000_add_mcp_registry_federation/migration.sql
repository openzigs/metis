-- Epic #195 — MCP federation registry cache (Smithery + Official Registry mirror).

CREATE TABLE "mcp_registry_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "publisher" TEXT,
    "version" TEXT,
    "downloads" INTEGER,
    "stars" INTEGER,
    "lastUpdated" DATETIME,
    "sha256" TEXT,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "mcp_registry_entries_source_externalId_key"
  ON "mcp_registry_entries"("source", "externalId");
CREATE INDEX "mcp_registry_entries_source_idx" ON "mcp_registry_entries"("source");
CREATE INDEX "mcp_registry_entries_fetchedAt_idx" ON "mcp_registry_entries"("fetchedAt");
