/**
 * Epic #195 / Issue #215 — Smithery federated discovery client tests.
 */
import { describe, expect, it, vi } from "vitest";
import { manifestSha256, searchSmithery, SmitheryError, toRegistryEntryRow } from "./smithery.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

describe("federation/smithery", () => {
  it("forwards `q`, `page`, and `pageSize` as query params", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ servers: [], total: 0 }),
    ) as unknown as typeof fetch;
    await searchSmithery({ q: "postgres", page: 2, pageSize: 5, fetchImpl });
    const calledUrl = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0],
    );
    expect(calledUrl).toContain("q=postgres");
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("pageSize=5");
  });

  it("clamps oversized pageSize to 100", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ servers: [], total: 0 }),
    ) as unknown as typeof fetch;
    await searchSmithery({ pageSize: 9999, fetchImpl });
    const calledUrl = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0],
    );
    expect(calledUrl).toContain("pageSize=100");
  });

  it("returns servers + total for both `servers` and `results` payload shapes", async () => {
    const fetchA = vi.fn(async () =>
      mockResponse({
        servers: [{ qualifiedName: "@x/y", displayName: "Y" }],
        total: 1,
      }),
    ) as unknown as typeof fetch;
    const a = await searchSmithery({ fetchImpl: fetchA });
    expect(a.servers).toHaveLength(1);
    expect(a.total).toBe(1);

    const fetchB = vi.fn(async () =>
      mockResponse({
        results: [{ qualifiedName: "@a/b" }],
        pagination: { totalCount: 1, nextCursor: "n" },
      }),
    ) as unknown as typeof fetch;
    const b = await searchSmithery({ fetchImpl: fetchB });
    expect(b.servers).toHaveLength(1);
    expect(b.total).toBe(1);
    expect(b.nextCursor).toBe("n");
  });

  it("forwards a bearer token when an apiKey is provided", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ servers: [] })) as unknown as typeof fetch;
    await searchSmithery({ apiKey: "sk-abc", fetchImpl });
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as
      | RequestInit
      | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer sk-abc");
  });

  it("throws SmitheryError with status on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({}, 502)) as unknown as typeof fetch;
    await expect(searchSmithery({ fetchImpl })).rejects.toMatchObject({
      name: "SmitheryError",
      status: 502,
    });
  });

  it("throws when the payload is not array-shaped", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ servers: "nope" }),
    ) as unknown as typeof fetch;
    await expect(searchSmithery({ fetchImpl })).rejects.toBeInstanceOf(SmitheryError);
  });

  it("throws when no fetch is reachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(searchSmithery({ fetchImpl })).rejects.toBeTruthy();
  });

  it("captures sha256 over the canonical install manifest", () => {
    const a = manifestSha256({
      type: "stdio",
      command: "npx",
      args: ["-y", "@scope/server"],
    });
    const b = manifestSha256({
      type: "stdio",
      command: "npx",
      // arg reorder should change the hash
      args: ["@scope/server", "-y"],
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(manifestSha256(undefined)).toBeNull();
  });

  it("env ordering is canonical so equivalent envs hash the same", () => {
    const a = manifestSha256({ env: { B: "2", A: "1" } });
    const b = manifestSha256({ env: { A: "1", B: "2" } });
    expect(a).toBe(b);
  });

  it("toRegistryEntryRow projects all known Smithery fields", () => {
    const row = toRegistryEntryRow({
      qualifiedName: "@scope/srv",
      displayName: "Server",
      description: "desc",
      publisher: "scope",
      version: "1.2.3",
      useCount: 42,
      starCount: 17,
      lastUpdated: "2026-01-02T03:04:05Z",
      tags: ["db"],
      homepage: "https://example.com",
      license: "MIT",
      install: { type: "stdio", command: "npx", args: ["-y", "@scope/srv"] },
    });
    expect(row.source).toBe("smithery");
    expect(row.externalId).toBe("@scope/srv");
    expect(row.downloads).toBe(42);
    expect(row.stars).toBe(17);
    expect(row.lastUpdated).toBeInstanceOf(Date);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    const meta = JSON.parse(row.metadata) as { tags: string[]; homepage: string };
    expect(meta.tags).toEqual(["db"]);
    expect(meta.homepage).toBe("https://example.com");
  });

  it("toRegistryEntryRow handles missing optional fields without throwing", () => {
    const row = toRegistryEntryRow({ qualifiedName: "@x/y" });
    expect(row.name).toBe("@x/y");
    expect(row.lastUpdated).toBeNull();
    expect(row.sha256).toBeNull();
    expect(row.downloads).toBeNull();
  });

  it("rejects payloads that exceed the size cap", async () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const fetchImpl = vi.fn(
      async () => new Response(huge, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(searchSmithery({ fetchImpl })).rejects.toBeInstanceOf(SmitheryError);
  });
});
