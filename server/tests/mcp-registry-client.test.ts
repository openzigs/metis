/**
 * Issue #98 — MCP registry client (cache + stale-on-error).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cacheRows = new Map<string, { fetchedAt: Date; payload: string }>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    mCPRegistryCache: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = cacheRows.get(where.id);
        return row ? { id: where.id, ...row } : null;
      }),
      upsert: vi.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: { id: string };
          update: { fetchedAt: Date; payload: string };
          create: { id: string; fetchedAt: Date; payload: string };
        }) => {
          cacheRows.set(where.id, cacheRows.has(where.id) ? update : create);
          return { id: where.id, ...(cacheRows.get(where.id) as object) };
        },
      ),
    },
  },
}));

import {
  fetchRegistry,
  filterRegistry,
  normalizeRegistryPayload,
  REGISTRY_TTL_MS,
  REGISTRY_URL,
} from "../src/lib/mcp/registry-client.js";

const samplePayload = {
  servers: [
    { id: "s1", name: "github-mcp", description: "GitHub server", category: "vcs" },
    { id: "s2", name: "fs-mcp", description: "Filesystem", category: "io" },
    { id: "s3", name: "search-mcp", description: "Web search", category: "io" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  cacheRows.clear();
});

describe("filterRegistry", () => {
  it("filters by query (case-insensitive) across name+description+publisher", () => {
    const out = filterRegistry(samplePayload.servers, { q: "search" });
    expect(out.total).toBe(1);
    expect(out.page[0].id).toBe("s3");
  });
  it("filters by category", () => {
    const out = filterRegistry(samplePayload.servers, { category: "io" });
    expect(out.total).toBe(2);
    expect(out.page.map((s) => s.id).sort()).toEqual(["s2", "s3"]);
  });
  it("paginates", () => {
    const out = filterRegistry(samplePayload.servers, { pageSize: 2, page: 2 });
    expect(out.total).toBe(3);
    expect(out.page).toHaveLength(1);
  });
});

describe("fetchRegistry", () => {
  it("hits the network on cold cache and persists the payload", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(REGISTRY_URL);
      return jsonResponse(samplePayload);
    }) as unknown as typeof fetch;

    const result = await fetchRegistry({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.servers).toHaveLength(3);
    expect(cacheRows.has("singleton")).toBe(true);
  });

  it("returns cached payload when within TTL without re-fetching", async () => {
    const now = Date.now();
    cacheRows.set("singleton", {
      fetchedAt: new Date(now - 1000),
      payload: JSON.stringify(samplePayload),
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ servers: [] })) as unknown as typeof fetch;

    const result = await fetchRegistry({ fetchImpl, now: () => now });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.servers).toHaveLength(3);
  });

  it("re-fetches when the cache is older than TTL", async () => {
    const now = Date.now();
    cacheRows.set("singleton", {
      fetchedAt: new Date(now - REGISTRY_TTL_MS - 1),
      payload: JSON.stringify({ servers: [{ id: "old", name: "old" }] }),
    });
    const fetchImpl = vi.fn(async () => jsonResponse(samplePayload)) as unknown as typeof fetch;

    const result = await fetchRegistry({ fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.servers.map((s) => s.id)).toContain("s1");
  });

  it("falls back to stale cache when the upstream fetch fails", async () => {
    const now = Date.now();
    cacheRows.set("singleton", {
      fetchedAt: new Date(now - REGISTRY_TTL_MS - 1),
      payload: JSON.stringify(samplePayload),
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const result = await fetchRegistry({ fetchImpl, now: () => now });
    expect(result.stale).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.servers).toHaveLength(3);
  });

  it("rejects non-2xx responses with a clear message", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(fetchRegistry({ fetchImpl })).rejects.toThrow(/registry HTTP 503/);
  });

  it("can return an empty offline result on cold-cache upstream failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("This operation was aborted");
    }) as unknown as typeof fetch;

    const result = await fetchRegistry({ fetchImpl, allowEmptyOnError: true });
    expect(result.offline).toBe(true);
    expect(result.fromCache).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.total).toBe(0);
    expect(result.servers).toEqual([]);
    expect(result.error).toMatch(/aborted/);
  });

  it("rejects non-JSON payloads", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    await expect(fetchRegistry({ fetchImpl })).rejects.toThrow(/not valid JSON/);
  });

  it("normalizes the current official registry envelope", () => {
    const result = normalizeRegistryPayload({
      servers: [
        {
          server: {
            name: "ac.inference.sh/mcp",
            title: "inference.sh",
            description: "Run AI apps",
            version: "1.0.1",
            repository: { url: "https://github.com/example/mcp" },
            remotes: [{ type: "streamable-http", url: "https://api.inference.sh/mcp" }],
          },
          _meta: {
            "io.modelcontextprotocol.registry/official": {
              updatedAt: "2026-04-13T17:33:26.613537Z",
            },
          },
        },
      ],
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({
      id: "ac.inference.sh/mcp@1.0.1",
      name: "inference.sh",
      publisher: "ac.inference.sh",
      repository: "https://github.com/example/mcp",
      install: { type: "http", url: "https://api.inference.sh/mcp" },
    });
  });

  it("skips malformed registry entries instead of surfacing raw validation arrays", () => {
    const result = normalizeRegistryPayload({
      servers: [{ server: { description: "missing name" } }],
    });
    expect(result.servers).toEqual([]);
  });

  it("forwards q + page to filterRegistry", async () => {
    cacheRows.set("singleton", {
      fetchedAt: new Date(),
      payload: JSON.stringify(samplePayload),
    });
    const result = await fetchRegistry({ q: "fs" });
    expect(result.total).toBe(1);
    expect(result.servers[0].id).toBe("s2");
  });
});
