/**
 * #346 — a PATCH that names one field leaves every other stored field alone.
 *
 * Under zod 4 (#317) `.partial()` still fills an inner `.default()` for an
 * absent key, so a PATCH schema built as `createSchema.partial()` wrote the
 * create defaults for every field the caller left out. Renaming a DISABLED
 * trigger or FinOps alert rule re-enabled it; renaming a scheduled job
 * re-enabled it and reset its task type, payload and retries; renaming a
 * project emptied its description; relabelling a repo connector reset its
 * branch to `main`.
 *
 * Each route runs through its REAL router, REAL auth (a signed JWT through
 * `requireAuth`) and REAL access middleware, against a REAL SQLite database
 * built from the migration chain, and every assertion reads the row back from
 * that database rather than trusting the response body.
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { projectTriggersRouter } = await import("../src/routes/triggers.js");
const { finopsWorkspaceRouter } = await import("../src/routes/finops-workspace.js");
const { projectsRouter } = await import("../src/routes/projects.js");
const { connectorsRouter } = await import("../src/routes/connectors.js");
const { schedulerRouter } = await import("../src/routes/scheduler.js");
const { bootstrapScheduler, __resetSchedulerBootstrap } =
  await import("../src/lib/scheduler/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

/** Real project ids are cuids; `idSchema` rejects anything under 10 chars. */
const PROJ = "proj-alpha-000001";

type Role = "admin" | "coordinator" | "developer" | "reader";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#346 — a partial PATCH leaves omitted stored fields unchanged (real routers, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let COORD_A = "";
    let DEV_OWNER_A = "";
    let COORD_B = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/triggers", projectTriggersRouter());
      a.use("/api/projects/:projectId/connectors", connectorsRouter());
      a.use("/api/projects", projectsRouter());
      a.use("/api/workspaces/:workspaceId/finops", finopsWorkspaceRouter());
      a.use("/api/scheduler", schedulerRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (
      method: "post" | "patch",
      url: string,
      bearer: string,
      body: Record<string, unknown>,
    ) => request(app())[method](url).set("Authorization", `Bearer ${bearer}`).send(body);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("346-patch-omitted-fields");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetSchedulerBootstrap();
      bootstrapScheduler();

      for (const id of ["u-admin", "u-coord-a", "u-dev-a", "u-coord-b"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.createMany({
        data: [
          { workspaceId: "ws-a", userId: "u-coord-a", role: "member" },
          { workspaceId: "ws-a", userId: "u-dev-a", role: "owner" },
          { workspaceId: "ws-b", userId: "u-coord-b", role: "owner" },
        ],
      });
      await db.project.create({
        data: {
          id: PROJ,
          name: "Project A",
          slug: PROJ,
          description: "The payments rewrite.",
          createdById: "u-coord-a",
          workspaceId: "ws-a",
        },
      });

      ADMIN = token("u-admin", "admin", []);
      COORD_A = token("u-coord-a", "coordinator", ["ws-a"]);
      DEV_OWNER_A = token("u-dev-a", "developer", ["ws-a"]);
      COORD_B = token("u-coord-b", "coordinator", ["ws-b"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __resetSchedulerBootstrap();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("triggers — PATCH /api/projects/:projectId/triggers/:id", () => {
      const config = { secret: "s3cr3t-hmac", repo: "octo/app", event: "push" };
      let triggerId = "";

      beforeAll(async () => {
        const res = await call("post", `/api/projects/${PROJ}/triggers`, ADMIN, {
          name: "Deploy hook",
          source: "github",
          config,
          enabled: false,
        });
        expect(res.status).toBe(201);
        triggerId = res.body.data.id;
      });

      it("a rename keeps a disabled trigger disabled and keeps its config", async () => {
        const res = await call("patch", `/api/projects/${PROJ}/triggers/${triggerId}`, ADMIN, {
          name: "Deploy hook (renamed)",
        });
        expect(res.status).toBe(200);
        const row = await db.trigger.findUniqueOrThrow({ where: { id: triggerId } });
        expect(row.name).toBe("Deploy hook (renamed)");
        expect(row.enabled).toBe(false);
        expect(row.source).toBe("github");
        expect(JSON.parse(row.config)).toEqual(config);
      });

      it("toggling enabled keeps the config (including the signing secret)", async () => {
        const res = await call("patch", `/api/projects/${PROJ}/triggers/${triggerId}`, ADMIN, {
          enabled: true,
        });
        expect(res.status).toBe(200);
        const row = await db.trigger.findUniqueOrThrow({ where: { id: triggerId } });
        expect(row.enabled).toBe(true);
        expect(row.name).toBe("Deploy hook (renamed)");
        expect(JSON.parse(row.config)).toEqual(config);
      });

      it("create still applies its defaults", async () => {
        const res = await call("post", `/api/projects/${PROJ}/triggers`, ADMIN, {
          name: "Bare",
          source: "webhook",
        });
        expect(res.status).toBe(201);
        const row = await db.trigger.findUniqueOrThrow({ where: { id: res.body.data.id } });
        expect(row.enabled).toBe(true);
        expect(row.config).toBe("{}");
      });
    });

    describe("FinOps alert rules — PATCH /api/workspaces/:workspaceId/finops/rules/:ruleId", () => {
      let ruleId = "";

      beforeAll(async () => {
        const res = await call("post", "/api/workspaces/ws-a/finops/rules", DEV_OWNER_A, {
          name: "Month-to-date 80%",
          thresholdPct: 80,
          basis: "mtd",
          cooldownSec: 600,
          enabled: false,
        });
        expect(res.status).toBe(201);
        ruleId = res.body.data.rule.id;
      });

      it("a rename keeps a disabled rule disabled and keeps its basis and cooldown", async () => {
        const res = await call(
          "patch",
          `/api/workspaces/ws-a/finops/rules/${ruleId}`,
          DEV_OWNER_A,
          { name: "MTD 80%" },
        );
        expect(res.status).toBe(200);
        const row = await db.alertRule.findUniqueOrThrow({ where: { id: ruleId } });
        expect(row).toMatchObject({
          name: "MTD 80%",
          thresholdPct: 80,
          basis: "mtd",
          cooldownSec: 600,
          enabled: false,
        });
      });

      it("a caller from another workspace still gets 404 and changes nothing", async () => {
        const before = await db.alertRule.findUniqueOrThrow({ where: { id: ruleId } });
        const res = await call("patch", `/api/workspaces/ws-a/finops/rules/${ruleId}`, COORD_B, {
          name: "Hijacked",
        });
        expect(res.status).toBe(404);
        expect(await db.alertRule.findUniqueOrThrow({ where: { id: ruleId } })).toEqual(before);
      });

      // The test above is answered by `requireWorkspaceRole` (COORD_B is not a
      // ws-a member), so it never reaches the route's own workspace-scoped
      // lookup. Here COORD_B passes the middleware — it OWNS ws-b — and names a
      // ws-a rule under its own workspace's URL: only the route's
      // `findFirst({ id: ruleId, workspaceId })` stands between it and the row.
      it("a ws-b owner naming a ws-a rule under /workspaces/ws-b gets 404 and changes nothing", async () => {
        const before = await db.alertRule.findUniqueOrThrow({ where: { id: ruleId } });
        const res = await call("patch", `/api/workspaces/ws-b/finops/rules/${ruleId}`, COORD_B, {
          name: "Hijacked",
          enabled: true,
        });
        expect(res.status).toBe(404);
        expect(await db.alertRule.findUniqueOrThrow({ where: { id: ruleId } })).toEqual(before);
      });

      it("create still applies its defaults", async () => {
        const res = await call("post", "/api/workspaces/ws-a/finops/rules", DEV_OWNER_A, {
          name: "Projected 100%",
          thresholdPct: 100,
        });
        expect(res.status).toBe(201);
        const expected = { basis: "projected", cooldownSec: 3600, enabled: true };
        expect(res.body.data.rule).toMatchObject(expected);
        const row = await db.alertRule.findUniqueOrThrow({ where: { id: res.body.data.rule.id } });
        expect(row).toMatchObject({ workspaceId: "ws-a", thresholdPct: 100, ...expected });
      });
    });

    describe("scheduled jobs — PATCH /api/scheduler/:id", () => {
      let jobId = "";

      beforeAll(async () => {
        const job = await db.scheduledJob.create({
          data: {
            key: "nightly-refresh",
            name: "Nightly refresh",
            cron: "0 2 * * *",
            taskType: "refresh-repo-connector",
            payload: JSON.stringify({ connectorId: "rc-1" }),
            projectId: PROJ,
            enabled: false,
            maxAttempts: 7,
          },
        });
        jobId = job.id;
      });

      it("a rename keeps a disabled job disabled and keeps its task, payload and retries", async () => {
        const res = await call("patch", `/api/scheduler/${jobId}`, COORD_A, {
          name: "Nightly repo refresh",
        });
        expect(res.status).toBe(200);
        const row = await db.scheduledJob.findUniqueOrThrow({ where: { id: jobId } });
        expect(row).toMatchObject({
          name: "Nightly repo refresh",
          cron: "0 2 * * *",
          taskType: "refresh-repo-connector",
          projectId: PROJ,
          enabled: false,
          maxAttempts: 7,
        });
        expect(JSON.parse(row.payload)).toEqual({ connectorId: "rc-1" });
      });

      it("a caller outside the job's project still gets 404 and changes nothing", async () => {
        const before = await db.scheduledJob.findUniqueOrThrow({ where: { id: jobId } });
        const res = await call("patch", `/api/scheduler/${jobId}`, COORD_B, { name: "Hijacked" });
        expect(res.status).toBe(404);
        expect(await db.scheduledJob.findUniqueOrThrow({ where: { id: jobId } })).toEqual(before);
      });
    });

    describe("projects — PATCH /api/projects/:id", () => {
      it("a rename keeps the description", async () => {
        const res = await call("patch", `/api/projects/${PROJ}`, COORD_A, { name: "Project A2" });
        expect(res.status).toBe(200);
        const row = await db.project.findUniqueOrThrow({ where: { id: PROJ } });
        expect(row.name).toBe("Project A2");
        expect(row.description).toBe("The payments rewrite.");
      });

      it("a caller from another workspace still gets 404 and changes nothing", async () => {
        const res = await call("patch", `/api/projects/${PROJ}`, COORD_B, { name: "Hijacked" });
        expect(res.status).toBe(404);
        const row = await db.project.findUniqueOrThrow({ where: { id: PROJ } });
        expect(row.name).toBe("Project A2");
      });
    });

    describe("repo connectors — PATCH /api/projects/:projectId/connectors/repos/:id", () => {
      let repoId = "";

      beforeAll(async () => {
        const rc = await db.repoConnection.create({
          data: {
            projectId: PROJ,
            label: "app",
            provider: "github",
            ownerOrOrg: "octo",
            repoName: "app",
            defaultBranch: "develop",
          },
        });
        repoId = rc.id;
      });

      it("a relabel keeps the default branch", async () => {
        const res = await call(
          "patch",
          `/api/projects/${PROJ}/connectors/repos/${repoId}`,
          COORD_A,
          {
            label: "app-primary",
          },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const row = await db.repoConnection.findUniqueOrThrow({ where: { id: repoId } });
        expect(row.label).toBe("app-primary");
        expect(row.defaultBranch).toBe("develop");
      });
    });
  },
);
