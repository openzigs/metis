/**
 * Epic #195 — Official MCP Registry mirror.
 *
 * Wraps the existing {@link fetchRegistry} payload from
 * `server/src/lib/mcp/registry-client.ts` and projects each entry into the
 * federated cache shape. Because the official registry uses a separate
 * 24h cache table, this module exists to (a) materialise rows in the
 * shared `mcp_registry_entries` table so the UI can browse Smithery and
 * Official side-by-side, and (b) capture a sha256 of each install
 * manifest at fetch time so the integrity gate can detect drift.
 */
import { createHash } from "node:crypto";
import { fetchRegistry } from "../registry-client.js";
import type { MCPRegistryEntry } from "@metis/shared";

export interface OfficialFetchOptions {
  /** Forward to the inner client — used by tests to inject a fetch stub. */
  fetchImpl?: typeof fetch;
  /** Force a fresh upstream fetch, bypassing the 24h cache. */
  forceRefresh?: boolean;
}

export interface OfficialFetchResult {
  fetchedAt: string;
  fromCache: boolean;
  stale: boolean;
  total: number;
  servers: MCPRegistryEntry[];
}

/**
 * Pull every server from the Official MCP Registry. Returns at most 1000
 * rows per call — anything larger violates METIS's payload caps.
 */
export async function fetchOfficialRegistry(
  opts: OfficialFetchOptions = {},
): Promise<OfficialFetchResult> {
  const result = await fetchRegistry({
    page: 1,
    pageSize: 100,
    fetchImpl: opts.fetchImpl,
    forceRefresh: opts.forceRefresh,
  });
  return {
    fetchedAt: result.fetchedAt,
    fromCache: result.fromCache,
    stale: result.stale,
    total: result.total,
    servers: result.servers,
  };
}

function officialManifestSha256(install: MCPRegistryEntry["install"]): string | null {
  if (!install) return null;
  const canonical = JSON.stringify({
    type: install.type ?? "stdio",
    command: install.command ?? null,
    args: install.args ? [...install.args] : [],
    url: install.url ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Project an Official Registry entry into the federated cache row shape.
 */
export function toRegistryEntryRow(entry: MCPRegistryEntry): {
  source: "official";
  externalId: string;
  name: string;
  description: string;
  publisher: string | null;
  version: string | null;
  downloads: number | null;
  stars: number | null;
  lastUpdated: Date | null;
  sha256: string | null;
  manifest: string;
  metadata: string;
} {
  // The Official Registry schema is `passthrough()`, so optional upstream
  // fields like `lastUpdated` come through as untyped properties.
  const extra = entry as unknown as Record<string, unknown>;
  const rawLastUpdated = typeof extra.lastUpdated === "string" ? extra.lastUpdated : null;
  const lastUpdated =
    rawLastUpdated && !Number.isNaN(Date.parse(rawLastUpdated)) ? new Date(rawLastUpdated) : null;
  return {
    source: "official",
    externalId: entry.id,
    name: entry.name,
    description: entry.description ?? "",
    publisher: entry.publisher ?? null,
    version: entry.version ?? null,
    downloads: null,
    stars: null,
    lastUpdated,
    sha256: officialManifestSha256(entry.install),
    manifest: JSON.stringify(entry.install ?? {}),
    metadata: JSON.stringify({
      category: entry.category ?? null,
      homepage: entry.homepage ?? null,
    }),
  };
}
