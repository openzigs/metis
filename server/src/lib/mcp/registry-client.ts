/**
 * Issue #98 — MCP Registry browser.
 *
 * Fetches the public registry payload from
 * `https://registry.modelcontextprotocol.io/v0/servers` with a 24h cache
 * persisted to the `MCPRegistryCache` table. Stale-on-error: if the upstream
 * fetch fails (network, non-2xx, parse error) and we have a cached payload —
 * even an expired one — we return the cache with `stale: true` so the UI can
 * surface a banner without breaking.
 *
 * Security:
 *   - URL is HARDCODED (no per-request override) — eliminates SSRF surface.
 *   - HTTPS-only.
 *   - No redirect following (`redirect: "manual"`).
 *   - Body length is capped (REGISTRY_MAX_BYTES) so a hostile / compromised
 *     mirror cannot exhaust memory.
 */
import { mcpRegistryEntrySchema, type MCPRegistryEntry, type MCPRegistryList } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("mcp-registry-client");

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const REGISTRY_MAX_BYTES = 4 * 1024 * 1024; // 4MB
export const REGISTRY_TIMEOUT_MS = 10_000;

export interface RegistryFetchOptions {
  /**
   * Page query. The upstream paginates via opaque cursors but we forward the
   * search/category client-side once cached — keeps the cache cohesive.
   */
  q?: string;
  category?: string;
  page?: number;
  pageSize?: number;
  /**
   * Override the underlying `fetch`. Tests inject a stub here so the
   * production codepath is never gated on `vi.mock`.
   */
  fetchImpl?: typeof fetch;
  /** Treat the cache as fresh regardless of age — used by tests + cron refresh. */
  forceCacheOnly?: boolean;
  /** Treat the cache as expired and force a network fetch. */
  forceRefresh?: boolean;
  /** Return an empty offline result instead of throwing when cold-cache fetch fails. */
  allowEmptyOnError?: boolean;
  now?: () => number;
}

export interface RegistryFetchResult {
  fetchedAt: string;
  /** True when the cached payload was returned because the upstream fetch failed. */
  stale: boolean;
  /** True when the result was served entirely from the in-DB cache (fresh or stale). */
  fromCache: boolean;
  /** True when no cache was available and the upstream registry could not be reached. */
  offline?: boolean;
  /** Redacted upstream failure message for operators/UI copy. */
  error?: string;
  total: number;
  servers: MCPRegistryEntry[];
}

interface CacheRow {
  fetchedAt: Date;
  payload: string;
}

/**
 * Top-level fetch — returns servers filtered by `q`/`category` + paginated by
 * `page`/`pageSize`. The TTL gate is applied to the underlying registry, NOT
 * to the filtered/paginated view, so a single fetch satisfies many UI calls.
 */
export async function fetchRegistry(opts: RegistryFetchOptions = {}): Promise<RegistryFetchResult> {
  const now = opts.now ? opts.now() : Date.now();
  const cache = await readCache();
  const fresh = cache && now - cache.fetchedAt.getTime() < REGISTRY_TTL_MS;
  let payload: MCPRegistryList | null = null;
  let stale = false;
  let fromCache = false;
  let fetchedAt = new Date(now);

  if (cache && (fresh || opts.forceCacheOnly) && !opts.forceRefresh) {
    payload = parseCached(cache.payload);
    fromCache = true;
    fetchedAt = cache.fetchedAt;
  } else {
    try {
      payload = await fetchUpstream(opts.fetchImpl);
      await writeCache(payload, fetchedAt);
    } catch (err) {
      log.warn("MCP registry fetch failed; falling back to cache", {
        error: (err as Error).message,
      });
      if (cache) {
        payload = parseCached(cache.payload);
        stale = true;
        fromCache = true;
        fetchedAt = cache.fetchedAt;
      } else if (opts.allowEmptyOnError) {
        return {
          fetchedAt: fetchedAt.toISOString(),
          stale: false,
          fromCache: false,
          offline: true,
          error: safeRegistryErrorMessage(err),
          total: 0,
          servers: [],
        };
      } else {
        throw err;
      }
    }
  }
  if (!payload) {
    throw new Error("MCP registry returned no payload");
  }
  const filtered = filterRegistry(payload.servers, opts);
  return {
    fetchedAt: fetchedAt.toISOString(),
    stale,
    fromCache,
    total: filtered.total,
    servers: filtered.page,
  };
}

export function filterRegistry(
  servers: MCPRegistryEntry[],
  opts: { q?: string; category?: string; page?: number; pageSize?: number },
): { total: number; page: MCPRegistryEntry[] } {
  const needle = opts.q?.toLowerCase().trim();
  const cat = opts.category?.toLowerCase().trim();
  const filtered = servers.filter((s) => {
    if (cat && (s.category ?? "").toLowerCase() !== cat) return false;
    if (!needle) return true;
    const hay = `${s.name} ${s.description ?? ""} ${s.publisher ?? ""}`.toLowerCase();
    return hay.includes(needle);
  });
  const pageSize = clampInt(opts.pageSize ?? 25, 1, 100);
  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * pageSize;
  return { total: filtered.length, page: filtered.slice(start, start + pageSize) };
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function fetchUpstream(fetchImpl?: typeof fetch): Promise<MCPRegistryList> {
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("global fetch not available");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REGISTRY_TIMEOUT_MS);
  let body: string;
  try {
    const res = await f(REGISTRY_URL, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "metis-mcp-registry/1.0" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`registry HTTP ${res.status}`);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      body = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > REGISTRY_MAX_BYTES) {
          throw new Error("registry payload exceeds size cap");
        }
        chunks.push(value);
      }
      body = new TextDecoder().decode(concat(chunks));
    }
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("registry payload is not valid JSON");
  }
  return normalizeRegistryPayload(parsed);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function parseCached(json: string): MCPRegistryList {
  try {
    return normalizeRegistryPayload(JSON.parse(json));
  } catch {
    log.warn("Cached MCP registry payload is corrupt — returning empty list");
    return { servers: [] };
  }
}

export function normalizeRegistryPayload(payload: unknown): MCPRegistryList {
  const source = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.servers)
      ? payload.servers
      : [];
  const servers = source.flatMap((raw) => {
    const entry = normalizeRegistryEntry(raw);
    if (!entry) return [];
    const parsed = mcpRegistryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      log.debug("Skipping malformed MCP registry entry", { error: parsed.error.message });
      return [];
    }
    return [parsed.data];
  });
  return { servers };
}

function normalizeRegistryEntry(raw: unknown): MCPRegistryEntry | null {
  if (!isRecord(raw)) return null;
  const nested = isRecord(raw.server) ? raw.server : raw;
  const officialMeta = isRecord(raw._meta)
    ? raw._meta["io.modelcontextprotocol.registry/official"]
    : null;
  const meta = isRecord(officialMeta) ? officialMeta : null;

  const canonicalName = firstString(nested.name, raw.name, nested.id, raw.id);
  const version = firstString(nested.version, raw.version);
  const id =
    firstString(raw.id, nested.id) ??
    (canonicalName ? stableRegistryId(canonicalName, version) : null);
  if (!id || !canonicalName) return null;

  const install = normalizeInstall(nested);
  const repository = normalizeUrl(nested.repository);

  return {
    id,
    name: firstString(nested.title, canonicalName) ?? canonicalName,
    description: firstString(nested.description, raw.description),
    version,
    publisher: firstString(nested.publisher, raw.publisher) ?? publisherFromName(canonicalName),
    category: firstString(nested.category, raw.category),
    homepage: normalizeUrl(nested.homepage),
    repository,
    install,
    lastUpdated: firstString(
      nested.lastUpdated,
      raw.lastUpdated,
      meta?.updatedAt,
      meta?.publishedAt,
    ),
  } as MCPRegistryEntry;
}

function normalizeInstall(entry: Record<string, unknown>): MCPRegistryEntry["install"] {
  if (isRecord(entry.install)) {
    const direct = toInstall(entry.install);
    if (direct) return direct;
  }
  const remotes = Array.isArray(entry.remotes) ? entry.remotes : [];
  for (const remote of remotes) {
    if (!isRecord(remote)) continue;
    const url = firstString(remote.url);
    if (!url) continue;
    const type = firstString(remote.type);
    return { type: type === "sse" ? "sse" : "http", url };
  }
  const packages = Array.isArray(entry.packages) ? entry.packages : [];
  for (const pkg of packages) {
    if (!isRecord(pkg)) continue;
    const install = installFromPackage(pkg);
    if (install) return install;
  }
  return undefined;
}

function toInstall(raw: Record<string, unknown>): MCPRegistryEntry["install"] | undefined {
  const type = firstString(raw.type);
  const command = firstString(raw.command);
  const args = Array.isArray(raw.args)
    ? raw.args.filter((arg): arg is string => typeof arg === "string")
    : undefined;
  const url = firstString(raw.url);
  const transport = type === "http" || type === "sse" || type === "stdio" ? type : undefined;
  if (!command && !url) return undefined;
  return { type: transport, command, args, url };
}

function installFromPackage(pkg: Record<string, unknown>): MCPRegistryEntry["install"] | undefined {
  const name = firstString(pkg.name, pkg.packageName);
  if (!name) return undefined;
  const runtime = firstString(pkg.runtime_hint, pkg.runtime, pkg.registry_name);
  const command = runtime === "uv" || runtime === "uvx" || runtime === "pypi" ? "uvx" : "npx";
  const args = [name];
  const packageArgs = Array.isArray(pkg.package_arguments) ? pkg.package_arguments : [];
  for (const arg of packageArgs) {
    if (typeof arg === "string") args.push(arg);
  }
  return { type: "stdio", command, args };
}

function safeRegistryErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_type|invalid_union|Required|ZodError|\[\s*\{/.test(message)) {
    return "Registry response format is currently unsupported";
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function stableRegistryId(name: string, version?: string): string {
  return version ? `${name}@${version}` : name;
}

function publisherFromName(name: string): string | undefined {
  const slash = name.indexOf("/");
  if (slash <= 0) return undefined;
  return name.slice(0, slash);
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return firstString(value.url);
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readCache(): Promise<CacheRow | null> {
  const row = await prisma.mCPRegistryCache.findUnique({ where: { id: "singleton" } });
  return row ? { fetchedAt: row.fetchedAt, payload: row.payload as unknown as string } : null;
}

async function writeCache(payload: MCPRegistryList, fetchedAt: Date): Promise<void> {
  const data = JSON.stringify(payload);
  await prisma.mCPRegistryCache.upsert({
    where: { id: "singleton" },
    update: { fetchedAt, payload: data },
    create: { id: "singleton", fetchedAt, payload: data },
  });
}
