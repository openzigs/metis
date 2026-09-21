/**
 * Tests for the grounded retrieval module (Epic #912 — #913 through #919).
 *
 * Covers query derivation from project metadata + operator notes, multi-query
 * fusion, documentIds honouring, per-requirement retrieval (fan-out cap +
 * concurrency), cross-encoder rerank wiring, and offline-safe HyDE gating.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import type {
  KnowledgeService,
  SearchOptions,
  SearchResult,
} from "../src/lib/rag/knowledge-service.js";
import type { RetrievedChunk } from "@metis/shared";
import type { Reranker, RerankCandidate } from "../src/lib/rag/reranker.js";
import {
  buildRetrievalQueries,
  CODE_REQUIREMENTS_QUERY,
  deriveRetrievalQuery,
  maybeGenerateHydeQuery,
  retrievePerRequirement,
  RETRIEVAL_QUERIES,
  runGroundedRetrieval,
} from "../src/lib/analysis/retrieval.js";

// ── Mock knowledge service ───────────────────────────────────────────────────

interface SearchCall {
  query: string;
  opts?: SearchOptions;
}

const chunk = (overrides: Partial<RetrievedChunk> & { chunkId: string }): RetrievedChunk => ({
  documentId: `doc-${overrides.chunkId}`,
  filename: `file-${overrides.chunkId}.md`,
  position: 0,
  text: `text for ${overrides.chunkId}`,
  score: 1,
  embeddingModel: "stub",
  ...overrides,
});

/** A knowledge service whose `search` returns canned hits per query. */
function makeKnowledge(responder: (query: string, opts?: SearchOptions) => RetrievedChunk[]): {
  knowledge: KnowledgeService;
  calls: SearchCall[];
} {
  const calls: SearchCall[] = [];
  const knowledge = {
    search: vi.fn(
      async (_projectId: string, query: string, opts?: SearchOptions): Promise<SearchResult> => {
        calls.push({ query, opts });
        return { hits: responder(query, opts), mode: "hybrid" };
      },
    ),
  } as unknown as KnowledgeService;
  return { knowledge, calls };
}

// ── deriveRetrievalQuery (#914 / #915) ───────────────────────────────────────

describe("deriveRetrievalQuery", () => {
  it("composes project metadata and operator notes", () => {
    const q = deriveRetrievalQuery({
      projectName: "Acme Billing",
      projectDescription: "A monolith that handles invoicing",
      extraInstructions: "Verify GDPR deletion support",
      fallback: "STATIC",
    });
    expect(q).toContain("Acme Billing");
    expect(q).toContain("monolith");
    expect(q).toContain("GDPR");
    expect(q).not.toBe("STATIC");
  });

  it("falls back to the static bag when all metadata is empty", () => {
    expect(
      deriveRetrievalQuery({
        projectName: "",
        projectDescription: "   ",
        extraInstructions: null,
        fallback: "STATIC",
      }),
    ).toBe("STATIC");
  });

  it("includes only non-empty fields", () => {
    const q = deriveRetrievalQuery({
      projectName: "Acme",
      projectDescription: "",
      extraInstructions: undefined,
      fallback: "STATIC",
    });
    expect(q).toBe("Acme");
  });
});

// ── buildRetrievalQueries (#917) ─────────────────────────────────────────────

describe("buildRetrievalQueries", () => {
  it("derives a query, adds operator notes and requirement texts, and keeps the static bag", () => {
    const queries = buildRetrievalQueries({
      agentKey: "document",
      projectName: "Acme",
      projectDescription: "billing monolith",
      extraInstructions: "check refunds",
      requirementTexts: ["System must support partial refunds"],
    });
    expect(queries[0]).toContain("Acme");
    expect(queries).toContain("check refunds");
    expect(queries).toContain("System must support partial refunds");
    expect(queries).toContain(RETRIEVAL_QUERIES.document);
  });

  it("falls back to the static bag when metadata is empty", () => {
    const queries = buildRetrievalQueries({ agentKey: "database" });
    expect(queries).toEqual([RETRIEVAL_QUERIES.database]);
  });

  it("honours a custom static bag override", () => {
    const queries = buildRetrievalQueries({
      agentKey: "code",
      staticBag: CODE_REQUIREMENTS_QUERY,
    });
    expect(queries).toEqual([CODE_REQUIREMENTS_QUERY]);
  });

  it("caps the number of queries", () => {
    const queries = buildRetrievalQueries({
      agentKey: "document",
      projectName: "Acme",
      extraInstructions: "note",
      requirementTexts: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"],
      maxQueries: 3,
    });
    expect(queries).toHaveLength(3);
  });

  it("de-duplicates case-insensitively", () => {
    const queries = buildRetrievalQueries({
      agentKey: "document",
      projectName: "Acme",
      requirementTexts: ["acme", "ACME"],
    });
    const lower = queries.map((q) => q.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});

// ── runGroundedRetrieval (#917 / #918 / #919) ────────────────────────────────

describe("runGroundedRetrieval", () => {
  it("forwards documentIds to every search call (#913)", async () => {
    const { knowledge, calls } = makeKnowledge(() => [chunk({ chunkId: "a" })]);
    await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1", "q2"],
      documentIds: ["doc-keep-1", "doc-keep-2"],
      rerank: false,
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.opts?.documentIds).toEqual(["doc-keep-1", "doc-keep-2"]);
    }
  });

  it("fuses results across multiple queries", async () => {
    const { knowledge } = makeKnowledge((q) =>
      q === "q1"
        ? [chunk({ chunkId: "a" }), chunk({ chunkId: "b" })]
        : [chunk({ chunkId: "c" }), chunk({ chunkId: "a" })],
    );
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1", "q2"],
      rerank: false,
    });
    const ids = out.map((c) => c.documentId);
    // chunk "a" appears in both lists → ranks first after RRF.
    expect(ids[0]).toBe("doc-a");
    expect(new Set(ids)).toEqual(new Set(["doc-a", "doc-b", "doc-c"]));
  });

  it("trims to the requested top-k after fusion (#918)", async () => {
    const { knowledge } = makeKnowledge(() => [
      chunk({ chunkId: "a" }),
      chunk({ chunkId: "b" }),
      chunk({ chunkId: "c" }),
      chunk({ chunkId: "d" }),
    ]);
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1"],
      k: 2,
      rerank: false,
    });
    expect(out).toHaveLength(2);
  });

  it("de-duplicates by documentId:position", async () => {
    const { knowledge } = makeKnowledge(() => [
      chunk({ chunkId: "a", documentId: "doc-x", position: 3 }),
      chunk({ chunkId: "b", documentId: "doc-x", position: 3 }),
    ]);
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1"],
      rerank: false,
    });
    expect(out).toHaveLength(1);
  });

  it("reranks the fused pool when rerank is enabled (#919)", async () => {
    const { knowledge } = makeKnowledge(() => [
      chunk({ chunkId: "a" }),
      chunk({ chunkId: "b" }),
      chunk({ chunkId: "c" }),
    ]);
    // Reverses the candidate order so we can observe the effect.
    const reranker: Reranker = {
      enabled: true,
      rerank: vi.fn(async (_q: string, cands: RerankCandidate[]) => [...cands].reverse()),
    };
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1"],
      rerank: true,
      reranker,
    });
    expect(reranker.rerank).toHaveBeenCalledOnce();
    expect(out[0].documentId).toBe("doc-c");
  });

  it("keeps fused order when the reranker is disabled", async () => {
    const { knowledge } = makeKnowledge(() => [chunk({ chunkId: "a" }), chunk({ chunkId: "b" })]);
    const reranker: Reranker = {
      enabled: false,
      rerank: vi.fn(async (_q, cands) => [...cands].reverse()),
    };
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1"],
      rerank: true,
      reranker,
    });
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(out[0].documentId).toBe("doc-a");
  });

  it("falls back to fused order when the reranker throws", async () => {
    const { knowledge } = makeKnowledge(() => [chunk({ chunkId: "a" }), chunk({ chunkId: "b" })]);
    const reranker: Reranker = {
      enabled: true,
      rerank: vi.fn(async () => {
        throw new Error("rerank backend down");
      }),
    };
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["q1"],
      rerank: true,
      reranker,
    });
    expect(out.map((c) => c.documentId)).toEqual(["doc-a", "doc-b"]);
  });

  it("returns nothing for an all-empty query list", async () => {
    const { knowledge, calls } = makeKnowledge(() => [chunk({ chunkId: "a" })]);
    const out = await runGroundedRetrieval(knowledge, {
      projectId: "p1",
      queries: ["", "   "],
      rerank: false,
    });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ── retrievePerRequirement (#916) ────────────────────────────────────────────

describe("retrievePerRequirement", () => {
  it("searches with each requirement's text and filters to documentIds", async () => {
    const { knowledge, calls } = makeKnowledge((q) => [chunk({ chunkId: q })]);
    const out = await retrievePerRequirement(knowledge, {
      projectId: "p1",
      requirements: [
        { id: "REQ-001", text: "must encrypt at rest" },
        { id: "REQ-002", text: "must log access" },
      ],
      documentIds: ["doc-sel"],
    });
    expect(out).toHaveLength(2);
    expect(out[0].requirementId).toBe("REQ-001");
    expect(out[1].requirementId).toBe("REQ-002");
    const queried = calls.map((c) => c.query).sort();
    expect(queried).toEqual(["must encrypt at rest", "must log access"]);
    for (const c of calls) expect(c.opts?.documentIds).toEqual(["doc-sel"]);
  });

  it("caps the requirement fan-out", async () => {
    const { knowledge, calls } = makeKnowledge(() => [chunk({ chunkId: "a" })]);
    const requirements = Array.from({ length: 10 }, (_, i) => ({
      id: `REQ-${i}`,
      text: `requirement ${i}`,
    }));
    await retrievePerRequirement(knowledge, {
      projectId: "p1",
      requirements,
      maxRequirements: 3,
    });
    expect(calls).toHaveLength(3);
  });

  it("skips blank requirement texts", async () => {
    const { knowledge, calls } = makeKnowledge(() => [chunk({ chunkId: "a" })]);
    const out = await retrievePerRequirement(knowledge, {
      projectId: "p1",
      requirements: [
        { id: "REQ-001", text: "real one" },
        { id: "REQ-002", text: "   " },
      ],
    });
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const knowledge = {
      search: vi.fn(async (): Promise<SearchResult> => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { hits: [], mode: "hybrid" };
      }),
    } as unknown as KnowledgeService;
    const requirements = Array.from({ length: 8 }, (_, i) => ({ id: `R${i}`, text: `t${i}` }));
    await retrievePerRequirement(knowledge, {
      projectId: "p1",
      requirements,
      concurrency: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

// ── maybeGenerateHydeQuery (#917 — offline-safe) ─────────────────────────────

function makeProvider(
  offline: boolean,
  handler?: (m: ChatMessage[]) => Promise<ChatResponse>,
): AIProvider {
  return {
    key: "stub",
    model: "stub",
    offline,
    chat: vi.fn(
      handler ??
        (async () => ({
          content: "Hypothetical passage describing the feature.",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "stub",
          provider: "offline-stub",
        })),
    ),
  } as unknown as AIProvider;
}

describe("maybeGenerateHydeQuery", () => {
  it("returns null without calling the provider when offline", async () => {
    const provider = makeProvider(true);
    const out = await maybeGenerateHydeQuery(provider, "encrypt data at rest");
    expect(out).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns the generated passage when online", async () => {
    const provider = makeProvider(false);
    const out = await maybeGenerateHydeQuery(provider, "encrypt data at rest");
    expect(out).toContain("Hypothetical passage");
  });

  it("returns null (no throw) when the provider fails", async () => {
    const provider = makeProvider(false, async () => {
      throw new Error("model unavailable");
    });
    const out = await maybeGenerateHydeQuery(provider, "topic");
    expect(out).toBeNull();
  });

  it("returns null for an empty seed", async () => {
    const provider = makeProvider(false);
    const out = await maybeGenerateHydeQuery(provider, "   ");
    expect(out).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });
});
