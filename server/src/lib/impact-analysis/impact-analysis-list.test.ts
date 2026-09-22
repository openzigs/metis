/**
 * #61 — `listImpactAnalyses` names each run's projects, so a project page can
 * list its own runs, without naming a project the caller cannot access.
 *
 * #70 — and it names the projects the run was STARTED for, not only those its
 * `ImpactItem` rows mention. A run that is pending/running, failed before its
 * first item, or extracted zero changes has no items at all, so the item-derived
 * set was empty: the run was invisible on every project page, and the
 * `projectIds.length === 0` arm of the access filter let it through to EVERY
 * non-admin caller.
 *
 * A fake `impactAnalysis.findMany` applies the `where`, `orderBy` and `take` the
 * real query would, so a filter left to the caller (after `take`) shows up as
 * a missing row rather than passing unnoticed.
 */
import { describe, expect, it } from "vitest";
import { listImpactAnalyses } from "./impact-analysis-read.js";

type Row = {
  id: string;
  status: string;
  documentId: string | null;
  summary: string | null;
  totalImpactedSymbols: number;
  startedAt: Date;
  completedAt: Date | null;
  rerunOfId: string | null;
  items: Array<{ projectId: string }>;
  /** #70 — the projects the run was started for, persisted at creation. */
  projects: Array<{ projectId: string }>;
};

function run(id: string, minute: number, projectIds: string[], over: Partial<Row> = {}): Row {
  return {
    id,
    status: "completed",
    documentId: null,
    summary: null,
    totalImpactedSymbols: 1,
    startedAt: new Date(Date.UTC(2026, 8, 22, 10, minute)),
    completedAt: null,
    rerunOfId: null,
    items: projectIds.map((projectId) => ({ projectId })),
    projects: projectIds.map((projectId) => ({ projectId })),
    ...over,
  };
}

/**
 * #70 — a run that has not written an item yet: the selected projects are
 * persisted, `items` is empty. This is the shape every pending/running run and
 * every zero-change run has.
 */
function startedRun(id: string, minute: number, projectIds: string[]): Row {
  return run(id, minute, projectIds, { status: "running", items: [], totalImpactedSymbols: 0 });
}

type WhereClause = {
  projects?: { some?: { projectId?: string } };
  items?: { some?: { projectId?: string } };
};

/** Apply one `where` (or one arm of an `OR`) the way the real query would. */
function matches(row: Row, clause: WhereClause): boolean {
  const viaProjects = clause.projects?.some?.projectId;
  if (viaProjects) return row.projects.some((p) => p.projectId === viaProjects);
  const viaItems = clause.items?.some?.projectId;
  if (viaItems) return row.items.some((i) => i.projectId === viaItems);
  return true;
}

function fakePrisma(rows: Row[]) {
  return {
    impactAnalysis: {
      findMany: async (args: { where?: WhereClause & { OR?: WhereClause[] }; take?: number }) => {
        const where = args.where;
        const predicate = (r: Row) => {
          if (!where) return true;
          if (where.OR) return where.OR.some((clause) => matches(r, clause));
          return matches(r, where);
        };
        return rows
          .filter(predicate)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, args.take ?? rows.length);
      },
    },
  } as never;
}

const ROWS = [
  run("shared", 3, ["p-mine", "p-secret", "p-mine"]),
  run("mine-only", 2, ["p-mine"]),
  run("secret-only", 1, ["p-secret"]),
];

describe("listImpactAnalyses — #61 projectIds", () => {
  it("names every project of a run for an admin", async () => {
    const rows = await listImpactAnalyses({ accessibleProjectIds: null }, fakePrisma(ROWS));
    expect(rows.map((r) => [r.id, r.projectIds, r.projectCount])).toEqual([
      ["shared", ["p-mine", "p-secret"], 2],
      ["mine-only", ["p-mine"], 1],
      ["secret-only", ["p-secret"], 1],
    ]);
  });

  it("names only the projects a member can access; the count is unchanged", async () => {
    const rows = await listImpactAnalyses({ accessibleProjectIds: ["p-mine"] }, fakePrisma(ROWS));
    expect(rows.map((r) => r.id)).toEqual(["shared", "mine-only"]);
    const shared = rows.find((r) => r.id === "shared")!;
    expect(shared.projectIds).toEqual(["p-mine"]);
    expect(shared.projectCount).toBe(2);
    expect(JSON.stringify(rows)).not.toContain("p-secret");
  });

  it("filters to one project in the query, ahead of the limit", async () => {
    // 3 newer runs of another project would fill a limit of 3 on their own.
    const rows = [
      run("other-1", 9, ["p-other"]),
      run("other-2", 8, ["p-other"]),
      run("other-3", 7, ["p-other"]),
      run("mine-old", 1, ["p-mine"]),
    ];
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: null, projectId: "p-mine", limit: 3 },
      fakePrisma(rows),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine-old"]);
  });
});

describe("listImpactAnalyses — #70 runs with no items yet", () => {
  /**
   * The bug: `projectIds` came only from `ImpactItem` rows, so the project page
   * (`GET /impact-analyses?projectId=`) could not list a run that had not
   * written one — every pending/running run, and every run that failed or
   * extracted zero changes.
   */
  it("lists a running run on the project it was started for, before any item exists", async () => {
    const rows = [startedRun("running", 5, ["p-mine"]), run("done", 4, ["p-mine"])];
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: null, projectId: "p-mine" },
      fakePrisma(rows),
    );
    expect(listed.map((r) => r.id)).toEqual(["running", "done"]);
  });

  /**
   * `/projects/:id/impact` re-filters on `projectIds` client-side, so naming the
   * run is not enough — the summary has to carry the started-for projects or the
   * page drops the row again one layer up.
   */
  it("names the started-for projects on a run that has no items", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: null, projectId: "p-mine" },
      fakePrisma([startedRun("running", 5, ["p-mine", "p-other"])]),
    );
    expect(listed[0].projectIds).toEqual(["p-mine", "p-other"]);
    expect(listed[0].projectCount).toBe(2);
  });

  /** Items may name a project the run was not started for; both are the run's. */
  it("unions the started-for projects with the item-derived ones, without duplicates", async () => {
    const row = run("mixed", 5, ["p-a"], {
      projects: [{ projectId: "p-a" }, { projectId: "p-b" }],
      items: [{ projectId: "p-a" }, { projectId: "p-c" }],
    });
    const listed = await listImpactAnalyses({ accessibleProjectIds: null }, fakePrisma([row]));
    expect(listed[0].projectIds).toEqual(["p-a", "p-b", "p-c"]);
  });

  /**
   * The access leak: the filter had a `projectIds.length === 0` arm, so a run
   * whose projects were unknown was visible to EVERY non-admin. With the
   * started-for projects persisted, a run's projects are always known and that
   * arm only ever let other people's runs through.
   */
  it("hides another member's in-progress run on a project the caller cannot access", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"] },
      fakePrisma([startedRun("secret-running", 5, ["p-secret"]), run("mine", 4, ["p-mine"])]),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine"]);
    expect(JSON.stringify(listed)).not.toContain("p-secret");
  });

  /**
   * The escape hatch itself, on the only row shape that can still reach it: a
   * legacy run with neither persisted projects nor items. `projectIds.length ===
   * 0` used to mean "show it to everyone" — whose projects it belongs to is not
   * recoverable, so the only safe answer for a non-admin is not to show it.
   */
  it("hides a run whose projects are unknown from a non-admin", async () => {
    const unknown = run("unknown", 5, [], { projects: [], items: [] });
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"] },
      fakePrisma([unknown, run("mine", 4, ["p-mine"])]),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine"]);
  });

  /** An admin (no accessible set) still sees it — nothing is hidden from them. */
  it("still shows a run with unknown projects to an admin", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: null },
      fakePrisma([run("unknown", 5, [], { projects: [], items: [] })]),
    );
    expect(listed.map((r) => r.id)).toEqual(["unknown"]);
  });

  /** A member's own in-progress run on a project they CAN access still lists. */
  it("shows the caller's own in-progress run on a project they can access", async () => {
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"] },
      fakePrisma([startedRun("mine-running", 5, ["p-mine", "p-secret"])]),
    );
    expect(listed.map((r) => r.id)).toEqual(["mine-running"]);
    expect(listed[0].projectIds).toEqual(["p-mine"]);
    expect(listed[0].projectCount).toBe(2);
  });

  /**
   * Rows written before the join table exists have no `projects`. They must keep
   * listing from their items rather than vanishing from the project page.
   */
  it("still lists a legacy run that has items but no persisted projects", async () => {
    const legacy = run("legacy", 5, ["p-mine"], { projects: [] });
    const listed = await listImpactAnalyses(
      { accessibleProjectIds: ["p-mine"], projectId: "p-mine" },
      fakePrisma([legacy]),
    );
    expect(listed.map((r) => r.id)).toEqual(["legacy"]);
    expect(listed[0].projectIds).toEqual(["p-mine"]);
  });
});
