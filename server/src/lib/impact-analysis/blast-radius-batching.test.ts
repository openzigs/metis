/**
 * Perf fix for the gap-report event-loop stall (epic #820 follow-up): the
 * blast-radius BFS issued one `getEdgesTo` query PER frontier node (N+1), which
 * on the synchronous SQLite dev driver blocked for ~8s and starved concurrent
 * requests. It now fetches the whole frontier's edges in one batched call per
 * depth. These tests pin BOTH invariants: the batched path returns the SAME
 * radius as the per-node path (behaviour-preserving), and it really batches
 * (one `getEdgesToMany` per depth, not per node).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory graph fakes */
import { describe, expect, it, vi } from "vitest";
import { blastRadius } from "./blast-radius.js";
import { CachingCodeGraphDataSource, type GraphEdge } from "../code-graph/query-service.js";

// A small graph: seed `a`; callers b,c → a (depth 1); d → b (depth 2); e → d (depth 3).
const EDGES: GraphEdge[] = [
  { id: "e1", fromSymbolId: "b", toSymbolId: "a", kind: "calls" },
  { id: "e2", fromSymbolId: "c", toSymbolId: "a", kind: "imports" },
  { id: "e3", fromSymbolId: "d", toSymbolId: "b", kind: "calls" },
  { id: "e4", fromSymbolId: "e", toSymbolId: "d", kind: "references" },
];
const SYM = (id: string) => ({
  id,
  qualifiedName: id,
  kind: "function",
  filePath: `${id}.ts`,
  language: "ts",
  startLine: 1,
  endLine: 2,
});

/** Per-node source only (no batched methods) → exercises the fallback path. */
function perNodeSource() {
  return {
    getSymbol: async (id: string) => SYM(id),
    getEdgesFrom: async (id: string) => EDGES.filter((e) => e.fromSymbolId === id),
    getEdgesTo: async (id: string) => EDGES.filter((e) => e.toSymbolId === id),
    getSymbolsByFile: async () => [],
    getSymbolsByIds: async (ids: string[]) => ids.map(SYM),
  };
}

/** Batched source that counts how many times each edge method is called. */
function batchedSource() {
  const calls = { to: 0, toMany: 0 };
  return {
    calls,
    src: {
      getSymbol: async (id: string) => SYM(id),
      getEdgesFrom: async (id: string) => EDGES.filter((e) => e.fromSymbolId === id),
      getEdgesTo: async (id: string) => {
        calls.to++;
        return EDGES.filter((e) => e.toSymbolId === id);
      },
      getEdgesToMany: async (ids: string[]) => {
        calls.toMany++;
        return EDGES.filter((e) => ids.includes(e.toSymbolId));
      },
      getEdgesFromMany: async (ids: string[]) => EDGES.filter((e) => ids.includes(e.fromSymbolId)),
      getSymbolsByFile: async () => [],
      getSymbolsByIds: async (ids: string[]) => ids.map(SYM),
    },
  };
}

describe("blastRadius batching (perf) is behaviour-preserving", () => {
  it("batched path returns the SAME radius as the per-node fallback", async () => {
    const opts = { maxDepth: 3, minConfidence: 0 } as const;
    const perNode = await blastRadius(perNodeSource() as any, ["a"], opts);
    const batched = await blastRadius(batchedSource().src as any, ["a"], opts);
    const key = (r: any) => `${r.codeSymbolId}:${r.depth}:${r.relation}:${r.confidence.toFixed(6)}`;
    expect(new Set(batched.map(key))).toEqual(new Set(perNode.map(key)));
    // sanity: transitive callers b,c (d1), d (d2), e (d3) at maxDepth 3
    expect(batched.map((r) => r.codeSymbolId).sort()).toEqual(["b", "c", "d", "e"]);
  });

  it("issues ONE getEdgesToMany per depth level, not one getEdgesTo per node", async () => {
    const { calls, src } = batchedSource();
    await blastRadius(src as any, ["a"], { maxDepth: 3, minConfidence: 0 });
    // depth 0 frontier {a}, depth 1 {b,c}, depth 2 {d} → 3 batched calls; 0 per-node.
    expect(calls.toMany).toBe(3);
    expect(calls.to).toBe(0);
  });
});

describe("CachingCodeGraphDataSource", () => {
  it("memoizes per-node lookups (inner queried once per distinct node)", async () => {
    const inner = perNodeSource();
    const spy = vi.spyOn(inner, "getEdgesTo");
    const cached = new CachingCodeGraphDataSource(inner as any);
    await cached.getEdgesTo("a");
    await cached.getEdgesTo("a");
    await cached.getEdgesTo("b");
    expect(spy).toHaveBeenCalledTimes(2); // 'a' cached on the 2nd call
  });

  it("getEdgesToMany batches misses through the inner batched method and caches per node", async () => {
    const base = batchedSource();
    const cached = new CachingCodeGraphDataSource(base.src as any);
    const first = await cached.getEdgesToMany(["a", "b"]);
    expect(base.calls.toMany).toBe(1);
    expect(first.map((e) => e.id).sort()).toEqual(["e1", "e2", "e3"]); // →a: e1,e2 ; →b: e3
    // second call for an already-cached node makes NO new inner call
    await cached.getEdgesToMany(["a"]);
    expect(base.calls.toMany).toBe(1);
  });
});
