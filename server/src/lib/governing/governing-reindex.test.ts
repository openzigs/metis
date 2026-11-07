/**
 * #1918 — the governing reindex sweep's decisions, over a stubbed store and
 * index: which revisions it embeds, when it rebuilds a table, and what a
 * failure leaves behind. #1947 — the rebuild goes through a shadow table, the
 * workspace is re-read after the swap, and `governingCoverage` reports what
 * the sweep would do. The real-database round trip is in
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

const { governingCoverage, reindexGoverningRevisions } = await import("./governing-reindex.js");
type Index = NonNullable<Parameters<typeof reindexGoverningRevisions>[0]>["index"];

/**
 * A two-table fake (#1947): `stored` is each workspace's LIVE table; a shadow
 * write goes to a separate table that `swapInShadow` moves into its place.
 * `calls` is the order of every table operation.
 */
function fakeIndex(stored: Record<string, Record<string, string[]>>) {
  const live = new Map(
    Object.entries(stored).map(([ws, revs]) => [
      ws,
      new Map(Object.entries(revs).map(([rev, ids]) => [rev, new Set(ids)])),
    ]),
  );
  const shadows = new Map<string, Map<string, Set<string>>>();
  const calls: string[] = [];
  const table = (tables: typeof live, ws: string) => {
    const t = tables.get(ws) ?? new Map<string, Set<string>>();
    tables.set(ws, t);
    return t;
  };
  const index = {
    activeEmbeddingIdentity: vi.fn(async () => "new"),
    storedIdentities: vi.fn(async (ws: string) => new Map(table(live, ws))),
    beginShadow: vi.fn(async (ws: string) => {
      calls.push(`begin ${ws}`);
      shadows.set(ws, new Map());
    }),
    swapInShadow: vi.fn(async (ws: string) => {
      calls.push(`swap ${ws}`);
      live.set(ws, shadows.get(ws) ?? new Map());
      shadows.delete(ws);
    }),
    indexRevision: vi.fn(
      async (
        input: { workspaceId: string; revisionId: string },
        opts: { shadow?: boolean } = {},
      ) => {
        calls.push(`${opts.shadow ? "shadow" : "live"} ${input.revisionId}`);
        if (input.revisionId === "bad") throw new Error("embedder down");
        table(opts.shadow ? shadows : live, input.workspaceId).set(
          input.revisionId,
          new Set(["new"]),
        );
        return 2;
      },
    ),
  };
  return { index, asIndex: index as unknown as Index, calls, live };
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
    expect(index.beginShadow).not.toHaveBeenCalled();
    expect(index.swapInShadow).not.toHaveBeenCalled();
    expect(index.indexRevision).toHaveBeenCalledWith(
      { workspaceId: "ws1", revisionId: "pending", filename: "Policy", text: "text pending" },
      { shadow: false },
    );
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "pending", "indexed");
    expect(setRevisionIndexState).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a workspace whose table holds another model's rows into a shadow, and leaves a clean one alone", async () => {
    const ws1 = { workspaceId: "ws1", revisions: [rev("a"), rev("b")] };
    listReindexTargets.mockImplementation(async (ws?: string) =>
      ws === "ws1" ? [ws1] : [ws1, { workspaceId: "ws2", revisions: [rev("c")] }],
    );
    const { asIndex, calls } = fakeIndex({
      ws1: { a: ["old"], b: ["new"] },
      ws2: { c: ["new"] },
    });
    const out = await reindexGoverningRevisions({ index: asIndex });
    // #1947 — every revision is written to the shadow and only then swapped in:
    // the live table, which search reads, is never dropped first.
    expect(calls).toEqual(["begin ws1", "shadow a", "shadow b", "swap ws1"]);
    expect(out.rebuiltWorkspaces).toEqual(["ws1"]);
    // Both of ws1's revisions, even `b`, whose live row the swap replaced.
    expect(out.reindexed.map((r) => r.revisionId)).toEqual(["a", "b"]);
    expect(out.revisions).toBe(3);
    expect(out.failures).toEqual([]);
  });

  it("#1947 — after the swap, re-reads the workspace and embeds a revision uploaded during the rebuild", async () => {
    // The snapshot holds `a`; `v3` was stored (and embedded into the old live
    // table) after it, so the shadow lacks it and the swap removes its rows.
    listReindexTargets.mockImplementation(async (ws?: string) =>
      ws === "ws1"
        ? [{ workspaceId: "ws1", revisions: [rev("a"), rev("v3")] }]
        : [{ workspaceId: "ws1", revisions: [rev("a")] }],
    );
    const { asIndex, calls, live } = fakeIndex({ ws1: { a: ["old"], v3: ["new"] } });
    const out = await reindexGoverningRevisions({ index: asIndex });
    expect(listReindexTargets).toHaveBeenLastCalledWith("ws1");
    expect(calls).toEqual(["begin ws1", "shadow a", "swap ws1", "live v3"]);
    expect([...live.get("ws1")!.keys()].sort()).toEqual(["a", "v3"]);
    expect(out.reindexed.map((r) => r.revisionId)).toEqual(["a", "v3"]);
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "v3", "indexed");
  });

  it("does not try a revision the shadow pass failed a second time; it is left pending", async () => {
    listReindexTargets.mockResolvedValue([
      { workspaceId: "ws1", revisions: [rev("bad"), rev("a")] },
    ]);
    const { asIndex, calls } = fakeIndex({ ws1: { a: ["old"] } });
    const out = await reindexGoverningRevisions({ index: asIndex });
    expect(calls).toEqual(["begin ws1", "shadow bad", "shadow a", "swap ws1"]);
    expect(out.failures).toEqual([
      { workspaceId: "ws1", revisionId: "bad", error: "embedder down" },
    ]);
    expect(setRevisionIndexState).toHaveBeenCalledWith("ws1", "bad", "pending");
    expect(setRevisionIndexState).toHaveBeenCalledTimes(1);
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
    expect(out.rebuiltWorkspaces).toEqual([]);
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

describe("governingCoverage (#1947)", () => {
  beforeEach(() => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    listReindexTargets.mockReset();
  });
  afterEach(() => {
    delete process.env.GOVERNING_DOCS_ENABLED;
  });

  it("lists the workspaces with a revision off the active model or another model's rows", async () => {
    listReindexTargets.mockResolvedValue([
      { workspaceId: "ws1", revisions: [rev("a"), rev("b", "pending")] },
      { workspaceId: "ws2", revisions: [rev("c")] },
      { workspaceId: "ws3", revisions: [rev("d")] },
    ]);
    const { index, asIndex } = fakeIndex({
      ws1: { a: ["new"] },
      ws2: { c: ["new", "old"] },
      ws3: { d: ["new"] },
    });
    expect(await governingCoverage({ index: asIndex })).toEqual({
      skipped: false,
      revisions: 4,
      workspaces: [
        { workspaceId: "ws1", darkRevisions: ["b"], foreignRows: false },
        { workspaceId: "ws2", darkRevisions: [], foreignRows: true },
      ],
    });
    // A read: nothing is embedded, rebuilt or written.
    expect(index.indexRevision).not.toHaveBeenCalled();
    expect(index.beginShadow).not.toHaveBeenCalled();
  });

  it("reads nothing with the flag off, and probes no embedder with no documents", async () => {
    listReindexTargets.mockResolvedValue([]);
    const { index, asIndex } = fakeIndex({});
    expect(await governingCoverage({ index: asIndex })).toEqual({
      skipped: false,
      revisions: 0,
      workspaces: [],
    });
    expect(index.activeEmbeddingIdentity).not.toHaveBeenCalled();
    delete process.env.GOVERNING_DOCS_ENABLED;
    listReindexTargets.mockClear();
    expect(await governingCoverage({ index: asIndex })).toMatchObject({ skipped: true });
    expect(listReindexTargets).not.toHaveBeenCalled();
  });
});
