/**
 * Issue #283 part (c) — opt-in domain web-research grounding for doc generation.
 *
 * These tests MOCK the augmenter and the analysis-service persistence — NO live
 * network and NO real DB. They assert:
 *  - the synthetic domain requirement is shaped to drive the augmenter at the
 *    project's business domain,
 *  - successful research is persisted into the grounding store (the same store
 *    `getLatestWebResearch` reads), so digests flow into per-section grounding,
 *  - a research failure NEVER throws (best-effort — doc gen proceeds ungrounded),
 *  - empty research is NOT persisted (so it can't shadow a richer prior record),
 *  - the default path makes NO web calls unless an augmenter is actually run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StructuredRequirement,
  WebResearchResult,
  EvidenceDigest,
} from "../../analysis/types/requirements.js";

// ── analysis-service mock (persistence) ─────────────────────────────────
const mockCreateAnalysis = vi.fn();
const mockPersistEnhancement = vi.fn();
const mockMarkCompleted = vi.fn();

vi.mock("../../analysis/analysis-service.js", () => ({
  createAnalysis: (...a: unknown[]) => mockCreateAnalysis(...a),
  persistAnalysisEnhancement: (...a: unknown[]) => mockPersistEnhancement(...a),
  markAnalysisCompleted: (...a: unknown[]) => mockMarkCompleted(...a),
}));

// ── prisma mock (the synthetic analysis tag update) ─────────────────────
const mockAnalysisUpdate = vi.fn();
vi.mock("../../prisma.js", () => ({
  prisma: {
    analysis: { update: (...a: unknown[]) => mockAnalysisUpdate(...a) },
  },
}));

// ── web-research-augmenter mock — guards against any live network ────────
const mockAugment = vi.fn();
const mockCreateSearchProvider = vi.fn(() => ({ search: vi.fn() }));
vi.mock("../../analysis/web-research-augmenter.js", () => ({
  WebResearchAugmenter: class {
    augment(...a: unknown[]) {
      return mockAugment(...a);
    }
  },
  createSearchProvider: (...a: unknown[]) => mockCreateSearchProvider(...a),
}));

import {
  buildDomainRequirement,
  runDomainWebResearch,
  type DomainAugmenterLike,
} from "./domain-web-research.js";

const digest = (id: string): EvidenceDigest => ({
  id,
  requirementId: "r",
  evidenceNeedId: "n",
  query: "q",
  sources: [
    {
      url: "https://www.acme-freight.example/markets",
      title: "Acme Freight Networks",
      excerpt: "Acme Freight administers regional freight networks.",
      relevanceScore: 0.9,
      domainTrust: "medium",
    },
  ],
  digest: "Acme Freight administers the regional regional freight network under DOT oversight.",
  needsHumanReview: false,
});

const research = (digests: EvidenceDigest[]): WebResearchResult => ({
  digests,
  totalSources: digests.reduce((s, d) => s + d.sources.length, 0),
  reviewRequired: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateAnalysis.mockResolvedValue({ id: "synthetic-analysis-1" });
  mockAnalysisUpdate.mockResolvedValue({});
  mockPersistEnhancement.mockResolvedValue(undefined);
  mockMarkCompleted.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildDomainRequirement (#283)", () => {
  it("builds a single domain requirement anchored on the project + doc title", () => {
    const req = buildDomainRequirement({
      projectName: "risk-calc",
      projectDescription: "Acme Freight carrier rate compliance",
      docTitle: "risk-calc Business Requirements",
    });
    expect(req.evidenceNeeds).toHaveLength(1);
    expect(req.title).toContain("risk-calc");
    expect(req.description).toContain("Acme Freight carrier rate compliance");
    const need = req.evidenceNeeds[0];
    expect(need.domain).toBe("business-domain");
    expect(need.description).toContain("risk-calc");
    expect(need.searchHints).toContain("risk-calc");
    expect(need.searchHints).toContain("risk-calc Business Requirements");
  });

  it("tolerates a missing description", () => {
    const req = buildDomainRequirement({
      projectName: "Acme",
      projectDescription: null,
      docTitle: "Docs",
    });
    expect(req.evidenceNeeds[0].description).toContain("Acme");
    expect(req.description).toContain("Acme");
  });
});

describe("runDomainWebResearch — success path (#283)", () => {
  it("feeds the domain requirement to the augmenter and persists digests into the grounding store", async () => {
    const augmenter: DomainAugmenterLike = { augment: mockAugment };
    mockAugment.mockResolvedValue(research([digest("d1"), digest("d2")]));

    const result = await runDomainWebResearch(
      {
        projectId: "p1",
        projectName: "risk-calc",
        projectDescription: "Acme Freight compliance",
        docTitle: "BR",
        actorId: "u1",
      },
      { augmenter },
    );

    // The augmenter was called with EXACTLY one synthetic domain requirement.
    expect(mockAugment).toHaveBeenCalledTimes(1);
    const reqs = mockAugment.mock.calls[0][0] as StructuredRequirement[];
    expect(reqs).toHaveLength(1);
    expect(reqs[0].evidenceNeeds[0].domain).toBe("business-domain");

    // Digests are persisted via the SAME enhancement path getLatestWebResearch reads.
    expect(mockCreateAnalysis).toHaveBeenCalledTimes(1);
    expect(mockPersistEnhancement).toHaveBeenCalledTimes(1);
    const [analysisId, patch] = mockPersistEnhancement.mock.calls[0];
    expect(analysisId).toBe("synthetic-analysis-1");
    expect((patch as { webResearch: WebResearchResult }).webResearch.digests).toHaveLength(2);

    // The synthetic row is tagged so it's excluded from analysis history + marked done.
    const tagPatch = JSON.parse(
      (mockAnalysisUpdate.mock.calls[0][0] as { data: { metadata: string } }).data.metadata,
    ) as { source?: string };
    expect(tagPatch.source).toBe("docs-gen-domain-research");
    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);

    expect(result?.digests).toHaveLength(2);
  });
});

describe("runDomainWebResearch — safety (#283)", () => {
  it("returns null and does NOT throw when the augmenter fails (doc gen proceeds ungrounded)", async () => {
    const augmenter: DomainAugmenterLike = { augment: mockAugment };
    mockAugment.mockRejectedValue(new Error("tavily down"));

    const result = await runDomainWebResearch(
      { projectId: "p1", projectName: "X", docTitle: "D", actorId: "u1" },
      { augmenter },
    );

    expect(result).toBeNull();
    // A failure must not persist anything.
    expect(mockPersistEnhancement).not.toHaveBeenCalled();
    expect(mockCreateAnalysis).not.toHaveBeenCalled();
  });

  it("returns null without throwing when no augmenter AND no provider are available (default-off safety)", async () => {
    // No injected augmenter → it tries to build the default WebResearchAugmenter,
    // which requires a provider. None supplied → requireProvider throws → caught.
    const result = await runDomainWebResearch({
      projectId: "p1",
      projectName: "X",
      docTitle: "D",
      actorId: "u1",
    });
    expect(result).toBeNull();
    // The default augmenter could not run, so nothing was searched or persisted.
    expect(mockAugment).not.toHaveBeenCalled();
    expect(mockPersistEnhancement).not.toHaveBeenCalled();
  });

  it("builds the default WebResearchAugmenter (with env search provider) when a provider is supplied", async () => {
    // No injected augmenter, but a provider is available → constructs the real
    // augmenter (mocked) and resolves the search provider via createSearchProvider.
    mockAugment.mockResolvedValue(research([digest("d1")]));
    // Minimal AIProvider stand-in — only its presence matters (the augmenter is mocked).
    const fakeProvider = { chat: vi.fn() } as unknown as import("../../ai/types.js").AIProvider;

    const result = await runDomainWebResearch(
      { projectId: "p1", projectName: "X", docTitle: "D", actorId: "u1" },
      { provider: fakeProvider },
    );

    expect(mockCreateSearchProvider).toHaveBeenCalledTimes(1);
    expect(mockAugment).toHaveBeenCalledTimes(1);
    expect(result?.digests).toHaveLength(1);
    expect(mockPersistEnhancement).toHaveBeenCalledTimes(1);
  });

  it("does NOT persist when research yields zero digests (avoids shadowing a richer prior record)", async () => {
    const augmenter: DomainAugmenterLike = { augment: mockAugment };
    mockAugment.mockResolvedValue(research([]));

    const result = await runDomainWebResearch(
      { projectId: "p1", projectName: "X", docTitle: "D", actorId: "u1" },
      { augmenter },
    );

    expect(result?.digests).toHaveLength(0);
    expect(mockPersistEnhancement).not.toHaveBeenCalled();
    expect(mockCreateAnalysis).not.toHaveBeenCalled();
  });
});
