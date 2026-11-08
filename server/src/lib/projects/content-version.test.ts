/**
 * #1843 — `getProjectContentVersion` over a stub source: what the key depends
 * on, and what it must not. The real queries run in
 * `tests/tool-result-cache-1843.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

// #1944 — the embedder the real source reads its identity from.
const embedder = vi.hoisted(() => ({
  model: "m",
  knownIdentity: vi.fn((): string => "m|cls|fp32"),
  currentIdentity: vi.fn(async (): Promise<string> => {
    throw new Error("probed the sidecar");
  }),
}));
vi.mock("../rag/embedder.js", () => ({ getEmbedder: () => embedder }));

import {
  RECENT_WRITE_WINDOW_MS,
  getProjectContentVersion,
  prismaContentVersionSource,
  type ContentVersionDocument as Doc,
  type ContentVersionSource,
} from "./content-version.js";

type Graph = Awaited<ReturnType<ContentVersionSource["codeGraphs"]>>[number];
const WRITTEN = new Date("2026-11-01T00:00:00Z");
/** The clock the versions below are read at: a second after the latest write. */
const AT = new Date(WRITTEN.getTime() + 1_000);
const version = (projectId: string, s: ContentVersionSource, now: Date = AT) =>
  getProjectContentVersion(projectId, s, now);

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
    await version("p1", s);
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
    const a = await version("p", source({ graphs, docs, symbols, chunks }));
    const b = await version(
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
    const v = await version(
      "p",
      source({ graphs: [graph("g1", "r1", "a"), graph("g2", null, "b")] }),
    );
    expect(v.codeShas).toEqual({ r1: "a", "graph:g2": "b" });
    expect(v.complete).toBe(true);
  });

  it("an empty project is complete; a graph with no SHA is not", async () => {
    expect((await version("p", source({}))).complete).toBe(true);
    const v = await version(
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
    const a = await version("p", source(base));
    const b = await version("p", source({ ...base, ...change }));
    expect(b.key).not.toBe(a.key);
  });

  it("two projects with identical content get different keys", async () => {
    const s = { graphs: [graph("g1", "r1", "a")] };
    const a = await version("p1", source(s));
    const b = await version("p2", source(s));
    expect(a.key).not.toBe(b.key);
    expect(a.docsVersion).toBe(b.docsVersion);
  });

  it("#1864 hashes only the rows written within the window before now", async () => {
    const old = new Date(AT.getTime() - RECENT_WRITE_WINDOW_MS - 1);
    const s = source({ docs: [doc("d1"), doc("d0", { updatedAt: old })] });
    const a = await version("p", s);
    expect(s.since).toEqual([new Date(AT.getTime() - RECENT_WRITE_WINDOW_MS)]);
    // A row older than the window is covered by the count and the latest write
    // alone: its state is not read, so a change the database never stamped
    // (impossible through Prisma) would not show.
    const b = await version(
      "p",
      source({ docs: [doc("d1"), doc("d0", { updatedAt: old, status: "failed" })] }),
    );
    expect(b.key).toBe(a.key);
  });

  it("#1944 reads no row once the latest write is older than the window", async () => {
    // A bulk write (a repo sync): many rows in the same minute, then nothing.
    const docs = Array.from({ length: 50 }, (_, i) =>
      doc(`d${i}`, { updatedAt: new Date(WRITTEN.getTime() - i * 100) }),
    );
    const later = new Date(WRITTEN.getTime() + RECENT_WRITE_WINDOW_MS + 1);
    const s = source({ docs });
    const v = await version("p", s, later);
    expect(s.since).toEqual([]);
    // The count and the latest write still stand for the set.
    const fewer = await version("p", source({ docs: docs.slice(1) }), later);
    expect(fewer.key).not.toBe(v.key);
  });

  it("#1944 a minute after a bulk write, rows from the minute before it are not read", async () => {
    const lastMinute = (over: Partial<Doc> = {}) =>
      doc("d0", { updatedAt: new Date(WRITTEN.getTime() - 30_000), ...over });
    const now = new Date(WRITTEN.getTime() + 45_000);
    const s = source({ docs: [doc("d1"), lastMinute()] });
    await version("p", s, now);
    expect(s.since).toEqual([new Date(now.getTime() - RECENT_WRITE_WINDOW_MS)]);
    // d0 was within a minute of the latest write but is 75 s old now: not read.
    const a = await version("p", source({ docs: [doc("d1"), lastMinute()] }), now);
    const b = await version("p", source({ docs: [doc("d1"), lastMinute({ status: "x" })] }), now);
    expect(b.key).toBe(a.key);
  });

  it("#1944 the real source reads the embedder identity without probing the sidecar", async () => {
    embedder.currentIdentity.mockClear();
    // The composite identity, not the bare model: a pooling flip must move the key.
    expect(await prismaContentVersionSource.embedderIdentity()).toBe("m|cls|fp32");
    expect(embedder.currentIdentity).not.toHaveBeenCalled();
  });

  it("#1864 rows written before the column existed (null) are counted, and no rows are read", async () => {
    const s = source({ docs: [doc("d1", { updatedAt: null })] });
    const a = await version("p", s);
    expect(s.since).toEqual([]);
    const none = await version("p", source({}));
    expect(a.docsVersion).not.toBe(none.docsVersion);
  });
});
