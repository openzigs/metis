/**
 * Epic #195 — Smithery federated MCP server discovery.
 *
 * Read-only browser over the Smithery API (https://smithery.ai). Smithery's
 * public discovery surface requires no auth, so we can query it from the
 * server without leaking any credentials to the browser. Installation still
 * flows through the existing `MCPRegistryService.create(...)` path so the
 * vault + allowlist + integrity gates from PR #181 always run.
 *
 * Security:
 *   - URL is HARDCODED — no per-request override → no SSRF.
 *   - HTTPS-only, no redirect following.
 *   - Body capped at {@link SMITHERY_MAX_BYTES}.
 *   - SHA-256 of the canonical install manifest is captured at fetch time so
 *     the integrity gate can detect post-fetch tampering.
 */
import { createHash } from "node:crypto";

export const SMITHERY_BASE_URL = "https://registry.smithery.ai";
export const SMITHERY_TIMEOUT_MS = 10_000;
export const SMITHERY_MAX_BYTES = 4 * 1024 * 1024;
export const SMITHERY_PAGE_SIZE_DEFAULT = 25;

export interface SmitheryServer {
  /** Vendor-specific id like `@modelcontextprotocol/server-postgres`. */
  qualifiedName: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  version?: string;
  /** Aggregate stats Smithery surfaces in its catalogue. */
  useCount?: number;
  starCount?: number;
  /** ISO timestamp of the most recent upstream change. */
  lastUpdated?: string;
  /** Tags/categories for filtering. */
  tags?: string[];
  homepage?: string;
  license?: string;
  /** Install manifest (transport + command/args/url). */
  install?: {
    type?: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };
}

export interface SmitherySearchResult {
  /** Total number of matching servers (across all pages). */
  total: number;
  /** Page slice. */
  servers: SmitheryServer[];
  /** Cursor for the next page if one exists. */
  nextCursor?: string;
}

export interface SmitherySearchOptions {
  q?: string;
  page?: number;
  pageSize?: number;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Optional bearer for authenticated quotas (vault-resolved). */
  apiKey?: string;
  /** Override base URL — only honoured in tests. */
  baseUrl?: string;
}

const ALLOW_BASE_URL_OVERRIDE = process.env.NODE_ENV === "test";

function safeBaseUrl(opts: SmitherySearchOptions): string {
  if (ALLOW_BASE_URL_OVERRIDE && opts.baseUrl) return opts.baseUrl.replace(/\/+$/, "");
  return SMITHERY_BASE_URL;
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const parsed =
    typeof n === "number" ? n : typeof n === "string" ? Number.parseInt(n, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * Stable SHA-256 of an install manifest. The hash covers the full canonical
 * shape (`type|command|args|url|env`) so any change — including arg
 * reordering — produces a different fingerprint.
 */
export function manifestSha256(install: SmitheryServer["install"]): string | null {
  if (!install) return null;
  const canonical = JSON.stringify({
    type: install.type ?? "stdio",
    command: install.command ?? null,
    args: install.args ? [...install.args] : [],
    url: install.url ?? null,
    env: install.env
      ? Object.fromEntries(Object.entries(install.env).sort(([a], [b]) => a.localeCompare(b)))
      : {},
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class SmitheryError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SmitheryError";
    this.status = status;
  }
}

/**
 * Search the Smithery registry. Pagination is forwarded to upstream; a
 * `nextCursor` is returned when more pages exist.
 */
export async function searchSmithery(
  opts: SmitherySearchOptions = {},
): Promise<SmitherySearchResult> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new SmitheryError("global fetch not available", 500);
  const page = clampInt(opts.page, 1, 100, 1);
  const pageSize = clampInt(opts.pageSize, 1, 100, SMITHERY_PAGE_SIZE_DEFAULT);
  const params = new URLSearchParams();
  if (opts.q && opts.q.trim()) params.set("q", opts.q.trim());
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  const url = `${safeBaseUrl(opts)}/servers?${params.toString()}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SMITHERY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "metis-mcp-federation/1.0",
    };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await f(url, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      headers,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new SmitheryError(`smithery HTTP ${res.status}`, res.status);
    }
    const reader = res.body?.getReader?.();
    let body: string;
    if (!reader) {
      body = await res.text();
      if (body.length > SMITHERY_MAX_BYTES) {
        throw new SmitheryError("smithery payload exceeds size cap", 413);
      }
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > SMITHERY_MAX_BYTES) {
          throw new SmitheryError("smithery payload exceeds size cap", 413);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      body = new TextDecoder().decode(merged);
    }
    const parsed = JSON.parse(body) as {
      servers?: SmitheryServer[];
      results?: SmitheryServer[];
      total?: number;
      pagination?: { totalCount?: number; nextCursor?: string };
      nextCursor?: string;
    };
    const list = parsed.servers ?? parsed.results ?? [];
    if (!Array.isArray(list)) {
      throw new SmitheryError("smithery returned non-array results", 502);
    }
    return {
      servers: list,
      total: parsed.total ?? parsed.pagination?.totalCount ?? list.length,
      nextCursor: parsed.nextCursor ?? parsed.pagination?.nextCursor,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalise a Smithery server into the federation cache row shape. The
 * `manifest` and `metadata` fields are stored JSON-encoded in the DB.
 */
export function toRegistryEntryRow(server: SmitheryServer): {
  source: "smithery";
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
  const lastUpdated =
    server.lastUpdated && !Number.isNaN(Date.parse(server.lastUpdated))
      ? new Date(server.lastUpdated)
      : null;
  return {
    source: "smithery",
    externalId: server.qualifiedName,
    name: server.displayName ?? server.qualifiedName,
    description: server.description ?? "",
    publisher: server.publisher ?? null,
    version: server.version ?? null,
    downloads: typeof server.useCount === "number" ? server.useCount : null,
    stars: typeof server.starCount === "number" ? server.starCount : null,
    lastUpdated,
    sha256: manifestSha256(server.install),
    manifest: JSON.stringify(server.install ?? {}),
    metadata: JSON.stringify({
      tags: server.tags ?? [],
      homepage: server.homepage ?? null,
      license: server.license ?? null,
    }),
  };
}
