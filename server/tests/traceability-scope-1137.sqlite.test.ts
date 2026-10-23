/**
 * #1137 — the workspace roll-up and New baseline counted imported items that
 * were never analysed.
 *
 * The #706 run-8 shape, against a real SQLite database built from the
 * migration chain: one project with 19 requirements promoted (and approved)
 * from an analysis, 17 of them mapped to code, plus 266 items imported from a
 * tracker that were never analysed.
 *
 *  - The roll-up's code coverage is 17 of 19 (89%), not 17 of 285 (6%), and it
 *    reports the 266 as a separate count.
 *  - New baseline pins the 19 approved requirements, not all 285, and the scope
 *    it previews before creating says so.
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
const PROJECT = "proj-1137";
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1137-traceability-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "owner" } });
      await db.project.create({
        data: { id: PROJECT, name: "Miniflux", slug: PROJECT, createdById: USER, workspaceId: WS },
      });
      const importRun = await db.analysis.create({
        data: {
          projectId: PROJECT,
          startedById: USER,
          status: "completed",
          metadata: JSON.stringify({ kind: "import", source: "github" }),
        },
      });
      const analysedRun = await db.analysis.create({
        data: { projectId: PROJECT, startedById: USER, status: "completed" },
      });
      await db.requirement.createMany({
        data: Array.from({ length: IMPORTED }, (_, i) => ({
          id: `imp-${i}`,
          projectId: PROJECT,
          analysisId: importRun.id,
          title: `Imported issue ${i}`,
          body: "From the tracker.",
          importSourceId: "src-github",
          externalSource: "github",
          externalId: String(i),
        })),
      });
      await db.requirement.createMany({
        data: Array.from({ length: PROMOTED }, (_, i) => ({
          id: `req-${i}`,
          projectId: PROJECT,
          analysisId: analysedRun.id,
          title: `Analysed requirement ${i}`,
          body: "Synthesised by the analysis.",
          reviewStatus: "approved",
        })),
      });
      await db.requirementCodeMapping.createMany({
        data: Array.from({ length: MAPPED }, (_, i) => ({
          requirementId: `req-${i}`,
          projectId: PROJECT,
          filePath: `internal/feature_${i}.go`,
          startLine: 1,
          endLine: 10,
        })),
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
      const row = summary.projects.find((p) => p.projectId === PROJECT);
      expect(row).toBeDefined();
      expect(row!.requirements).toBe(PROMOTED + IMPORTED);
      expect(row!.analysedRequirements).toBe(PROMOTED);
      expect(row!.importedUnanalysed).toBe(IMPORTED);
      expect(Math.round(row!.codeCoverage * 100)).toBe(89);
    });

    it("New baseline previews 19 approved requirements and leaves the 266 imported out", async () => {
      const res = await request(app())
        .get(`/api/projects/${PROJECT}/baselines/scope`)
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        pinCount: PROMOTED,
        status: "approved",
        excluded: { total: IMPORTED, imported: IMPORTED },
      });
    });

    it("New baseline pins only the 19 approved requirements", async () => {
      const res = await request(app())
        .post(`/api/projects/${PROJECT}/baselines`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ name: "Run 8 baseline" });
      expect(res.status).toBe(201);
      const items = await db.baselineItem.findMany({ where: { baselineId: res.body.data.id } });
      expect(items).toHaveLength(PROMOTED);
      expect(items.every((i) => i.requirementId.startsWith("req-"))).toBe(true);
    });

    it("an explicit selection may still pin an unapproved imported item", async () => {
      const res = await request(app())
        .post(`/api/projects/${PROJECT}/baselines`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ name: "Chosen items", requirementIds: ["imp-0", "req-0"] });
      expect(res.status).toBe(201);
      expect(res.body.data.items).toHaveLength(2);
    });
  },
);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1137 — New baseline on a project with nothing approved",
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1137-baseline-none-approved");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "owner" } });
      await db.project.create({
        data: { id: PROJECT, name: "Empty", slug: PROJECT, createdById: USER, workspaceId: WS },
      });
      const run = await db.analysis.create({
        data: { projectId: PROJECT, startedById: USER, status: "completed" },
      });
      await db.requirement.create({
        data: { id: "draft-1", projectId: PROJECT, analysisId: run.id, title: "Draft", body: "" },
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

    it("refuses with a message that names approval, and previews zero", async () => {
      const scope = await request(app())
        .get(`/api/projects/${PROJECT}/baselines/scope`)
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(scope.body.data).toEqual({
        pinCount: 0,
        status: "approved",
        excluded: { total: 1, imported: 0 },
      });

      const res = await request(app())
        .post(`/api/projects/${PROJECT}/baselines`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ name: "Nothing approved" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("EMPTY_BASELINE");
      expect(res.body.error.message).toMatch(/approved/i);
    });
  },
);
