/**
 * #1472 — who reads a project's PR reviews, and who re-runs one.
 *
 * Owner's decision: `coordinator`, `developer` and `reader` get `pr.review.read`;
 * `coordinator` also gets `pr.review.manage` (re-review); `reader` keeps no
 * `*.manage`. Driven through the REAL `apiRouter()` on a REAL SQLite database
 * built from the migration chain, with real JWTs, the real `requirePermission`
 * and the real project-scope guards, so the role matrix and the workspace scope
 * are both exercised as production composes them. The re-review queue is a
 * recording stub installed in the worker singleton: no model runs and nothing
 * reaches GitHub.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { PrReviewJobPayload, PrReviewQueue } from "../src/lib/agents/pr-reviewer/queue.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { apiRouter } = await import("../src/routes/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setPrReviewWorker } = await import("../src/lib/agents/pr-reviewer/worker-singleton.js");

const WS = "ws-1472";
const WS_OTHER = "ws-other-1472";
const P = "project-1472-live";
const GONE = "project-1472-gone";
const OWNER = "acme-1472";
const PR = 7;

const MEMBER_ROLES = ["coordinator", "developer", "reader"] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1472 — PR-review read and re-review by role",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let api: express.Express;
    const enqueued: PrReviewJobPayload[] = [];

    const bearer = (userId: string, role: RoleKey, workspaces: string[]) => {
      const payload: AuthPayload = {
        userId,
        username: userId,
        role,
        permissions: getPermissionsForRole(role),
        workspaces,
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };
    /** A member of the project's workspace holding `role`. */
    const member = (role: RoleKey) => bearer(`u-${role}`, role, [WS]);
    /** A coordinator in another workspace: role-permitted, outside the project. */
    const outsider = () => bearer("u-outsider", "coordinator", [WS_OTHER]);
    const admin = () => bearer("u-admin", "admin", []);

    const list = (projectId: string, auth: string) =>
      request(api).get(`/api/projects/${projectId}/pr-reviews`).set("Authorization", auth);
    const detail = (projectId: string, auth: string) =>
      request(api)
        .get(`/api/projects/${projectId}/pr-reviews/${PR}?owner=${OWNER}&repo=app`)
        .set("Authorization", auth);
    const reReview = (projectId: string, auth: string) =>
      request(api)
        .post(`/api/projects/${projectId}/pr-reviews/${PR}/re-review`)
        .set("Authorization", auth)
        .send({ owner: OWNER, repo: "app" });

    const seedProject = async (id: string, deleted: boolean) => {
      await db.project.create({
        data: {
          id,
          name: id,
          slug: id,
          createdById: "u-admin",
          workspaceId: WS,
          status: "active",
          ...(deleted ? { deletedAt: new Date() } : {}),
        },
      });
      await db.prReviewState.create({
        data: {
          projectId: id,
          repoOwner: OWNER,
          repoName: "app",
          prNumber: PR,
          lastReviewedSha: "abc1234",
          lastVerdict: "approve",
          lastStatus: "reviewed",
        },
      });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1472-pr-review-rbac");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      const users = [...MEMBER_ROLES.map((r) => `u-${r}`), "u-outsider", "u-admin"];
      for (const id of users) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS, WS_OTHER]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const role of MEMBER_ROLES) {
        await db.workspaceMember.create({
          data: { workspaceId: WS, userId: `u-${role}`, role: "member" },
        });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS_OTHER, userId: "u-outsider", role: "member" },
      });
      await seedProject(P, false);
      await seedProject(GONE, true);

      // Recording queue: the re-review route enqueues here instead of a worker.
      const queue = {
        enqueueAfter: async (job: PrReviewJobPayload, before: (id: string) => Promise<void>) => {
          const jobId = `job-1472-${enqueued.length + 1}`;
          await before(jobId);
          enqueued.push(job);
          return { jobId, queueDepth: 1 };
        },
      } as unknown as PrReviewQueue;
      setPrReviewWorker({ queue, shutdown: async () => undefined });

      api = express();
      api.use(express.json());
      api.use("/api", apiRouter());
      api.use(notFoundHandler);
      api.use(errorHandler);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setPrReviewWorker(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      enqueued.length = 0;
    });

    describe("reading the list and the detail", () => {
      it.each(MEMBER_ROLES)("a workspace %s gets 200 on both", async (role) => {
        const l = await list(P, member(role));
        expect(l.status).toBe(200);
        expect(l.body.data.items).toHaveLength(1);
        expect(l.body.data.items[0]).toMatchObject({ projectId: P, prNumber: PR });
        const d = await detail(P, member(role));
        expect(d.status).toBe(200);
        expect(d.body.data).toMatchObject({ projectId: P, prNumber: PR, lastVerdict: "approve" });
      });

      it("an outsider gets the 404 of an unknown project, on both", async () => {
        const unknown = await list("project-1472-missing", outsider());
        expect(unknown.status).toBe(404);
        for (const res of [await list(P, outsider()), await detail(P, outsider())]) {
          expect(res.status).toBe(404);
          expect(res.body).toEqual(unknown.body);
          expect(JSON.stringify(res.body)).not.toContain(OWNER);
        }
      });

      it.each(MEMBER_ROLES)(
        "a deleted project is a 404 for a workspace %s, on both",
        async (role) => {
          const unknown = await list("project-1472-missing", member(role));
          for (const res of [await list(GONE, member(role)), await detail(GONE, member(role))]) {
            expect(res.status).toBe(404);
            expect(res.body).toEqual(unknown.body);
          }
        },
      );

      it("an admin still reads a deleted project's reviews", async () => {
        const l = await list(GONE, admin());
        expect(l.status).toBe(200);
        expect(l.body.data.items).toHaveLength(1);
        expect((await detail(GONE, admin())).status).toBe(200);
      });
    });

    describe("re-review", () => {
      it("is allowed for a workspace coordinator and enqueues the PR", async () => {
        const res = await reReview(P, member("coordinator"));
        expect(res.status).toBe(202);
        expect(res.body.data).toMatchObject({ prNumber: PR, jobId: "job-1472-1" });
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ projectId: P, owner: OWNER, repo: "app" });
      });

      it.each(["developer", "reader"] as const)(
        "is refused for a workspace %s with 403, and enqueues nothing",
        async (role) => {
          const res = await reReview(P, member(role));
          expect(res.status).toBe(403);
          expect(res.body.error.message).toContain("pr.review.manage");
          expect(enqueued).toHaveLength(0);
        },
      );

      it("is a 404 for a coordinator outside the workspace, and on a deleted project", async () => {
        expect((await reReview(P, outsider())).status).toBe(404);
        expect((await reReview(GONE, member("coordinator"))).status).toBe(404);
        expect(enqueued).toHaveLength(0);
      });
    });
  },
);
