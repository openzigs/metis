/**
 * Unit tests for the ProductContractDoc versioning service (Issue #90).
 *
 * Persistence is dependency-injected as a minimal `ContractDocStore` so these
 * tests never touch a real database. Covers:
 *  - first generation → version 1, no diff (initial version);
 *  - regenerate identical spec → NO new version (contentHash dedupe);
 *  - changed spec → new version + correct structural diff surfaced in the doc;
 *  - diff spans OpenAPI, GraphQL and protobuf.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlSpec } from "./repo-crawler.js";
import {
  recordContractDocVersion,
  createPrismaContractDocStore,
  type ContractDocStore,
  type ContractDocVersionRecord,
} from "./contract-doc-versioning.js";

function openapi(paths: Record<string, unknown>): CrawlSpec {
  return { format: "openapi", filePath: "openapi.json", content: JSON.stringify({ paths }) };
}

/** In-memory store implementing the injected persistence seam. */
function makeStore(): ContractDocStore & { rows: ContractDocVersionRecord[] } {
  const rows: ContractDocVersionRecord[] = [];
  return {
    rows,
    findLatest: vi.fn(async (productId: string, repoId: string | null) => {
      const matching = rows
        .filter((r) => r.productId === productId && r.repoId === repoId)
        .sort((a, b) => b.version - a.version);
      return matching[0] ?? null;
    }),
    create: vi.fn(async (rec: ContractDocVersionRecord) => {
      rows.push(rec);
      return rec;
    }),
  };
}

const baseInput = {
  productId: "p1",
  productName: "My Product",
  repoName: "backend",
  repoConnectionId: "r1",
  ownerOrOrg: "org",
};

describe("recordContractDocVersion", () => {
  let store: ReturnType<typeof makeStore>;
  beforeEach(() => {
    store = makeStore();
  });

  it("creates version 1 with no diff on first generation", async () => {
    const res = await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/users": { get: {} } })] },
      store,
    );
    expect(res.version).toBe(1);
    expect(res.created).toBe(true);
    expect(res.diff).toBeNull();
    expect(res.doc.content).toMatch(/initial version/i);
    expect(store.create).toHaveBeenCalledOnce();
  });

  it("does NOT bump version when the spec is unchanged (contentHash dedupe)", async () => {
    const spec = [openapi({ "/users": { get: { summary: "List" } } })];
    const first = await recordContractDocVersion({ ...baseInput, specs: spec }, store);
    const second = await recordContractDocVersion({ ...baseInput, specs: spec }, store);

    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
    expect(second.created).toBe(false);
    expect(store.create).toHaveBeenCalledOnce();
    expect(store.rows).toHaveLength(1);
  });

  it("bumps to version 2 with a diff when an endpoint is added", async () => {
    await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/users": { get: {} } })] },
      store,
    );
    const res = await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/users": { get: {} }, "/orders": { post: {} } })] },
      store,
    );

    expect(res.version).toBe(2);
    expect(res.created).toBe(true);
    expect(res.diff?.added.map((i) => i.id)).toEqual(["openapi endpoint POST /orders"]);
    expect(res.doc.content).toContain("### Added");
    expect(res.doc.content).toContain("POST /orders");
  });

  it("surfaces removed and changed items in the diff and doc", async () => {
    await recordContractDocVersion(
      {
        ...baseInput,
        specs: [openapi({ "/gone": { get: {} }, "/mod": { get: { summary: "a" } } })],
      },
      store,
    );
    const res = await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/mod": { get: { summary: "b" } } })] },
      store,
    );

    expect(res.diff?.removed.map((i) => i.id)).toEqual(["openapi endpoint GET /gone"]);
    expect(res.diff?.changed.map((i) => i.id)).toEqual(["openapi endpoint GET /mod"]);
    expect(res.doc.content).toContain("### Removed");
    expect(res.doc.content).toContain("### Changed");
  });

  it("computes a diff across OpenAPI, GraphQL and protobuf together", async () => {
    const v1: CrawlSpec[] = [
      openapi({ "/a": { get: {} } }),
      { format: "graphql", filePath: "s.graphql", content: "type A { id: ID }" },
      { format: "protobuf", filePath: "s.proto", content: "message M { string a = 1; }" },
    ];
    const v2: CrawlSpec[] = [
      openapi({ "/a": { get: {} }, "/b": { post: {} } }), // added endpoint
      { format: "graphql", filePath: "s.graphql", content: "type A { id: ID name: String }" }, // changed type
      { format: "protobuf", filePath: "s.proto", content: "" }, // removed message
    ];
    await recordContractDocVersion({ ...baseInput, specs: v1 }, store);
    const res = await recordContractDocVersion({ ...baseInput, specs: v2 }, store);

    expect(res.diff?.added.map((i) => i.id)).toContain("openapi endpoint POST /b");
    expect(res.diff?.changed.map((i) => i.id)).toContain("graphql type A");
    expect(res.diff?.removed.map((i) => i.id)).toContain("protobuf message M");
  });

  it("persists version metadata: contentHash, generatedAt and diffSummary", async () => {
    await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/users": { get: {} } })] },
      store,
    );
    const res = await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/users": { get: {} }, "/x": { get: {} } })] },
      store,
    );
    const persisted = store.rows.find((r) => r.version === 2)!;
    expect(persisted.contentHash).toEqual(res.contentHash);
    expect(persisted.diffSummary).toMatch(/1 added/);
    expect(typeof persisted.generatedAt).toBe("string");
    expect(persisted.specIdentity).toContain("openapi.json");
  });

  it("returns the previously-stored diff on a dedupe hit (version >= 2)", async () => {
    // v1
    await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/a": { get: {} } })] },
      store,
    );
    // v2 adds an endpoint (stores a diff)
    const v2spec = [openapi({ "/a": { get: {} }, "/b": { post: {} } })];
    await recordContractDocVersion({ ...baseInput, specs: v2spec }, store);
    // regenerate identical v2 → dedupe hit, should echo the stored diff
    const dedup = await recordContractDocVersion({ ...baseInput, specs: v2spec }, store);
    expect(dedup.created).toBe(false);
    expect(dedup.version).toBe(2);
    expect(dedup.diff?.added.map((i) => i.id)).toEqual(["openapi endpoint POST /b"]);
  });

  it("treats a malformed itemsSnapshot as an empty prior contract (everything added)", async () => {
    // Seed a row with a corrupt snapshot directly.
    await store.create({
      productId: "p1",
      repoId: "r1",
      version: 1,
      contentHash: "stale-hash",
      specIdentity: "[]",
      itemsSnapshot: "{not json",
      diff: null,
      diffSummary: "Initial version.",
      content: "# old",
      title: "t",
      generatedAt: new Date().toISOString(),
    });
    const res = await recordContractDocVersion(
      { ...baseInput, specs: [openapi({ "/a": { get: {} } })] },
      store,
    );
    expect(res.version).toBe(2);
    expect(res.diff?.added.map((i) => i.id)).toEqual(["openapi endpoint GET /a"]);
  });

  it("scopes versions per repo (independent counters)", async () => {
    await recordContractDocVersion(
      { ...baseInput, repoConnectionId: "r1", specs: [openapi({ "/a": { get: {} } })] },
      store,
    );
    const res = await recordContractDocVersion(
      { ...baseInput, repoConnectionId: "r2", specs: [openapi({ "/b": { get: {} } })] },
      store,
    );
    expect(res.version).toBe(1);
  });
});

describe("createPrismaContractDocStore", () => {
  it("maps findFirst → domain record (Date generatedAt → ISO string)", async () => {
    const when = new Date("2026-07-01T12:00:00.000Z");
    const delegate = {
      findFirst: vi.fn(async () => ({
        productId: "p1",
        repoId: "r1",
        version: 3,
        contentHash: "hash",
        specIdentity: "[]",
        itemsSnapshot: "[]",
        diff: null,
        diffSummary: "Initial version.",
        content: "# doc",
        title: "t",
        generatedAt: when,
      })),
      create: vi.fn(),
    };
    const store = createPrismaContractDocStore(delegate as never);
    const rec = await store.findLatest("p1", "r1");
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { productId: "p1", repoId: "r1" },
      orderBy: { version: "desc" },
    });
    expect(rec?.generatedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(rec?.version).toBe(3);
  });

  it("returns null when no prior version exists", async () => {
    const delegate = { findFirst: vi.fn(async () => null), create: vi.fn() };
    const store = createPrismaContractDocStore(delegate as never);
    expect(await store.findLatest("p1", "r9")).toBeNull();
  });

  it("marshals create data generatedAt (ISO string → Date) and maps the row back", async () => {
    const created: Record<string, unknown> = {};
    const delegate = {
      findFirst: vi.fn(),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(created, args.data);
        return { ...args.data, generatedAt: new Date(args.data.generatedAt as string) };
      }),
    };
    const store = createPrismaContractDocStore(delegate as never);
    const rec: ContractDocVersionRecord = {
      productId: "p1",
      repoId: "r1",
      version: 1,
      contentHash: "h",
      specIdentity: "[]",
      itemsSnapshot: "[]",
      diff: null,
      diffSummary: "Initial version.",
      content: "# doc",
      title: "t",
      generatedAt: "2026-07-01T12:00:00.000Z",
    };
    const out = await store.create(rec);
    expect(created.generatedAt).toBeInstanceOf(Date);
    expect(out.generatedAt).toBe("2026-07-01T12:00:00.000Z");
  });
});
