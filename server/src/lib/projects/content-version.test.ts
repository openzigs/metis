/**
 * #1843 — `getProjectContentVersion` over a stub source: what the key depends
 * on, and what it must not. The real queries run in
 * `tests/tool-result-cache-1843.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { getProjectContentVersion, type ContentVersionSource } from "./content-version.js";

type Graph = Awaited<ReturnType<ContentVersionSource["codeGraphs"]>>[number];
type Doc = Awaited<ReturnType<ContentVersionSource["documents"]>>[number];

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
  ...over,
});

function source(input: {
  graphs?: Graph[];
  docs?: Doc[];
  symbols?: Array<{ model: string; count: number }>;
  model?: string;
}): ContentVersionSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    codeGraphs: async (p) => (asked.push(p), input.graphs ?? []),
    documents: async (p) => (asked.push(p), input.docs ?? []),
    symbolEmbeddingCounts: async (p) => (asked.push(p), input.symbols ?? []),
    embedderModel: () => input.model ?? "m",
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
    const a = await getProjectContentVersion("p", source({ graphs, docs, symbols }));
    const b = await getProjectContentVersion(
      "p",
      source({
        graphs: [...graphs].reverse(),
        docs: [...docs].reverse(),
        symbols: [...symbols].reverse(),
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

  it.each<[string, Parameters<typeof source>[0]]>([
    ["a commit", { graphs: [graph("g1", "r1", "z")] }],
    ["a document", { docs: [doc("d1", { checksum: "other" })] }],
    ["the symbol embeddings", { symbols: [{ model: "m", count: 2 }] }],
    ["the embedder model", { model: "other-model" }],
  ])("changes with %s", async (_label, change) => {
    const base = {
      graphs: [graph("g1", "r1", "a")],
      docs: [doc("d1")],
      symbols: [{ model: "m", count: 1 }],
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
});
