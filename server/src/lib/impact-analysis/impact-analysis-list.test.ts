/**
 * #61 — `listImpactAnalyses` names each run's projects, so a project page can
 * list its own runs, without naming a project the caller cannot access.
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
};

function run(id: string, minute: number, projectIds: string[]): Row {
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
  };
}

function fakePrisma(rows: Row[]) {
  return {
    impactAnalysis: {
      findMany: async (args: {
        where?: { items?: { some?: { projectId?: string } } };
        take?: number;
      }) => {
        const pid = args.where?.items?.some?.projectId;
        return rows
          .filter((r) => !pid || r.items.some((i) => i.projectId === pid))
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
