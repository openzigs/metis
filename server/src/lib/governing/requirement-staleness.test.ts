/**
 * #2222 — which governing findings judge an older wording of a requirement.
 * The pure join (`withGoverningStaleness`) on plain objects, and the reads
 * (`storedRequirementStates`, `analysedVersions`) on a mocked Prisma client,
 * so their scoping is asserted.
 */
import type { GoverningAnalysisApplicability, GoverningFinding } from "@metis/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  requirementFindMany: vi.fn(),
  findingFindMany: vi.fn(),
  versionGroupBy: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: { findMany: db.requirementFindMany },
    finding: { findMany: db.findingFindMany },
    requirementVersion: { groupBy: db.versionGroupBy },
  },
}));

const {
  analysedVersionOf,
  analysedVersions,
  evidenceFindingIdsOf,
  evidenceRequirementId,
  recheckedRequirementTitles,
  storedRequirementStates,
  withGoverningStaleness,
} = await import("./requirement-staleness.js");
type State = import("./requirement-staleness.js").StoredRequirementState;

function finding(overrides: Partial<GoverningFinding> = {}): GoverningFinding {
  return {
    id: "gf-1",
    analysisId: "ana-1",
    requirementId: "AC-2",
    ruleId: "rule-1",
    revisionId: "rev-1",
    revisionLabel: "v1",
    documentTitle: "Authentication Standard",
    controlId: "PW-01",
    clauseRef: "§5.1",
    status: "gap",
    reasoning: "r",
    clauseStart: 0,
    clauseEnd: 10,
    clauseExcerpt: "x",
    citationDropped: false,
    modelStatus: null,
    businessQuestion: null,
    decision: null,
    decisionNote: null,
    decidedById: null,
    decidedByName: null,
    decidedAt: null,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    requirementVersions: null,
    ...overrides,
  };
}

function state(overrides: Partial<State> & Pick<State, "id">): State {
  return {
    title: `Title of ${overrides.id}`,
    version: 0,
    analysedVersion: 0,
    analysedIds: new Set(["AC-2"]),
    ...overrides,
  };
}

function applicability(
  entries: GoverningAnalysisApplicability["requirements"],
): GoverningAnalysisApplicability {
  return { decidedAt: "2026-11-10T00:00:00.000Z", requirements: entries };
}

describe("analysedVersionOf", () => {
  it("is the version before a person's first edit, else the current version", () => {
    expect(analysedVersionOf(3, undefined)).toBe(3);
    expect(analysedVersionOf(3, 2)).toBe(1);
    expect(analysedVersionOf(1, 1)).toBe(0);
    expect(analysedVersionOf(1, 0)).toBe(0);
  });
});

describe("evidence helpers", () => {
  it("reads the analysed id of a finding's evidence, and nothing from a bad blob", () => {
    expect(evidenceRequirementId(JSON.stringify({ requirementId: "AC-2" }))).toBe("AC-2");
    expect(evidenceRequirementId(JSON.stringify({ requirementId: "" }))).toBeNull();
    expect(evidenceRequirementId(JSON.stringify({ requirementId: 3 }))).toBeNull();
    expect(evidenceRequirementId("not json")).toBeNull();
    expect(evidenceRequirementId(null)).toBeNull();
  });

  it("reads only the finding labels", () => {
    expect(evidenceFindingIdsOf(JSON.stringify(["triage", "finding:f-1", "finding:f-2"]))).toEqual([
      "f-1",
      "f-2",
    ]);
  });
});

describe("withGoverningStaleness", () => {
  it("an analysed finding is current while every requirement drawn from it is at its analysed version", () => {
    const [f] = withGoverningStaleness(
      [finding()],
      [state({ id: "r1", version: 2, analysedVersion: 2 }), state({ id: "r2" })],
      null,
    );
    expect(f!.stale).toEqual([]);
  });

  it("is stale for each requirement a person edited, and only those", () => {
    const [f] = withGoverningStaleness(
      [finding()],
      [
        state({ id: "r1", title: "Minimum length", version: 1, analysedVersion: 0 }),
        state({ id: "r2" }),
        state({ id: "r3", version: 4, analysedVersion: 1, analysedIds: new Set(["AC-9"]) }),
      ],
      null,
    );
    expect(f!.stale).toEqual([
      { requirementId: "r1", title: "Minimum length", judgedVersion: 0, currentVersion: 1 },
    ]);
  });

  it("an analysed finding stops being stale for a requirement re-checked at its current version", () => {
    const states = [state({ id: "r1", version: 2, analysedVersion: 0 })];
    const current = applicability([
      { requirementId: "r1", text: "t", decisions: [], versions: { r1: 2 } },
    ]);
    expect(withGoverningStaleness([finding()], states, current)[0]!.stale).toEqual([]);
    // Re-checked at an older version, or the re-check failed: still stale.
    const older = applicability([
      { requirementId: "r1", text: "t", decisions: [], versions: { r1: 1 } },
    ]);
    expect(withGoverningStaleness([finding()], states, older)[0]!.stale).toHaveLength(1);
    const failed = applicability([
      { requirementId: "r1", text: "t", decisions: [], versions: { r1: 2 }, error: "e" },
    ]);
    expect(withGoverningStaleness([finding()], states, failed)[0]!.stale).toHaveLength(1);
  });

  it("a re-checked finding judges the version it recorded, and only its own requirement", () => {
    const states = [
      state({ id: "r1", version: 3, analysedVersion: 0 }),
      state({ id: "r2", version: 5, analysedVersion: 0 }),
    ];
    const own = finding({ id: "gf-2", requirementId: "r1", requirementVersions: { r1: 3 } });
    expect(withGoverningStaleness([own], states, null)[0]!.stale).toEqual([]);
    const behind = finding({ id: "gf-3", requirementId: "r1", requirementVersions: { r1: 2 } });
    expect(withGoverningStaleness([behind], states, null)[0]!.stale).toEqual([
      { requirementId: "r1", title: "Title of r1", judgedVersion: 2, currentVersion: 3 },
    ]);
  });

  it("a finding on an analysed requirement no stored requirement draws on is never stale", () => {
    const [f] = withGoverningStaleness(
      [finding({ requirementId: "NR-1" })],
      [state({ id: "r1", version: 1 })],
      null,
    );
    expect(f!.stale).toEqual([]);
  });
});

describe("recheckedRequirementTitles", () => {
  it("names the stored requirements findings are keyed by, and no other", () => {
    const states = [state({ id: "r1", title: "One" }), state({ id: "r2", title: "Two" })];
    expect(
      recheckedRequirementTitles([finding(), finding({ id: "gf-2", requirementId: "r1" })], states),
    ).toEqual({ r1: "One" });
  });
});

describe("the reads", () => {
  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset();
  });

  it("asks for person versions only of requirements above version 0, and none when there are none", async () => {
    db.versionGroupBy.mockResolvedValue([{ requirementId: "r2", _min: { version: 2 } }]);
    const versions = await analysedVersions([
      { id: "r1", version: 0 },
      { id: "r2", version: 3 },
      { id: "r3", version: 1 },
    ]);
    expect(db.versionGroupBy).toHaveBeenCalledWith({
      by: ["requirementId"],
      where: { requirementId: { in: ["r2", "r3"] }, actorId: { not: null } },
      _min: { version: true },
    });
    expect([...versions]).toEqual([
      ["r1", 0],
      ["r2", 1],
      ["r3", 1],
    ]);
    db.versionGroupBy.mockClear();
    await analysedVersions([{ id: "r1", version: 0 }]);
    expect(db.versionGroupBy).not.toHaveBeenCalled();
  });

  it("reads the analysis's live requirements and their evidence within the analysis and project", async () => {
    db.requirementFindMany.mockResolvedValue([
      {
        id: "r1",
        title: "One",
        version: 1,
        labels: JSON.stringify(["finding:f-1", "finding:f-9"]),
      },
      { id: "r2", title: "Two", version: 0, labels: "[]" },
    ]);
    db.findingFindMany.mockResolvedValue([
      { id: "f-1", evidence: JSON.stringify({ requirementId: "AC-2" }) },
      { id: "f-9", evidence: null },
    ]);
    db.versionGroupBy.mockResolvedValue([{ requirementId: "r1", _min: { version: 1 } }]);
    const states = await storedRequirementStates("ana-1", "p-1");
    expect(db.requirementFindMany).toHaveBeenCalledWith({
      where: { analysisId: "ana-1", projectId: "p-1", deletedAt: null },
      select: { id: true, title: true, version: true, labels: true },
    });
    expect(db.findingFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["f-1", "f-9"] },
        agentResult: { analysisId: "ana-1", analysis: { projectId: "p-1" } },
      },
      select: { id: true, evidence: true },
    });
    expect(states).toEqual([
      { id: "r1", title: "One", version: 1, analysedVersion: 0, analysedIds: new Set(["AC-2"]) },
      { id: "r2", title: "Two", version: 0, analysedVersion: 0, analysedIds: new Set() },
    ]);
  });

  it("reads nothing more for an analysis with no live requirement, or no evidence", async () => {
    db.requirementFindMany.mockResolvedValue([]);
    expect(await storedRequirementStates("ana-1", "p-1")).toEqual([]);
    db.requirementFindMany.mockResolvedValue([
      { id: "r1", title: "One", version: 0, labels: "[]" },
    ]);
    await storedRequirementStates("ana-1", "p-1");
    expect(db.findingFindMany).not.toHaveBeenCalled();
    expect(db.versionGroupBy).not.toHaveBeenCalled();
  });
});
