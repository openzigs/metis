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
  versionFindMany: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: { findMany: db.requirementFindMany },
    finding: { findMany: db.findingFindMany },
    requirementVersion: { groupBy: db.versionGroupBy, findMany: db.versionFindMany },
  },
}));

const {
  ANSWERED_CLARIFICATION_VERSION_REASON,
  analysedVersionOf,
  analysedVersions,
  answeredOnlyVersions,
  editedWithoutFindings,
  evidenceFindingIdsOf,
  evidenceRequirementId,
  isRecheckEntry,
  recheckedRequirementTitles,
  storedRequirementStates,
  withGoverningStaleness,
  withoutDeletedRechecks,
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
      // #2429 — an answer to a clarifying question given after the analysis is
      // a person's edit too, though its actor is null.
      where: {
        requirementId: { in: ["r2", "r3"] },
        OR: [{ actorId: { not: null } }, { reason: ANSWERED_CLARIFICATION_VERSION_REASON }],
      },
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

  it("#2429 — answeredOnlyVersions: the live requirements of the analysis and project no one edited by hand, at their version and body", async () => {
    db.requirementFindMany.mockResolvedValue([
      { id: "r1", version: 2, body: "b1" },
      { id: "r2", version: 3, body: "b2" },
    ]);
    db.versionFindMany.mockResolvedValue([{ requirementId: "r2" }]);
    const versions = await answeredOnlyVersions(["r1", "r2", "gone"], "ana-1", "proj-1");
    // The body is read in the same read as the version, so it is the body at it.
    expect(db.requirementFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["r1", "r2", "gone"] },
        analysisId: "ana-1",
        projectId: "proj-1",
        deletedAt: null,
      },
      select: { id: true, version: true, body: true },
    });
    // Only versions with an actor are a hand edit here: the answers were judged.
    expect(db.versionFindMany).toHaveBeenCalledWith({
      where: { requirementId: { in: ["r1", "r2"] }, actorId: { not: null } },
      distinct: ["requirementId"],
      select: { requirementId: true },
    });
    expect([...versions]).toEqual([["r1", { version: 2, body: "b1" }]]);

    db.requirementFindMany.mockClear();
    db.versionFindMany.mockClear();
    db.requirementFindMany.mockResolvedValue([]);
    expect((await answeredOnlyVersions([], "ana-1", "proj-1")).size).toBe(0);
    expect(db.requirementFindMany).not.toHaveBeenCalled();
    expect((await answeredOnlyVersions(["gone"], "ana-1", "proj-1")).size).toBe(0);
    expect(db.versionFindMany).not.toHaveBeenCalled();
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

describe("a deleted requirement's re-check (#2281)", () => {
  const recheckOf = (id: string, version = 1) => ({
    requirementId: id,
    text: "t",
    decisions: [],
    versions: { [id]: version },
  });

  it("isRecheckEntry: an entry recording its own id's version, never an analysed one", () => {
    expect(isRecheckEntry(recheckOf("r1"))).toBe(true);
    expect(isRecheckEntry({ requirementId: "AC-2", text: "t", decisions: [] })).toBe(false);
    expect(
      isRecheckEntry({ requirementId: "AC-2", text: "t", decisions: [], versions: { r1: 0 } }),
    ).toBe(false);
  });

  it("leaves out the findings of a re-checked requirement that is no longer live, and no other", () => {
    const findings = [
      finding(),
      finding({ id: "gf-gone", requirementId: "r-gone", requirementVersions: { "r-gone": 1 } }),
      finding({ id: "gf-live", requirementId: "r1", requirementVersions: { r1: 1 } }),
    ];
    const stored = applicability([
      { requirementId: "AC-2", text: "t", decisions: [] },
      recheckOf("r-gone"),
      recheckOf("r1"),
    ]);
    const out = withGoverningStaleness(findings, [state({ id: "r1", version: 1 })], stored);
    expect(out.map((f) => f.id)).toEqual(["gf-1", "gf-live"]);
    // A finding keyed by an id no re-check stored (an analysed one) always stays.
    expect(withGoverningStaleness(findings, [], null).map((f) => f.id)).toEqual([
      "gf-1",
      "gf-gone",
      "gf-live",
    ]);
  });

  it("withoutDeletedRechecks reads only the re-checked ids, within the analysis and project", async () => {
    db.requirementFindMany.mockReset();
    const stored = applicability([
      { requirementId: "AC-2", text: "t", decisions: [] },
      recheckOf("r-gone"),
      recheckOf("r1"),
    ]);
    db.requirementFindMany.mockResolvedValue([{ id: "r1" }]);
    const out = await withoutDeletedRechecks(stored, "ana-1", "p-1");
    expect(db.requirementFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["r-gone", "r1"] },
        analysisId: "ana-1",
        projectId: "p-1",
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(out.requirements.map((e) => e.requirementId)).toEqual(["AC-2", "r1"]);

    // Nothing deleted: the same object. No re-check entry: no read at all.
    db.requirementFindMany.mockResolvedValue([{ id: "r-gone" }, { id: "r1" }]);
    expect(await withoutDeletedRechecks(stored, "ana-1", "p-1")).toBe(stored);
    db.requirementFindMany.mockClear();
    const analysed = applicability([{ requirementId: "AC-2", text: "t", decisions: [] }]);
    expect(await withoutDeletedRechecks(analysed, "ana-1", "p-1")).toBe(analysed);
    expect(db.requirementFindMany).not.toHaveBeenCalled();
  });
});

describe("editedWithoutFindings (#2281)", () => {
  const checked = applicability([{ requirementId: "AC-2", text: "t", decisions: [] }]);

  it("lists a requirement edited since the check whose analysed requirement produced no finding", () => {
    const states = [
      state({ id: "r1", title: "Timeout", version: 2, analysedVersion: 0 }),
      // Not edited since the analysis.
      state({ id: "r2", version: 1, analysedVersion: 1 }),
      // Drawn from no analysed requirement: the check never saw it.
      state({ id: "r3", version: 1, analysedVersion: 0, analysedIds: new Set() }),
    ];
    expect(editedWithoutFindings([], states, checked)).toEqual([
      { requirementId: "r1", title: "Timeout", judgedVersion: 0, currentVersion: 2 },
    ]);
    // The check never ran: nothing to re-check against.
    expect(editedWithoutFindings([], states, null)).toEqual([]);
  });

  it("leaves out one a stale finding already offers, or one with findings of its own", () => {
    const states = [state({ id: "r1", version: 2, analysedVersion: 0 })];
    const stale = withGoverningStaleness([finding()], states, checked);
    expect(stale[0]!.stale).toHaveLength(1);
    expect(editedWithoutFindings(stale, states, checked)).toEqual([]);
    const own = withGoverningStaleness(
      [finding({ requirementId: "r1", requirementVersions: { r1: 1 } })],
      states,
      checked,
    );
    expect(editedWithoutFindings(own, states, checked)).toEqual([]);
  });

  it("a re-check that found nothing judges its version: listed again after the next edit only", () => {
    const rechecked = (version: number) =>
      applicability([
        { requirementId: "AC-2", text: "t", decisions: [] },
        { requirementId: "r1", text: "t", decisions: [], versions: { r1: version } },
      ]);
    const states = [
      state({ id: "r1", title: "T", version: 3, analysedVersion: 0, analysedIds: new Set() }),
    ];
    expect(editedWithoutFindings([], states, rechecked(3))).toEqual([]);
    expect(editedWithoutFindings([], states, rechecked(2))).toEqual([
      { requirementId: "r1", title: "T", judgedVersion: 2, currentVersion: 3 },
    ]);
  });

  it("#2311 — lists none whose analysed requirement the check could not decide, or never reached", () => {
    const states = [state({ id: "r1", title: "Timeout", version: 2, analysedVersion: 0 })];
    // Every entry errored: the check judged nothing, so nothing was edited "since" it.
    const errored = applicability([
      { requirementId: "AC-2", text: "t", decisions: [], error: "Rules could not be loaded." },
    ]);
    expect(editedWithoutFindings([], states, errored)).toEqual([]);
    // An entry for another analysed requirement only: AC-2 was never reached.
    const elsewhere = applicability([{ requirementId: "AC-9", text: "t", decisions: [] }]);
    expect(editedWithoutFindings([], states, elsewhere)).toEqual([]);
    // Drawn from two analysed requirements, one of them decided: it was judged.
    const twoSources = [state({ ...states[0]!, analysedIds: new Set(["AC-2", "AC-9"]) })];
    expect(editedWithoutFindings([], twoSources, elsewhere)).toEqual([
      { requirementId: "r1", title: "Timeout", judgedVersion: 0, currentVersion: 2 },
    ]);
  });

  it("#2429 — an analysed entry a clarification re-run re-decided judges the version it recorded", () => {
    const states = [state({ id: "r1", title: "Timeout", version: 2, analysedVersion: 1 })];
    const reDecided = (version: number) =>
      applicability([
        { requirementId: "AC-2", text: "t", decisions: [], versions: { r1: version } },
      ]);
    // The re-decision judged the answered wording: nothing to re-check.
    expect(editedWithoutFindings([], states, reDecided(2))).toEqual([]);
    // Edited again since: listed, judged at the re-decided version.
    expect(editedWithoutFindings([], states, reDecided(1))).toEqual([
      { requirementId: "r1", title: "Timeout", judgedVersion: 1, currentVersion: 2 },
    ]);
    // Drawn from two decided analysed requirements, one not re-decided: the
    // older judgment stands, so it is still offered.
    const two = [state({ ...states[0]!, analysedIds: new Set(["AC-2", "AC-9"]) })];
    const both = applicability([
      { requirementId: "AC-2", text: "t", decisions: [], versions: { r1: 2 } },
      { requirementId: "AC-9", text: "t", decisions: [] },
    ]);
    expect(editedWithoutFindings([], two, both)).toEqual([
      { requirementId: "r1", title: "Timeout", judgedVersion: 1, currentVersion: 2 },
    ]);
    // An errored entry's versions judge nothing.
    const errored = applicability([
      { requirementId: "AC-2", text: "t", decisions: [], versions: { r1: 2 }, error: "x" },
    ]);
    expect(editedWithoutFindings([], states, errored)).toEqual([]);
  });

  it("#2429 — a finding a clarification re-run re-produced is current for the row it judged, and stale for the rest", () => {
    const states = [
      state({ id: "r1", version: 2, analysedVersion: 1 }),
      state({ id: "r2", version: 1, analysedVersion: 0 }),
    ];
    const [f] = withGoverningStaleness([finding({ requirementVersions: { r1: 2 } })], states, null);
    expect(f!.stale).toEqual([
      { requirementId: "r2", title: "Title of r2", judgedVersion: 0, currentVersion: 1 },
    ]);
  });
});
