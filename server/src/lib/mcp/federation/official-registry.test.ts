/**
 * Epic #195 / Issue #217 — Official MCP Registry mirror tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {
    mCPRegistryCache: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => null),
    },
  },
}));

import { fetchOfficialRegistry, toRegistryEntryRow } from "./official-registry.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

describe("federation/official-registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the upstream payload and projects servers", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        servers: [
          {
            id: "srv-1",
            name: "Postgres",
            description: "MCP server for Postgres",
            publisher: "modelcontextprotocol",
            version: "1.0.0",
            install: { type: "stdio", command: "npx", args: ["-y", "@mcp/pg"] },
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const result = await fetchOfficialRegistry({ fetchImpl, forceRefresh: true });
    expect(result.total).toBe(1);
    expect(result.servers[0].id).toBe("srv-1");
  });

  it("toRegistryEntryRow captures sha256 + projects core fields", () => {
    const row = toRegistryEntryRow({
      id: "srv-1",
      name: "Postgres",
      description: "desc",
      publisher: "mcp",
      version: "1.2.3",
      install: { type: "stdio", command: "npx", args: ["-y", "@mcp/pg"] },
    });
    expect(row.source).toBe("official");
    expect(row.externalId).toBe("srv-1");
    expect(row.publisher).toBe("mcp");
    expect(row.version).toBe("1.2.3");
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.lastUpdated).toBeNull();
  });

  it("parses lastUpdated when upstream provides one (passthrough field)", () => {
    const row = toRegistryEntryRow({
      id: "srv-2",
      name: "X",
      lastUpdated: "2026-04-01T00:00:00Z",
    } as unknown as Parameters<typeof toRegistryEntryRow>[0]);
    expect(row.lastUpdated).toBeInstanceOf(Date);
  });

  it("ignores invalid lastUpdated strings", () => {
    const row = toRegistryEntryRow({
      id: "srv-3",
      name: "X",
      lastUpdated: "not-a-date",
    } as unknown as Parameters<typeof toRegistryEntryRow>[0]);
    expect(row.lastUpdated).toBeNull();
  });

  it("returns null sha256 for entries without an install manifest", () => {
    const row = toRegistryEntryRow({ id: "srv-4", name: "X" });
    expect(row.sha256).toBeNull();
    expect(row.manifest).toBe("{}");
  });

  it("metadata contains category + homepage when present", () => {
    const row = toRegistryEntryRow({
      id: "srv-5",
      name: "X",
      category: "db",
      homepage: "https://example.com",
    });
    const meta = JSON.parse(row.metadata) as { category: string; homepage: string };
    expect(meta.category).toBe("db");
    expect(meta.homepage).toBe("https://example.com");
  });

  it("propagates upstream errors", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({}, 500)) as unknown as typeof fetch;
    await expect(fetchOfficialRegistry({ fetchImpl, forceRefresh: true })).rejects.toThrow();
  });
});
