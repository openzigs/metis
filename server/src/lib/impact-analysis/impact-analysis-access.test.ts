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
import { describe, expect, it, vi } from "vitest";
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
 *
 * #103 — it honours `include` the way Prisma does: a relation the query did not
 * ask for is ABSENT from the row. The previous double answered from `where.id`
 * alone and returned `projects` regardless, so reverting the detail read to
 * `ITEM_INCLUDE` (which drops `projects`) left every test here green.
 */
function detailPrisma(row: DetailRow | null) {
  const findFirst = vi.fn(
    async ({ where, include }: { where: { id: string }; include?: Record<string, unknown> }) => {
      if (!row || row.id !== where.id) return null;
      const { items, projects, ...scalars } = row;
      return {
        ...scalars,
        ...(include?.items ? { items } : {}),
        ...(include?.projects ? { projects } : {}),
      };
    },
  );
  return { impactAnalysis: { findFirst } };
}

describe("#88 getImpactAnalysisDetail names the run's PERSISTED projects", () => {
  /**
   * The bug in one assertion: before the fix this run reported `projectIds: []`,
   * which is what let `loadAccessibleImpactDetail` skip its own check.
   */
  it("names the started-for projects of a run that has written no item yet", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-88",
      detailPrisma(detailRow({ projects: [{ projectId: "p-secret" }], items: [] })) as never,
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
      ) as never,
    );
    // Started-for first, exactly as the list projection orders them.
    expect(detail?.projectIds).toEqual(["p-a", "p-b", "p-c"]);
  });

  /** The legacy row the route's `startedById` fallback exists for. */
  it("reports no projects, and the starting actor, for a run with neither", async () => {
    const detail = await getImpactAnalysisDetail(
      "ia-88",
      detailPrisma(detailRow({ projects: [], items: [], startedById: "user-owner" })) as never,
    );
    expect(detail?.projectIds).toEqual([]);
    expect(detail?.startedById).toBe("user-owner");
  });
});

/**
 * #103 — the query shape itself, pinned. The behavioural tests above only see
 * what the double returns; these fix what the read ASKS Prisma for, so a
 * narrowed `include` cannot pass unnoticed through a permissive double.
 */
describe("#103 getImpactAnalysisDetail query shape", () => {
  it("asks for the run by id and includes its persisted projects", async () => {
    const prisma = detailPrisma(detailRow({ projects: [{ projectId: "p-a" }] }));
    await getImpactAnalysisDetail("ia-88", prisma as never);

    expect(prisma.impactAnalysis.findFirst).toHaveBeenCalledWith({
      where: { id: "ia-88" },
      include: expect.objectContaining({
        projects: { select: { projectId: true } },
      }),
    });
  });

  it("includes every item relation the detail projection renders", async () => {
    const prisma = detailPrisma(detailRow());
    await getImpactAnalysisDetail("ia-88", prisma as never);

    expect(prisma.impactAnalysis.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          items: expect.objectContaining({
            include: {
              affectedSymbols: { orderBy: [{ depth: "asc" }, { confidence: "desc" }] },
              affectedTables: {
                include: {
                  consumers: {
                    orderBy: [{ consumerProjectName: "asc" }, { consumerProjectId: "asc" }],
                  },
                },
                orderBy: [{ tableName: "asc" }, { columnName: "asc" }],
              },
              feedback: { orderBy: [{ createdAt: "asc" }] },
              requirement: { select: { title: true } },
            },
          }),
        }),
      }),
    );
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

/**
 * #103 audit — the list read's `projects` include was equally unpinned: this
 * file's double returns `projects` whatever the query asked for.
 */
describe("#103 listImpactAnalyses query shape", () => {
  it("includes both the item-derived and the persisted project ids", async () => {
    const findMany = vi.fn(async () => [] as ListRow[]);
    await listImpactAnalyses({}, { impactAnalysis: { findMany } } as never);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          items: { select: { projectId: true } },
          projects: { select: { projectId: true } },
        },
      }),
    );
  });
});

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
