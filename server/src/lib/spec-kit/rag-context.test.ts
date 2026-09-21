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
    expect(res).toEqual({ context: "", usedChunks: 0 });
  });
});
