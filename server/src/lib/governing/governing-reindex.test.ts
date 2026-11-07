/**
 * #1918 — the governing reindex sweep's decisions, over a stubbed store and
 * index: which revisions it embeds, when it drops a table, and what a failure
 * leaves behind. The real-database round trip is in
 * `tests/governing-documents.workspace-scope.sqlite.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listReindexTargets = vi.fn();
const revisionText = vi.fn();
const setRevisionIndexState = vi.fn();
vi.mock("./governing-store.js", () => ({
  listReindexTargets: (...a: unknown[]) => listReindexTargets(...a),
  revisionText: (...a: unknown[]) => revisionText(...a),
  setRevisionIndexState: (...a: unknown[]) => setRevisionIndexState(...a),
}));

const { reindexGoverningRevisions } = await import("./governing-reindex.js");
type Index = NonNullable<Parameters<typeof reindexGoverningRevisions>[0]>["index"];

function fakeIndex(stored: Record<string, Record<string, string[]>>) {
  const index = {
    activeEmbeddingIdentity: vi.fn(async () => "new"),
    storedIdentities: vi.fn(
      async (ws: string) =>
        new Map(Object.entries(stored[ws] ?? {}).map(([rev, ids]) => [rev, new Set(ids)])),
    ),
    dropWorkspaceTable: vi.fn(async () => undefined),
    indexRevision: vi.fn(async (input: { revisionId: string }) => {
      if (input.revisionId === "bad") throw new Error("embedder down");
      return 2;
    }),
  };
  return { index, asIndex: index as unknown as Index };
}

const rev = (revisionId: string, indexState = "indexed") => ({
  revisionId,
  title: "Policy",
  indexState,
});

describe("reindexGoverningRevisions", () => {
  beforeEach(() => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    listReindexTargets.mockReset();
    revisionText.mockReset().mockImplementation(async (_ws: string, id: string) => `text ${id}`);
    setRevisionIndexState.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.GOVERNING_DOCS_ENABLED;
  });

  it("embeds only revisions with no row on the active model, from their stored text", async () => {
    listReindexTargets.mockResolvedValue([
      { workspaceId: "ws1", revisions: [rev("done"), rev("pending", "pending")] },
    ]);
    const { index, asIndex } = fakeIndex({ ws1: { done: ["new"] } });
    const out = await reindexGoverningRevisions({ index: asIndex });
    expect(out).toMatchObject({ skipped: false, revisions: 2, rebuiltWorkspaces: [] });
    expect(out.reindexed).toEqual([{ workspaceId: "ws1", revisionId: "pending", chunkCount: 2 }]);
    expect(index.dropWorkspaceTable).not.toHaveBeenCalled();
    expect(index.indexRevision).toHaveBeenCalledWith({
      workspaceId: "ws1",
      revisionId: "pending",
      filename: "Policy",
      text: "text pending",
    });
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "pending", "indexed");
    expect(setRevisionIndexState).toHaveBeenCalledTimes(1);
  });

  it("drops and rebuilds a workspace whose table holds another model's rows, and leaves a clean one alone", async () => {
    listReindexTargets.mockResolvedValue([
      { workspaceId: "ws1", revisions: [rev("a"), rev("b")] },
      { workspaceId: "ws2", revisions: [rev("c")] },
    ]);
    const { index, asIndex } = fakeIndex({ ws1: { a: ["old"], b: ["new"] }, ws2: { c: ["new"] } });
    const out = await reindexGoverningRevisions({ index: asIndex });
    expect(index.dropWorkspaceTable).toHaveBeenCalledWith("ws1");
    expect(index.dropWorkspaceTable).toHaveBeenCalledTimes(1);
    expect(out.rebuiltWorkspaces).toEqual(["ws1"]);
    // Both of ws1's revisions, even `b`, whose row the drop removed.
    expect(out.reindexed.map((r) => r.revisionId)).toEqual(["a", "b"]);
    expect(out.revisions).toBe(3);
  });

  it("marks a revision whose rows are already on the active model indexed without embedding it", async () => {
    listReindexTargets.mockResolvedValue([
      { workspaceId: "ws1", revisions: [rev("stuck", "pending")] },
    ]);
    const { index, asIndex } = fakeIndex({ ws1: { stuck: ["new"] } });
    const out = await reindexGoverningRevisions({ index: asIndex });
    expect(index.indexRevision).not.toHaveBeenCalled();
    expect(out.reindexed).toEqual([]);
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "stuck", "indexed");
  });

  it("records a failed revision as pending and goes on to the next", async () => {
    listReindexTargets.mockResolvedValue([
      { workspaceId: "ws1", revisions: [rev("bad"), rev("good", "pending")] },
    ]);
    const { asIndex } = fakeIndex({});
    const out = await reindexGoverningRevisions({ index: asIndex });
    expect(out.failures).toEqual([
      { workspaceId: "ws1", revisionId: "bad", error: "embedder down" },
    ]);
    expect(out.reindexed.map((r) => r.revisionId)).toEqual(["good"]);
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "bad", "pending");
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "good", "indexed");
  });

  it("does not probe the embedder when there is nothing to sweep, and reads nothing with the flag off", async () => {
    listReindexTargets.mockResolvedValue([]);
    const { index, asIndex } = fakeIndex({});
    expect(await reindexGoverningRevisions({ index: asIndex })).toMatchObject({
      skipped: false,
      revisions: 0,
    });
    expect(index.activeEmbeddingIdentity).not.toHaveBeenCalled();

    delete process.env.GOVERNING_DOCS_ENABLED;
    listReindexTargets.mockClear();
    expect(await reindexGoverningRevisions({ index: asIndex })).toMatchObject({ skipped: true });
    expect(listReindexTargets).not.toHaveBeenCalled();
  });
});
