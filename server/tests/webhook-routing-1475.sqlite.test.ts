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
 * Two receivers:
 *   - `/github/pr` takes the deployment secret only. Its delivery goes to the
 *     earliest-bound live, connected GitHub connector for the repository that
 *     has no own secret: a newcomer can neither take it nor stop it.
 *   - `/github/pr/c/:connectorId` takes that connector's own secret only.
 *
 * On `main` before this change the router attributed every delivery to the
 * primary connector of whichever project it found first, so the newcomer
 * took the delivery over.
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
  return {
    db: null as unknown,
    touched: new Set<string>(),
    repoCalls: [] as string[],
    beforeRepoUpdateMany: null as null | (() => Promise<void>),
  };
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
const { updateRepoConnector } = await import("../src/lib/connectors/repo/repo-service.js");

const DEPLOYMENT_SECRET = "deployment-secret-1475";
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const WS_A = "ws-a-1475";
const WS_B = "ws-b-1475";
const PA = "project-a-1475";
const PB = "project-b-1475";
const PG = "project-ghe-1475";
const SOLO = "project-solo-1475";
const OWNER = "acme-1475";
const REPO = `${OWNER}/app`;
const T_A = new Date("2026-01-01T00:00:00.000Z");
const T_B = new Date("2026-02-01T00:00:00.000Z");

/** The derivation the server documents: HKDF(master key) → HMAC(id \0 nonce). */
function derive(info: string, key = MASTER_KEY): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(key, "base64"), Buffer.alloc(0), info, 32),
  );
}
function secretOf(connectorId: string, nonce: string, key = MASTER_KEY): string {
  return crypto
    .createHmac("sha256", derive("metis.github-webhook-secret.v1", key))
    .update(`${connectorId}\0${nonce}`)
    .digest("base64url");
}
function checkOf(connectorId: string, nonce: string): string {
  return crypto
    .createHmac("sha256", derive("metis.github-webhook-secret-check.v1"))
    .update(`${connectorId}\0${nonce}`)
    .digest("base64url")
    .slice(0, 16);
}
const connUrl = (connectorId: string) => `/api/webhooks/github/pr/c/${connectorId}`;

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

    const payloadOf = (
      repo: string,
      prNumber: number,
      action = "opened",
      extra: Record<string, unknown> = {},
      host = "github.com",
    ) =>
      JSON.stringify({
        action,
        pull_request: {
          number: prNumber,
          title: `PR #${prNumber}`,
          body: "Closes #5",
          head: { sha: `sha-${prNumber}`, ref: "feature" },
          html_url: `https://${host}/${repo}/pull/${prNumber}`,
          ...extra,
        },
        repository: { full_name: repo, html_url: `https://${host}/${repo}` },
      });

    const deliver = async (
      secret: string | null,
      payload: string,
      path = "/api/webhooks/github/pr",
      extraHeaders: Record<string, string> = {},
    ) => {
      const req = request(webhookApp())
        .post(path)
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", "pull_request");
      for (const [k, v] of Object.entries(extraHeaders)) req.set(k, v);
      if (secret !== null) {
        req.set(
          "X-Hub-Signature-256",
          "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex"),
        );
      }
      return req.send(payload);
    };
    const enqueuedFor = () => enqueued.map((j) => j.projectId);

    /** Give a connector its own secret exactly as the server records one. */
    const ownSecret = async (connectorId: string, nonce: string) => {
      await db.repoConnection.update({
        where: { id: connectorId },
        data: { webhookSecretNonce: nonce, webhookSecretCheck: checkOf(connectorId, nonce) },
      });
      return secretOf(connectorId, nonce);
    };

    const seedProject = async (
      id: string,
      workspaceId: string,
      repo: string,
      opts: { primary: boolean; createdAt: Date; provider?: string; apiBaseUrl?: string },
    ) => {
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
          isPrimary: opts.primary,
          status: "connected",
          provider: opts.provider ?? "github",
          apiBaseUrl: opts.apiBaseUrl ?? null,
          createdAt: opts.createdAt,
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

    const resetConnector = (id: string, createdAt: Date) =>
      db.repoConnection.update({
        where: { id },
        data: {
          webhookSecretNonce: null,
          webhookSecretCheck: null,
          status: "connected",
          deletedAt: null,
          repoBoundAt: null,
          createdAt,
        },
      });

    beforeAll(async () => {
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      sqlite = createMigratedSqlite("1475-webhook-routing");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      // Records which models a request reached and every repo_connections call,
      // so "nothing read before the signature" and "one lookup" are observations.
      const repoDelegate = new Proxy(db.repoConnection, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== "function") return v;
          return async (...args: unknown[]) => {
            state.repoCalls.push(String(prop));
            if (prop === "updateMany" && state.beforeRepoUpdateMany) {
              const hook = state.beforeRepoUpdateMany;
              state.beforeRepoUpdateMany = null;
              await hook();
            }
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      state.db = new Proxy(db, {
        get(target, prop) {
          state.touched.add(String(prop));
          if (prop === "repoConnection") return repoDelegate;
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
      await seedProject(PA, WS_A, REPO, { primary: false, createdAt: T_A });
      await db.repoConnection.create({
        data: {
          projectId: PA,
          label: "main",
          ownerOrOrg: OWNER,
          repoName: "main",
          isPrimary: true,
        },
      });
      await seedProject(PB, WS_B, REPO, { primary: true, createdAt: T_B });
      await seedProject(SOLO, WS_A, "solo-1475/app", { primary: true, createdAt: T_A });

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
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      enqueued.length = 0;
      state.repoCalls.length = 0;
      await resetConnector(`repo-${PA}`, T_A);
      await resetConnector(`repo-${PB}`, T_B);
      await db.requirement.updateMany({ data: { implementedAt: null } });
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    describe("the shared receiver (deployment secret; existing installs)", () => {
      it("a single-project install is unchanged: its delivery reaches its project", async () => {
        const res = await deliver(DEPLOYMENT_SECRET, payloadOf("solo-1475/app", 1));
        expect(res.status).toBe(200);
        expect(enqueuedFor()).toEqual([SOLO]);
      });

      it("a connected newcomer in another workspace takes nothing and stops nothing", async () => {
        // Before #1475 project B's primary connector took it.
        const res = await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 2));
        expect(res.status).toBe(200);
        expect(enqueuedFor()).toEqual([PA]);
      });

      it("a pending connector never counts, even one bound to the repository earlier", async () => {
        await db.repoConnection.update({
          where: { id: `repo-${PB}` },
          data: { status: "pending", createdAt: new Date("2025-01-01T00:00:00.000Z") },
        });
        await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 3));
        expect(enqueuedFor()).toEqual([PA]);

        // …and with the existing connector errored, a pending one still gets nothing.
        enqueued.length = 0;
        await db.repoConnection.update({ where: { id: `repo-${PA}` }, data: { status: "error" } });
        await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 4));
        expect(enqueuedFor()).toEqual([]);
      });

      it("an old connector repointed at the repository counts from the repoint", async () => {
        await db.repoConnection.create({
          data: {
            id: "repo-b-old-1475",
            projectId: PB,
            label: "old",
            ownerOrOrg: OWNER,
            repoName: "elsewhere",
            status: "connected",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
        });
        try {
          await updateRepoConnector(PB, "repo-b-old-1475", { repoName: "app" }, "u-b");
          await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 5));
          expect(enqueuedFor()).toEqual([PA]);
        } finally {
          await db.repoConnection.delete({ where: { id: "repo-b-old-1475" } });
        }
      });

      it("connectors of another provider, or another GitHub server, never count", async () => {
        await seedProject(PG, WS_B, REPO, {
          primary: true,
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
          provider: "github_enterprise",
          apiBaseUrl: "https://ghe.example.test/api/v3",
        });
        await db.repoConnection.create({
          data: {
            id: "repo-gitlab-1475",
            projectId: PB,
            label: "gl",
            provider: "gitlab",
            ownerOrOrg: OWNER,
            repoName: "app",
            status: "connected",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
        });
        try {
          await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 6));
          expect(enqueuedFor()).toEqual([PA]);
          enqueued.length = 0;
          await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 7, "opened", {}, "ghe.example.test"));
          expect(enqueuedFor()).toEqual([PG]);
        } finally {
          await db.repoConnection.delete({ where: { id: "repo-gitlab-1475" } });
          await db.project.delete({ where: { id: PG } });
        }
      });

      it("a project with its own secret no longer takes shared-secret deliveries", async () => {
        await ownSecret(`repo-${PA}`, "nonce-a");
        await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 8));
        expect(enqueuedFor()).toEqual([PB]);
        enqueued.length = 0;
        await ownSecret(`repo-${PB}`, "nonce-b");
        await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 9));
        expect(enqueuedFor()).toEqual([]);
      });

      it("a connector's own secret is refused on the shared receiver", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        const res = await deliver(secretA, payloadOf(REPO, 10));
        expect(res.status).toBe(401);
        expect(enqueuedFor()).toEqual([]);
      });

      it("reads no repository connector before the deployment signature verifies", async () => {
        await ownSecret(`repo-${PB}`, "nonce-b");
        state.touched.clear();
        const res = await deliver("forged", payloadOf(REPO, 11));
        expect(res.status).toBe(401);
        expect([...state.touched]).toEqual([]);
      });

      it("a deployment-signed merge leaves the requirements of projects with their own secret alone", async () => {
        await ownSecret(`repo-${PA}`, "nonce-a");
        const res = await deliver(
          DEPLOYMENT_SECRET,
          payloadOf(REPO, 12, "closed", {
            merged: true,
            merged_at: "2026-10-20T00:00:00.000Z",
            merge_commit_sha: "merge-12",
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

    describe("a connector's own receiver", () => {
      it("each project gets only the deliveries its own secret signed, at its own URL", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");

        expect((await deliver(secretA, payloadOf(REPO, 20), connUrl(`repo-${PA}`))).status).toBe(
          200,
        );
        expect(enqueuedFor()).toEqual([PA]);
        enqueued.length = 0;
        expect((await deliver(secretB, payloadOf(REPO, 21), connUrl(`repo-${PB}`))).status).toBe(
          200,
        );
        expect(enqueuedFor()).toEqual([PB]);
      });

      it("one project's secret is refused at another project's URL", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        await ownSecret(`repo-${PB}`, "nonce-b");
        const res = await deliver(secretA, payloadOf(REPO, 22), connUrl(`repo-${PB}`));
        expect(res.status).toBe(401);
        expect(enqueuedFor()).toEqual([]);
      });

      it("the deployment secret is refused at a connector's URL", async () => {
        await ownSecret(`repo-${PB}`, "nonce-b");
        const res = await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 23), connUrl(`repo-${PB}`));
        expect(res.status).toBe(401);
      });

      it("does one connector lookup however many connectors the repository has", async () => {
        for (let i = 0; i < 12; i++) {
          const id = `repo-many-${i}-1475`;
          await db.repoConnection.create({
            data: { id, projectId: PB, label: `many-${i}`, ownerOrOrg: OWNER, repoName: "app" },
          });
          await ownSecret(id, `n-${i}`);
        }
        try {
          state.repoCalls.length = 0;
          const res = await deliver("forged", payloadOf(REPO, 24), connUrl("repo-many-3-1475"));
          expect(res.status).toBe(401);
          expect(state.repoCalls).toEqual(["findFirst"]);
        } finally {
          await db.repoConnection.deleteMany({ where: { id: { startsWith: "repo-many-" } } });
        }
      });

      it("every unusable connector gets the same answer as a wrong signature", async () => {
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");
        const forged = await deliver("forged", payloadOf(REPO, 25), connUrl(`repo-${PB}`));
        expect(forged.status).toBe(401);
        const answers = [
          // unknown connector
          await deliver(secretB, payloadOf(REPO, 25), connUrl("no-such-connector")),
          // a payload for another repository
          await deliver(secretB, payloadOf("solo-1475/app", 25), connUrl(`repo-${PB}`)),
          // a connector with no own secret
          await deliver(secretB, payloadOf(REPO, 25), connUrl(`repo-${PA}`)),
        ];
        // a replaced secret
        await ownSecret(`repo-${PB}`, "nonce-b2");
        answers.push(await deliver(secretB, payloadOf(REPO, 25), connUrl(`repo-${PB}`)));
        // a deleted connector, and a deleted project
        const secretB3 = await ownSecret(`repo-${PB}`, "nonce-b3");
        await db.repoConnection.update({
          where: { id: `repo-${PB}` },
          data: { deletedAt: new Date() },
        });
        answers.push(await deliver(secretB3, payloadOf(REPO, 25), connUrl(`repo-${PB}`)));
        await db.repoConnection.update({ where: { id: `repo-${PB}` }, data: { deletedAt: null } });
        await db.project.update({ where: { id: PB }, data: { deletedAt: new Date() } });
        try {
          answers.push(await deliver(secretB3, payloadOf(REPO, 25), connUrl(`repo-${PB}`)));
        } finally {
          await db.project.update({ where: { id: PB }, data: { deletedAt: null } });
        }
        for (const a of answers) {
          expect(a.status).toBe(401);
          expect(a.body).toEqual(forged.body);
        }
        expect(enqueuedFor()).toEqual([]);
      });

      it("an unsigned delivery is refused before any database read", async () => {
        state.touched.clear();
        const res = await deliver(null, payloadOf(REPO, 26), connUrl(`repo-${PB}`));
        expect(res.status).toBe(401);
        expect([...state.touched]).toEqual([]);
      });

      it("a delivery outside the timestamp window is refused as expired", async () => {
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");
        const res = await deliver(secretB, payloadOf(REPO, 27), connUrl(`repo-${PB}`), {
          "X-Webhook-Timestamp": "1",
        });
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe("EXPIRED");
        expect(enqueuedFor()).toEqual([]);
      });

      it("works on a server with no deployment secret", async () => {
        delete process.env.GITHUB_WEBHOOK_SECRET;
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");
        const ok = await deliver(secretB, payloadOf(REPO, 28), connUrl(`repo-${PB}`));
        expect(ok.status).toBe(200);
        expect(enqueuedFor()).toEqual([PB]);
        const shared = await deliver("whatever", payloadOf(REPO, 29));
        expect(shared.status).toBe(401);
        expect(shared.body.reason).toBe("MISSING_SECRET");
      });

      it("a merged pull request updates only the signing project's requirements", async () => {
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");
        const res = await deliver(
          secretB,
          payloadOf(REPO, 30, "closed", {
            merged: true,
            merged_at: "2026-10-20T00:00:00.000Z",
            merge_commit_sha: "merge-30",
          }),
          connUrl(`repo-${PB}`),
        );
        expect(res.status).toBe(200);
        const [a, b] = await Promise.all([
          db.requirement.findUnique({ where: { id: `req-${PA}` } }),
          db.requirement.findUnique({ where: { id: `req-${PB}` } }),
        ]);
        expect(b?.implementedAt).not.toBeNull();
        expect(a?.implementedAt).toBeNull();
      });

      it("the issues receiver still takes the deployment secret only", async () => {
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");
        const payload = JSON.stringify({
          action: "closed",
          issue: { number: 5, title: "x" },
          repository: { full_name: REPO },
        });
        const res = await request(webhookApp())
          .post("/api/webhooks/github/issues")
          .set("Content-Type", "application/json")
          .set(
            "X-Hub-Signature-256",
            "sha256=" + crypto.createHmac("sha256", secretB).update(payload).digest("hex"),
          )
          .send(payload);
        expect(res.status).toBe(401);
      });
    });

    describe("vault key rotation", () => {
      it("a secret derived under the old key shows as needing a new one and is not routed to", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        process.env.VAULT_MASTER_KEY = OTHER_MASTER_KEY;
        const read = await request(api)
          .get(`/api/projects/${PA}/connectors/repos/repo-${PA}`)
          .set("Authorization", memberA());
        expect(read.status).toBe(200);
        expect(read.body.data.webhookSecretConfigured).toBe(false);
        expect(read.body.data.webhookSecretNeedsRenewal).toBe(true);

        // The old secret no longer verifies, under either secret derived from it.
        const old = await deliver(secretA, payloadOf(REPO, 40), connUrl(`repo-${PA}`));
        expect(old.status).toBe(401);
        const rederived = await deliver(
          secretOf(`repo-${PA}`, "nonce-a", OTHER_MASTER_KEY),
          payloadOf(REPO, 41),
          connUrl(`repo-${PA}`),
        );
        expect(rederived.status).toBe(401);
        // For shared-secret routing the connector counts as having no own secret.
        await deliver(DEPLOYMENT_SECRET, payloadOf(REPO, 42));
        expect(enqueuedFor()).toEqual([PA]);
      });
    });

    describe("queued reviews", () => {
      it("a job runs for the project it was enqueued for, even while another project connects the repository", async () => {
        const job = { deliveryId: "d", owner: OWNER, repo: "app", prNumber: 50 };
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
            prNumber: 51,
            projectId: PA,
          }),
        ).toBeNull();
      });
    });

    describe("the connector's webhook secret endpoints", () => {
      const base = (projectId: string) =>
        `/api/projects/${projectId}/connectors/repos/repo-${projectId}`;

      it("generates a secret shown once with its receiver URL, which then signs for that project only", async () => {
        const res = await request(api)
          .post(`${base(PB)}/webhook-secret`)
          .set("Authorization", memberB());
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        const secret: string = res.body.data.secret;
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(res.body.data.webhookPath).toBe(connUrl(`repo-${PB}`));

        const read = await request(api).get(base(PB)).set("Authorization", memberB());
        expect(read.status).toBe(200);
        expect(read.body.data.webhookSecretConfigured).toBe(true);
        expect(read.body.data.webhookSecretNeedsRenewal).toBe(false);
        expect(JSON.stringify(read.body)).not.toContain(secret);

        await deliver(secret, payloadOf(REPO, 60), res.body.data.webhookPath);
        expect(enqueuedFor()).toEqual([PB]);

        // The path the API hands out is the one the real `apiRouter()` mounts.
        const viaApi = payloadOf(REPO, 61);
        const mounted = await request(api)
          .post(res.body.data.webhookPath)
          .set("Content-Type", "application/json")
          .set(
            "X-Hub-Signature-256",
            "sha256=" + crypto.createHmac("sha256", secret).update(viaApi).digest("hex"),
          )
          .send(viaApi);
        expect(mounted.status).toBe(200);
        expect(mounted.body).toMatchObject({ ok: true, handled: true, kind: "reviewable" });
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({ action: "connector.repo.webhook_secret.generate" }),
        );
      });

      it("a concurrent change between read and write is a conflict, not a secret that never worked", async () => {
        state.beforeRepoUpdateMany = async () => {
          await db.repoConnection.update({
            where: { id: `repo-${PB}` },
            data: {
              webhookSecretNonce: "winner",
              webhookSecretCheck: checkOf(`repo-${PB}`, "winner"),
            },
          });
        };
        const res = await request(api)
          .post(`${base(PB)}/webhook-secret`)
          .set("Authorization", memberB());
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("WEBHOOK_SECRET_CONFLICT");
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${PB}` } });
        expect(row?.webhookSecretNonce).toBe("winner");
      });

      it("removing the secret returns the connector to the deployment secret", async () => {
        await ownSecret(`repo-${PA}`, "nonce-a");
        const del = await request(api)
          .delete(`${base(PA)}/webhook-secret`)
          .set("Authorization", memberA());
        expect(del.status).toBe(200);
        expect(del.body.data.webhookSecretConfigured).toBe(false);
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${PA}` } });
        expect(row?.webhookSecretNonce).toBeNull();
        expect(row?.webhookSecretCheck).toBeNull();
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
        try {
          const local = await request(api)
            .post(`/api/projects/${PA}/connectors/repos/repo-local-1475/webhook-secret`)
            .set("Authorization", memberA());
          expect(local.status).toBe(400);
          expect(local.body.error.code).toBe("WEBHOOK_SECRET_UNSUPPORTED");
          const crossed = await request(api)
            .post(`/api/projects/${PA}/connectors/repos/repo-${PB}/webhook-secret`)
            .set("Authorization", memberA());
          expect(crossed.status).toBe(404);
          const row = await db.repoConnection.findUnique({ where: { id: `repo-${PB}` } });
          expect(row?.webhookSecretNonce).toBeNull();
        } finally {
          await db.repoConnection.delete({ where: { id: "repo-local-1475" } });
        }
      });

      it("a reader without connector.write cannot generate one", async () => {
        const res = await request(api)
          .post(`${base(PA)}/webhook-secret`)
          .set("Authorization", bearer("u-a", "reader", [WS_A]));
        expect(res.status).toBe(403);
      });

      it("refuses to generate a secret when the server has no vault master key", async () => {
        delete process.env.VAULT_MASTER_KEY;
        const res = await request(api)
          .post(`${base(PA)}/webhook-secret`)
          .set("Authorization", memberA());
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("WEBHOOK_SECRET_UNAVAILABLE");
      });
    });
  },
);
