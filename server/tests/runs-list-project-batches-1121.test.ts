/**
 * Issue #1121 — `listRuns` reads a long reachable-project list in batches and
 * merges them into the page one statement would give.
 *
 * Engine-free on purpose: the SQLite twin
 * (`runs-list-many-projects-1121.sqlite.test.ts`) is skipped on the
 * postgres-adapter job, so the batching and the merge are pinned here as well,
 * against an in-memory `agentRun.findMany` that honours `projectId: { in }`,
 * the two-key order and `take` the way both engines do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Run {
  id: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  latencyMs: number | null;
  totalTokens: number;
  costCents: number;
}

const runs: Run[] = [];
const reads: Array<{ ids: string[] | null; orderBy: unknown; take: number }> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    agentRun: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: { projectId?: string | { in: string[] } };
          orderBy: unknown;
          take: number;
        }) => {
          const scope = where.projectId;
          const ids = typeof scope === "object" ? scope.in : null;
          reads.push({ ids, orderBy, take });
          return runs
            .filter((r) =>
              scope === undefined
                ? true
                : typeof scope === "string"
                  ? r.projectId === scope
                  : r.projectId !== null && scope.in.includes(r.projectId),
            )
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1))
            .slice(0, take)
            .map((r) => ({ ...r, _count: { steps: 0 } }));
        },
      ),
    },
    tokenUsage: { findMany: vi.fn(async () => []) },
  },
}));

const { listRuns, RUN_LIST_PROJECT_BATCH } = await import("../src/lib/replay/runs-service.js");

const project = (i: number) => `p-${String(i).padStart(4, "0")}`;
const run = (id: string, projectId: string | null, second: number): Run => ({
  id,
  sessionId: `s-${id}`,
  projectId,
  kind: "chat",
  status: "completed",
  startedAt: new Date(Date.UTC(2026, 9, 9, 10, 0, second)),
  completedAt: null,
  latencyMs: null,
  totalTokens: 0,
  costCents: 0,
});

beforeEach(() => {
  runs.length = 0;
  reads.length = 0;
});

describe("#1121 listRuns over more reachable projects than a statement can name", () => {
  const reachable = Array.from({ length: 1_000 }, (_, i) => project(i));

  it("reads the projects a batch at a time, every batch in the same total order and size", async () => {
    await listRuns({ accessibleProjectIds: reachable, limit: 5 });
    expect(reads).toHaveLength(Math.ceil(reachable.length / RUN_LIST_PROJECT_BATCH));
    for (const r of reads) {
      expect(r.ids!.length).toBeLessThanOrEqual(RUN_LIST_PROJECT_BATCH);
      expect(r.orderBy).toEqual([{ startedAt: "desc" }, { id: "desc" }]);
      expect(r.take).toBe(5);
    }
    expect(reads.flatMap((r) => r.ids)).toEqual(reachable);
    expect(RUN_LIST_PROJECT_BATCH).toBeLessThan(999 - 10);
  });

  it("the page is the newest runs across every batch, ties by id, and nothing outside reach", async () => {
    runs.push(
      run("r-early", project(0), 1),
      run("r-b1-new", project(10), 50),
      run("r-b3-new", project(950), 49),
      run("r-tie-a", project(500), 40),
      run("r-tie-z", project(5), 40),
      run("r-mid", project(820), 30),
      run("x-outside", "p-elsewhere", 59),
      run("x-system", null, 58),
    );
    const out = await listRuns({ accessibleProjectIds: reachable, limit: 4 });
    expect(out.map((r) => r.id)).toEqual(["r-b1-new", "r-b3-new", "r-tie-z", "r-tie-a"]);
    const all = await listRuns({ accessibleProjectIds: reachable });
    expect(all.map((r) => r.id)).toEqual([
      "r-b1-new",
      "r-b3-new",
      "r-tie-z",
      "r-tie-a",
      "r-mid",
      "r-early",
    ]);
  });

  it("no reachable project lists nothing, without a read", async () => {
    runs.push(run("r", project(1), 1));
    expect(await listRuns({ accessibleProjectIds: [] })).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("an explicit project is one read of that project, and nothing if it is out of reach", async () => {
    runs.push(run("r1", project(1), 1), run("r2", project(2), 2));
    expect(
      (await listRuns({ accessibleProjectIds: reachable, projectId: project(1) })).map((r) => r.id),
    ).toEqual(["r1"]);
    expect(reads).toEqual([expect.objectContaining({ ids: [project(1)] })]);
    expect(await listRuns({ accessibleProjectIds: reachable, projectId: "p-elsewhere" })).toEqual(
      [],
    );
  });

  it("an admin (no reachable list) is one unscoped read", async () => {
    runs.push(run("r1", project(1), 1), run("sys", null, 2));
    expect((await listRuns({})).map((r) => r.id)).toEqual(["sys", "r1"]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.ids).toBeNull();
  });
});
