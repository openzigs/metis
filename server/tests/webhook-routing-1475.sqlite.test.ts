/**
 * #1475 — a GitHub `pull_request` delivery belongs to the registration that
 * signed it, never to "the first primary connector found" across projects.
 *
 * Two workspaces, each with a project connecting the SAME repository. Driven
 * against a REAL SQLite database built by the migration chain, through the
 * real webhook router (and, for the secret endpoints, the real `apiRouter()`
 * with its project-scope chokepoint). The queue only records what the router
 * enqueued; nothing is reviewed and nothing reaches GitHub.
 *
 * On `main` before this change the router verified the deployment secret only
 * and attributed the delivery to the primary connector of whichever project it
 * found first, so the newcomer took the delivery over.
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
import type { PrReviewJob, PrReviewQueue } from "../src/lib/agents/pr-reviewer/queue.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown, touched: new Set<string>() };
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
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { githubPrWebhookRouter, resolveProjectForQueuedReview } =
  await import("../src/routes/webhooks-github.js");
const { apiRouter } = await import("../src/routes/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const DEPLOYMENT_SECRET = "deployment-secret-1475";
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const WS_A = "ws-a-1475";
const WS_B = "ws-b-1475";
const PA = "project-a-1475";
const PB = "project-b-1475";
const SOLO = "project-solo-1475";
const OWNER = "acme-1475";

/** The same derivation the server documents: HMAC(HKDF(master key), id \0 nonce). */
function secretOf(connectorId: string, nonce: string): string {
  const root = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(MASTER_KEY, "base64"),
      Buffer.alloc(0),
      "metis.github-webhook-secret.v1",
      32,
    ),
  );
  return crypto.createHmac("sha256", root).update(`${connectorId}\0${nonce}`).digest("base64url");
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1475 — webhook deliveries are attributed to the registration that signed them",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let api: express.Express;
    const enqueued: PrReviewJob[] = [];
    const queue = {
      enqueueAfter: async (job: PrReviewJob) => {
        enqueued.push(job);
      },
    } as unknown as PrReviewQueue;

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
    const memberA = () => bearer("u-a", "coordinator", [WS_A]);
    const memberB = () => bearer("u-b", "coordinator", [WS_B]);

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

    const payloadOf = (repo: string, prNumber: number, action = "opened", extra = {}) =>
      JSON.stringify({
        action,
        pull_request: {
          number: prNumber,
          title: `PR #${prNumber}`,
          body: "Closes #5",
          head: { sha: `sha-${prNumber}`, ref: "feature" },
          html_url: `https://github.com/${repo}/pull/${prNumber}`,
          ...extra,
        },
        repository: { full_name: repo, html_url: `https://github.com/${repo}` },
      });

    const deliver = async (secret: string | null, payload: string) => {
      const req = request(webhookApp())
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", "pull_request");
      if (secret !== null) {
        req.set(
          "X-Hub-Signature-256",
          "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex"),
        );
      }
      return req.send(payload);
    };
    const enqueuedFor = () => enqueued.map((j) => j.projectId);

    const setNonce = (connectorId: string, nonce: string | null) =>
      db.repoConnection.update({
        where: { id: connectorId },
        data: { webhookSecretNonce: nonce },
      });

    const seedProject = async (id: string, workspaceId: string, repo: string, primary: boolean) => {
      await db.project.create({
        data: {
          id,
          name: id,
          slug: id,
          createdById: "u-a",
          workspaceId,
          status: "active",
          autoReviewPrs: true,
        },
      });
      const [ownerOrOrg, repoName] = repo.split("/");
      await db.repoConnection.create({
        data: {
          id: `repo-${id}`,
          projectId: id,
          label: "app",
          ownerOrOrg,
          repoName,
          isPrimary: primary,
        },
      });
      await db.analysis.create({ data: { id: `an-${id}`, projectId: id, startedById: "u-a" } });
      await db.requirement.create({
        data: { id: `req-${id}`, projectId: id, analysisId: `an-${id}`, title: "R", body: "b" },
      });
      await db.issueDraft.create({
        data: {
          id: `draft-${id}`,
          projectId: id,
          requirementId: `req-${id}`,
          title: "Draft",
          body: "## Acceptance criteria\n- [ ] Works",
          status: "published",
        },
      });
      await db.publishBatch.create({
        data: {
          id: `batch-${id}`,
          projectId: id,
          targetOwner: ownerOrOrg,
          targetRepo: repoName,
          startedById: "u-a",
          status: "completed",
        },
      });
      await db.publishedIssue.create({
        data: {
          batchId: `batch-${id}`,
          draftId: `draft-${id}`,
          issueNumber: 5,
          issueId: `node-${id}`,
          htmlUrl: `https://github.com/${repo}/issues/5`,
          destination: "github",
        },
      });
    };

    beforeAll(async () => {
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      sqlite = createMigratedSqlite("1475-webhook-routing");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      // Records which models a request reached, so "nothing read before the
      // signature" is an observation, not an assumption.
      state.db = new Proxy(db, {
        get(target, prop) {
          state.touched.add(String(prop));
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      for (const id of ["u-a", "u-b"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS_A, WS_B]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS_A, userId: "u-a", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WS_B, userId: "u-b", role: "member" },
      });

      // Project A connected the repository first (as a secondary repository);
      // project B, in another workspace, later made the same repository its primary.
      await seedProject(PA, WS_A, `${OWNER}/app`, false);
      await db.repoConnection.create({
        data: {
          projectId: PA,
          label: "main",
          ownerOrOrg: OWNER,
          repoName: "main",
          isPrimary: true,
        },
      });
      await seedProject(PB, WS_B, `${OWNER}/app`, true);
      await seedProject(SOLO, WS_A, "solo-1475/app", true);

      api = express();
      api.use(express.json());
      api.use("/api", apiRouter());
      api.use(notFoundHandler);
      api.use(errorHandler);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.VAULT_MASTER_KEY;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      process.env.GITHUB_WEBHOOK_SECRET = DEPLOYMENT_SECRET;
      enqueued.length = 0;
      await setNonce(`repo-${PA}`, null);
      await setNonce(`repo-${PB}`, null);
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    describe("deliveries signed with the deployment secret (existing installs)", () => {
      it("a single-project install is unchanged: its delivery reaches its project", async () => {
        const res = await deliver(DEPLOYMENT_SECRET, payloadOf("solo-1475/app", 1));
        expect(res.status).toBe(200);
        expect(enqueuedFor()).toEqual([SOLO]);
      });

      it("two projects taking the deployment secret on one repository: neither gets it", async () => {
        const res = await deliver(DEPLOYMENT_SECRET, payloadOf(`${OWNER}/app`, 2));
        expect(res.status).toBe(200);
        // Before #1475 project B's primary connector took it.
        expect(enqueuedFor()).toEqual([]);
      });

      it("an existing install keeps its deliveries when another workspace connects with its own secret", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        await deliver(DEPLOYMENT_SECRET, payloadOf(`${OWNER}/app`, 3));
        expect(enqueuedFor()).toEqual([PA]);
      });
    });

    describe("deliveries signed with a connector's own secret", () => {
      it("each project gets only the deliveries its own secret signed", async () => {
        await setNonce(`repo-${PA}`, "nonce-a");
        await setNonce(`repo-${PB}`, "nonce-b");

        expect(
          (await deliver(secretOf(`repo-${PA}`, "nonce-a"), payloadOf(`${OWNER}/app`, 4))).status,
        ).toBe(200);
        expect(enqueuedFor()).toEqual([PA]);

        enqueued.length = 0;
        expect(
          (await deliver(secretOf(`repo-${PB}`, "nonce-b"), payloadOf(`${OWNER}/app`, 5))).status,
        ).toBe(200);
        expect(enqueuedFor()).toEqual([PB]);
      });

      it("a project with its own secret no longer takes deployment-signed deliveries", async () => {
        await setNonce(`repo-${PA}`, "nonce-a");
        await setNonce(`repo-${PB}`, "nonce-b");
        await deliver(DEPLOYMENT_SECRET, payloadOf(`${OWNER}/app`, 6));
        expect(enqueuedFor()).toEqual([]);
      });

      it("a secret is bound to its connector: the same nonce on another connector is a different secret", async () => {
        await setNonce(`repo-${PB}`, "shared-nonce");
        const res = await deliver(
          secretOf(`repo-${PA}`, "shared-nonce"),
          payloadOf(`${OWNER}/app`, 7),
        );
        expect(res.status).toBe(401);
        expect(enqueuedFor()).toEqual([]);
      });

      it("a replaced secret stops working", async () => {
        await setNonce(`repo-${PB}`, "old");
        await setNonce(`repo-${PB}`, "new");
        const res = await deliver(secretOf(`repo-${PB}`, "old"), payloadOf(`${OWNER}/app`, 8));
        expect(res.status).toBe(401);
        expect(enqueuedFor()).toEqual([]);
      });

      it("a removed connector's secret stops working", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        await db.repoConnection.update({
          where: { id: `repo-${PB}` },
          data: { deletedAt: new Date() },
        });
        try {
          const res = await deliver(
            secretOf(`repo-${PB}`, "nonce-b"),
            payloadOf(`${OWNER}/app`, 9),
          );
          expect(res.status).toBe(401);
          expect(enqueuedFor()).toEqual([]);
        } finally {
          await db.repoConnection.update({
            where: { id: `repo-${PB}` },
            data: { deletedAt: null },
          });
        }
      });

      it("a connector's secret signs only for its own repository", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        const res = await deliver(
          secretOf(`repo-${PB}`, "nonce-b"),
          payloadOf("solo-1475/app", 10),
        );
        expect(res.status).toBe(401);
        expect(enqueuedFor()).toEqual([]);
      });

      it("a merged pull request updates only the signing project's requirements", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        const res = await deliver(
          secretOf(`repo-${PB}`, "nonce-b"),
          payloadOf(`${OWNER}/app`, 11, "closed", {
            merged: true,
            merged_at: "2026-10-20T00:00:00.000Z",
            merge_commit_sha: "merge-11",
          }),
        );
        expect(res.status).toBe(200);
        const [a, b] = await Promise.all([
          db.requirement.findUnique({ where: { id: `req-${PA}` } }),
          db.requirement.findUnique({ where: { id: `req-${PB}` } }),
        ]);
        expect(b?.implementedAt).not.toBeNull();
        expect(a?.implementedAt).toBeNull();
      });
    });

    describe("verification edges", () => {
      it("connector secrets work on a server with no deployment secret", async () => {
        delete process.env.GITHUB_WEBHOOK_SECRET;
        await setNonce(`repo-${PB}`, "nonce-b");
        const ok = await deliver(secretOf(`repo-${PB}`, "nonce-b"), payloadOf(`${OWNER}/app`, 20));
        expect(ok.status).toBe(200);
        expect(enqueuedFor()).toEqual([PB]);
        const bad = await deliver("whatever", payloadOf(`${OWNER}/app`, 21));
        expect(bad.status).toBe(401);
        expect(bad.body.reason).toBe("MISSING_SECRET");
      });

      it("a connector-signed delivery outside the timestamp window is refused as expired", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        const payload = payloadOf(`${OWNER}/app`, 22);
        const sig =
          "sha256=" +
          crypto
            .createHmac("sha256", secretOf(`repo-${PB}`, "nonce-b"))
            .update(payload)
            .digest("hex");
        const res = await request(webhookApp())
          .post("/api/webhooks/github/pr")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", sig)
          .set("X-Webhook-Timestamp", "1")
          .send(payload);
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe("EXPIRED");
        expect(enqueuedFor()).toEqual([]);
      });

      it("a connector-signed delivery for a deleted project is refused", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        await db.project.update({ where: { id: PB }, data: { deletedAt: new Date() } });
        try {
          const res = await deliver(
            secretOf(`repo-${PB}`, "nonce-b"),
            payloadOf(`${OWNER}/app`, 23),
          );
          expect(res.status).toBe(401);
          expect(enqueuedFor()).toEqual([]);
        } finally {
          await db.project.update({ where: { id: PB }, data: { deletedAt: null } });
        }
      });

      it("the issues receiver still takes the deployment secret only", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        const payload = JSON.stringify({
          action: "closed",
          issue: { number: 5, title: "x" },
          repository: { full_name: `${OWNER}/app` },
        });
        const res = await request(webhookApp())
          .post("/api/webhooks/github/issues")
          .set("Content-Type", "application/json")
          .set(
            "X-Hub-Signature-256",
            "sha256=" +
              crypto
                .createHmac("sha256", secretOf(`repo-${PB}`, "nonce-b"))
                .update(payload)
                .digest("hex"),
          )
          .send(payload);
        expect(res.status).toBe(401);
      });
    });

    describe("refusals reveal nothing", () => {
      it("a forged signature gets the same answer whether or not any project connects the repository", async () => {
        await setNonce(`repo-${PB}`, "nonce-b");
        const forged = crypto.randomBytes(32).toString("hex");
        const known = await deliver(forged, payloadOf(`${OWNER}/app`, 12));
        const unknown = await deliver(forged, payloadOf("nobody-1475/app", 12));
        expect(known.status).toBe(401);
        expect(unknown.status).toBe(401);
        expect(known.body).toEqual(unknown.body);
        expect(enqueuedFor()).toEqual([]);
      });

      it("an unsigned delivery is refused before any database read", async () => {
        state.touched.clear();
        const res = await deliver(null, payloadOf(`${OWNER}/app`, 13));
        expect(res.status).toBe(401);
        expect([...state.touched]).toEqual([]);
      });

      it("a deployment-signed delivery reads no connector secret before it verifies", async () => {
        state.touched.clear();
        await deliver(DEPLOYMENT_SECRET, payloadOf(`${OWNER}/app`, 14, "edited"));
        // `edited` is not handled, so nothing at all needs the database.
        expect([...state.touched]).toEqual([]);
      });
    });

    describe("queued reviews", () => {
      it("a job runs for the project it was enqueued for, even while another project connects the repository", async () => {
        const job = { deliveryId: "d", owner: OWNER, repo: "app", prNumber: 15 };
        expect(await resolveProjectForQueuedReview({ ...job, projectId: PA })).toMatchObject({
          id: PA,
        });
        expect(await resolveProjectForQueuedReview({ ...job, projectId: PB })).toMatchObject({
          id: PB,
        });
      });

      it("a job for a project that no longer connects the repository is dropped", async () => {
        expect(
          await resolveProjectForQueuedReview({
            deliveryId: "d",
            owner: "solo-1475",
            repo: "app",
            prNumber: 16,
            projectId: PA,
          }),
        ).toBeNull();
      });
    });

    describe("the connector's webhook secret endpoints", () => {
      const base = (projectId: string) =>
        `/api/projects/${projectId}/connectors/repos/repo-${projectId}`;

      it("generates a secret shown once, which then signs deliveries for that project only", async () => {
        const res = await request(api)
          .post(`${base(PB)}/webhook-secret`)
          .set("Authorization", memberB());
        expect(res.status).toBe(200);
        const secret: string = res.body.data.secret;
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const read = await request(api).get(base(PB)).set("Authorization", memberB());
        expect(read.status).toBe(200);
        expect(read.body.data.webhookSecretConfigured).toBe(true);
        expect(JSON.stringify(read.body)).not.toContain(secret);

        await deliver(secret, payloadOf(`${OWNER}/app`, 17));
        expect(enqueuedFor()).toEqual([PB]);

        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({ action: "connector.repo.webhook_secret.generate" }),
        );
      });

      it("removing the secret returns the connector to the deployment secret", async () => {
        await setNonce(`repo-${PA}`, "nonce-a");
        const del = await request(api)
          .delete(`${base(PA)}/webhook-secret`)
          .set("Authorization", memberA());
        expect(del.status).toBe(200);
        expect(del.body.data.webhookSecretConfigured).toBe(false);
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${PA}` } });
        expect(row?.webhookSecretNonce).toBeNull();
      });

      it("another workspace's member cannot generate or remove a project's secret", async () => {
        const post = await request(api)
          .post(`${base(PA)}/webhook-secret`)
          .set("Authorization", memberB());
        const del = await request(api)
          .delete(`${base(PA)}/webhook-secret`)
          .set("Authorization", memberB());
        expect(post.status).toBe(404);
        expect(del.status).toBe(404);
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${PA}` } });
        expect(row?.webhookSecretNonce).toBeNull();
      });

      it("refuses a connection GitHub does not deliver to, and a connector of another project", async () => {
        await db.repoConnection.create({
          data: { id: "repo-local-1475", projectId: PA, label: "local", provider: "local" },
        });
        const local = await request(api)
          .post(`/api/projects/${PA}/connectors/repos/repo-local-1475/webhook-secret`)
          .set("Authorization", memberA());
        expect(local.status).toBe(400);
        expect(local.body.error.code).toBe("WEBHOOK_SECRET_UNSUPPORTED");
        // B's connector id under A's project path: not A's connector.
        const crossed = await request(api)
          .post(`/api/projects/${PA}/connectors/repos/repo-${PB}/webhook-secret`)
          .set("Authorization", memberA());
        expect(crossed.status).toBe(404);
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${PB}` } });
        expect(row?.webhookSecretNonce).toBeNull();
      });

      it("a reader without connector.write cannot generate one", async () => {
        const res = await request(api)
          .post(`${base(PA)}/webhook-secret`)
          .set("Authorization", bearer("u-a", "reader", [WS_A]));
        expect(res.status).toBe(403);
      });

      it("refuses to generate a secret when the server has no vault master key", async () => {
        delete process.env.VAULT_MASTER_KEY;
        try {
          const res = await request(api)
            .post(`${base(PA)}/webhook-secret`)
            .set("Authorization", memberA());
          expect(res.status).toBe(503);
          expect(res.body.error.code).toBe("WEBHOOK_SECRET_UNAVAILABLE");
        } finally {
          process.env.VAULT_MASTER_KEY = MASTER_KEY;
        }
      });
    });
  },
);
