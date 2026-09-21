/**
 * Epic #1107 (#1110 / A2) — **the API exposes verdicts and their reasoning, not
 * an aggregate score.**
 *
 * The acceptance criterion is that dissent reasoning is reachable from the UI
 * *without a round-trip to the database*. So this exercises the REAL
 * `getAnalysisSnapshot` against the in-memory Prisma fake and asserts that ONE
 * response already carries, per requirement: the rolled-up confidence, the
 * dissenting lens, that lens's own words, and its `file:line`.
 *
 * It also pins the two #1109 invariants at the API boundary — a `no-signal`
 * finding never drags a requirement down, and no requirement disappears for
 * being low-confidence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingSupportPanel } from "@metis/shared";

interface FindingRow {
  id: string;
  agentResultId: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  evidence: string | null;
  derivation: string;
  confidence: number;
  verificationStatus: string | null;
}
interface RequirementRow {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  labels: string;
  storyPoints: number | null;
  reviewStatus: string | null;
  coverage: string | null;
  verdict: string | null;
  acceptanceCriteria: string | null;
  version: number;
}

const store = { findings: [] as FindingRow[], requirements: [] as RequirementRow[] };
const ANALYSIS_ID = "an_1";

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== ANALYSIS_ID) return null;
        return {
          id: ANALYSIS_ID,
          projectId: "pr_1",
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          errorMessage: null,
          metadata: null,
          agentResults: [
            {
              id: "ar_1",
              analysisId: ANALYSIS_ID,
              agentKey: "code",
              status: "completed",
              startedAt: new Date(),
              completedAt: new Date(),
              output: JSON.stringify({ summary: "s", notes: [] }),
              errorMessage: null,
              findings: store.findings,
            },
          ],
          requirements: store.requirements,
        };
      }),
    },
    crossDocFinding: { findMany: vi.fn(async () => []) },
  },
}));

function panel(confidence: FindingSupportPanel["confidence"]): FindingSupportPanel {
  const judged = confidence !== "no-signal";
  return {
    confidence,
    votes: [
      {
        lens: "support",
        judgement: judged ? "supported" : null,
        discardReason: judged ? null : "no-signal",
        citation: judged ? "src/api/auth.ts:12" : null,
        reasoning: judged ? "the excerpt backs it" : "provider-error: upstream 503",
        counted: judged,
      },
      {
        lens: "scope",
        judgement: judged ? (confidence === "high" ? "supported" : "unsupported") : null,
        discardReason: judged ? null : "no-signal",
        citation: judged ? "src/api/auth.ts:30" : null,
        reasoning: judged
          ? "one handler generalised to the whole surface"
          : "provider-error: upstream 503",
        counted: judged,
      },
      {
        lens: "currency",
        judgement: judged ? (confidence === "low" ? "unsupported" : "supported") : null,
        discardReason: judged ? null : "no-signal",
        citation: judged ? "src/api/auth.ts:44" : null,
        reasoning: judged ? "superseded by a later excerpt" : "provider-error: upstream 503",
        counted: judged,
      },
    ],
    countedVotes: judged ? 3 : 0,
    supportedVotes: confidence === "high" ? 3 : confidence === "low" ? 1 : judged ? 2 : 0,
    unsupportedVotes: confidence === "low" ? 2 : confidence === "medium" ? 1 : 0,
    uncertainVotes: 0,
    noSignalVotes: judged ? 0 : 3,
    uncitedVotes: 0,
    usage: { promptTokens: 900, completionTokens: 120, llmCalls: 3 },
  };
}

function seedFinding(id: string, title: string, p: FindingSupportPanel | null): void {
  store.findings.push({
    id,
    agentResultId: "ar_1",
    category: "security",
    severity: "high",
    title,
    body: "b",
    evidence: JSON.stringify({ citations: [], tags: [], ...(p ? { supportPanel: p } : {}) }),
    derivation: "inferred",
    confidence: 0.7,
    verificationStatus: "confirmed",
  });
}

function seedRequirement(id: string, title: string, findingIds: string[]): void {
  store.requirements.push({
    id,
    type: "feature",
    title,
    body: "rb",
    priority: "high",
    labels: JSON.stringify(findingIds.map((f) => `finding:${f}`)),
    storyPoints: null,
    reviewStatus: "draft",
    coverage: null,
    verdict: null,
    acceptanceCriteria: null,
    version: 1,
  });
}

const snapshot = async () => {
  const { getAnalysisSnapshot } = await import("./analysis-service.js");
  return getAnalysisSnapshot(ANALYSIS_ID);
};

describe("the analysis snapshot carries panel confidence per requirement (#1110)", () => {
  beforeEach(() => {
    store.findings = [];
    store.requirements = [];
  });

  it("answers 'why is this low-confidence?' from ONE response — lens, reason and file:line", async () => {
    seedFinding("f1", "Refunds are blocked", panel("low"));
    seedRequirement("r1", "Block refunds", ["f1"]);

    const rollup = (await snapshot())?.requirements[0].supportConfidence;
    expect(rollup?.confidence).toBe("low");
    expect(rollup?.dissent.map((d) => d.lens)).toEqual(["scope", "currency"]);
    expect(rollup?.dissent[0].reasoning).toBe("one handler generalised to the whole surface");
    expect(rollup?.dissent[0].citation).toBe("src/api/auth.ts:30");
    // Attributed to the finding it came from, so a multi-evidence requirement
    // still says WHICH claim the lens disagreed with.
    expect(rollup?.dissent[0].findingTitle).toBe("Refunds are blocked");
  });

  it("keeps the low-confidence requirement in the response — nothing is filtered out", async () => {
    seedFinding("f1", "doubted", panel("low"));
    seedFinding("f2", "backed", panel("high"));
    seedRequirement("r1", "Doubted requirement", ["f1"]);
    seedRequirement("r2", "Backed requirement", ["f2"]);

    const reqs = (await snapshot())?.requirements ?? [];
    expect(reqs.map((r) => r.title)).toEqual(["Doubted requirement", "Backed requirement"]);
  });

  it("rolls up to the WORST judged label across a requirement's evidence", async () => {
    seedFinding("f1", "backed", panel("high"));
    seedFinding("f2", "doubted", panel("low"));
    seedRequirement("r1", "Mixed evidence", ["f1", "f2"]);

    const rollup = (await snapshot())?.requirements[0].supportConfidence;
    expect(rollup?.confidence).toBe("low");
    expect(rollup?.findingsWithPanel).toBe(2);
    expect(rollup?.lowConfidenceFindings).toBe(1);
  });

  it("does NOT downgrade a requirement because one lens set degraded", async () => {
    seedFinding("f1", "backed", panel("high"));
    seedFinding("f2", "unjudged", panel("no-signal"));
    seedRequirement("r1", "Mixed evidence", ["f1", "f2"]);

    const rollup = (await snapshot())?.requirements[0].supportConfidence;
    expect(rollup?.confidence).toBe("high");
    expect(rollup?.noSignalFindings).toBe(1);
  });

  it("is null on a flag-off run, so the response is unchanged from pre-#1109", async () => {
    seedFinding("f1", "plain", null);
    seedRequirement("r1", "Plain requirement", ["f1"]);
    expect((await snapshot())?.requirements[0].supportConfidence).toBeNull();
  });

  it("is null when a requirement links no finding at all", async () => {
    seedRequirement("r1", "Orphan requirement", []);
    expect((await snapshot())?.requirements[0].supportConfidence).toBeNull();
  });
});
