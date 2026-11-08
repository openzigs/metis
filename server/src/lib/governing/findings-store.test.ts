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
  governingRule: { count: vi.fn() },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
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

const {
  GOVERNING_FINDINGS_WRITE_TIMEOUT_MS,
  governingFindingRevisions,
  governingFindingsRefreshing,
  produceGoverningFindingsForAnalysis,
  summariseFindings,
} = await import("./findings-store.js");

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

  /** One evaluated finding of REQ-001's rule r1, with `status`. */
  const finding = (status: string) => ({
    requirementId: "REQ-001",
    rule: RULE,
    status,
    reasoning: "r",
    citation: { clauseStart: 0, clauseEnd: 6, clauseExcerpt: "clause" },
    citationDropped: false,
    modelStatus: null,
    businessQuestion: null,
  });
  const prior = (over: Record<string, unknown> = {}) => ({
    id: "gf_r1",
    requirementId: "REQ-001",
    ruleId: "r1",
    controlId: "C-1",
    status: "compliant",
    clauseExcerpt: "clause",
    revisionId: "rev",
    decision: "accepted",
    decisionNote: "Legal signed this off.",
    decidedById: "u_ba",
    decidedAt: new Date("2026-11-07T09:30:00.000Z"),
    ...over,
  });

  it("#2010 — the write is one transaction with the 60 s timeout, not Prisma's 5 s default", async () => {
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
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.$transaction.mock.calls[0]![1]).toEqual({ timeout: 60_000 });
    expect(GOVERNING_FINDINGS_WRITE_TIMEOUT_MS).toBe(60_000);
  });

  it("#2010 — a changed finding's cleared BA decision is audited in the same transaction; an unchanged one's is kept, unaudited", async () => {
    evaluateRequirementFindings.mockResolvedValue({
      findings: [finding("gap")],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    db.governingFinding.findMany.mockResolvedValue([prior()]);
    const run = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-001"],
    });
    expect(run.decisionsCleared).toBe(1);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const row = (db.auditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(row).toMatchObject({
      actorId: null,
      action: "governing.finding.decision-cleared",
      targetType: "governing_finding",
      targetId: "gf_r1",
    });
    expect(JSON.parse(row.metadata as string)).toMatchObject({
      analysisId: "a",
      requirementId: "REQ-001",
      previousDecision: "accepted",
      previousDecidedById: "u_ba",
      previousStatus: "compliant",
      status: "gap",
      // #2017 — the note and when it was made survive in the trail.
      previousDecisionNote: "Legal signed this off.",
      previousDecidedAt: "2026-11-07T09:30:00.000Z",
    });
    const update = (
      db.governingFinding.upsert.mock.calls[0]![0] as { update: Record<string, unknown> }
    ).update;
    expect(update).toMatchObject({ decision: null, decidedById: null });

    // Unchanged: the decision stands, and nothing is audited.
    vi.clearAllMocks();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
    db.project.findFirst.mockResolvedValue({ workspaceId: "ws" });
    evaluateRequirementFindings.mockResolvedValue({
      findings: [finding("compliant")],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    db.governingFinding.findMany.mockResolvedValue([prior()]);
    const kept = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-001"],
    });
    expect(kept.decisionsCleared).toBe(0);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(
      (db.governingFinding.upsert.mock.calls[0]![0] as { update: Record<string, unknown> }).update,
    ).not.toHaveProperty("decision");
  });

  it("#2010 — a changed finding that had no decision clears nothing worth auditing", async () => {
    evaluateRequirementFindings.mockResolvedValue({
      findings: [finding("gap")],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    db.governingFinding.findMany.mockResolvedValue([prior({ decision: null, decidedById: null })]);
    const run = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-001"],
    });
    expect(run.decisionsCleared).toBe(0);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("#2010 — a still-applying pair whose rule is no longer citable keeps its row and decision", async () => {
    // r1 applies to REQ-001, but the workspace no longer returns it (soft-deleted).
    citableWorkspaceRules.mockResolvedValue({ rules: [], revisionText: new Map() });
    evaluateRequirementFindings.mockResolvedValue({
      findings: [],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    db.governingFinding.findMany.mockResolvedValue([
      prior(),
      // r2 is does-not-apply now: its row is stale and goes.
      prior({ id: "gf_r2", ruleId: "r2" }),
    ]);
    const run = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-001"],
    });
    expect(db.governingFinding.deleteMany).toHaveBeenCalledWith({
      where: { analysisId: "a", id: { in: ["gf_r2"] } },
    });
    expect(run.removed).toBe(1);
    expect(db.governingFinding.upsert).not.toHaveBeenCalled();
    // gf_r1 is kept with its decision; gf_r2's decision is erased with its row.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(
      (db.auditLog.create.mock.calls[0]![0] as { data: { targetId: string } }).data.targetId,
    ).toBe("gf_r2");
  });

  it("#2017 — a stale row deleted with a BA decision is audited in the same transaction; one without is not", async () => {
    evaluateRequirementFindings.mockResolvedValue({
      findings: [],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    // r2 is does-not-apply for REQ-001 now: both its rows are stale.
    db.governingFinding.findMany.mockResolvedValue([
      prior({ id: "gf_r2", ruleId: "r2", controlId: "C-2", decision: "rejected" }),
      prior({ id: "gf_r3", ruleId: "r3", decision: null, decisionNote: null, decidedAt: null }),
    ]);
    citableWorkspaceRules.mockResolvedValue({ rules: [], revisionText: new Map() });
    const run = await produceGoverningFindingsForAnalysis({
      analysisId: "a",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-001"],
    });
    expect(run).toMatchObject({ removed: 2, decisionsCleared: 1 });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const row = (db.auditLog.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(row).toMatchObject({
      actorId: null,
      action: "governing.finding.decision-cleared",
      targetType: "governing_finding",
      targetId: "gf_r2",
    });
    expect(JSON.parse(row.metadata as string)).toMatchObject({
      analysisId: "a",
      requirementId: "REQ-001",
      controlId: "C-2",
      previousDecision: "rejected",
      previousDecisionNote: "Legal signed this off.",
      previousDecidedById: "u_ba",
      previousDecidedAt: "2026-11-07T09:30:00.000Z",
      previousStatus: "compliant",
      status: null,
      reason: "the rule no longer applies to the requirement",
    });
    // Audited before the delete, in the same transaction.
    expect(db.auditLog.create.mock.invocationCallOrder[0]!).toBeLessThan(
      db.governingFinding.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("#2017 — runs of one analysis are serialised in call order; refreshing reads true until the last settles", async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    evaluateRequirementFindings.mockImplementation(async (i: { requirement: { id: string } }) => {
      order.push(`start ${i.requirement.id}`);
      await new Promise<void>((r) => release.push(r));
      order.push(`end ${i.requirement.id}`);
      return { findings: [], unverifiedCitations: 0, noEvidenceDemoted: 0 };
    });
    const run = (requirementIds: string[]) =>
      produceGoverningFindingsForAnalysis({
        analysisId: "a_serial",
        projectId: "p",
        provider,
        applicability: STORED,
        requirementIds,
      });
    expect(governingFindingsRefreshing("a_serial")).toBe(false);
    const first = run(["REQ-001"]);
    const second = run(["REQ-003"]);
    // Another analysis is not queued behind this one.
    const other = produceGoverningFindingsForAnalysis({
      analysisId: "a_other",
      projectId: "p",
      provider,
      applicability: STORED,
      requirementIds: ["REQ-003"],
    });
    expect(governingFindingsRefreshing("a_serial")).toBe(true);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    // The first run and the other analysis's run started; the second waits.
    expect(order).toEqual(["start REQ-001", "start REQ-003"]);
    release.shift()!();
    release.shift()!();
    await first;
    await other;
    await vi.waitFor(() => expect(release).toHaveLength(1));
    expect(governingFindingsRefreshing("a_serial")).toBe(true);
    release.shift()!();
    await second;
    expect(order).toEqual([
      "start REQ-001",
      "start REQ-003",
      "end REQ-001",
      "end REQ-003",
      "start REQ-003",
      "end REQ-003",
    ]);
    await vi.waitFor(() => expect(governingFindingsRefreshing("a_serial")).toBe(false));
    expect(governingFindingsRefreshing("a_other")).toBe(false);
  });

  it("#2022 — a run cancelled while queued rejects at once and evaluates nothing; the run behind it still waits its turn", async () => {
    const order: string[] = [];
    const release: Array<() => void> = [];
    evaluateRequirementFindings.mockImplementation(async (i: { requirement: { id: string } }) => {
      order.push(`start ${i.requirement.id}`);
      await new Promise<void>((r) => release.push(r));
      order.push(`end ${i.requirement.id}`);
      return { findings: [], unverifiedCitations: 0, noEvidenceDemoted: 0 };
    });
    const run = (requirementIds: string[], signal?: AbortSignal) =>
      produceGoverningFindingsForAnalysis({
        analysisId: "a_queued_abort",
        projectId: "p",
        provider,
        applicability: STORED,
        requirementIds,
        ...(signal ? { signal } : {}),
      });
    const controller = new AbortController();
    const first = run(["REQ-001"]);
    const cancelled = run(["REQ-003"], controller.signal);
    const third = run(["REQ-003"]);
    await vi.waitFor(() => expect(release).toHaveLength(1));
    controller.abort(Object.assign(new Error("aborted"), { name: "AbortError" }));
    // Rejected while the first run is still in flight, not after it.
    await expect(cancelled).rejects.toThrow("aborted");
    expect(order).toEqual(["start REQ-001"]);
    // The run behind the cancelled one did not jump ahead of the first.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start REQ-001"]);
    expect(governingFindingsRefreshing("a_queued_abort")).toBe(true);
    release.shift()!();
    await first;
    await vi.waitFor(() => expect(release).toHaveLength(1));
    release.shift()!();
    await third;
    expect(order).toEqual(["start REQ-001", "end REQ-001", "start REQ-003", "end REQ-003"]);
    expect(evaluateRequirementFindings).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(governingFindingsRefreshing("a_queued_abort")).toBe(false));
  });

  it("#2022 — a run whose signal is already aborted evaluates nothing", async () => {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(
      produceGoverningFindingsForAnalysis({
        analysisId: "a_pre_aborted",
        projectId: "p",
        provider,
        applicability: STORED,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(evaluateRequirementFindings).not.toHaveBeenCalled();
    expect(readGoverningApplicability).not.toHaveBeenCalled();
  });

  it("#2017 — a failed run does not stop the next one queued behind it", async () => {
    evaluateRequirementFindings.mockResolvedValue({
      findings: [],
      unverifiedCitations: 0,
      noEvidenceDemoted: 0,
    });
    db.$transaction.mockRejectedValueOnce(new Error("write failed"));
    const failing = produceGoverningFindingsForAnalysis({
      analysisId: "a_fail",
      projectId: "p",
      provider,
      applicability: STORED,
    });
    const next = produceGoverningFindingsForAnalysis({
      analysisId: "a_fail",
      projectId: "p",
      provider,
      applicability: STORED,
    });
    await expect(failing).rejects.toThrow("write failed");
    await expect(next).resolves.toMatchObject({ requirements: 2 });
    await vi.waitFor(() => expect(governingFindingsRefreshing("a_fail")).toBe(false));
  });

  it("#2010 — a cancelled run stops: it throws, counts nothing as failed, and writes nothing", async () => {
    const controller = new AbortController();
    evaluateRequirementFindings.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(
      produceGoverningFindingsForAnalysis({
        analysisId: "a",
        projectId: "p",
        provider,
        applicability: STORED,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.governingFinding.upsert).not.toHaveBeenCalled();
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
      decidedByName: null,
      createdAt: at.toISOString(),
    });
    // No finding was decided, so no user was looked up.
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("#1876 — a decided finding carries its decider's display name, or the username without one; a gone user reads null", async () => {
    const { listGoverningFindings } = await import("./findings-store.js");
    const at = new Date("2026-11-08T00:00:00.000Z");
    const row = (id: string, decidedById: string | null) => ({
      id,
      analysisId: "a",
      requirementId: "REQ-001",
      ruleId: `r-${id}`,
      revisionId: "rev",
      revisionLabel: "v1",
      documentTitle: "Doc",
      controlId: "C-1",
      clauseRef: "§1",
      status: "gap",
      reasoning: "r",
      clauseStart: null,
      clauseEnd: null,
      clauseExcerpt: null,
      citationDropped: false,
      modelStatus: null,
      businessQuestion: null,
      decision: decidedById ? "rejected" : null,
      decisionNote: null,
      decidedById,
      decidedAt: decidedById ? at : null,
      createdAt: at,
      updatedAt: at,
    });
    db.governingFinding.findMany.mockResolvedValueOnce([
      row("f1", "u1"),
      row("f2", "u2"),
      row("f3", "u1"),
      row("f4", "gone"),
      row("f5", null),
    ]);
    db.user.findMany.mockResolvedValueOnce([
      { id: "u1", displayName: "Ada Lovelace", username: "ada" },
      { id: "u2", displayName: "  ", username: "grace" },
    ]);
    const out = await listGoverningFindings("a");
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["u1", "u2", "gone"] } },
      select: { id: true, displayName: true, username: true },
    });
    expect(out.map((f) => f.decidedByName)).toEqual([
      "Ada Lovelace",
      "grace",
      "Ada Lovelace",
      null,
      null,
    ]);
  });
});

describe("decideGoverningFinding — the decider is read inside its transaction (#2032)", () => {
  it("looks the decider's name up through the transaction client, never the global one", async () => {
    const { decideGoverningFinding } = await import("./findings-store.js");
    const at = new Date("2026-11-08T00:00:00.000Z");
    const stored = {
      id: "gf1",
      analysisId: "a",
      requirementId: "REQ-001",
      ruleId: "r1",
      revisionId: "rev",
      revisionLabel: "v1",
      documentTitle: "Doc",
      controlId: "C-1",
      clauseRef: "§1",
      status: "gap",
      reasoning: "r",
      clauseStart: null,
      clauseEnd: null,
      clauseExcerpt: null,
      citationDropped: false,
      modelStatus: null,
      businessQuestion: null,
      decision: null,
      decisionNote: null,
      decidedById: null,
      decidedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const tx = {
      governingFinding: {
        findFirst: vi.fn().mockResolvedValue(stored),
        update: vi.fn(async ({ data }: { data: object }) => ({ ...stored, ...data })),
      },
      auditLog: { create: vi.fn() },
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "u1", displayName: "Ada", username: "ada" }]),
      },
    };
    db.$transaction.mockImplementationOnce(async (fn: (t: unknown) => unknown) => fn(tx));
    const out = await decideGoverningFinding({
      analysisId: "a",
      findingId: "gf1",
      decision: "rejected",
      note: "  out of scope  ",
      decidedById: "u1",
      now: at,
    });
    expect(out).toMatchObject({
      decision: "rejected",
      decisionNote: "out of scope",
      decidedByName: "Ada",
    });
    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["u1"] } },
      select: { id: true, displayName: true, username: true },
    });
    // The global client would take a second pooled connection mid-transaction.
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe("governingFindingRevisions (#1876)", () => {
  const f = (over: Partial<GoverningFinding>): GoverningFinding =>
    ({
      revisionId: "rev-1",
      documentTitle: "Policy",
      revisionLabel: "v1",
      ruleId: "r1",
      ...over,
    }) as GoverningFinding;

  it("one entry per cited revision, in first-cited order, with its live rules plus any cited rule since deleted", async () => {
    db.governingRule.count.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
    const out = await governingFindingRevisions([
      f({ ruleId: "r1" }),
      f({ ruleId: "r2" }),
      f({ ruleId: "r1", requirementId: "REQ-002" }),
      f({ revisionId: "rev-2", documentTitle: "Retention", revisionLabel: "v4", ruleId: "r9" }),
    ]);
    expect(out).toEqual([
      { revisionId: "rev-1", documentTitle: "Policy", revisionLabel: "v1", rules: 12 },
      { revisionId: "rev-2", documentTitle: "Retention", revisionLabel: "v4", rules: 3 },
    ]);
    expect(db.governingRule.count).toHaveBeenNthCalledWith(1, {
      where: { revisionId: "rev-1", OR: [{ deletedAt: null }, { id: { in: ["r1", "r2"] } }] },
    });
    expect(db.governingRule.count).toHaveBeenNthCalledWith(2, {
      where: { revisionId: "rev-2", OR: [{ deletedAt: null }, { id: { in: ["r9"] } }] },
    });
  });

  it("no findings: no revisions and no query", async () => {
    expect(await governingFindingRevisions([])).toEqual([]);
    expect(db.governingRule.count).not.toHaveBeenCalled();
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
