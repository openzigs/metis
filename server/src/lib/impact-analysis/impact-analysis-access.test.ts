/**
 * #88 — the read-side half of the impact-analysis A01 fix.
 *
 * #70 closed the "empty `projectIds` means visible to everyone" hatch on the
 * LIST path. Its twin survived on the DETAIL path for one reason: the detail
 * projection derived `projectIds` from `ImpactItem` rows ALONE, so an in-flight
 * run — which has no items yet — presented as a run belonging to no project,
 * and the route's guard skipped itself on the empty list. `impact_analysis_projects`
 * has held the started-for selection since #70; the detail read simply never
 * consulted it.
 *
 * The other half is the legacy row: a pre-#70 run with neither persisted
 * projects nor items. Its projects are not recoverable, so the only principal
 * who may still see it is the one who started it (`startedById`), on BOTH the
 * list and the detail paths.
 */
import { describe, expect, it } from "vitest";
import { getImpactAnalysisDetail, listImpactAnalyses } from "./impact-analysis-read.js";

type ProjectLink = { projectId: string };

type DetailRow = {
  id: string;
  status: string;
  documentId: string | null;
  sourceText: string | null;
  summary: string | null;
  errorMessage: string | null;
  totalImpactedSymbols: number;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  rerunOfId: string | null;
  items: Array<Record<string, unknown>>;
  projects: ProjectLink[];
};

function detailRow(over: Partial<DetailRow> = {}): DetailRow {
  return {
    id: "ia-88",
    status: "running",
    documentId: null,
    sourceText: "change something",
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 0,
    startedById: "user-owner",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    rerunOfId: null,
    items: [],
    projects: [],
    ...over,
  };
}

/** One impact item, reduced to the fields the detail projection reads. */
function item(projectId: string, id = `item-${projectId}`): Record<string, unknown> {
  return {
    id,
    projectId,
    requirementId: null,
    requirementText: null,
    changeType: "added",
    severity: "low",
    impactScore: 0.1,
    confidence: 0.5,
    affectedFileCount: 0,
    affectedSymbolCount: 0,
    requirement: null,
    affectedSymbols: [],
    affectedTables: [],
    feedback: [],
  };
}

/**
 * A prisma double WITHOUT `codeSymbol`/`codeEdge`, so the #962 write-path pass
 * is skipped and the assertions measure the projection alone.
 */
function detailPrisma(row: DetailRow | null) {
  return {
    impactAnalysis: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        row && row.id === where.id ? row : null,
    },
  } as never;
}

describe("#88 getImpactAnalysisDetail names the run's PERSISTED projects", () => {
  /**
   * The bug in one assertion: before the fix this run reported `projectIds: []`,
   * which is what let `loadAccessibleImpactDetail` skip its own check.
   */
  it("names the started-for projects of a run that has written no item yet", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-88",
      detailPrisma(detailRow({ projects: [{ projectId: "p-secret" }], items: [] })),
    );
    expect(detail?.projectIds).toEqual(["p-secret"]);
  });

  /** Items may name a project the run was not started for; both are the run's. */
  it("unions the started-for projects with the item-derived ones, without duplicates", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-88",
      detailPrisma(
        detailRow({
          projects: [{ projectId: "p-a" }, { projectId: "p-b" }],
          items: [item("p-a"), item("p-c")],
        }),
      ),
    );
    // Started-for first, exactly as the list projection orders them.
    expect(detail?.projectIds).toEqual(["p-a", "p-b", "p-c"]);
  });

  /** The legacy row the route's `startedById` fallback exists for. */
  it("reports no projects, and the starting actor, for a run with neither", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-88",
      detailPrisma(detailRow({ projects: [], items: [], startedById: "user-owner" })),
    );
    expect(detail?.projectIds).toEqual([]);
    expect(detail?.startedById).toBe("user-owner");
  });
});

// ---- list path: the legacy run stays visible to the actor who started it ----

type ListRow = {
  id: string;
  status: string;
  documentId: string | null;
  summary: string | null;
  totalImpactedSymbols: number;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  rerunOfId: string | null;
  items: ProjectLink[];
  projects: ProjectLink[];
};

function listRow(id: string, over: Partial<ListRow> = {}): ListRow {
  return {
    id,
    status: "completed",
    documentId: null,
    summary: null,
    totalImpactedSymbols: 0,
    startedById: "user-owner",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    rerunOfId: null,
    items: [],
    projects: [],
    ...over,
  };
}

function listPrisma(rows: ListRow[]) {
  return {
    impactAnalysis: { findMany: async () => rows },
  } as never;
}

describe("#88 listImpactAnalyses keeps a legacy run visible to its starter", () => {
  const legacy = listRow("legacy", { startedById: "user-owner" });
  const mine = listRow("mine", { projects: [{ projectId: "p-mine" }] });

  it("shows a run with no recoverable projects to the actor who started it", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"], actorId: "user-owner" },
      listPrisma([legacy, mine]),
    );
    expect(listed.map((r) => r.id)).toEqual(["legacy", "mine"]);
  });

  /** #70's rule is unchanged for everybody else — this is not a reopened hatch. */
  it("still hides it from every other member", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"], actorId: "user-stranger" },
      listPrisma([legacy, mine]),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine"]);
  });

  it("hides it when no actor is supplied at all", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"] },
      listPrisma([legacy, mine]),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine"]);
  });

  /**
   * The fallback is for UNRECOVERABLE runs only. Starting a run does not buy
   * you back a project you have lost access to.
   */
  it("does not show its starter a run whose projects they cannot access", async () => {
    const secret = listRow("secret", {
      startedById: "user-owner",
      projects: [{ projectId: "p-secret" }],
    });
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"], actorId: "user-owner" },
      listPrisma([secret, mine]),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine"]);
  });
});
