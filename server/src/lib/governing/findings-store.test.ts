/**
 * #1874 — the findings store's edges: nothing to produce, a project with no
 * workspace, a requirement whose evaluation fails, the requirement filter, and
 * the summary counts. The real round trip is
 * `tests/governing-findings-1874.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoverningAnalysisApplicability, GoverningFinding } from "@metis/shared";

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  governingFinding: { findMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const readGoverningApplicability = vi.fn();
vi.mock("./applicability-store.js", () => ({
  readGoverningApplicability: (...a: unknown[]) => readGoverningApplicability(...a),
}));
const citableWorkspaceRules = vi.fn();
vi.mock("./governing-store.js", () => ({
  citableWorkspaceRules: (...a: unknown[]) => citableWorkspaceRules(...a),
}));
const evaluateRequirementFindings = vi.fn();
vi.mock("./findings.js", () => ({
  evaluateRequirementFindings: (...a: unknown[]) => evaluateRequirementFindings(...a),
}));

const { produceGoverningFindingsForAnalysis, summariseFindings } =
  await import("./findings-store.js");

const provider = { key: "anthropic", model: "m", offline: false, chat: vi.fn() } as never;
const STORED: GoverningAnalysisApplicability = {
  decidedAt: "2026-11-08T00:00:00.000Z",
  requirements: [
    {
      requirementId: "REQ-001",
      text: "A",
      decisions: [
        {
          ruleId: "r1",
          controlId: "C-1",
          verdict: "applies",
          reason: "",
          foundBy: ["screen"],
          settled: {
            questionId: "q1",
            question: "Q?",
            answer: "Yes.",
            previousVerdict: "uncertain",
            at: "2026-11-08T00:00:00.000Z",
          },
        },
        {
          ruleId: "r2",
          controlId: "C-2",
          verdict: "does-not-apply",
          reason: "",
          foundBy: ["screen"],
        },
      ],
    },
    { requirementId: "REQ-002", text: "B", decisions: [], error: "could not be decided" },
    {
      requirementId: "REQ-003",
      text: "C",
      decisions: [
        { ruleId: "r1", controlId: "C-1", verdict: "uncertain", reason: "", foundBy: ["top-k"] },
      ],
    },
  ],
};
const RULE = {
  id: "r1",
  revisionId: "rev",
  controlId: "C-1",
  summary: "s",
  clauseRef: "§1",
  clauseExcerpt: "clause",
  clauseStart: 0,
  clauseEnd: 6,
  revisionLabel: "v1",
  documentTitle: "Doc",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.project.findFirst.mockResolvedValue({ workspaceId: "ws" });
  citableWorkspaceRules.mockResolvedValue({
    rules: [RULE],
    revisionText: new Map([["rev", "clause"]]),
  });
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.governingFinding.findMany.mockResolvedValue([]);
});

describe("produceGoverningFindingsForAnalysis — edges", () => {
  it("nothing stored, or a project with no workspace: nothing evaluated or written", async () => {
    readGoverningApplicability.mockResolvedValueOnce(null);
    expect(
      await produceGoverningFindingsForAnalysis({ analysisId: "a", projectId: "p", provider }),
    ).toMatchObject({
      requirements: 0,
      written: 0,
    });
    db.project.findFirst.mockResolvedValueOnce({ workspaceId: null });
    expect(
      await produceGoverningFindingsForAnalysis({
        analysisId: "a",
        projectId: "p",
        provider,
        applicability: STORED,
      }),
    ).toMatchObject({ requirements: 0, written: 0 });
    expect(evaluateRequirementFindings).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("skips a requirement that errored and the does-not-apply pairs; passes the BA's answer; a failed evaluation is counted, not thrown", async () => {
    evaluateRequirementFindings
      .mockResolvedValueOnce({ findings: [], unverifiedCitations: 2, noEvidenceDemoted: 1 })
      .mockRejectedValueOnce(new Error("rate limited"));
    const run = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
    });
    expect(evaluateRequirementFindings).toHaveBeenCalledTimes(2);
    const first = evaluateRequirementFindings.mock.calls[0]![0] as {
      requirement: { id: string };
      pairs: Array<{ rule: { id: string }; applicability: string }>;
      answers: unknown[];
    };
    expect(first.requirement.id).toBe("REQ-001");
    expect(first.pairs.map((p) => [p.rule.id, p.applicability])).toEqual([["r1", "applies"]]);
    expect(first.answers).toEqual([{ answer: "Yes.", question: "Q?" }]);
    expect(run).toMatchObject({
      requirements: 1,
      failed: 1,
      unverifiedCitations: 2,
      noEvidenceDemoted: 1,
    });
    expect(citableWorkspaceRules).toHaveBeenCalledWith("ws", ["r1"]);
  });

  it("requirementIds limits the run to those requirements", async () => {
    evaluateRequirementFindings.mockResolvedValue({
      findings: [],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-003"],
    });
    expect(evaluateRequirementFindings).toHaveBeenCalledTimes(1);
    expect(
      (evaluateRequirementFindings.mock.calls[0]![0] as { requirement: { id: string } }).requirement
        .id,
    ).toBe("REQ-003");
  });

  it("a finding no longer produced for its requirement is removed", async () => {
    evaluateRequirementFindings.mockResolvedValue({
      findings: [],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    db.governingFinding.findMany.mockResolvedValue([{ id: "gf_old", ruleId: "r_gone" }]);
    const run = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-001"],
    });
    expect(db.governingFinding.deleteMany).toHaveBeenCalledWith({
      where: { analysisId: "a", id: { in: ["gf_old"] } },
    });
    expect(run.removed).toBe(1);
  });
});

describe("listGoverningFindings — the wire shape", () => {
  it("reads by the analysis id, and a stored value outside the vocabulary never reaches the wire", async () => {
    const { listGoverningFindings } = await import("./findings-store.js");
    const at = new Date("2026-11-08T00:00:00.000Z");
    db.governingFinding.findMany.mockResolvedValueOnce([
      {
        id: "gf1",
        analysisId: "a",
        requirementId: "REQ-001",
        ruleId: "r1",
        revisionId: "rev",
        revisionLabel: "v1",
        documentTitle: "Doc",
        controlId: "C-1",
        clauseRef: "§1",
        status: "certified",
        reasoning: "r",
        clauseStart: null,
        clauseEnd: null,
        clauseExcerpt: null,
        citationDropped: true,
        modelStatus: "maybe",
        businessQuestion: "q?",
        decision: "approved",
        decisionNote: null,
        decidedById: null,
        decidedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    const [f] = await listGoverningFindings("a");
    expect(db.governingFinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { analysisId: "a" } }),
    );
    expect(f).toMatchObject({
      status: "needs-ba-input",
      modelStatus: null,
      decision: null,
      decidedAt: null,
      createdAt: at.toISOString(),
    });
  });
});

describe("summariseFindings", () => {
  const f = (over: Partial<GoverningFinding>): GoverningFinding =>
    ({ status: "gap", citationDropped: false, modelStatus: null, ...over }) as GoverningFinding;

  it("counts statuses, dropped citations, and compliant answers demoted for want of evidence", () => {
    expect(
      summariseFindings([
        f({ status: "compliant" }),
        f({ status: "gap", modelStatus: "compliant" }),
        f({ status: "needs-ba-input", modelStatus: "compliant", citationDropped: true }),
        f({ status: "needs-ba-input" }),
      ]),
    ).toEqual({
      total: 4,
      compliant: 1,
      gap: 1,
      needsBaInput: 2,
      unverifiedCitations: 1,
      noEvidenceDemoted: 1,
    });
  });
});
