/**
 * Issue #1610 — the `partial` verdict survives the real write and read paths.
 *
 * Runs the REAL `runSynthesis` over a provider reply that pins each acceptance
 * criterion to its findings, rolls the verdicts up with the REAL
 * `computeVerdictsForRequirements`, persists with the REAL `persistRequirements`,
 * and reads the requirement back through `getAnalysisSnapshot` — the function
 * the analysis GET route serves. The assertion is on the row as read back, not
 * on the in-memory roll-up.
 *
 * It also pins the other direction: rows written before #1610 (a null verdict
 * or one of the three earlier values) read back unchanged, and a finding blob
 * can never surface `partial` (it is a requirement-level roll-up only).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { FlatFinding } from "./synthesis.js";

interface ReqRow {
  id: string;
  analysisId: string;
  projectId: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  labels: string;
  storyPoints: number | null;
  reviewStatus: string | null;
  coverage: string | null;
  verdict: string | null;
  acceptanceCriteria: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const store = { requirements: [] as ReqRow[], agentResults: [] as unknown[], seq: 0 };

const ANALYSIS_ID = "an_1610";
const PROJECT_ID = "pr_1610";

vi.mock("../prisma.js", () => ({
  resolveDatabaseProvider: () => "sqlite" as const,
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn((await import("../prisma.js")).prisma),
    ),
    requirement: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async ({ where }: { where: { analysisId: string } }) => {
        const before = store.requirements.length;
        store.requirements = store.requirements.filter((r) => r.analysisId !== where.analysisId);
        return { count: before - store.requirements.length };
      }),
      create: vi.fn(async ({ data }: { data: Partial<ReqRow> }) => {
        const now = new Date();
        const row: ReqRow = {
          id: `req-${++store.seq}`,
          analysisId: data.analysisId!,
          projectId: data.projectId!,
          type: data.type ?? "feature",
          title: data.title ?? "",
          body: data.body ?? "",
          priority: data.priority ?? "medium",
          labels: data.labels ?? "[]",
          storyPoints: data.storyPoints ?? null,
          reviewStatus: data.reviewStatus ?? null,
          coverage: data.coverage ?? null,
          verdict: data.verdict ?? null,
          acceptanceCriteria: data.acceptanceCriteria ?? "[]",
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        store.requirements.push(row);
        return row;
      }),
    },
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== ANALYSIS_ID) return null;
        return {
          id: ANALYSIS_ID,
          projectId: PROJECT_ID,
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: null,
          agentResults: store.agentResults,
          requirements: store.requirements.filter((r) => r.analysisId === ANALYSIS_ID),
        };
      }),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
  },
}));

const AC_VALIDATE = "POST /orders rejects a quantity above stock with HTTP 409.";
const AC_CONSTRAINT = "INVENTORY.QTY can never go below zero (database CHECK constraint).";

/** Finding 0: the API check exists. Finding 1: the DB constraint does not. */
const FINDINGS: FlatFinding[] = [
  {
    agentKey: "code",
    category: "architecture",
    severity: "info",
    title: "Order quantity is validated against stock",
    body: "OrderController.create rejects quantity > stock with 409.",
    tags: [],
    citations: [{ filePath: "src/orders/controller.ts", startLine: 40, endLine: 58 }],
    verdict: "implemented",
  },
  {
    agentKey: "code",
    category: "architecture",
    severity: "high",
    title: "No CHECK constraint on INVENTORY.QTY",
    body: "The INVENTORY table has no CHECK (QTY >= 0) constraint.",
    tags: [],
    citations: [],
    verdict: "gap-confirmed",
  },
] as FlatFinding[];

const REPLY = JSON.stringify({
  summary: "One inventory requirement, half built.",
  requirements: [
    {
      type: "feature",
      title: "Never oversell inventory",
      body: "Checkout must not sell stock it does not have.",
      priority: "high",
      labels: [],
      evidenceFindingIndexes: [0, 1],
      acceptanceCriteria: [AC_VALIDATE, AC_CONSTRAINT],
      acceptanceCriteriaEvidence: [[0], [1]],
    },
  ],
});

function providerReturning(content: string): AIProvider {
  return {
    chat: vi.fn(
      async () =>
        ({
          content,
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        }) as ChatResponse,
    ),
  } as unknown as AIProvider;
}

beforeEach(() => {
  store.requirements = [];
  store.agentResults = [];
  store.seq = 0;
});

describe("#1610 — partial verdict round trip", () => {
  it("synthesis → roll-up → persist → GET snapshot reads back verdict: partial", async () => {
    const { runSynthesis } = await import("./synthesis.js");
    const { computeVerdictsForRequirements } = await import("./requirement-verdict.js");
    const { persistRequirements, getAnalysisSnapshot } = await import("./analysis-service.js");

    const result = await runSynthesis(providerReturning(REPLY), {
      projectName: "Shop",
      findings: FINDINGS,
    });
    expect(result.degraded).toBeUndefined();
    // The per-criterion links came through the reply repair keyed by text.
    expect(result.output.requirements[0]!.criterionEvidence).toEqual([
      { criterion: AC_VALIDATE, evidenceFindingIndexes: [0] },
      { criterion: AC_CONSTRAINT, evidenceFindingIndexes: [1] },
    ]);

    const verdicts = computeVerdictsForRequirements(
      result.output.requirements,
      FINDINGS.map((f) => ({ agentKey: f.agentKey, verdict: f.verdict ?? null })),
      true,
    );
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: result.output,
      findingIdsByIndex: ["f0", "f1"],
      verdicts,
    });

    // Written to the column…
    expect(store.requirements.map((r) => r.verdict)).toEqual(["partial"]);
    // …and served back by the snapshot the analysis GET route returns.
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot!.requirements.map((r) => r.verdict)).toEqual(["partial"]);
  });

  it("the same reply WITHOUT per-criterion evidence keeps the three-state verdict", async () => {
    const { runSynthesis } = await import("./synthesis.js");
    const { computeVerdictsForRequirements } = await import("./requirement-verdict.js");
    const { persistRequirements, getAnalysisSnapshot } = await import("./analysis-service.js");

    const legacy = JSON.parse(REPLY) as { requirements: Array<Record<string, unknown>> };
    delete legacy.requirements[0]!.acceptanceCriteriaEvidence;
    const result = await runSynthesis(providerReturning(JSON.stringify(legacy)), {
      projectName: "Shop",
      findings: FINDINGS,
    });
    expect(result.output.requirements[0]!.criterionEvidence).toBeUndefined();
    const verdicts = computeVerdictsForRequirements(
      result.output.requirements,
      FINDINGS.map((f) => ({ agentKey: f.agentKey, verdict: f.verdict ?? null })),
      true,
    );
    await persistRequirements({
      analysisId: ANALYSIS_ID,
      projectId: PROJECT_ID,
      synthesis: result.output,
      findingIdsByIndex: ["f0", "f1"],
      verdicts,
    });
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot!.requirements.map((r) => r.verdict)).toEqual(["gap-confirmed"]);
  });

  it("rows written before #1610 read back unchanged; an unknown value reads as no verdict", async () => {
    const { getAnalysisSnapshot } = await import("./analysis-service.js");
    const now = new Date();
    for (const verdict of [null, "implemented", "gap-confirmed", "could-not-verify", "bogus"]) {
      store.requirements.push({
        id: `legacy-${store.seq++}`,
        analysisId: ANALYSIS_ID,
        projectId: PROJECT_ID,
        type: "feature",
        title: `Legacy ${String(verdict)}`,
        body: "b",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        reviewStatus: null,
        coverage: null,
        verdict,
        acceptanceCriteria: "[]",
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    expect(snapshot!.requirements.map((r) => r.verdict)).toEqual([
      null,
      "implemented",
      "gap-confirmed",
      "could-not-verify",
      null,
    ]);
  });

  it("a finding blob carrying `partial` reads back as no verdict (findings have three states)", async () => {
    const { getAnalysisSnapshot } = await import("./analysis-service.js");
    const now = new Date();
    const finding = (id: string, verdict: string) => ({
      id,
      agentResultId: "ar-1",
      category: "architecture",
      severity: "info",
      title: id,
      body: "b",
      evidence: JSON.stringify({ citations: [], tags: [], verdict }),
      derivation: "inferred",
      confidence: 0.7,
      verificationStatus: null,
    });
    store.agentResults = [
      {
        id: "ar-1",
        agentKey: "code",
        status: "completed",
        output: null,
        errorMessage: null,
        startedAt: now,
        completedAt: now,
        findings: [finding("f-partial", "partial"), finding("f-gap", "gap-confirmed")],
      },
    ];
    const snapshot = await getAnalysisSnapshot(ANALYSIS_ID);
    const findings = snapshot!.agents.flatMap((a) => a.findings);
    expect(findings.map((f) => [f.id, f.verdict])).toEqual([
      ["f-partial", null],
      ["f-gap", "gap-confirmed"],
    ]);
  });
});
