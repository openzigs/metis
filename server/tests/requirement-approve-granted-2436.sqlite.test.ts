/**
 * #2436 — the point of `requirement.approve`: an organisation lets an analyst
 * approve without granting `project.update`, the right to edit project settings.
 *
 * The default roles hold both (coordinator, admin) or neither (developer,
 * reader), so this file grants the permission to a `developer` (a non-admin
 * analyst) and nothing else, by wrapping the shared registry's `hasPermission`
 * every server gate reads. Then, through the REAL routes and a REAL SQLite
 * database: the analyst approves from the list/card route and the API route,
 * is still refused an edit, promotes a checkpoint as approved, is still bound by
 * maker-checker, and may sign off their own review only where the project allows
 * self-approval.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { PermissionKey, RoleKey } from "@metis/shared";
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
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
// The organisation's grant: `developer` also carries `requirement.approve`.
vi.mock("@metis/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metis/shared")>();
  return {
    ...actual,
    hasPermission: (role: RoleKey, permission: PermissionKey) =>
      (role === "developer" && permission === "requirement.approve") ||
      actual.hasPermission(role, permission),
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { projectReviewsRouter, reviewsRouter } = await import("../src/routes/reviews.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { signOffForRole } = await import("../src/lib/analysis/checkpoint-sign-off.js");

const WORKSPACE = "ws-2436g";
const PROJECT = "proj-2436g";
const ANALYSIS = "ana-2436g";
const ANALYST = "u-2436g-analyst";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2436 — a non-admin analyst granted requirement.approve (and not project.update)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use("/api/analyses", initAnalysisRouter().topLevel);
      a.use("/api/projects/:projectId/reviews", projectReviewsRouter());
      a.use("/api/reviews", reviewsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const auth = () =>
      `Bearer ${
        issueTokens({
          userId: ANALYST,
          username: ANALYST,
          role: "developer",
          permissions: [],
          workspaces: [WORKSPACE],
        }).accessToken
      }`;
    const makeRequirement = async () => {
      seq += 1;
      return db.requirement.create({
        data: {
          id: `req-2436g-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "The original body",
          reviewStatus: "draft",
          version: 0,
        },
      });
    };
    const row = (id: string) => db.requirement.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2436-requirement-approve-granted");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      await db.user.create({
        data: { id: ANALYST, username: ANALYST, displayName: "Analyst", email: "a@example.test" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WORKSPACE, userId: ANALYST, role: "member" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: ANALYST,
          workspaceId: WORKSPACE,
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: ANALYST, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("approves from the list and card route, and from the API route", async () => {
      const viaPut = await makeRequirement();
      const viaPatch = await makeRequirement();

      const put = await request(app())
        .put(`/api/requirements/${viaPut.id}`)
        .set("Authorization", auth())
        .send({ reviewStatus: "approved", version: 0 });
      const patch = await request(app())
        .patch(`/api/analyses/${ANALYSIS}/requirements/${viaPatch.id}`)
        .set("Authorization", auth())
        .send({ reviewStatus: "approved" });

      expect(put.status).toBe(200);
      expect(patch.status).toBe(200);
      expect((await row(viaPut.id)).reviewStatus).toBe("approved");
      expect((await row(viaPatch.id)).reviewStatus).toBe("approved");
    });

    it("is still refused an edit, which needs project.update, and an edit with the approval", async () => {
      const req = await makeRequirement();
      for (const body of [{ title: "Renamed" }, { title: "Renamed", reviewStatus: "approved" }]) {
        const res = await request(app())
          .put(`/api/requirements/${req.id}`)
          .set("Authorization", auth())
          .send(body);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatchObject({
          code: "FORBIDDEN",
          message: "Requires permission project.update",
        });
      }
      expect(await row(req.id)).toEqual(req);
    });

    it("promotes a checkpoint as approved, as the permission now stands for", () => {
      expect(signOffForRole("developer")).toEqual({ asApproved: true });
      expect(signOffForRole("reader")).toEqual({ asApproved: false });
    });

    it("is bound by maker-checker like anyone else", async () => {
      const req = await makeRequirement();
      await db.requirementVersion.create({
        data: {
          requirementId: req.id,
          version: 1,
          changedFields: JSON.stringify({ body: { from: "a", to: "b" } }),
          actorId: ANALYST,
        },
      });
      const res = await request(app())
        .put(`/api/requirements/${req.id}`)
        .set("Authorization", auth())
        .send({ reviewStatus: "approved" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("SELF_APPROVAL_FORBIDDEN");
    });

    it("signs off their own review only where the project allows self-approval", async () => {
      const req = await makeRequirement();
      const create = () =>
        request(app())
          .post(`/api/projects/${PROJECT}/reviews`)
          .set("Authorization", auth())
          .send({ title: "Solo", reviewerIds: [ANALYST], items: [{ requirementId: req.id }] });

      expect((await create()).body.error?.code).toBe("SELF_REVIEW_FORBIDDEN");

      await db.project.update({ where: { id: PROJECT }, data: { allowSelfApproval: true } });
      const created = await create();
      expect(created.status).toBe(201);
      const reviewId = created.body.data.id as string;
      await request(app()).post(`/api/reviews/${reviewId}/submit`).set("Authorization", auth());
      const decided = await request(app())
        .post(`/api/reviews/${reviewId}/decision`)
        .set("Authorization", auth())
        .send({ decision: "approved" });
      expect(decided.status).toBe(200);
      expect((await row(req.id)).reviewStatus).toBe("approved");
    });
  },
);
