/**
 * Epic #195 — Federated MCP registry cache.
 *
 * Reads + writes the `mcp_registry_entries` table that backs both the
 * Smithery and Official Registry mirrors. Two responsibilities:
 *
 *   1. **Refresh** — pull fresh discovery payloads from each enabled
 *      source and upsert into the shared cache. Designed to be invoked
 *      from a scheduler tick (TTL-driven) or on-demand from the Federated
 *      tab in the MCP settings UI.
 *
 *   2. **Search** — list entries matching a query, optionally scoped to a
 *      single source, with a per-source dedupe so an entry that exists in
 *      both Smithery and the Official Registry only appears once (the
 *      Official Registry wins because it's the canonical source).
 *
 * The cache rows are READ-ONLY. Installation creates a normal `MCPServer`
 * row by calling `MCPRegistryService.create(...)` with the manifest from
 * the entry — the existing PR #181 governance gates run from there.
 */
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import {
  searchSmithery,
  toRegistryEntryRow as smitheryRow,
  type SmitherySearchOptions,
} from "./smithery.js";
import {
  fetchOfficialRegistry,
  toRegistryEntryRow as officialRow,
  type OfficialFetchOptions,
} from "./official-registry.js";

const log = createChildLogger("mcp-federation-cache");

export const FEDERATION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type FederationSource = "smithery" | "official" | "local";

export interface FederationEntry {
  id: string;
  source: FederationSource;
  externalId: string;
  name: string;
  description: string;
  publisher: string | null;
  version: string | null;
  downloads: number | null;
  stars: number | null;
  lastUpdated: string | null;
  sha256: string | null;
  manifest: Record<string, unknown>;
  metadata: Record<string, unknown>;
  fetchedAt: string;
}

export interface RefreshResult {
  source: FederationSource;
  fetched: number;
  upserted: number;
  errors: string[];
}

export interface FederationSearchOptions {
  q?: string;
  source?: FederationSource;
  page?: number;
  pageSize?: number;
}

export interface FederationSearchResult {
  total: number;
  entries: FederationEntry[];
}

interface CacheRow {
  id: string;
  source: string;
  externalId: string;
  name: string;
  description: string | null;
  publisher: string | null;
  version: string | null;
  downloads: number | null;
  stars: number | null;
  lastUpdated: Date | null;
  sha256: string | null;
  manifest: string;
  metadata: string;
  fetchedAt: Date;
}

function rowToEntry(row: CacheRow): FederationEntry {
  let manifest: Record<string, unknown> = {};
  let metadata: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(row.manifest) as Record<string, unknown>;
  } catch {
    /* corrupt — surface empty so the UI doesn't break */
  }
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    /* corrupt — surface empty so the UI doesn't break */
  }
  return {
    id: row.id,
    source: row.source as FederationSource,
    externalId: row.externalId,
    name: row.name,
    description: row.description ?? "",
    publisher: row.publisher,
    version: row.version,
    downloads: row.downloads,
    stars: row.stars,
    lastUpdated: row.lastUpdated ? row.lastUpdated.toISOString() : null,
    sha256: row.sha256,
    manifest,
    metadata,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

/**
 * Refresh a single source. Errors are captured per-entry — a single bad
 * row never aborts the whole refresh.
 */
export async function refreshSource(
  source: FederationSource,
  opts: { smithery?: SmitherySearchOptions; official?: OfficialFetchOptions } = {},
): Promise<RefreshResult> {
  if (source === "local") {
    // Local installs are mirrored back when an admin promotes a federated
    // entry — there is nothing to fetch from the network.
    return { source, fetched: 0, upserted: 0, errors: [] };
  }
  const errors: string[] = [];
  let fetched = 0;
  let upserted = 0;
  try {
    if (source === "smithery") {
      const r = await searchSmithery({ pageSize: 100, ...(opts.smithery ?? {}) });
      fetched = r.servers.length;
      for (const server of r.servers) {
        try {
          const row = smitheryRow(server);
          await upsertEntry(row);
          upserted += 1;
        } catch (err) {
          errors.push(`${server.qualifiedName}: ${(err as Error).message}`);
        }
      }
    } else {
      const r = await fetchOfficialRegistry(opts.official ?? {});
      fetched = r.servers.length;
      for (const entry of r.servers) {
        try {
          const row = officialRow(entry);
          await upsertEntry(row);
          upserted += 1;
        } catch (err) {
          errors.push(`${entry.id}: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    errors.push(`${source}: ${(err as Error).message}`);
    log.warn("MCP federation refresh failed", {
      source,
      error: (err as Error).message,
    });
  }
  return { source, fetched, upserted, errors };
}

/**
 * Refresh every enabled source. Used by the periodic scheduler tick.
 */
export async function refreshAll(): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  for (const src of ["smithery", "official"] as const) {
    results.push(await refreshSource(src));
  }
  return results;
}

interface UpsertRow {
  source: FederationSource;
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
}

async function upsertEntry(row: UpsertRow): Promise<void> {
  const data = {
    name: row.name,
    description: row.description,
    publisher: row.publisher,
    version: row.version,
    downloads: row.downloads,
    stars: row.stars,
    lastUpdated: row.lastUpdated,
    sha256: row.sha256,
    manifest: row.manifest,
    metadata: row.metadata,
    fetchedAt: new Date(),
  };
  await prisma.mcpRegistryEntry.upsert({
    where: { source_externalId: { source: row.source, externalId: row.externalId } },
    create: { source: row.source, externalId: row.externalId, ...data },
    update: data,
  });
}

/**
 * Search the federated cache. Results are deduped across sources by
 * canonical `externalId` — Official Registry entries take precedence over
 * Smithery so the UI doesn't show the same `@modelcontextprotocol/server-X`
 * twice.
 */
export async function searchFederated(
  opts: FederationSearchOptions = {},
): Promise<FederationSearchResult> {
  const where: Record<string, unknown> = {};
  if (opts.source) where.source = opts.source;
  const needle = opts.q?.trim().toLowerCase();
  // Per-source ordering: official > smithery > local. We pull all matching
  // rows, dedupe in-memory, then page. Federation is an admin surface so
  // result counts are bounded (low hundreds) — the simplicity is worth more
  // than the marginal DB optimisation.
  const rows = (await prisma.mcpRegistryEntry.findMany({
    where,
    orderBy: [{ source: "asc" }, { name: "asc" }],
    take: 1000,
  })) as unknown as CacheRow[];
  const filtered = needle
    ? rows.filter((r) => {
        const hay = `${r.name} ${r.description ?? ""} ${r.publisher ?? ""}`.toLowerCase();
        return hay.includes(needle);
      })
    : rows;
  // Dedup: prefer official > smithery > local for the same externalId.
  const sourceRank: Record<string, number> = { official: 3, smithery: 2, local: 1 };
  const winners = new Map<string, CacheRow>();
  for (const r of filtered) {
    const existing = winners.get(r.externalId);
    if (!existing || (sourceRank[r.source] ?? 0) > (sourceRank[existing.source] ?? 0)) {
      winners.set(r.externalId, r);
    }
  }
  const deduped = [...winners.values()];
  const pageSize = clampInt(opts.pageSize, 1, 100, 25);
  const page = clampInt(opts.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const start = (page - 1) * pageSize;
  return {
    total: deduped.length,
    entries: deduped.slice(start, start + pageSize).map(rowToEntry),
  };
}

/**
 * Get a single entry by id — used by the install endpoint to pull the
 * cached manifest before handing off to `MCPRegistryService.create`.
 */
export async function getEntryById(id: string): Promise<FederationEntry | null> {
  const row = (await prisma.mcpRegistryEntry.findUnique({
    where: { id },
  })) as unknown as CacheRow | null;
  return row ? rowToEntry(row) : null;
}

/**
 * Materialise a "local" mirror row when an admin successfully installs a
 * federated entry. The mirror is what powers cross-source dedup — once
 * installed, the same server stops surfacing as an installable foreign
 * entry on subsequent searches.
 */
export async function recordLocalInstall(args: {
  externalId: string;
  name: string;
  manifest: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.mcpRegistryEntry.upsert({
    where: { source_externalId: { source: "local", externalId: args.externalId } },
    create: {
      source: "local",
      externalId: args.externalId,
      name: args.name,
      description: "",
      manifest: JSON.stringify(args.manifest ?? {}),
      metadata: JSON.stringify(args.metadata ?? {}),
      fetchedAt: new Date(),
    },
    update: {
      name: args.name,
      manifest: JSON.stringify(args.manifest ?? {}),
      metadata: JSON.stringify(args.metadata ?? {}),
      fetchedAt: new Date(),
    },
  });
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const parsed =
    typeof n === "number" ? n : typeof n === "string" ? Number.parseInt(n, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
