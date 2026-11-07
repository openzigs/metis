/**
 * #1843 — `getProjectContentVersion` over a stub source: what the key depends
 * on, and what it must not. The real queries run in
 * `tests/tool-result-cache-1843.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  RECENT_WRITE_WINDOW_MS,
  getProjectContentVersion,
  type ContentVersionDocument as Doc,
  type ContentVersionSource,
} from "./content-version.js";

type Graph = Awaited<ReturnType<ContentVersionSource["codeGraphs"]>>[number];
const WRITTEN = new Date("2026-11-01T00:00:00Z");

const graph = (id: string, repo: string | null, sha: string | null): Graph => ({
  id,
  repoConnectionId: repo,
  commitSha: sha,
  lastIndexedAt: sha ? new Date("2026-11-01T00:00:00Z") : null,
});
const doc = (id: string, over: Partial<Doc> = {}): Doc => ({
  id,
  filename: `${id}.md`,
  title: null,
  checksum: `c-${id}`,
  status: "ready",
  indexState: "indexed",
  chunkCount: 1,
  aclSubjects: "[]",
  processedAt: new Date("2026-11-01T00:00:00Z"),
  deletedAt: null,
  updatedAt: WRITTEN,
  ...over,
});

/**
 * A source over `docs`, answering the summary and the recent-rows query the
 * way the database would; `since` records every window asked for.
 */
function source(input: {
  graphs?: Graph[];
  docs?: Doc[];
  symbols?: Array<{ model: string; count: number }>;
  chunks?: Array<{ model: string; count: number }>;
  model?: string;
}): ContentVersionSource & { asked: string[]; since: Date[] } {
  const asked: string[] = [];
  const since: Date[] = [];
  const docs = input.docs ?? [];
  const latest = docs.reduce<Date | null>(
    (m, d) => (d.updatedAt && (!m || d.updatedAt > m) ? d.updatedAt : m),
    null,
  );
  return {
    asked,
    since,
    codeGraphs: async (p) => (asked.push(p), input.graphs ?? []),
    symbolEmbeddingCounts: async (p) => (asked.push(p), input.symbols ?? []),
    chunkEmbeddingCounts: async (p) => (asked.push(p), input.chunks ?? []),
    documentSummary: async (p) => (asked.push(p), { count: docs.length, latestWrite: latest }),
    documentsWrittenSince: async (p, from) => {
      asked.push(p);
      since.push(from);
      return docs.filter((d) => d.updatedAt !== null && d.updatedAt >= from);
    },
    embedderIdentity: async () => input.model ?? "m",
  };
}

describe("getProjectContentVersion", () => {
  it("asks only for the project it was given", async () => {
    const s = source({});
    await getProjectContentVersion("p1", s);
    expect(new Set(s.asked)).toEqual(new Set(["p1"]));
  });

  it("does not depend on the order rows come back in", async () => {
    const graphs = [graph("g1", "r1", "a"), graph("g2", "r2", "b")];
    const docs = [doc("d1"), doc("d2")];
    const symbols = [
      { model: "m1", count: 3 },
      { model: "m2", count: 4 },
    ];
    const chunks = [
      { model: "c1", count: 5 },
      { model: "c2", count: 6 },
    ];
    const a = await getProjectContentVersion("p", source({ graphs, docs, symbols, chunks }));
    const b = await getProjectContentVersion(
      "p",
      source({
        graphs: [...graphs].reverse(),
        docs: [...docs].reverse(),
        symbols: [...symbols].reverse(),
        chunks: [...chunks].reverse(),
      }),
    );
    expect(b).toEqual(a);
  });

  it("maps each graph to its repo connection, or graph:<id> when it has none", async () => {
    const v = await getProjectContentVersion(
      "p",
      source({ graphs: [graph("g1", "r1", "a"), graph("g2", null, "b")] }),
    );
    expect(v.codeShas).toEqual({ r1: "a", "graph:g2": "b" });
    expect(v.complete).toBe(true);
  });

  it("an empty project is complete; a graph with no SHA is not", async () => {
    expect((await getProjectContentVersion("p", source({}))).complete).toBe(true);
    const v = await getProjectContentVersion(
      "p",
      source({ graphs: [graph("g1", "r1", "a"), graph("g2", "r2", null)] }),
    );
    expect(v.complete).toBe(false);
  });

  // A second row, written five seconds before the latest: inside the window.
  const earlier = (over: Partial<Doc> = {}) =>
    doc("d0", { updatedAt: new Date(WRITTEN.getTime() - 5_000), ...over });
  it.each<[string, Parameters<typeof source>[0]]>([
    ["a commit", { graphs: [graph("g1", "r1", "z")] }],
    ["a document", { docs: [doc("d1", { checksum: "other" }), earlier()] }],
    ["the symbol embeddings", { symbols: [{ model: "m", count: 2 }] }],
    ["the embedder identity", { model: "m|cls|fp32" }],
    // #1864: a reindex or retag moves chunks to the active identity; no document row changes.
    ["the chunks' embedding models", { chunks: [{ model: "m2", count: 4 }] }],
    ["a document hard-deleted", { docs: [doc("d1")] }],
    [
      "a later document write",
      { docs: [doc("d1", { updatedAt: new Date(WRITTEN.getTime() + 1) }), earlier()] },
    ],
    // #1864: a second write in the same millisecond leaves the count and the latest write.
    [
      "a same-millisecond ACL edit",
      { docs: [doc("d1", { aclSubjects: '[{"kind":"role"}]' }), earlier()] },
    ],
    [
      "a row inside the window whose state changed",
      { docs: [doc("d1"), earlier({ status: "x" })] },
    ],
  ])("changes with %s", async (_label, change) => {
    const base = {
      graphs: [graph("g1", "r1", "a")],
      docs: [doc("d1"), earlier()],
      symbols: [{ model: "m", count: 1 }],
      chunks: [{ model: "m", count: 4 }],
      model: "m",
    };
    const a = await getProjectContentVersion("p", source(base));
    const b = await getProjectContentVersion("p", source({ ...base, ...change }));
    expect(b.key).not.toBe(a.key);
  });

  it("two projects with identical content get different keys", async () => {
    const s = { graphs: [graph("g1", "r1", "a")] };
    const a = await getProjectContentVersion("p1", source(s));
    const b = await getProjectContentVersion("p2", source(s));
    expect(a.key).not.toBe(b.key);
    expect(a.docsVersion).toBe(b.docsVersion);
  });

  it("#1864 hashes only the rows written within the window before the latest write", async () => {
    const old = new Date(WRITTEN.getTime() - RECENT_WRITE_WINDOW_MS - 1);
    const s = source({ docs: [doc("d1"), doc("d0", { updatedAt: old })] });
    const a = await getProjectContentVersion("p", s);
    expect(s.since).toEqual([new Date(WRITTEN.getTime() - RECENT_WRITE_WINDOW_MS)]);
    // A row older than the window is covered by the count and the latest write
    // alone: its state is not read, so a change the database never stamped
    // (impossible through Prisma) would not show.
    const b = await getProjectContentVersion(
      "p",
      source({ docs: [doc("d1"), doc("d0", { updatedAt: old, status: "failed" })] }),
    );
    expect(b.key).toBe(a.key);
  });

  it("#1864 rows written before the column existed (null) are counted, and no rows are read", async () => {
    const s = source({ docs: [doc("d1", { updatedAt: null })] });
    const a = await getProjectContentVersion("p", s);
    expect(s.since).toEqual([]);
    const none = await getProjectContentVersion("p", source({}));
    expect(a.docsVersion).not.toBe(none.docsVersion);
  });
});
