/**
 * Issue #999 — the Requirements hub summarised only the latest *completed*
 * run. A newer run with no requirements yet (its approvals still pending) made
 * the hub read 0/0/0/0 and hide Request review while 16 approved requirements
 * sat in the previous run.
 *
 * `listAnalysesForProject` now carries each run's review-status tally, so the
 * hub can pick a run that has requirements and offer the others. Every
 * assertion reads back through the real list query against a REAL migrated
 * SQLite database.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const { listAnalysesForProject, resolveRequirementReviewStatus } =
  await import("../src/lib/analysis/analysis-service.js");

const USER = "u999";
const PROJECT = "p999";
const OTHER_PROJECT = "q999";

describe("resolveRequirementReviewStatus", () => {
  it("prefers the column, then the legacy label, then draft", () => {
    expect(resolveRequirementReviewStatus("approved", ["review:rejected"])).toBe("approved");
    expect(resolveRequirementReviewStatus(null, ["x", "review:deferred"])).toBe("deferred");
    expect(resolveRequirementReviewStatus(undefined, [])).toBe("draft");
    expect(resolveRequirementReviewStatus("bogus", [])).toBe("draft");
  });
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Issue #999 — each run on the project list carries its requirement tally (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("999-run-counts");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u999@x.test" },
      });
      for (const id of [PROJECT, OTHER_PROJECT]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
      // The older run holds the reviewed set; the newer one has nothing yet.
      await db.analysis.create({
        data: {
          id: "older",
          projectId: PROJECT,
          startedById: USER,
          status: "completed",
          startedAt: new Date("2026-10-01T00:00:00Z"),
        },
      });
      await db.analysis.create({
        data: {
          id: "newer",
          projectId: PROJECT,
          startedById: USER,
          status: "completed",
          startedAt: new Date("2026-10-09T00:00:00Z"),
        },
      });
      await db.analysis.create({
        data: { id: "foreign", projectId: OTHER_PROJECT, startedById: USER, status: "completed" },
      });
      const req = (
        id: string,
        analysisId: string,
        projectId: string,
        extra: { reviewStatus?: string | null; labels?: string; deletedAt?: Date } = {},
      ) =>
        db.requirement.create({
          data: { id, analysisId, projectId, title: id, body: id, ...extra },
        });
      await req("r1", "older", PROJECT, { reviewStatus: "approved" });
      await req("r2", "older", PROJECT, { reviewStatus: "approved" });
      await req("r3", "older", PROJECT, { reviewStatus: "draft" });
      // A pre-#M4 row: status only in the legacy label.
      await req("r4", "older", PROJECT, { reviewStatus: null, labels: '["review:rejected"]' });
      await req("r5", "older", PROJECT, { reviewStatus: "approved", deletedAt: new Date() });
      await req("f1", "foreign", OTHER_PROJECT, { reviewStatus: "approved" });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("tallies each run's requirements by review status, newest run first", async () => {
      const items = await listAnalysesForProject(PROJECT);
      expect(items.map((i) => i.id)).toEqual(["newer", "older"]);
      expect(items[0].requirementCounts).toEqual({
        draft: 0,
        approved: 0,
        rejected: 0,
        deferred: 0,
      });
      // The soft-deleted approval is not counted; the legacy label is.
      expect(items[1].requirementCounts).toEqual({
        draft: 1,
        approved: 2,
        rejected: 1,
        deferred: 0,
      });
    });

    it("never counts another project's requirements", async () => {
      const items = await listAnalysesForProject(OTHER_PROJECT);
      expect(items.map((i) => i.id)).toEqual(["foreign"]);
      expect(items[0].requirementCounts.approved).toBe(1);
      // A requirement row naming this project's run but another project is not
      // this project's: the scope column is part of the filter.
      await db.requirement.create({
        data: {
          id: "x1",
          analysisId: "older",
          projectId: OTHER_PROJECT,
          title: "x",
          body: "x",
          reviewStatus: "approved",
        },
      });
      const mine = await listAnalysesForProject(PROJECT);
      expect(mine.find((i) => i.id === "older")?.requirementCounts.approved).toBe(2);
    });
  },
);
