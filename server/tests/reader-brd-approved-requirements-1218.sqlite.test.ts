/**
 * Issue #1218 — a reader-layout BRD lists the project's approved requirements.
 * Read against a REAL migrated SQLite database: only this project's live,
 * approved rows are selected, with the analysts' latest edits, and a second
 * project's approved requirements never reach the section.
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

const { loadApprovedRequirements, renderApprovedRequirementsSection } =
  await import("../src/lib/docs-gen/approved-requirements-section.js");

const USER = "u1218";
const PROJECT = "p1218";
const OTHER_PROJECT = "q1218";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Issue #1218 — the approved requirements a reader-layout BRD lists (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1218-approved-requirements");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u1218@x.test" },
      });
      for (const id of [PROJECT, OTHER_PROJECT]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
        await db.analysis.create({
          data: {
            id: `run-${id}`,
            projectId: id,
            startedById: USER,
            status: "completed",
            startedAt: new Date("2026-10-05T00:00:00Z"),
          },
        });
      }
      // Older and newer runs of this project around the one the section reads:
      // an older completed run (superseded), a newer completed run with no
      // approved requirement, and a newer run that is still running.
      const run = (id: string, status: string, day: string) =>
        db.analysis.create({
          data: {
            id,
            projectId: PROJECT,
            startedById: USER,
            status,
            startedAt: new Date(`2026-10-${day}T00:00:00Z`),
          },
        });
      await run("run-older", "completed", "01");
      await run("run-newer-unapproved", "completed", "07");
      await run("run-running", "running", "09");
      const req = (
        id: string,
        projectId: string,
        extra: {
          reviewStatus?: string | null;
          priority?: string;
          deletedAt?: Date;
          analysisId?: string;
        } = {},
      ) =>
        db.requirement.create({
          data: {
            id,
            analysisId: `run-${projectId}`,
            projectId,
            title: `Title of ${id}`,
            body: `Body of ${id}`,
            acceptanceCriteria: JSON.stringify([`Criterion of ${id}`]),
            ...extra,
          },
        });
      await req("mine-approved-low", PROJECT, { reviewStatus: "approved", priority: "low" });
      await req("mine-approved-critical", PROJECT, {
        reviewStatus: "approved",
        priority: "critical",
      });
      await req("mine-draft", PROJECT, { reviewStatus: "draft" });
      await req("mine-unreviewed", PROJECT, { reviewStatus: null });
      await req("mine-deleted", PROJECT, { reviewStatus: "approved", deletedAt: new Date() });
      await req("theirs-approved", OTHER_PROJECT, { reviewStatus: "approved" });
      await req("older-run-approved", PROJECT, {
        reviewStatus: "approved",
        analysisId: "run-older",
      });
      await req("newer-run-draft", PROJECT, {
        reviewStatus: "draft",
        analysisId: "run-newer-unapproved",
      });
      await req("running-run-approved", PROJECT, {
        reviewStatus: "approved",
        analysisId: "run-running",
      });
      // The analyst's edit after approval: the stored row is what is listed.
      await db.requirement.update({
        where: { id: "mine-approved-low" },
        data: {
          title: "Edited title",
          body: "Edited body, clarified with the sponsor.",
          acceptanceCriteria: JSON.stringify(["Edited criterion: at most 100 entries."]),
          version: { increment: 1 },
        },
      });
      // A code link recorded under the other project is never read with mine.
      await db.requirementCodeMapping.create({
        data: {
          requirementId: "mine-approved-critical",
          projectId: OTHER_PROJECT,
          filePath: "foreign/path.go",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("selects the live, approved requirements of the newest completed run that has any, highest priority first", async () => {
      // Not the superseded run's, the running run's, or the newer run's drafts.
      const rows = await loadApprovedRequirements(PROJECT);
      expect(rows.map((r) => r.id)).toEqual(["mine-approved-critical", "mine-approved-low"]);
      expect(rows[0].codeMappings).toEqual([]);
    });

    it("lists the analyst's edits as stored", async () => {
      const rows = await loadApprovedRequirements(PROJECT);
      const { markdown, listed } = renderApprovedRequirementsSection(rows, 28_000);
      expect(listed).toBe(2);
      expect(markdown).toContain("### R2. Edited title");
      expect(markdown).toContain("Edited body, clarified with the sponsor.");
      expect(markdown).toContain("- Edited criterion: at most 100 entries.");
      expect(markdown).not.toContain("Criterion of mine-approved-low");
    });

    it("never reads another project's approved requirements", async () => {
      const mine = renderApprovedRequirementsSection(
        await loadApprovedRequirements(PROJECT),
        28_000,
      ).markdown;
      expect(mine).not.toContain("theirs-approved");
      expect(mine).not.toContain("foreign/path.go");
      const theirs = await loadApprovedRequirements(OTHER_PROJECT);
      expect(theirs.map((r) => r.id)).toEqual(["theirs-approved"]);
      expect(await loadApprovedRequirements("no-such-project")).toEqual([]);
    });
  },
);
