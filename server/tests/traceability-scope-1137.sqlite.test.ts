/**
 * #1137 — the workspace roll-up and New baseline counted imported items that
 * were never analysed.
 *
 * The #706 run-8 shape, against a real SQLite database built from the
 * migration chain: one project with 19 requirements promoted (and approved)
 * from an analysis, 17 of them mapped to code, plus 266 items imported from a
 * tracker that were never analysed or approved.
 *
 *  - The roll-up's code coverage is 17 of 19 (89%), not 17 of 285 (6%), and it
 *    reports the 266 as a separate count. An imported item an analysis HAS
 *    mapped counts as analysed.
 *  - New baseline pins the 19, not all 285, and the scope it previews before
 *    creating says so. It leaves out only unapproved imports: a draft the
 *    project wrote and an approved import are still pinned (#732).
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { projectBaselinesRouter } = await import("../src/routes/baselines.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getWorkspaceTraceabilitySummary } =
  await import("../src/lib/traceability/workspace-rollup.js");

const WS = "ws-1137";
const RUN8 = "proj-1137";
const MIXED = "proj-1137-mixed";
const IMPORTS_ONLY = "proj-1137-imports";
const USER = "u-1137";
const PROMOTED = 19;
const MAPPED = 17;
const IMPORTED = 266;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1137 — imported, never-analysed items stay out of the roll-up and New baseline",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/baselines", projectBaselinesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const api = {
      scope: (projectId: string) =>
        request(app())
          .get(`/api/projects/${projectId}/baselines/scope`)
          .set("Authorization", `Bearer ${TOKEN}`),
      create: (projectId: string, body: Record<string, unknown>) =>
        request(app())
          .post(`/api/projects/${projectId}/baselines`)
          .set("Authorization", `Bearer ${TOKEN}`)
          .send(body),
    };
    const pinnedIds = async (baselineId: string) =>
      (await db.baselineItem.findMany({ where: { baselineId } }))
        .map((i) => i.requirementId)
        .sort();

    const makeProject = async (id: string) => {
      await db.project.create({
        data: { id, name: id, slug: id, createdById: USER, workspaceId: WS },
      });
      const importRun = await db.analysis.create({
        data: {
          projectId: id,
          startedById: USER,
          status: "completed",
          metadata: JSON.stringify({ kind: "import", source: "github" }),
        },
      });
      const analysedRun = await db.analysis.create({
        data: { projectId: id, startedById: USER, status: "completed" },
      });
      return { importRun: importRun.id, analysedRun: analysedRun.id };
    };
    const imported = (projectId: string, analysisId: string, id: string, extra = {}) => ({
      id,
      projectId,
      analysisId,
      title: `Imported ${id}`,
      body: "From the tracker.",
      importSourceId: "src-github",
      externalSource: "github",
      externalId: id,
      ...extra,
    });
    const mapTo = (projectId: string, requirementId: string) => ({
      requirementId,
      projectId,
      filePath: `internal/${requirementId}.go`,
      startLine: 1,
      endLine: 10,
    });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1137-traceability-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "owner" } });

      // Run 8: 19 promoted and approved, 17 mapped; 266 unapproved imports, none mapped.
      const run8 = await makeProject(RUN8);
      await db.requirement.createMany({
        data: Array.from({ length: IMPORTED }, (_, i) =>
          imported(RUN8, run8.importRun, `imp-${i}`),
        ),
      });
      await db.requirement.createMany({
        data: Array.from({ length: PROMOTED }, (_, i) => ({
          id: `req-${i}`,
          projectId: RUN8,
          analysisId: run8.analysedRun,
          title: `Analysed requirement ${i}`,
          body: "Synthesised by the analysis.",
          reviewStatus: "approved",
        })),
      });
      await db.requirementCodeMapping.createMany({
        data: Array.from({ length: MAPPED }, (_, i) => mapTo(RUN8, `req-${i}`)),
      });

      // Mixed: an unreviewed draft, an approved import, an import an analysis
      // mapped, and a plain unapproved import.
      const mixed = await makeProject(MIXED);
      await db.requirement.createMany({
        data: [
          {
            id: "mixed-draft",
            projectId: MIXED,
            analysisId: mixed.analysedRun,
            title: "Draft",
            body: "",
          },
          imported(MIXED, mixed.importRun, "mixed-imp-approved", { reviewStatus: "approved" }),
          imported(MIXED, mixed.importRun, "mixed-imp-mapped"),
          imported(MIXED, mixed.importRun, "mixed-imp-plain"),
        ],
      });
      await db.requirementCodeMapping.create({ data: mapTo(MIXED, "mixed-imp-mapped") });
      // A deleted requirement whose mapping row survived: in neither count.
      await db.requirement.create({
        data: {
          id: "mixed-deleted",
          projectId: MIXED,
          analysisId: mixed.analysedRun,
          title: "Deleted",
          body: "",
          deletedAt: new Date(),
        },
      });
      await db.requirementCodeMapping.create({ data: mapTo(MIXED, "mixed-deleted") });

      // Nothing but unapproved imports.
      const only = await makeProject(IMPORTS_ONLY);
      await db.requirement.create({
        data: imported(IMPORTS_ONLY, only.importRun, "only-imp"),
      });

      TOKEN = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: [],
        workspaces: [WS],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("roll-up: code coverage is 17 of the 19 analysed, with the 266 imported counted apart", async () => {
      const summary = await getWorkspaceTraceabilitySummary({ id: USER, role: "admin" }, WS);
      const row = summary.projects.find((p) => p.projectId === RUN8)!;
      expect(row.requirements).toBe(PROMOTED + IMPORTED);
      expect(row.analysedRequirements).toBe(PROMOTED);
      expect(row.importedUnanalysed).toBe(IMPORTED);
      expect(Math.round(row.codeCoverage * 100)).toBe(89);
    });

    it("roll-up: an imported item an analysis mapped counts as analysed; an unmapped one does not", async () => {
      const summary = await getWorkspaceTraceabilitySummary({ id: USER, role: "admin" }, WS);
      const row = summary.projects.find((p) => p.projectId === MIXED)!;
      expect(row.requirements).toBe(4);
      // The approved and the plain import were never mapped: both are apart.
      expect(row.importedUnanalysed).toBe(2);
      expect(row.analysedRequirements).toBe(2);
      // The mapped import is in both the numerator and the denominator.
      expect(row.codeCoverage).toBe(0.5);
    });

    it("the scope preview is for review administrators only", async () => {
      const reader = issueTokens({
        userId: USER,
        username: USER,
        role: "reader",
        permissions: [],
        workspaces: [WS],
      }).accessToken;
      const res = await request(app())
        .get(`/api/projects/${RUN8}/baselines/scope`)
        .set("Authorization", `Bearer ${reader}`);
      expect(res.status).toBe(403);
    });

    it("New baseline previews the 19 it pins and the 266 imported it leaves out", async () => {
      const res = await api.scope(RUN8);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        pinCount: PROMOTED,
        approved: PROMOTED,
        excludedImported: IMPORTED,
      });
    });

    it("New baseline pins the 19, not the 266 unapproved imports", async () => {
      const res = await api.create(RUN8, { name: "Run 8 baseline" });
      expect(res.status).toBe(201);
      const ids = await pinnedIds(res.body.data.id);
      expect(ids).toHaveLength(PROMOTED);
      expect(ids.every((id) => id.startsWith("req-"))).toBe(true);
    });

    it("New baseline still pins an unreviewed draft and an approved import (#732)", async () => {
      const scope = await api.scope(MIXED);
      expect(scope.body.data).toEqual({ pinCount: 2, approved: 1, excludedImported: 2 });
      const res = await api.create(MIXED, { name: "Mixed" });
      expect(res.status).toBe(201);
      expect(await pinnedIds(res.body.data.id)).toEqual(["mixed-draft", "mixed-imp-approved"]);
    });

    it("an explicit selection may still pin an unapproved imported item", async () => {
      const res = await api.create(RUN8, {
        name: "Chosen items",
        requirementIds: ["imp-0", "req-0"],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.items).toHaveLength(2);
    });

    it("refuses a project with nothing but unapproved imports, and previews zero", async () => {
      const scope = await api.scope(IMPORTS_ONLY);
      expect(scope.body.data).toEqual({ pinCount: 0, approved: 0, excludedImported: 1 });
      const res = await api.create(IMPORTS_ONLY, { name: "Nothing to pin" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("EMPTY_BASELINE");
      expect(res.body.error.message).toMatch(/unapproved imported/);
    });
  },
);
