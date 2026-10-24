/**
 * #1169 — `Project.autoReviewPrs` gets a setter: `PATCH /api/projects/:id
 * { autoReviewPrs }`.
 *
 * Driven through the REAL projects router, project service and GitHub PR
 * webhook router against a REAL SQLite database built from the migration
 * chain. Every success is read back from the row (or a fresh GET), never from
 * the PATCH's own answer; every denial is paired with a positive control. The
 * webhook half proves the setter is the switch the receiver reads: the same
 * delivery enqueues a review while the flag is on and does nothing while off.
 * No model runs — the queue is a recording fake.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { PrReviewQueue } from "../src/lib/agents/pr-reviewer/queue.js";

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
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { projectsRouter } = await import("../src/routes/projects.js");
const { githubPrWebhookRouter } = await import("../src/routes/webhooks-github.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-1169";
const WS_OTHER = "ws-other-1169";
const SECRET = "test-secret-1169";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1169 — PATCH /api/projects/:id { autoReviewPrs }",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, role: RoleKey, workspaces: string[] = []) => {
      const payload: AuthPayload = {
        userId,
        username: userId,
        role,
        permissions: getPermissionsForRole(role),
        workspaces,
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects", projectsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const patch = (projectId: string, auth: string, body: unknown) =>
      request(app())
        .patch(`/api/projects/${projectId}`)
        .set("Authorization", auth)
        .send(body as object);

    const flagOf = async (projectId: string) =>
      (await db.project.findUniqueOrThrow({ where: { id: projectId } })).autoReviewPrs;

    let seq = 0;
    const newProject = async (createdById: string, workspaceId: string | null = WS) => {
      const id = `project-1169-${++seq}`;
      await db.project.create({
        data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
      });
      return id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1169-auto-review-prs");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-owner", "u-dev", "u-outsider", "u-reader"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS, WS_OTHER]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [workspaceId, userId] of [
        [WS, "u-owner"],
        [WS, "u-dev"],
        [WS, "u-reader"],
        [WS_OTHER, "u-outsider"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => auditSpy.mockClear());

    it("defaults to off, and the project owner turns it on and off again", async () => {
      const id = await newProject("u-owner");
      expect(await flagOf(id)).toBe(false);
      const owner = bearer("u-owner", "coordinator", [WS]);

      const on = await patch(id, owner, { autoReviewPrs: true });
      expect(on.status).toBe(200);
      expect(await flagOf(id)).toBe(true);
      const read = await request(app()).get(`/api/projects/${id}`).set("Authorization", owner);
      expect(read.status).toBe(200);
      expect(read.body.data.autoReviewPrs).toBe(true);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "project.autoReviewPrs.update",
          actor: { id: "u-owner" },
          target: { type: "project", id },
          metadata: { previous: false, next: true },
        }),
      );

      auditSpy.mockClear();
      const off = await patch(id, owner, { autoReviewPrs: false });
      expect(off.status).toBe(200);
      expect(await flagOf(id)).toBe(false);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "project.autoReviewPrs.update",
          metadata: { previous: true, next: false },
        }),
      );
    });

    it("an unchanged value writes no dedicated audit entry", async () => {
      const id = await newProject("u-owner");
      const res = await patch(id, bearer("u-owner", "coordinator", [WS]), {
        autoReviewPrs: false,
      });
      expect(res.status).toBe(200);
      const actions = auditSpy.mock.calls.map((c) => (c[0] as { action: string }).action);
      expect(actions).not.toContain("project.autoReviewPrs.update");
    });

    it("leaves the flag alone when a PATCH does not mention it", async () => {
      const id = await newProject("u-owner");
      await db.project.update({ where: { id }, data: { autoReviewPrs: true } });
      const res = await patch(id, bearer("u-owner", "coordinator", [WS]), { name: "renamed" });
      expect(res.status).toBe(200);
      expect(await flagOf(id)).toBe(true);
    });

    it("rejects a non-boolean value with 400 and writes nothing", async () => {
      const id = await newProject("u-owner");
      for (const autoReviewPrs of ["yes", 1, null]) {
        const res = await patch(id, bearer("u-owner", "coordinator", [WS]), { autoReviewPrs });
        expect(res.status).toBe(400);
      }
      expect(await flagOf(id)).toBe(false);
    });

    it("a developer (no project.update) gets 403 and the flag stays off", async () => {
      const id = await newProject("u-dev");
      const res = await patch(id, bearer("u-dev", "developer", [WS]), { autoReviewPrs: true });
      expect(res.status).toBe(403);
      expect(await flagOf(id)).toBe(false);
    });

    it("a reader gets 403 and the flag stays off", async () => {
      const id = await newProject("u-reader");
      const res = await patch(id, bearer("u-reader", "reader", [WS]), { autoReviewPrs: true });
      expect(res.status).toBe(403);
      expect(await flagOf(id)).toBe(false);
    });

    it("a coordinator from another workspace gets 404, not 403, and the flag stays off", async () => {
      const id = await newProject("u-owner");
      const res = await patch(id, bearer("u-outsider", "coordinator", [WS_OTHER]), {
        autoReviewPrs: true,
      });
      expect(res.status).toBe(404);
      expect(await flagOf(id)).toBe(false);
      // Positive control: the same request from a member of the project's workspace lands.
      const ok = await patch(id, bearer("u-owner", "coordinator", [WS]), { autoReviewPrs: true });
      expect(ok.status).toBe(200);
      expect(await flagOf(id)).toBe(true);
    });

    it("an unknown project is a 404", async () => {
      const res = await patch("p-1169-missing", bearer("u-owner", "admin", [WS]), {
        autoReviewPrs: true,
      });
      expect(res.status).toBe(404);
    });

    describe("the webhook reads the flag this setter writes", () => {
      const enqueued: Array<{ projectId: string; prNumber: number }> = [];
      const queue: PrReviewQueue = {
        enqueue: (job) => {
          enqueued.push(job);
          return { jobId: "jq", queueDepth: enqueued.length };
        },
        enqueueAfter: async (job) => {
          enqueued.push(job);
          return { jobId: `jq_${enqueued.length}`, queueDepth: enqueued.length };
        },
        depth: () => enqueued.length,
        deadLetters: () => [],
        drain: async () => undefined,
        shutdown: async () => undefined,
        isShuttingDown: () => false,
      };

      const webhookApp = () => {
        const a = express();
        a.use(
          express.json({
            verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
              req.rawBody = buf.toString("utf8");
            },
          }),
        );
        a.use("/api/webhooks", githubPrWebhookRouter({ queue, skipDedup: true }));
        return a;
      };

      const deliver = (prNumber: number) => {
        const body = JSON.stringify({
          action: "opened",
          pull_request: {
            number: prNumber,
            title: `PR #${prNumber}`,
            body: "",
            head: { sha: "abc", ref: "feature" },
            html_url: `https://github.com/acme-1169/app/pull/${prNumber}`,
          },
          repository: {
            full_name: "acme-1169/app",
            html_url: "https://github.com/acme-1169/app",
          },
        });
        const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
        return request(webhookApp())
          .post("/api/webhooks/github/pr")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", sig)
          .set("X-GitHub-Event", "pull_request")
          .send(body);
      };

      let projectId: string;
      beforeAll(async () => {
        projectId = await newProject("u-owner");
        await db.repoConnection.create({
          data: {
            id: "repo-1169",
            projectId,
            label: "main",
            ownerOrOrg: "acme-1169",
            repoName: "app",
            isPrimary: true,
          },
        });
      });
      beforeEach(() => {
        process.env.GITHUB_WEBHOOK_SECRET = SECRET;
        enqueued.length = 0;
      });
      afterEach(() => {
        delete process.env.GITHUB_WEBHOOK_SECRET;
      });

      it("with the flag off, an opened PR enqueues nothing", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { autoReviewPrs: false })).status).toBe(200);
        const res = await deliver(7);
        expect(res.status).toBe(200);
        expect(enqueued).toHaveLength(0);
      });

      it("once switched on through the route, the same delivery enqueues a review", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { autoReviewPrs: true })).status).toBe(200);
        const res = await deliver(8);
        expect(res.status).toBe(200);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ projectId, prNumber: 8 });
      });

      it("switched back off, it stops again", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { autoReviewPrs: false })).status).toBe(200);
        await deliver(9);
        expect(enqueued).toHaveLength(0);
      });
    });
  },
);
