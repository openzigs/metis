/**
 * Issue #1230 — a reader-layout BRD's Approved Requirements section reads the
 * run the Requirements hub opens on. Against a REAL migrated SQLite database:
 * the server's choice equals the hub's (`listAnalysesForProject` through the
 * shared `defaultRequirementsRunId`) for every fixture, a re-run whose
 * requirements are all draft is read rather than the older run's approvals,
 * and an import run is a run like any other.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultRequirementsRunId } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { loadApprovedRequirements } =
  await import("../src/lib/docs-gen/approved-requirements-section.js");
const { defaultRequirementsRunIdFor } = await import("../src/lib/analysis/requirement-runs.js");
const { listAnalysesForProject } = await import("../src/lib/analysis/analysis-service.js");

const USER = "u1230";

/** What the Requirements hub opens on, from the list it is given. */
async function hubDefault(projectId: string): Promise<string | null> {
  const runs = await listAnalysesForProject(projectId);
  return defaultRequirementsRunId(
    runs.map((r) => ({
      id: r.id,
      status: r.status,
      requirementCount: Object.values(r.requirementCounts).reduce((n, c) => n + c, 0),
    })),
  );
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Issue #1230 — the run a reader BRD's approved requirements come from (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const run = (
      id: string,
      projectId: string,
      day: string,
      extra: { status?: string; metadata?: string; deletedAt?: Date } = {},
    ) =>
      db.analysis.create({
        data: {
          id,
          projectId,
          startedById: USER,
          status: extra.status ?? "completed",
          startedAt: new Date(`2026-10-${day}T00:00:00Z`),
          ...(extra.metadata ? { metadata: extra.metadata } : {}),
          ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
        },
      });
    const req = (
      id: string,
      projectId: string,
      analysisId: string,
      reviewStatus: string | null,
      deletedAt?: Date,
    ) =>
      db.requirement.create({
        data: {
          id,
          analysisId,
          projectId,
          title: `Title of ${id}`,
          body: `Body of ${id}`,
          reviewStatus,
          ...(deletedAt ? { deletedAt } : {}),
        },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1230-approved-requirements-run");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1230@x.test" },
      });
      for (const id of ["rerun", "imported", "background", "empty", "tie"]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }

      // A re-run whose requirements are all still draft, after a run with approvals.
      await run("rerun-old", "rerun", "01");
      await req("old-approved", "rerun", "rerun-old", "approved");
      await run("rerun-new", "rerun", "05");
      await req("new-draft-1", "rerun", "rerun-new", "draft");
      await req("new-draft-2", "rerun", "rerun-new", null);
      // Newer still: a running run, a deleted run, and a run whose only
      // requirement is deleted. None of them is the current set.
      await run("rerun-running", "rerun", "07", { status: "running" });
      await req("running-approved", "rerun", "rerun-running", "approved");
      await run("rerun-deleted", "rerun", "08", { deletedAt: new Date() });
      await req("deleted-run-approved", "rerun", "rerun-deleted", "approved");
      await run("rerun-emptied", "rerun", "09");
      await req("emptied-approved", "rerun", "rerun-emptied", "approved", new Date());

      // An analysis run and a newer import run, each with approvals.
      await run("analysis-run", "imported", "01");
      await req("analysed-approved", "imported", "analysis-run", "approved");
      await run("import-run", "imported", "03", {
        metadata: JSON.stringify({ kind: "import", source: "jira", label: "PROJ" }),
      });
      await req("imported-approved", "imported", "import-run", "approved");
      await req("imported-draft", "imported", "import-run", "draft");

      // A newer background row never wins, even where no run has requirements.
      await run("bg-analysis", "background", "01");
      await req("bg-approved", "background", "bg-analysis", "approved");
      await run("bg-ingest", "background", "06", {
        metadata: JSON.stringify({ source: "code-graph-ingest" }),
      });

      // Two runs started at the same instant, each with requirements; the
      // smaller id is written first, so table order alone would pick it.
      await run("tie-a", "tie", "04");
      await req("tie-a-approved", "tie", "tie-a", "approved");
      await run("tie-b", "tie", "04");
      await req("tie-b-approved", "tie", "tie-b", "approved");

      await run("empty-old", "empty", "01");
      await run("empty-ingest", "empty", "02", {
        metadata: JSON.stringify({ source: "docs-gen-domain-research" }),
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("chooses the run the Requirements hub opens on, for every project", async () => {
      for (const projectId of [
        "rerun",
        "imported",
        "background",
        "empty",
        "tie",
        "no-such-project",
      ]) {
        expect({ projectId, run: await defaultRequirementsRunIdFor(projectId) }).toEqual({
          projectId,
          run: await hubDefault(projectId),
        });
      }
      expect(await defaultRequirementsRunIdFor("rerun")).toBe("rerun-new");
      expect(await defaultRequirementsRunIdFor("imported")).toBe("import-run");
      expect(await defaultRequirementsRunIdFor("background")).toBe("bg-analysis");
      expect(await defaultRequirementsRunIdFor("empty")).toBe("empty-old");
      // Two runs started at the same instant: the larger id, on both sides (review NB3).
      expect(await defaultRequirementsRunIdFor("tie")).toBe("tie-b");
      expect(await defaultRequirementsRunIdFor("no-such-project")).toBeNull();
    });

    it("lists none after a re-run whose requirements are all draft, not the older run's approvals", async () => {
      expect(await loadApprovedRequirements("rerun")).toEqual([]);
      // Once the analysts approve one of the re-run's requirements, it is listed alone.
      await db.requirement.update({
        where: { id: "new-draft-2" },
        data: { reviewStatus: "approved" },
      });
      expect((await loadApprovedRequirements("rerun")).map((r) => r.id)).toEqual(["new-draft-2"]);
    });

    it("lists one run's approvals when an import run and an analysis run both exist", async () => {
      expect((await loadApprovedRequirements("imported")).map((r) => r.id)).toEqual([
        "imported-approved",
      ]);
      expect((await loadApprovedRequirements("background")).map((r) => r.id)).toEqual([
        "bg-approved",
      ]);
      expect(await loadApprovedRequirements("empty")).toEqual([]);
    });
  },
);
