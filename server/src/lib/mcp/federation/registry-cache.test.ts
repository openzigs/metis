/**
 * Epic #195 — Federated registry cache: refresh, dedupe, install mirror.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const rows = new Map<string, CacheRow>();
const key = (s: string, e: string): string => `${s}::${e}`;

vi.mock("../../prisma.js", () => ({
  prisma: {
    mcpRegistryEntry: {
      findMany: vi.fn(async () => [...rows.values()]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const r of rows.values()) if (r.id === where.id) return r;
        return null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { source_externalId: { source: string; externalId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const k = key(where.source_externalId.source, where.source_externalId.externalId);
          const existing = rows.get(k);
          if (existing) {
            const merged = { ...existing, ...update } as CacheRow;
            rows.set(k, merged);
            return merged;
          }
          const id = `id-${rows.size + 1}`;
          const row = {
            id,
            source: where.source_externalId.source,
            externalId: where.source_externalId.externalId,
            ...(create as object),
          } as CacheRow;
          rows.set(k, row);
          return row;
        },
      ),
    },
  },
}));

vi.mock("./smithery.js", async () => {
  const actual = await vi.importActual<typeof import("./smithery.js")>("./smithery.js");
  return {
    ...actual,
    searchSmithery: vi.fn(),
  };
});

vi.mock("./official-registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("./official-registry.js")>("./official-registry.js");
  return {
    ...actual,
    fetchOfficialRegistry: vi.fn(),
  };
});

import {
  refreshSource,
  refreshAll,
  searchFederated,
  recordLocalInstall,
  getEntryById,
} from "./registry-cache.js";
import { searchSmithery } from "./smithery.js";
import { fetchOfficialRegistry } from "./official-registry.js";

beforeEach(() => {
  rows.clear();
  vi.clearAllMocks();
});

describe("federation/registry-cache", () => {
  it("refreshSource('local') is a no-op", async () => {
    const r = await refreshSource("local");
    expect(r.upserted).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("refreshSource('smithery') upserts every server", async () => {
    (searchSmithery as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      total: 2,
      servers: [
        { qualifiedName: "@a/b", displayName: "AB" },
        { qualifiedName: "@c/d", displayName: "CD" },
      ],
    });
    const r = await refreshSource("smithery");
    expect(r.upserted).toBe(2);
    expect(rows.size).toBe(2);
  });

  it("refreshSource captures per-row errors without aborting", async () => {
    (searchSmithery as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      total: 2,
      servers: [
        { qualifiedName: "@a/b", displayName: "AB" },
        { qualifiedName: "@c/d", displayName: "CD" },
      ],
    });
    // Force the second upsert to throw.
    const callCount = { n: 0 };
    const original = (await import("../../prisma.js")).prisma.mcpRegistryEntry.upsert;
    (original as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callCount.n += 1;
      return { id: "ok" } as unknown as CacheRow;
    });
    (original as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const r = await refreshSource("smithery");
    expect(r.upserted).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("boom");
  });

  it("refreshSource('official') upserts mirrored servers", async () => {
    (fetchOfficialRegistry as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      stale: false,
      total: 1,
      servers: [{ id: "off-1", name: "Off1" }],
    });
    const r = await refreshSource("official");
    expect(r.upserted).toBe(1);
  });

  it("refreshSource captures fetch failures", async () => {
    (searchSmithery as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network down"),
    );
    const r = await refreshSource("smithery");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join(" ")).toContain("network down");
  });

  it("refreshAll runs every external source", async () => {
    (searchSmithery as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      total: 0,
      servers: [],
    });
    (fetchOfficialRegistry as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      stale: false,
      total: 0,
      servers: [],
    });
    const all = await refreshAll();
    expect(all.map((r) => r.source)).toEqual(["smithery", "official"]);
  });

  it("searchFederated dedupes across sources, official wins over smithery", async () => {
    rows.set(key("smithery", "@x/y"), {
      id: "s1",
      source: "smithery",
      externalId: "@x/y",
      name: "X-smithery",
      description: "",
      publisher: null,
      version: null,
      downloads: null,
      stars: null,
      lastUpdated: null,
      sha256: null,
      manifest: "{}",
      metadata: "{}",
      fetchedAt: new Date(),
    });
    rows.set(key("official", "@x/y"), {
      id: "o1",
      source: "official",
      externalId: "@x/y",
      name: "X-official",
      description: "",
      publisher: null,
      version: null,
      downloads: null,
      stars: null,
      lastUpdated: null,
      sha256: null,
      manifest: "{}",
      metadata: "{}",
      fetchedAt: new Date(),
    });
    const r = await searchFederated();
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].source).toBe("official");
  });

  it("searchFederated filters by `q` against name/description/publisher", async () => {
    rows.set(key("smithery", "@a/postgres"), {
      id: "s1",
      source: "smithery",
      externalId: "@a/postgres",
      name: "Postgres MCP",
      description: "db",
      publisher: "a",
      version: null,
      downloads: null,
      stars: null,
      lastUpdated: null,
      sha256: null,
      manifest: "{}",
      metadata: "{}",
      fetchedAt: new Date(),
    });
    rows.set(key("smithery", "@a/redis"), {
      id: "s2",
      source: "smithery",
      externalId: "@a/redis",
      name: "Redis MCP",
      description: "kv",
      publisher: "a",
      version: null,
      downloads: null,
      stars: null,
      lastUpdated: null,
      sha256: null,
      manifest: "{}",
      metadata: "{}",
      fetchedAt: new Date(),
    });
    const r = await searchFederated({ q: "postgres" });
    expect(r.entries.map((e) => e.name)).toEqual(["Postgres MCP"]);
  });

  it("searchFederated paginates results", async () => {
    for (let i = 0; i < 30; i += 1) {
      rows.set(key("smithery", `@a/srv-${i}`), {
        id: `s-${i}`,
        source: "smithery",
        externalId: `@a/srv-${i}`,
        name: `Srv ${i}`,
        description: "",
        publisher: null,
        version: null,
        downloads: null,
        stars: null,
        lastUpdated: null,
        sha256: null,
        manifest: "{}",
        metadata: "{}",
        fetchedAt: new Date(),
      });
    }
    const p1 = await searchFederated({ pageSize: 10, page: 1 });
    const p2 = await searchFederated({ pageSize: 10, page: 2 });
    expect(p1.entries).toHaveLength(10);
    expect(p2.entries).toHaveLength(10);
    expect(p1.entries[0].id).not.toBe(p2.entries[0].id);
    expect(p1.total).toBe(30);
  });

  it("searchFederated returns parsed manifest + metadata even when DB string is corrupt", async () => {
    rows.set(key("smithery", "@x/bad"), {
      id: "s1",
      source: "smithery",
      externalId: "@x/bad",
      name: "X",
      description: null,
      publisher: null,
      version: null,
      downloads: null,
      stars: null,
      lastUpdated: null,
      sha256: null,
      manifest: "not-json",
      metadata: "{not json}",
      fetchedAt: new Date(),
    });
    const r = await searchFederated();
    expect(r.entries[0].manifest).toEqual({});
    expect(r.entries[0].metadata).toEqual({});
  });

  it("recordLocalInstall mirrors a row under source='local'", async () => {
    await recordLocalInstall({
      externalId: "@x/y",
      name: "X",
      manifest: { command: "npx" },
      metadata: { tag: "ok" },
    });
    const all = await searchFederated({ source: "local" });
    expect(all.entries).toHaveLength(1);
    expect(all.entries[0].source).toBe("local");
    expect(all.entries[0].manifest).toEqual({ command: "npx" });
  });

  it("getEntryById returns null for unknown ids", async () => {
    expect(await getEntryById("nope")).toBeNull();
  });

  it("getEntryById returns the parsed entry when found", async () => {
    rows.set(key("smithery", "@x/y"), {
      id: "find-me",
      source: "smithery",
      externalId: "@x/y",
      name: "X",
      description: "",
      publisher: null,
      version: null,
      downloads: null,
      stars: null,
      lastUpdated: null,
      sha256: null,
      manifest: "{}",
      metadata: "{}",
      fetchedAt: new Date(),
    });
    const e = await getEntryById("find-me");
    expect(e?.externalId).toBe("@x/y");
  });
});
