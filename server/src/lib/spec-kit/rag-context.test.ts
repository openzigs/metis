/**
 * Epic #712 / Issue #714 — Spec-Kit call-site: fused code retrieval in
 * `buildSpecKitRagContext` (the parallel path to chat's `buildAutoRagContext`).
 *
 * Verifies the same fused-merge contract via the shared helper: flag-off
 * byte-identical + no searcher query; flag-on deduped, locator-bearing block;
 * code-only when doc RAG is empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import { buildSpecKitRagContext, type SpecKitFusedCodeDeps } from "./rag-context.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import type {
  FusedCodeSearcher,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../rag/fused-code-context.js";

afterEach(() => {
  delete process.env.CHAT_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

function knowledgeService(hits: RetrievedChunk[]) {
  return { search: vi.fn().mockResolvedValue({ hits }) };
}

function fused(
  results: RawCodeSymbolHit[],
  lines: Record<string, { filePath: string; startLine: number; endLine: number }>,
): SpecKitFusedCodeDeps & {
  searcher: FusedCodeSearcher & { search: ReturnType<typeof vi.fn> };
} {
  const searcher = { search: vi.fn().mockResolvedValue(results) };
  const lineLookup: SymbolLineLookup = {
    resolve: vi.fn().mockResolvedValue(new Map(Object.entries(lines))),
  };
  return { searcher, lineLookup };
}

const docHit: RetrievedChunk = {
  chunkId: "c1",
  documentId: "d1",
  filename: "connector:repo:cid1:src/main/java/Doc.java",
  position: 0,
  text: "public class Doc {}",
  score: 0.9,
  embeddingModel: "test",
  source: "repo",
};

describe("buildSpecKitRagContext — flag OFF", () => {
  it("returns the doc block only and never queries the searcher", async () => {
    __resetConfigSingleton();
    const deps = fused([{ symbolId: "s1", filePath: "x", name: "Sym", kind: "class", score: 1 }], {
      s1: { filePath: "src/Sym.java", startLine: 1, endLine: 5 },
    });
    const res = await buildSpecKitRagContext("p1", "how does Doc work", {
      knowledgeService: knowledgeService([docHit]),
      fusedCode: deps,
    });

    expect(res.usedChunks).toBe(1);
    expect(res.context).toContain("## Retrieved Project Knowledge (project-scoped RAG)");
    expect(res.context).not.toContain("## Retrieved Code Symbols");
    expect(deps.searcher.search).not.toHaveBeenCalled();
  });
});

describe("buildSpecKitRagContext — flag ON", () => {
  beforeEach(() => {
    process.env.CHAT_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
  });

  it("appends a deduped, locator-bearing symbol block", async () => {
    const deps = fused(
      [
        { symbolId: "s1", filePath: "x", name: "Doc", kind: "class", score: 2 },
        { symbolId: "s2", filePath: "y", name: "Validator", kind: "class", score: 1 },
      ],
      {
        s1: { filePath: "main/java/Doc.java", startLine: 1, endLine: 9 }, // dup of docHit
        s2: { filePath: "src/Validator.java", startLine: 20, endLine: 55 },
      },
    );
    const res = await buildSpecKitRagContext("p1", "validator", {
      knowledgeService: knowledgeService([docHit]),
      fusedCode: deps,
    });

    expect(res.context).toContain("## Retrieved Project Knowledge (project-scoped RAG)");
    expect(res.context).toContain("## Retrieved Code Symbols (project-scoped code graph)");
    expect(res.context).toContain("src/Validator.java:20-55");
    expect(res.context).not.toContain("[1] Doc (class)");
  });

  it("#547 — an upload sharing a repo path does not suppress the code symbol", async () => {
    const deps = fused([{ symbolId: "s1", filePath: "x", name: "Doc", kind: "class", score: 2 }], {
      s1: { filePath: "main/java/Doc.java", startLine: 1, endLine: 9 },
    });
    const upload: RetrievedChunk = { ...docHit, chunkId: "u1", documentId: "u1", source: "upload" };
    const res = await buildSpecKitRagContext("p1", "doc", {
      knowledgeService: knowledgeService([upload]),
      fusedCode: deps,
    });

    expect(res.context).toContain("## Retrieved Code Symbols (project-scoped code graph)");
    expect(res.context).toContain("main/java/Doc.java:1-9");
    expect(res.usedSymbols).toBe(1);
  });

  it("returns a code-only block when doc RAG is empty", async () => {
    const deps = fused(
      [{ symbolId: "s2", filePath: "y", name: "Validator", kind: "class", score: 1 }],
      { s2: { filePath: "src/Validator.java", startLine: 20, endLine: 55 } },
    );
    const res = await buildSpecKitRagContext("p1", "validator", {
      knowledgeService: knowledgeService([]),
      fusedCode: deps,
    });
    expect(res.context).toContain("## Retrieved Code Symbols");
    expect(res.context).not.toContain("## Retrieved Project Knowledge");
    expect(res.usedChunks).toBe(0);
  });

  it("stays ungrounded (empty) when neither index yields a hit", async () => {
    const deps = fused([], {});
    const res = await buildSpecKitRagContext("p1", "nothing", {
      knowledgeService: knowledgeService([]),
      fusedCode: deps,
    });
    expect(res).toEqual({ context: "", usedChunks: 0, usedSymbols: 0 });
  });
});

describe("buildSpecKitRagContext — includeCode (#20)", () => {
  it("queries the code graph with the env flag off and counts the symbols it used", async () => {
    __resetConfigSingleton();
    const deps = fused(
      [{ symbolId: "s1", filePath: "x", name: "parseToolCall", kind: "function", score: 1 }],
      { s1: { filePath: "server/src/lib/analysis/agent-loop.ts", startLine: 1030, endLine: 1088 } },
    );
    const res = await buildSpecKitRagContext("p1", "malformed tool call", {
      knowledgeService: knowledgeService([docHit]),
      fusedCode: deps,
      includeCode: true,
    });
    expect(deps.searcher.search).toHaveBeenCalledOnce();
    expect(res.context).toContain("server/src/lib/analysis/agent-loop.ts:1030-1088");
    expect(res.usedChunks).toBe(1);
    expect(res.usedSymbols).toBe(1);
  });

  it("reports zero symbols when only documents were used", async () => {
    __resetConfigSingleton();
    const res = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: knowledgeService([docHit]),
      fusedCode: fused([], {}),
      includeCode: true,
    });
    expect(res.usedSymbols).toBe(0);
  });
});

function reqChunk(id: string, position: number, documentId = "req"): RetrievedChunk {
  return {
    chunkId: id,
    documentId,
    filename: `${documentId}.md`,
    position,
    text: `${documentId} body ${position}`,
    score: 0.5,
    embeddingModel: "test",
    source: "upload",
  };
}

describe("buildSpecKitRagContext — expandDocuments (#20)", () => {
  const expansion = { maxDocuments: 2, maxChunksPerDocument: 10 };

  function pinningService(top: RetrievedChunk[], byDoc: Record<string, RetrievedChunk[]>) {
    return {
      search: vi.fn(async (_p: string, _q: string, o: { documentIds?: string[] }) =>
        o.documentIds ? { hits: byDoc[o.documentIds[0]!] ?? [] } : { hits: top },
      ),
    };
  }

  it("pins the rest of a retrieved requirements document in position order", async () => {
    const ks = pinningService([reqChunk("r0", 0)], {
      req: [reqChunk("r2", 2), reqChunk("r0", 0), reqChunk("r1", 1)],
    });
    const res = await buildSpecKitRagContext("p1", "tool call recovery", {
      knowledgeService: ks,
      fusedCode: fused([], {}),
      expandDocuments: expansion,
    });
    expect(ks.search).toHaveBeenCalledWith("p1", "tool call recovery", {
      k: 10,
      documentIds: ["req"],
    });
    expect(res.usedChunks).toBe(3);
    const r1 = res.context.indexOf("req.md#1 (pinned");
    const r2 = res.context.indexOf("req.md#2 (pinned");
    expect(r1).toBeGreaterThan(-1);
    expect(r2).toBeGreaterThan(r1);
    expect(res.context.match(/req body 0/g)).toHaveLength(1);
  });

  it("never expands source-file chunks and stops at maxDocuments", async () => {
    const ks = pinningService(
      [docHit, reqChunk("a0", 0, "a"), reqChunk("b0", 0, "b"), reqChunk("c0", 0, "c")],
      { a: [reqChunk("a1", 1, "a")], b: [reqChunk("b1", 1, "b")], c: [reqChunk("c1", 1, "c")] },
    );
    const res = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: ks,
      fusedCode: fused([], {}),
      expandDocuments: expansion,
    });
    const expandedIds = ks.search.mock.calls
      .map((c) => (c[2] as { documentIds?: string[] }).documentIds?.[0])
      .filter(Boolean);
    expect(expandedIds).toEqual(["a", "b"]);
    expect(res.context).toContain("a.md#1 (pinned");
    expect(res.context).not.toContain("c.md#1");
    expect(res.usedChunks).toBe(6);
  });

  // #547 — an upload stored before #540 under a source-file name is a
  // document like any other; its source, not its filename, says so.
  it("expands a connector-shaped upload: only a repo-sourced chunk is source code", async () => {
    const legacy = { ...docHit, documentId: "legacy", chunkId: "l0", source: "upload" as const };
    const ks = pinningService([legacy], { legacy: [{ ...legacy, chunkId: "l1", position: 1 }] });
    await buildSpecKitRagContext("p1", "q", {
      knowledgeService: ks,
      fusedCode: fused([], {}),
      expandDocuments: expansion,
    });
    expect(ks.search).toHaveBeenCalledWith("p1", "q", { k: 10, documentIds: ["legacy"] });
  });

  it("ignores chunks from another document and keeps top-k when expansion fails", async () => {
    const ks = {
      search: vi.fn(async (_p: string, _q: string, o: { documentIds?: string[] }) => {
        if (!o.documentIds) return { hits: [reqChunk("a0", 0, "a"), reqChunk("b0", 0, "b")] };
        if (o.documentIds[0] === "a") throw new Error("store offline");
        return { hits: [reqChunk("x9", 9, "other"), reqChunk("b1", 1, "b")] };
      }),
    };
    const res = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: ks,
      fusedCode: fused([], {}),
      expandDocuments: expansion,
    });
    expect(res.usedChunks).toBe(3);
    expect(res.context).toContain("b.md#1 (pinned");
    expect(res.context).not.toContain("other.md");
  });

  it("does not expand unless asked", async () => {
    const ks = pinningService([reqChunk("r0", 0)], { req: [reqChunk("r1", 1)] });
    const res = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: ks,
      fusedCode: fused([], {}),
    });
    expect(ks.search).toHaveBeenCalledOnce();
    expect(res.usedChunks).toBe(1);
  });
});

describe("buildSpecKitRagContext — repo hits are named by path, scored by rank (#824 item 4)", () => {
  it("prints the repo-relative path and the rank score, marking a keyword-only hit", async () => {
    const hit: RetrievedChunk = {
      ...docHit,
      filename: "connector:repo:cid1:src/internal/storage/entry.go",
      path: "internal/storage/entry.go",
      position: 3,
      score: 0,
      rankScore: 0.0312,
      matchedBy: ["lexical"],
    };
    const res = await buildSpecKitRagContext("p1", "mark all as read", {
      knowledgeService: knowledgeService([hit]),
      fusedCode: fused([], {}),
    });
    expect(res.context).toContain("[1] internal/storage/entry.go#3 (score=0.031, keyword match)");
    expect(res.context).not.toContain("connector:repo:");
    expect(res.context).not.toContain("score=0.000");
  });
});

describe("buildSpecKitRagContext — same-file siblings (#785)", () => {
  const ENTRY = "internal/storage/entry.go";
  type Row = {
    id: string;
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
  };
  const siblingLookup = (rows: Row[]) => ({
    findInFiles: vi.fn(async (_p: string, files: string[]) =>
      rows.filter((r) => files.includes(r.filePath)),
    ),
  });
  const fn = (id: string, name: string, filePath: string, startLine: number): Row => ({
    id,
    name,
    kind: "function",
    filePath,
    startLine,
    endLine: startLine + 14,
  });

  it("lists a same-file function that extends a retrieved name (MarkAllAsReadBeforeDate)", async () => {
    const deps = fused(
      [{ symbolId: "s-mark", filePath: ENTRY, name: "MarkAllAsRead", kind: "function", score: 1 }],
      { "s-mark": { filePath: ENTRY, startLine: 506, endLine: 520 } },
    );
    const lookup = siblingLookup([
      fn("s-mark", "MarkAllAsRead", ENTRY, 506),
      { ...fn("s-before", "MarkAllAsReadBeforeDate", ENTRY, 523), endLine: 544 },
      fn("s-feed", "MarkFeedAsRead", ENTRY, 581),
      fn("s-count", "CountAllEntries", ENTRY, 24),
      fn("s-other", "MarkAllAsReadSoon", "internal/ui/x.go", 1),
    ]);
    const res = await buildSpecKitRagContext("p1", "mark all entries as read older than N days", {
      knowledgeService: knowledgeService([]),
      fusedCode: deps,
      includeCode: true,
      siblings: { lookup },
    });
    expect(res.context).toContain("## Sibling Symbols");
    expect(res.context).toContain(
      `MarkAllAsReadBeforeDate (function) — ${ENTRY}:523-544 (beside MarkAllAsRead)`,
    );
    // Sharing only the verb, or living in another file, is not a sibling.
    expect(res.context).not.toContain("MarkFeedAsRead");
    expect(res.context).not.toContain("CountAllEntries");
    expect(res.context).not.toContain("MarkAllAsReadSoon");
    expect(res.usedSymbols).toBe(2);
    expect(lookup.findInFiles).toHaveBeenCalledWith("p1", [ENTRY]);
  });

  it("adds nothing without the option, and survives a failing lookup", async () => {
    const deps = fused(
      [{ symbolId: "s-mark", filePath: ENTRY, name: "MarkAllAsRead", kind: "function", score: 1 }],
      { "s-mark": { filePath: ENTRY, startLine: 506, endLine: 520 } },
    );
    const off = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: knowledgeService([]),
      fusedCode: deps,
      includeCode: true,
    });
    expect(off.context).not.toContain("## Sibling Symbols");
    const failing = await buildSpecKitRagContext("p1", "q", {
      knowledgeService: knowledgeService([]),
      fusedCode: deps,
      includeCode: true,
      siblings: { lookup: { findInFiles: vi.fn().mockRejectedValue(new Error("db down")) } },
    });
    expect(failing.usedSymbols).toBe(1);
    expect(failing.context).toContain("MarkAllAsRead");
    expect(failing.context).not.toContain("## Sibling Symbols");
  });
});
