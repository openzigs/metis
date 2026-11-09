/**
 * #1869 — GoverningIndex unit behaviour: the membership check runs before the
 * table is read, the search is filtered to the revisions the database says are
 * searchable, and a stale vector of any other revision is dropped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalVectorStore, type VectorStore } from "../rag/vector-store.js";

const canReadWorkspace = vi.fn();
const searchableRevisions = vi.fn();
vi.mock("./governing-store.js", () => ({
  canReadWorkspace: (...a: unknown[]) => canReadWorkspace(...a),
  searchableRevisions: (...a: unknown[]) => searchableRevisions(...a),
}));

const {
  GoverningIndex,
  MAX_GOVERNING_SEARCH_K,
  getGoverningIndex,
  __resetGoverningIndexSingleton,
} = await import("./governing-index.js");

const embedder = {
  embed: vi.fn(async (texts: string[]) => ({
    vectors: texts.map((t) => [t.length % 7, 1, 0.5]),
    model: "m",
    dimension: 3,
  })),
};
const actor = { id: "u1", role: "developer" };

describe("GoverningIndex", () => {
  let root: string;
  let store: VectorStore;
  const space = () => ({ store, tableKey: (ws: string) => ws });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "metis-1869-index-"));
    store = new LocalVectorStore({ root });
    process.env.GOVERNING_DOCS_ENABLED = "1";
    canReadWorkspace.mockReset().mockResolvedValue(true);
    searchableRevisions.mockReset();
    embedder.embed.mockClear();
  });
  afterEach(() => {
    delete process.env.GOVERNING_DOCS_ENABLED;
    rmSync(root, { recursive: true, force: true });
  });

  it("writes one row per chunk, keyed by revision, into the workspace's table", async () => {
    const index = new GoverningIndex({ space: space(), embedder });
    const n = await index.indexRevision({
      workspaceId: "ws1",
      revisionId: "rev1",
      filename: "p.md",
      text: "# Policy\n\nAll laptops are encrypted.",
    });
    expect(n).toBe(1);
    const refs = await store.listChunkRefs("ws1");
    expect(refs.map((r) => r.chunkId)).toEqual(["rev1:0"]);
    expect(refs[0]!.embeddingModel).toBe("m");
  });

  it("writes nothing for text with no chunks", async () => {
    const index = new GoverningIndex({ space: space(), embedder });
    expect(
      await index.indexRevision({ workspaceId: "ws1", revisionId: "r", filename: "f", text: "  " }),
    ).toBe(0);
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("refuses an embedder that returns the wrong number of vectors", async () => {
    const short = { embed: async () => ({ vectors: [], model: "m", dimension: 3 }) };
    const index = new GoverningIndex({ space: space(), embedder: short });
    await expect(
      index.indexRevision({ workspaceId: "ws1", revisionId: "r", filename: "f", text: "Text." }),
    ).rejects.toThrow(/embedder returned 0 vectors/);
  });

  it("returns nothing, without reading the table, when the actor may not read the workspace", async () => {
    canReadWorkspace.mockResolvedValue(false);
    const search = vi.spyOn(store, "search");
    const index = new GoverningIndex({ space: space(), embedder });
    expect(await index.search("ws1", "laptops", 5, actor)).toEqual([]);
    expect(canReadWorkspace).toHaveBeenCalledWith("ws1", actor);
    expect(searchableRevisions).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("returns nothing for an empty query, with the flag off, or with no searchable revision", async () => {
    const index = new GoverningIndex({ space: space(), embedder });
    expect(await index.search("ws1", "   ", 5, actor)).toEqual([]);
    searchableRevisions.mockResolvedValue(new Map());
    expect(await index.search("ws1", "laptops", 5, actor)).toEqual([]);
    process.env.GOVERNING_DOCS_ENABLED = "0";
    canReadWorkspace.mockClear();
    expect(await index.search("ws1", "laptops", 5, actor)).toEqual([]);
    expect(canReadWorkspace).not.toHaveBeenCalled();
  });

  it("filters to searchable revisions, drops stale vectors and clamps k", async () => {
    const index = new GoverningIndex({ space: space(), embedder });
    for (const revisionId of ["current", "old"]) {
      await index.indexRevision({
        workspaceId: "ws1",
        revisionId,
        filename: "p.md",
        text: `Clause of ${revisionId}.`,
      });
    }
    searchableRevisions.mockResolvedValue(
      new Map([["current", { documentId: "doc1", revisionLabel: "v2", title: "Policy" }]]),
    );
    const search = vi.spyOn(store, "search");
    const hits = await index.search("ws1", "clause", 0, actor, {});
    expect(hits.map((h) => h.revisionId)).toEqual(["current"]);
    expect(hits[0]).toMatchObject({ documentId: "doc1", revisionLabel: "v2", title: "Policy" });
    expect(search.mock.calls[0]![2]).toBe(1);
    expect(search.mock.calls[0]![3]).toEqual({ embeddingModel: "m", documentIds: ["current"] });
    expect(searchableRevisions).toHaveBeenCalledWith("ws1", {});

    await index.search("ws1", "clause", 10_000, actor);
    expect(search.mock.calls[1]![2]).toBe(MAX_GOVERNING_SEARCH_K);

    // A store that returns a row the database does not list (a stale vector) is filtered.
    search.mockResolvedValueOnce([
      {
        row: {
          id: "old:0",
          vector: [1, 1, 1],
          metadata: {
            documentId: "old",
            chunkId: "old:0",
            filename: "p.md",
            position: 0,
            text: "stale",
            embeddingModel: "m",
          },
        },
        score: 0.9,
      },
    ]);
    expect(await index.search("ws1", "clause", 5, actor)).toEqual([]);
  });

  it("#1918 — reports the active identity and the identities stored per revision", async () => {
    const tagged = {
      embed: async (texts: string[]) => ({
        vectors: texts.map(() => [1, 0, 0]),
        model: "m",
        identity: "m|cls|q8",
        dimension: 3,
      }),
    };
    const index = new GoverningIndex({ space: space(), embedder: tagged });
    expect(await index.activeEmbeddingIdentity()).toBe("m|cls|q8");
    expect(await new GoverningIndex({ space: space(), embedder }).activeEmbeddingIdentity()).toBe(
      "m",
    );
    for (const revisionId of ["r1", "r2"]) {
      await index.indexRevision({
        workspaceId: "ws1",
        revisionId,
        filename: "p.md",
        text: `# Policy ${revisionId}\n\nAll laptops are encrypted.`,
      });
    }
    const stored = await index.storedIdentities("ws1");
    expect([...stored.keys()].sort()).toEqual(["r1", "r2"]);
    expect([...stored.get("r1")!]).toEqual(["m|cls|q8"]);
    expect((await index.storedIdentities("ws-empty")).size).toBe(0);
  });

  it("#1947 — a rebuild writes a shadow the live table never sees until the swap", async () => {
    const index = new GoverningIndex({ space: space(), embedder });
    const write = (revisionId: string, shadow: boolean) =>
      index.indexRevision(
        { workspaceId: "ws1", revisionId, filename: "p.md", text: `Clause of ${revisionId}.` },
        { shadow },
      );
    await write("old", false);
    // A stale shadow from an interrupted rebuild is dropped when the next begins.
    await index.beginShadow("ws1");
    await write("stale", true);
    await index.beginShadow("ws1");
    await write("rebuilt", true);
    // Search's table still holds only the live row.
    expect([...(await index.storedIdentities("ws1")).keys()]).toEqual(["old"]);
    expect((await store.listChunkRefs("ws1__reindex")).map((r) => r.chunkId)).toEqual([
      "rebuilt:0",
    ]);

    await index.swapInShadow("ws1");
    expect([...(await index.storedIdentities("ws1")).keys()]).toEqual(["rebuilt"]);
    expect(await store.listChunkRefs("ws1__reindex")).toEqual([]);
  });

  it("#1947 — an empty rebuild still swaps in (the shadow table exists from the start)", async () => {
    const index = new GoverningIndex({ space: space(), embedder });
    await index.indexRevision({
      workspaceId: "ws1",
      revisionId: "old",
      filename: "p.md",
      text: "Clause.",
    });
    await index.beginShadow("ws1");
    await index.swapInShadow("ws1");
    expect((await index.storedIdentities("ws1")).size).toBe(0);
  });

  it("keeps one process-wide index", () => {
    __resetGoverningIndexSingleton();
    process.env.LANCEDB_PATH = root;
    expect(getGoverningIndex()).toBe(getGoverningIndex());
    __resetGoverningIndexSingleton();
  });
});
