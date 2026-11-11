/**
 * #2240 — `buildAutoRagContext` searches with the conversation: the user's own
 * words first, each part of a multi-part question, a follow-up read with the
 * turn before it, fused into one list; excerpts the previous answer cited are
 * kept; attached documents limit the search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { search, findUnique, loadChunksById } = vi.hoisted(() => ({
  search: vi.fn(),
  findUnique: vi.fn(),
  loadChunksById: vi.fn(),
}));

vi.mock("../lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search }),
}));
vi.mock("../lib/rag/chunk-lookup.js", () => ({ loadChunksById }));
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findUnique },
    // #2248 — the requester must be a live user, or retrieval fails closed.
    user: { findFirst: async () => ({ id: "u1", authRoleAuthority: null }) },
    userRole: { findMany: async () => [] },
  },
}));

import type { RetrievedChunk } from "@metis/shared";
import type { ChatMessage } from "../lib/ai/types.js";
import { __resetConfigSingleton } from "../lib/config/config-service.js";
import type { FusedCodeDeps, RagContextCapture, buildAutoRagContext as Build } from "./ai.js";

let buildAutoRagContext: typeof Build;
let RETRIEVAL_FAILED_BLOCK: string;
let insufficientEvidenceBlock: (name: string, n: number) => string;

function hit(id: string, text = `text of ${id}`, filename = `${id}.md`): RetrievedChunk {
  return {
    chunkId: id,
    documentId: `d-${id}`,
    filename,
    position: 0,
    text,
    // #2241 — above chat's relevance floor, so the floor keeps every excerpt here.
    score: 0.9,
    embeddingModel: "test",
    source: "upload",
  };
}

function deps(): FusedCodeDeps & { searcher: { search: ReturnType<typeof vi.fn> } } {
  return {
    searcher: { search: vi.fn().mockResolvedValue([]) },
    lineLookup: { resolve: vi.fn().mockResolvedValue(new Map()) },
  };
}

const capture = (): RagContextCapture => ({ contexts: [], sources: 0 });

beforeEach(async () => {
  ({ buildAutoRagContext, RETRIEVAL_FAILED_BLOCK, insufficientEvidenceBlock } =
    await import("./ai.js"));
  search.mockReset();
  loadChunksById.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue({ name: "Reader" });
});

afterEach(() => {
  delete process.env.CHAT_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

const followUp: ChatMessage[] = [
  { role: "user", content: "How does the refund rule work?" },
  { role: "assistant", content: "Which product do you mean, Reader or Server?" },
  { role: "user", content: "product B" },
];

describe("buildAutoRagContext — conversation-aware searches (#2240)", () => {
  it("searches a follow-up with its own words AND with the turn before it", async () => {
    search.mockResolvedValue({ hits: [] });
    await buildAutoRagContext("p1", followUp, "u1", deps());
    const queries = search.mock.calls.map((c) => c[1]);
    expect(queries).toEqual([
      "product B",
      "product B\nWhich product do you mean, Reader or Server?\nHow does the refund rule work?",
    ]);
    for (const c of search.mock.calls) expect(c[0]).toBe("p1");
  });

  it("fuses the searches: excerpts both found lead, then each list's best in turn", async () => {
    search.mockImplementation(async (_p: string, q: string) => ({
      hits: q === "product B" ? [hit("noise"), hit("both")] : [hit("refund-b"), hit("both")],
    }));
    const cap = capture();
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), cap);
    expect(cap.excerpts!.map((e) => e.chunkId)).toEqual(["both", "noise", "refund-b"]);
    expect(out.indexOf("text of both")).toBeLessThan(out.indexOf("text of noise"));
    expect(out).toContain("[3] refund-b.md#0");
  });

  it("keeps at most eight fused excerpts", async () => {
    search.mockImplementation(async (_p: string, q: string) => ({
      hits: Array.from({ length: 8 }, (_, i) => hit(`${q.length}-${i}`)),
    }));
    const cap = capture();
    await buildAutoRagContext("p1", followUp, "u1", deps(), cap);
    expect(cap.sources).toBe(8);
  });

  // PR #2266 panel — after a refund answer that ended on a question, a new
  // question about password resets retrieved refund excerpts.
  it("searches a new, self-contained question alone after an answer that asked something", async () => {
    search.mockImplementation(async (_p: string, q: string) => ({
      hits: q.includes("refund") ? [hit("refund-1"), hit("refund-2")] : [hit("reset-1")],
    }));
    const cap = capture();
    await buildAutoRagContext(
      "p1",
      [
        { role: "user", content: "How does the refund rule work?" },
        {
          role: "assistant",
          content: "Refunds are issued within 30 days [1]. Would you like more detail?",
        },
        { role: "user", content: "Describe the password reset flow for administrators" },
      ],
      "u1",
      deps(),
      cap,
    );
    expect(search.mock.calls.map((c) => c[1])).toEqual([
      "Describe the password reset flow for administrators",
    ]);
    expect(cap.excerpts!.map((e) => e.chunkId)).toEqual(["reset-1"]);
  });

  it("gives the earlier topic at most 3 of the 8 slots on a follow-up", async () => {
    search.mockImplementation(async (_p: string, q: string) => ({
      hits: Array.from({ length: 8 }, (_, i) =>
        hit(q === "product B" ? `own-${i}` : `earlier-${i}`),
      ),
    }));
    const cap = capture();
    await buildAutoRagContext("p1", followUp, "u1", deps(), cap);
    const ids = cap.excerpts!.map((e) => e.chunkId);
    expect(ids).toHaveLength(8);
    expect(ids.filter((id) => id.startsWith("earlier-")).length).toBeLessThanOrEqual(3);
    expect(ids[0]).toBe("own-0");
  });

  it("searches each part of a multi-part question", async () => {
    search.mockResolvedValue({ hits: [] });
    await buildAutoRagContext(
      "p1",
      [{ role: "user", content: "What changes in Reader? What changes in Server?" }],
      "u1",
      deps(),
    );
    expect(search.mock.calls.map((c) => c[1])).toEqual([
      "What changes in Reader? What changes in Server?",
      "What changes in Reader?",
      "What changes in Server?",
    ]);
  });

  it("gives the code search the conversation too", async () => {
    process.env.CHAT_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    search.mockResolvedValue({ hits: [] });
    const d = deps();
    await buildAutoRagContext("p1", followUp, "u1", d);
    expect(d.searcher.search).toHaveBeenCalledWith(
      expect.stringContaining("How does the refund rule work?"),
      "p1",
      expect.anything(),
    );
  });
});

describe("buildAutoRagContext — cited excerpts carry forward (#2240)", () => {
  it("keeps the excerpts the previous answer cited, after the fresh ones, marked as such", async () => {
    search.mockResolvedValue({ hits: [hit("fresh")] });
    loadChunksById.mockResolvedValue([hit("cited", "the 30-day refund rule")]);
    const cap = capture();
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), cap, {
      carryForward: ["cited"],
    });
    expect(loadChunksById).toHaveBeenCalledWith("p1", ["cited"], { userId: "u1", role: "reader" });
    expect(out).toContain("[2] cited.md#0 (cited in your previous answer)\nthe 30-day refund rule");
    expect(out).toContain('An excerpt marked "cited in your previous answer"');
    expect(cap.sources).toBe(2);
    expect(cap.excerpts!.map((e) => [e.n, e.chunkId])).toEqual([
      [1, "fresh"],
      [2, "cited"],
    ]);
  });

  it("carries only excerpts of the attached documents when documents are attached", async () => {
    search.mockResolvedValue({ hits: [hit("fresh")] });
    loadChunksById.mockResolvedValue([hit("other-doc"), hit("attached-doc")]);
    const cap = capture();
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), cap, {
      carryForward: ["other-doc", "attached-doc"],
      documentIds: ["d-attached-doc"],
    });
    expect(out).toContain("every excerpt below comes from them");
    expect(out).toContain("attached-doc.md#0 (cited in your previous answer)");
    expect(out).not.toContain("other-doc.md");
    expect(cap.excerpts!.map((e) => e.chunkId)).toEqual(["fresh", "attached-doc"]);
  });

  it("lists an excerpt once when the fresh search found it again", async () => {
    search.mockResolvedValue({ hits: [hit("cited")] });
    loadChunksById.mockResolvedValue([hit("cited")]);
    const cap = capture();
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), cap, {
      carryForward: ["cited"],
    });
    expect(cap.sources).toBe(1);
    expect(out).not.toContain("cited in your previous answer");
  });

  it("grounds a turn on carried excerpts alone when the search finds nothing", async () => {
    search.mockResolvedValue({ hits: [] });
    loadChunksById.mockResolvedValue([hit("cited")]);
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), capture(), {
      carryForward: ["cited"],
    });
    expect(out).toContain("[1] cited.md#0 (cited in your previous answer)");
  });

  it("keeps the fresh retrieval when the cited excerpts cannot be read", async () => {
    search.mockResolvedValue({ hits: [hit("fresh")] });
    loadChunksById.mockRejectedValue(new Error("db down"));
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), capture(), {
      carryForward: ["cited"],
    });
    expect(out).toContain("text of fresh");
  });

  it("reads nothing back when there is nothing to carry", async () => {
    search.mockResolvedValue({ hits: [hit("fresh")] });
    await buildAutoRagContext("p1", followUp, "u1", deps(), capture(), { carryForward: [] });
    expect(loadChunksById).not.toHaveBeenCalled();
  });

  it("empties the capture's excerpts when retrieval fails", async () => {
    search.mockRejectedValue(new Error("search down"));
    const cap: RagContextCapture = {
      contexts: ["stale"],
      sources: 1,
      excerpts: [{ n: 1, chunkId: "x", name: "x", locator: "x#0" }],
    };
    // #2241 — the model is told the search failed, and the capture says so.
    expect(await buildAutoRagContext("p1", followUp, "u1", deps(), cap)).toBe(
      RETRIEVAL_FAILED_BLOCK,
    );
    expect(cap).toEqual({ contexts: [], sources: 0, failed: true });
  });
});

describe("buildAutoRagContext — attached documents (#2240)", () => {
  it("limits every search to the attached documents and says so; no code-graph search", async () => {
    process.env.CHAT_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    search.mockResolvedValue({ hits: [hit("frd")] });
    const d = deps();
    const out = await buildAutoRagContext("p1", followUp, "u1", d, capture(), {
      documentIds: ["d-frd"],
    });
    for (const c of search.mock.calls) {
      expect(c[2]).toMatchObject({ k: 8, documentIds: ["d-frd"] });
    }
    expect(out).toContain("The user attached documents to this question");
    expect(d.searcher.search).not.toHaveBeenCalled();
  });

  it("searches the whole project when nothing is attached", async () => {
    search.mockResolvedValue({ hits: [hit("a")] });
    const out = await buildAutoRagContext("p1", followUp, "u1", deps(), capture(), {
      documentIds: [],
    });
    for (const c of search.mock.calls) expect(c[2]).not.toHaveProperty("documentIds");
    expect(out).not.toContain("attached");
  });
});

describe("buildAutoRagContext — relevance floor (#2241)", () => {
  const question: ChatMessage[] = [{ role: "user", content: "How does the refund rule work?" }];
  const scored = (id: string, score: number): RetrievedChunk => ({
    ...hit(id),
    score,
    matchedBy: ["dense"],
  });

  afterEach(() => {
    delete process.env.CHAT_RETRIEVAL_MIN_SCORE;
    __resetConfigSingleton();
  });

  it("keeps a weak match out of the prompt and records it, with each excerpt's relevance", async () => {
    search.mockResolvedValue({ hits: [scored("strong", 0.72), scored("weak", 0.41)] });
    const cap = capture();
    const out = await buildAutoRagContext("p1", question, "u1", deps(), cap);
    expect(out).toContain("text of strong");
    expect(out).not.toContain("text of weak");
    expect(cap.sources).toBe(1);
    expect(cap.belowFloor).toBe(1);
    expect(cap.excerpts).toEqual([
      { n: 1, chunkId: "strong", name: "strong.md", locator: "strong.md#0", relevance: 0.72 },
    ]);
  });

  it("tells the model the sources don't support an answer when every match is too weak", async () => {
    search.mockResolvedValue({ hits: [scored("a", 0.3), scored("b", 0.2)] });
    const cap = capture();
    const out = await buildAutoRagContext("p1", question, "u1", deps(), cap);
    expect(out).toBe(insufficientEvidenceBlock("Reader", 2));
    expect(out).toContain("2 closest matches were too weak");
    expect(out).toContain(`say that "Reader"'s sources don't show this`);
    expect(out).not.toContain("text of a");
    expect(cap).toEqual({ contexts: [], sources: 0, belowFloor: 2 });
  });

  it("says nothing when the search found nothing at all", async () => {
    search.mockResolvedValue({ hits: [] });
    const cap = capture();
    expect(await buildAutoRagContext("p1", question, "u1", deps(), cap)).toBe("");
    expect(cap).toEqual({ contexts: [], sources: 0 });
  });

  it("records a partial coverage the search reported", async () => {
    search.mockResolvedValue({
      hits: [scored("a", 0.8)],
      coverageWarning: {
        totalChunks: 10,
        matchingChunks: 6,
        mismatchedModels: ["old"],
        currentModel: "new",
      },
    });
    const cap = capture();
    await buildAutoRagContext("p1", question, "u1", deps(), cap);
    expect(cap.coverage).toEqual({ matchingChunks: 6, totalChunks: 10 });
  });

  it("keeps every match when the floor is configured off", async () => {
    process.env.CHAT_RETRIEVAL_MIN_SCORE = "0";
    __resetConfigSingleton();
    search.mockResolvedValue({ hits: [scored("weak", 0.2)] });
    const cap = capture();
    const out = await buildAutoRagContext("p1", question, "u1", deps(), cap);
    expect(out).toContain("text of weak");
    expect(cap.belowFloor).toBeUndefined();
  });
});
