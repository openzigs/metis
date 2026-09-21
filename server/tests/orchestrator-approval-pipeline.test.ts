/**
 * Epic #202 (#215 + #216) — approval checkpoints wired into the orchestrator.
 *
 * #215: `runEnhancementPipeline` must create durable approval requests after
 *       extraction (one per requirement) and after web research (one per
 *       evidence digest), honouring DEFAULT_APPROVAL_POLICY.
 * #216: `runSynthesisAndPersist` must *gate artifact promotion* — it persists
 *       the synthesis agent result but must NOT promote requirements into
 *       durable `Requirement` rows while any approval is pending/rejected. Once
 *       approvals resolve, promotion proceeds.
 *
 * The real `approval-checkpoint` service runs against an in-memory `prisma`
 * mock so the create/gate logic is exercised for real. The heavy
 * `analysis-service` persistence helpers and the LLM seams (extractor, web
 * research, synthesis) are stubbed so the test stays unit-scoped and offline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../src/lib/ai/types.js";

// ── Durable approval row store (backs the real approval-checkpoint service) ──
interface ApprovalRow {
  id: string;
  analysisId: string;
  type: string;
  itemId: string;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}
const approvals: ApprovalRow[] = [];
let approvalId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    approvalRequest: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        approvalId++;
        const row: ApprovalRow = {
          id: `ap-${approvalId}`,
          analysisId: data.analysisId as string,
          type: data.type as string,
          itemId: data.itemId as string,
          status: (data.status as string) ?? "pending",
          reviewerId: null,
          reviewNote: null,
          createdAt: new Date(),
          reviewedAt: null,
        };
        approvals.push(row);
        return Promise.resolve(row);
      }),
      findMany: vi.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(approvals.filter((r) => r.analysisId === where.analysisId)),
      ),
      findFirst: vi.fn(({ where }: { where: { id: string; analysisId: string } }) =>
        Promise.resolve(
          approvals.find((r) => r.id === where.id && r.analysisId === where.analysisId) ?? null,
        ),
      ),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = approvals.find((r) => r.id === where.id);
        if (!row) return Promise.resolve(null);
        if (data.status !== undefined) row.status = data.status as string;
        if (data.reviewerId !== undefined) row.reviewerId = data.reviewerId as string;
        if (data.reviewNote !== undefined) row.reviewNote = data.reviewNote as string | null;
        if (data.reviewedAt !== undefined) row.reviewedAt = data.reviewedAt as Date;
        return Promise.resolve({ ...row });
      }),
      count: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        let f = approvals.filter((r) => r.analysisId === where.analysisId);
        if (where.status) f = f.filter((r) => r.status === where.status);
        return Promise.resolve(f.length);
      }),
    },
  },
}));

// ── Stub the heavy persistence helpers + LLM seams. ──────────────────────────
const persisted = {
  enhancement: [] as Array<Record<string, unknown>>,
  requirements: [] as Array<Record<string, unknown>>,
  agentResults: [] as Array<Record<string, unknown>>,
};

vi.mock("../src/lib/analysis/analysis-service.js", () => ({
  persistAnalysisEnhancement: vi.fn((id: string, patch: Record<string, unknown>) => {
    persisted.enhancement.push({ id, ...patch });
    return Promise.resolve();
  }),
  persistRequirements: vi.fn((input: Record<string, unknown>) => {
    persisted.requirements.push(input);
    return Promise.resolve(["req-row-1"]);
  }),
  persistAgentResult: vi.fn((input: Record<string, unknown>) => {
    persisted.agentResults.push(input);
    return Promise.resolve();
  }),
  readFlattenedFindings: vi.fn(() => Promise.resolve([])),
  getStructuredRequirements: vi.fn(() => Promise.resolve(null)),
  createAnalysis: vi.fn(),
  finalizeAnalysisDelta: vi.fn(),
  markAnalysisCancelled: vi.fn(),
  markAnalysisCompleted: vi.fn(),
  markAnalysisFailed: vi.fn(),
}));

const extractMock = vi.fn();
vi.mock("../src/lib/analysis/requirements-extractor.js", () => ({
  RequirementsExtractor: class {
    extract = extractMock;
  },
}));

const augmentMock = vi.fn();
vi.mock("../src/lib/analysis/web-research-augmenter.js", () => ({
  WebResearchAugmenter: class {
    augment = augmentMock;
  },
  createSearchProvider: vi.fn(() => ({ search: vi.fn(() => Promise.resolve([])) })),
}));

const runSynthesisMock = vi.fn();
vi.mock("../src/lib/analysis/synthesis.js", () => ({
  runSynthesis: (...args: unknown[]) => runSynthesisMock(...args),
}));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const approvalSvc = await import("../src/lib/analysis/approval-checkpoint.js");

/** Minimal online provider stub (offline=false so enhancement runs). */
function onlineProvider(): AIProvider {
  return {
    offline: false,
    chat: vi.fn(),
  } as unknown as AIProvider;
}

/** Reach the private methods under test without a full pipeline run. */
type PrivateOrchestrator = {
  runEnhancementPipeline(input: Record<string, unknown>): Promise<void>;
  runSynthesisAndPersist(input: Record<string, unknown>): Promise<void>;
};

function makeOrchestrator(): {
  orch: InstanceType<typeof AnalysisOrchestrator>;
  emitted: unknown[];
  blockedEvents: Array<{
    analysisId: string;
    pendingCount: number;
    rejectedCount: number;
    reason: string;
  }>;
} {
  const orch = new AnalysisOrchestrator({ provider: onlineProvider() });
  const emitted: unknown[] = [];
  // Swallow socket emits and capture them for assertions.
  (orch as unknown as { emit: (e: unknown) => void }).emit = (e: unknown) => {
    emitted.push(e);
  };
  // #256 — capture the distinct promotion-blocked event (normally routed
  // through `this.deps.io`, which isn't wired in these unit tests).
  const blockedEvents: Array<{
    analysisId: string;
    pendingCount: number;
    rejectedCount: number;
    reason: string;
  }> = [];
  (
    orch as unknown as {
      emitPromotionBlocked: (id: string, d: Record<string, unknown>) => void;
    }
  ).emitPromotionBlocked = (analysisId, detail) => {
    blockedEvents.push({
      analysisId,
      pendingCount: detail.pendingCount as number,
      rejectedCount: detail.rejectedCount as number,
      reason: detail.reason as string,
    });
  };
  return { orch, emitted, blockedEvents };
}

beforeEach(() => {
  approvals.length = 0;
  approvalId = 0;
  persisted.enhancement = [];
  persisted.requirements = [];
  persisted.agentResults = [];
  vi.clearAllMocks();
});

describe("#215 — orchestrator creates approval requests after extraction/clarification", () => {
  it("creates one requirement approval per extracted requirement (default policy)", async () => {
    extractMock.mockResolvedValue({
      requirements: [
        { id: "r1", title: "A", description: "", ambiguities: [], evidenceNeeds: [] },
        { id: "r2", title: "B", description: "", ambiguities: [], evidenceNeeds: [] },
      ],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 0,
    });

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runEnhancementPipeline({
      analysisId: "ana-1",
      extractedRequirements: [{ id: "x", text: "seed requirement text" }],
      enableWebResearch: false,
      enableClarification: false,
      signal: new AbortController().signal,
    });

    const rows = await approvalSvc.listApprovalRequests("ana-1");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "requirement")).toBe(true);
    expect(rows.map((r) => r.itemId).sort()).toEqual(["r1", "r2"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("also creates evidence approvals per digest when web research is enabled", async () => {
    extractMock.mockResolvedValue({
      requirements: [{ id: "r1", title: "A", description: "", ambiguities: [], evidenceNeeds: [] }],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 1,
    });
    augmentMock.mockResolvedValue({
      digests: [
        {
          id: "d1",
          requirementId: "r1",
          query: "q",
          sources: [],
          digest: "x",
          needsHumanReview: true,
        },
        {
          id: "d2",
          requirementId: "r1",
          query: "q",
          sources: [],
          digest: "y",
          needsHumanReview: false,
        },
      ],
      totalSources: 0,
      reviewRequired: 1,
    });

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runEnhancementPipeline({
      analysisId: "ana-2",
      extractedRequirements: [{ id: "x", text: "seed" }],
      enableWebResearch: true,
      enableClarification: false,
      signal: new AbortController().signal,
    });

    const rows = await approvalSvc.listApprovalRequests("ana-2");
    const byType = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    // 1 requirement + 2 evidence digests.
    expect(byType.requirement).toBe(1);
    expect(byType.evidence).toBe(2);
  });

  it("respects a custom policy that disables requirement approval (no rows created)", async () => {
    extractMock.mockResolvedValue({
      requirements: [{ id: "r1", title: "A", description: "", ambiguities: [], evidenceNeeds: [] }],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 0,
    });

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runEnhancementPipeline({
      analysisId: "ana-3",
      extractedRequirements: [{ id: "x", text: "seed" }],
      enableWebResearch: false,
      enableClarification: false,
      signal: new AbortController().signal,
      approvalPolicy: {
        requireEvidenceApproval: false,
        requireClarificationApproval: false,
        requireRequirementApproval: false,
      },
    });

    expect(await approvalSvc.listApprovalRequests("ana-3")).toHaveLength(0);
  });

  it("falls back to flattened findings as seed text when no extracted requirements are passed", async () => {
    const svcMock = await import("../src/lib/analysis/analysis-service.js");
    (svcMock.readFlattenedFindings as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { agentKey: "document", title: "Doc finding", body: "needs an approval" },
    ]);
    extractMock.mockResolvedValue({
      requirements: [{ id: "rF", title: "F", description: "", ambiguities: [], evidenceNeeds: [] }],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 0,
    });

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runEnhancementPipeline({
      analysisId: "ana-seed",
      extractedRequirements: [], // forces the readFlattenedFindings fallback
      enableWebResearch: false,
      enableClarification: false,
      signal: new AbortController().signal,
    });

    // Extraction ran on the fallback seed and produced one requirement approval.
    expect(extractMock).toHaveBeenCalled();
    expect(await approvalSvc.listApprovalRequests("ana-seed")).toHaveLength(1);
  });

  it("creates no approvals when the signal aborts right after extraction", async () => {
    extractMock.mockResolvedValue({
      requirements: [{ id: "r1", title: "A", description: "", ambiguities: [], evidenceNeeds: [] }],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 0,
    });
    const controller = new AbortController();
    controller.abort();

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runEnhancementPipeline({
      analysisId: "ana-abort",
      extractedRequirements: [{ id: "x", text: "seed" }],
      enableWebResearch: true,
      enableClarification: false,
      signal: controller.signal,
    });

    // Aborted before web research / approval persistence — no rows created.
    expect(augmentMock).not.toHaveBeenCalled();
    expect(await approvalSvc.listApprovalRequests("ana-abort")).toHaveLength(0);
  });

  it("creates no approvals offline (provider offline → no extraction)", async () => {
    const orch = new AnalysisOrchestrator({
      provider: { offline: true, chat: vi.fn() } as unknown as AIProvider,
    });
    (orch as unknown as { emit: (e: unknown) => void }).emit = () => {};

    await (orch as unknown as PrivateOrchestrator).runEnhancementPipeline({
      analysisId: "ana-offline",
      extractedRequirements: [{ id: "x", text: "seed" }],
      enableWebResearch: false,
      enableClarification: false,
      signal: new AbortController().signal,
    });

    expect(extractMock).not.toHaveBeenCalled();
    expect(await approvalSvc.listApprovalRequests("ana-offline")).toHaveLength(0);
  });
});

describe("#216 — promotion is gated on resolved approvals", () => {
  const synthInput = {
    projectId: "proj-1",
    projectName: "Proj",
    signal: new AbortController().signal,
    accumulator: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };

  beforeEach(() => {
    runSynthesisMock.mockResolvedValue({
      output: { requirements: [{ title: "T", description: "D" }] },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
  });

  it("blocks promotion while an approval is pending (no Requirement rows persisted)", async () => {
    await approvalSvc.createApprovalRequests("ana-block", [{ type: "requirement", itemId: "r1" }]);

    const { orch, emitted, blockedEvents } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runSynthesisAndPersist({
      analysisId: "ana-block",
      ...synthInput,
    });

    // Synthesis result is captured, but requirements are NOT promoted.
    expect(persisted.agentResults).toHaveLength(1);
    expect(persisted.requirements).toHaveLength(0);

    // A durable blocked marker is recorded for the UI (#217) — not silent.
    const blocked = persisted.enhancement.find((e) => "promotionBlocked" in e);
    expect(blocked).toBeDefined();
    expect((blocked!.promotionBlocked as { blocked: boolean }).blocked).toBe(true);
    // #258 — the marker and the coarse status are written in ONE metadata
    // patch (a single persistAnalysisEnhancement call for the blocked path).
    expect(blocked!.promotionStatus).toBe("blocked");
    const blockedWrites = persisted.enhancement.filter((e) => "promotionBlocked" in e);
    expect(blockedWrites).toHaveLength(1);

    // A blocked notice was surfaced on the socket.
    const blockedNotice = emitted.find(
      (e) => typeof (e as { message?: string }).message === "string",
    ) as { message: string } | undefined;
    expect(blockedNotice?.message).toMatch(/Promotion blocked/i);

    // #256 — a DISTINCT promotion-blocked event carries the reason + counts so
    // the UI doesn't have to infer the blocked state from the generic message.
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({
      analysisId: "ana-block",
      pendingCount: 1,
      rejectedCount: 0,
    });
    expect(blockedEvents[0].reason).toMatch(/Promotion blocked/i);
  });

  it("blocks promotion while an approval is rejected", async () => {
    await approvalSvc.createApprovalRequests("ana-reject", [{ type: "requirement", itemId: "r1" }]);
    await approvalSvc.reviewApprovalRequest("ana-reject", "ap-1", {
      status: "rejected",
      reviewerId: "u1",
    });

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runSynthesisAndPersist({
      analysisId: "ana-reject",
      ...synthInput,
    });

    expect(persisted.requirements).toHaveLength(0);
  });

  it("promotes once all approvals are approved", async () => {
    await approvalSvc.createApprovalRequests("ana-ok", [{ type: "requirement", itemId: "r1" }]);
    await approvalSvc.reviewApprovalRequest("ana-ok", "ap-1", {
      status: "approved",
      reviewerId: "u1",
    });

    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runSynthesisAndPersist({
      analysisId: "ana-ok",
      ...synthInput,
    });

    expect(persisted.requirements).toHaveLength(1);
    // The blocked marker is cleared on successful promotion.
    const cleared = persisted.enhancement.find((e) => "promotionBlocked" in e);
    expect((cleared!.promotionBlocked as { blocked: boolean }).blocked).toBe(false);
    // #258 — the clear-marker and the `allowed` status are folded into a SINGLE
    // metadata patch: exactly one persistAnalysisEnhancement write carries the
    // promotionBlocked key, and it also sets promotionStatus.
    expect(cleared!.promotionStatus).toBe("allowed");
    const clearWrites = persisted.enhancement.filter((e) => "promotionBlocked" in e);
    expect(clearWrites).toHaveLength(1);
  });

  it("promotes when there are no approvals at all (nothing to gate)", async () => {
    const { orch } = makeOrchestrator();
    await (orch as unknown as PrivateOrchestrator).runSynthesisAndPersist({
      analysisId: "ana-none",
      ...synthInput,
    });

    expect(persisted.requirements).toHaveLength(1);
  });
});
