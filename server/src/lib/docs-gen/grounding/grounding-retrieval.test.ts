import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildProjectGroundingContext,
  buildSectionGroundingRetriever,
  resolveGroundingK,
  DEFAULT_GROUNDING_K,
  MAX_GROUNDING_K,
  MIN_GROUNDING_K,
  type KnowledgeSearchLike,
  type WebResearchReader,
} from "./grounding-retrieval.js";
import type { EvidenceDigest } from "../../analysis/types/requirements.js";
import type { EvidencePolicy } from "../evidence-policy.js";

const policy: EvidencePolicy = {
  projectId: "p1",
  generatedDocumentId: "gen1",
  actor: { userId: "alice", role: "developer" },
  sharedDocumentIds: [],
  allowWebResearch: true,
};
const searchPolicy = { actor: policy.actor, evidencePolicy: policy };

function knowledge(
  hits: Array<Partial<{ documentId: string; chunkId: string; filename: string; text: string }>>,
): KnowledgeSearchLike {
  return {
    search: vi.fn().mockResolvedValue({
      hits: hits.map((h) => ({
        documentId: h.documentId ?? "doc1",
        chunkId: h.chunkId ?? "c1",
        filename: h.filename ?? "F.ts",
        text: h.text ?? "chunk text",
      })),
    }),
  };
}

function digest(id: string): EvidenceDigest {
  return {
    id,
    requirementId: "r",
    evidenceNeedId: "e",
    query: "q",
    sources: [],
    digest: `digest ${id}`,
    needsHumanReview: false,
  };
}

describe("buildProjectGroundingContext", () => {
  it("merges RAG hits and web digests into one context with stable ids", async () => {
    const reader: WebResearchReader = vi.fn().mockResolvedValue({ digests: [digest("d1")] });
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "billing rules" },
      { knowledge: knowledge([{ documentId: "doc1", chunkId: "c1" }]), readWebResearch: reader },
    );
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["rag:doc1:c1", "web:d1"]);
  });

  it("passes the query and k through to the knowledge service", async () => {
    const k = knowledge([{ documentId: "doc1", chunkId: "c1" }]);
    await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "arch", k: 5 },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    expect(k.search).toHaveBeenCalledWith("p1", "arch", { k: 5, ...searchPolicy });
  });

  it("returns an empty context when query is blank and no web research", async () => {
    const k = knowledge([{ documentId: "doc1", chunkId: "c1" }]);
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "   " },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    expect(ctx.isEmpty).toBe(true);
    expect(k.search).not.toHaveBeenCalled();
  });

  it("survives a RAG retrieval error and still includes web digests", async () => {
    const failing: KnowledgeSearchLike = {
      search: vi.fn().mockRejectedValue(new Error("lance down")),
    };
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "x" },
      {
        knowledge: failing,
        readWebResearch: vi.fn().mockResolvedValue({ digests: [digest("d9")] }),
      },
    );
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["web:d9"]);
  });

  it("survives a web-research read error and still includes RAG chunks", async () => {
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "x" },
      {
        knowledge: knowledge([{ documentId: "doc1", chunkId: "c1" }]),
        readWebResearch: vi.fn().mockRejectedValue(new Error("db down")),
      },
    );
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["rag:doc1:c1"]);
  });

  it("returns empty context when both sources are empty", async () => {
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "x" },
      { knowledge: knowledge([]), readWebResearch: vi.fn().mockResolvedValue({ digests: [] }) },
    );
    expect(ctx.isEmpty).toBe(true);
  });

  it("retrieves with the raised default k (80) when none is given (#264 + recall raise)", async () => {
    const k = knowledge([{ documentId: "doc1", chunkId: "c1" }]);
    await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "arch" },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    expect(k.search).toHaveBeenCalledWith("p1", "arch", {
      k: DEFAULT_GROUNDING_K,
      ...searchPolicy,
    });
    expect(DEFAULT_GROUNDING_K).toBe(80);
  });
});

describe("junk-path filtering of RAG hits (SAS doc-gen fix)", () => {
  it("drops __MACOSX/AppleDouble RAG chunks already in the index", async () => {
    // Mixed hits: one real source chunk + two junk chunks whose connector-
    // prefixed filenames embed `__MACOSX` / `._*`. Junk must never become a
    // citable grounding source even though it's in the vector index.
    const k = knowledge([
      { documentId: "doc1", chunkId: "c1", filename: "connector:repo:abc:src/RISK/load.sas" },
      {
        documentId: "junk1",
        chunkId: "c1",
        filename: "connector:repo:abc:src/__MACOSX/RISK/._load.sas",
      },
      { documentId: "junk2", chunkId: "c1", filename: "connector:repo:abc:src/RISK/._load.sas" },
    ]);
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "load rules" },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    const ids = ctx.sources.map((s) => s.sourceId);
    expect(ids).toEqual(["rag:doc1:c1"]);
    expect(ids).not.toContain("rag:junk1:c1");
    expect(ids).not.toContain("rag:junk2:c1");
  });

  it("drops junk chunks in the per-section retriever too", async () => {
    const k = knowledge([
      { documentId: "real", chunkId: "c1", filename: "connector:repo:abc:src/RISK/load.sas" },
      {
        documentId: "junk",
        chunkId: "c1",
        filename: "connector:repo:abc:src/__MACOSX/RISK/._load.sas",
      },
    ]);
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    const ctx = await retrieve({ id: "rules", query: "rules" });
    expect(ctx?.sources.map((s) => s.sourceId)).toEqual(["rag:real:c1"]);
  });
});

describe("resolveGroundingK (#264)", () => {
  afterEach(() => {
    delete process.env.DOCS_GROUNDING_K;
  });

  it("defaults to 80 with no explicit value and no env", () => {
    delete process.env.DOCS_GROUNDING_K;
    expect(resolveGroundingK()).toBe(80);
    expect(resolveGroundingK()).toBe(DEFAULT_GROUNDING_K);
  });

  it("honors an explicit value over the env/default", () => {
    process.env.DOCS_GROUNDING_K = "99";
    expect(resolveGroundingK(7)).toBe(7);
  });

  it("reads the DOCS_GROUNDING_K env override when no explicit value", () => {
    // In-range value (<= MAX_GROUNDING_K = 80) so this exercises the env path,
    // not the clamp path (covered separately below).
    process.env.DOCS_GROUNDING_K = "30";
    expect(resolveGroundingK()).toBe(30);
  });

  it("ignores a non-numeric / non-positive env and falls back to the default", () => {
    process.env.DOCS_GROUNDING_K = "not-a-number";
    expect(resolveGroundingK()).toBe(DEFAULT_GROUNDING_K);
    process.env.DOCS_GROUNDING_K = "0";
    expect(resolveGroundingK()).toBe(DEFAULT_GROUNDING_K);
  });

  it("clamps an out-of-range env to [MIN, MAX] (80, matching the backend cap)", () => {
    process.env.DOCS_GROUNDING_K = "1000";
    expect(resolveGroundingK()).toBe(MAX_GROUNDING_K);
    // The backend (KnowledgeService.search) re-clamps k to MAX_SEARCH_K (80), so
    // MAX_GROUNDING_K must stay in lock-step at 80 or the raise is a silent no-op.
    expect(resolveGroundingK()).toBe(80);
    expect(MAX_GROUNDING_K).toBe(80);
  });

  it("clamps an out-of-range explicit value to [MIN, MAX]", () => {
    expect(resolveGroundingK(99999)).toBe(MAX_GROUNDING_K);
    expect(resolveGroundingK(99999)).toBe(80);
    expect(resolveGroundingK(MIN_GROUNDING_K)).toBe(MIN_GROUNDING_K);
  });
});

describe("buildSectionGroundingRetriever (#264)", () => {
  afterEach(() => {
    delete process.env.DOCS_GROUNDING_K;
  });

  it("issues the section-topic query (not just the doc title) per section", async () => {
    const k = knowledge([{ documentId: "doc1", chunkId: "c1" }]);
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    await retrieve({ id: "rules", query: "Business Rules & Policies validation thresholds" });
    expect(k.search).toHaveBeenCalledWith("p1", "Business Rules & Policies validation thresholds", {
      k: DEFAULT_GROUNDING_K,
      ...searchPolicy,
    });
  });

  it("merges the doc-level web digests into every section context, fetched once", async () => {
    const reader = vi.fn().mockResolvedValue({ digests: [digest("d1")] });
    const k = knowledge([{ documentId: "doc1", chunkId: "c1" }]);
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy },
      { knowledge: k, readWebResearch: reader },
    );
    const a = await retrieve({ id: "overview", query: "overview" });
    const b = await retrieve({ id: "rules", query: "rules" });
    expect(a?.sources.map((s) => s.sourceId)).toContain("web:d1");
    expect(b?.sources.map((s) => s.sourceId)).toContain("web:d1");
    // Web research read only once across both sections.
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("improves a narrative section's grounding ratio vs the single doc-title query", async () => {
    // A knowledge service that ONLY returns section-relevant chunks when the
    // query mentions the section topic ("domain"), and nothing for a bare
    // doc-title query. This models the #264 root cause directly.
    const sectionChunk = { documentId: "domain", chunkId: "c1", filename: "domain.ts", text: "x" };
    const search = vi.fn(async (_p: string, query: string) => {
      if (query.toLowerCase().includes("domain")) {
        return { hits: [{ ...sectionChunk }] };
      }
      return { hits: [] };
    });
    const knowledgeSvc: KnowledgeSearchLike = { search };
    const reader: WebResearchReader = vi.fn().mockResolvedValue(null);

    // OLD path: one doc-title query → no section-relevant chunks retrieved.
    const docLevel = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "My Doc business requirements" },
      { knowledge: knowledgeSvc, readWebResearch: reader },
    );
    expect(docLevel.isEmpty).toBe(true);

    // NEW path: section-topic query mentions the domain → relevant chunk lands.
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy },
      { knowledge: knowledgeSvc, readWebResearch: reader },
    );
    const sectionCtx = await retrieve({
      id: "overview",
      query: "Overview & Domain business domain actors My Doc",
    });
    expect(sectionCtx?.isEmpty).toBe(false);
    expect(sectionCtx?.sources.map((s) => s.sourceId)).toContain("rag:domain:c1");
  });

  it("survives a RAG failure for one section (still returns a context)", async () => {
    const failing: KnowledgeSearchLike = {
      search: vi.fn().mockRejectedValue(new Error("lance down")),
    };
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy },
      {
        knowledge: failing,
        readWebResearch: vi.fn().mockResolvedValue({ digests: [digest("d2")] }),
      },
    );
    const ctx = await retrieve({ id: "rules", query: "rules" });
    expect(ctx?.sources.map((s) => s.sourceId)).toEqual(["web:d2"]);
  });

  it("respects the DOCS_GROUNDING_K env override for the per-section k", async () => {
    process.env.DOCS_GROUNDING_K = "25";
    const k = knowledge([{ documentId: "doc1", chunkId: "c1" }]);
    const retrieve = buildSectionGroundingRetriever(
      { projectId: "p1", policy },
      { knowledge: k, readWebResearch: vi.fn().mockResolvedValue(null) },
    );
    await retrieve({ id: "overview", query: "overview" });
    expect(k.search).toHaveBeenCalledWith("p1", "overview", { k: 25, ...searchPolicy });
  });
});

describe("required evidence boundary #1353", () => {
  it("rejects missing or foreign-project policy before either retrieval", async () => {
    const deps = { knowledge: knowledge([]), readWebResearch: vi.fn() };
    for (const invalid of [undefined, { ...policy, projectId: "foreign" }]) {
      const input = { projectId: "p1", query: "q", policy: invalid as EvidencePolicy };
      await expect(buildProjectGroundingContext(input, deps)).rejects.toThrow(
        "Generation authorization unavailable",
      );
      expect(() => buildSectionGroundingRetriever(input, deps)).toThrow(
        "Generation authorization unavailable",
      );
    }
    expect(deps.knowledge.search).not.toHaveBeenCalled();
    expect(deps.readWebResearch).not.toHaveBeenCalled();
  });

  it("never reads stored web digests without an explicit opt-in, for either retriever", async () => {
    const deps = {
      knowledge: knowledge([]),
      readWebResearch: vi.fn().mockResolvedValue({ digests: [digest("secret")] }),
    };
    const input = { projectId: "p1", policy: { ...policy, allowWebResearch: false } };
    expect((await buildProjectGroundingContext({ ...input, query: "q" }, deps)).isEmpty).toBe(true);
    const retrieve = buildSectionGroundingRetriever(input, deps);
    expect((await retrieve({ id: "one", query: "q" }))?.isEmpty).toBe(true);
    expect((await retrieve({ id: "two", query: "q" }))?.isEmpty).toBe(true);
    expect(deps.readWebResearch).not.toHaveBeenCalled();
  });

  it("labels explicit references separately from repository evidence", async () => {
    const ctx = await buildProjectGroundingContext(
      { projectId: "p1", policy, query: "q" },
      {
        knowledge: knowledge([
          { documentId: "repo", filename: "connector:repo:a:src/a.ts" },
          { documentId: "reference", filename: "glossary.md" },
        ]),
        readWebResearch: vi.fn().mockResolvedValue(null),
      },
    );
    expect(ctx.sources.map((s) => s.evidenceClass)).toEqual([
      "repository-source",
      "project-reference",
    ]);
  });
});
