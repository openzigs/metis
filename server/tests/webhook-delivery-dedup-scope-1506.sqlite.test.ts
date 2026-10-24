/**
 * #1506 — the delivery-id dedup is keyed on the receiver and its signer, not
 * on the bare `X-GitHub-Delivery` GUID.
 *
 * GitHub gives ONE GUID to every webhook subscribed to an event. On `main`
 * before this change `pr_review_webhook_deliveries` was unique on that GUID
 * alone, so when two webhooks on one repository received the same event (the
 * deployment hook and a connector's own hook during the #1475 migration, or
 * two projects' own hooks) the second was dropped as `DUPLICATE_DELIVERY`.
 *
 * Driven against a REAL SQLite database built by the migration chain, through
 * the real routers.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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

const { githubPrWebhookRouter } = await import("../src/routes/webhooks-github.js");
const { syncWebhookRouter } = await import("../src/routes/sync.js");

const SECRET = "deployment-secret-1506";
const JIRA_SECRET = "jira-secret-1506";
const MASTER_KEY = Buffer.alloc(32, 6).toString("base64");
const WS = "ws-1506";
const PA = "project-a-1506"; // takes the deployment hook's deliveries
const PB = "project-b-1506"; // its own hook: /github/pr/c/repo-project-b-1506
const PC = "project-c-1506"; // its own hook: /github/pr/c/repo-project-c-1506
const CB = `repo-${PB}`;
const CC = `repo-${PC}`;
const REPO = "acme-1506/app";
// #1506 review — one project (D) with TWO connectors on this repository: its
// own-secret one (D1) and an older one with no own secret (D2).
const PD = "project-d-1506";
const D1 = "repo-d1-1506";
const D2 = "repo-d2-1506";
const REPO_D = "acme-1506/other";
const TASKS = "# Tasks\n\n- [ ] T01 Build the thing\n";

const hmac = (secret: string, body: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

/** The connector-secret derivation the server documents (#1475). */
function derive(info: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(MASTER_KEY, "base64"), Buffer.alloc(0), info, 32),
  );
}
const secretOf = (id: string, nonce: string) =>
  crypto
    .createHmac("sha256", derive("metis.github-webhook-secret.v1"))
    .update(`${id}\0${nonce}`)
    .digest("base64url");
const checkOf = (id: string, nonce: string) =>
  crypto
    .createHmac("sha256", derive("metis.github-webhook-secret-check.v1"))
    .update(`${id}\0${nonce}`)
    .digest("base64url")
    .slice(0, 16);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1506 — one GitHub delivery GUID reaching several webhooks is processed by each",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const enqueued: PrReviewJob[] = [];
    let failNextEnqueue = false;
    const queue = {
      enqueueAfter: async (job: PrReviewJob) => {
        if (failNextEnqueue) {
          failNextEnqueue = false;
          throw new Error("queue unavailable");
        }
        enqueued.push(job);
      },
    } as unknown as PrReviewQueue;

    let app: express.Express;
    const buildApp = () => {
      const a = express();
      a.use(
        express.json({
          verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
            req.rawBody = buf.toString("utf8");
          },
        }),
      );
      a.use("/api/webhooks", githubPrWebhookRouter({ queue }));
      a.use("/api/webhooks", syncWebhookRouter({ resolveJiraSecret: () => JIRA_SECRET }));
      return a;
    };

    const prBody = (n: number, repo = REPO) =>
      JSON.stringify({
        action: "opened",
        pull_request: {
          number: n,
          title: `PR #${n}`,
          body: "",
          updated_at: new Date().toISOString(),
          head: { sha: `sha-${n}`, ref: "feature" },
          html_url: `https://github.com/${repo}/pull/${n}`,
        },
        repository: { full_name: repo, html_url: `https://github.com/${repo}` },
      });
    const issuesBody = (n: number, action = "edited") =>
      JSON.stringify({
        action,
        issue: {
          number: n,
          node_id: `node-${n}`,
          title: "[T01] Build the thing",
          body: "b",
          state: action === "closed" ? "closed" : "open",
          updated_at: new Date().toISOString(),
          labels: [],
          assignees: [],
        },
        repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
      });

    /** Whether project `id`'s Spec Kit `tasks.md` has T01 ticked (the issue-sync's write). */
    const ticked = async (id: string) => {
      const feature = await db.specKitFeature.findUniqueOrThrow({
        where: { projectId_slug: { projectId: id, slug: "001-feat" } },
      });
      const art = await db.specKitFeatureArtifact.findUniqueOrThrow({
        where: { featureId_key: { featureId: feature.id, key: "tasks.md" } },
      });
      return art.content.includes("[x] T01");
    };

    /** Where a hook points, and the secret GitHub signs with for it. */
    type Hook = { path: string; secret: string };
    const prHook = (connectorId?: string): Hook =>
      connectorId
        ? {
            path: `/api/webhooks/github/pr/c/${connectorId}`,
            secret: secretOf(connectorId, `nonce-${connectorId}`),
          }
        : { path: "/api/webhooks/github/pr", secret: SECRET };
    const issuesHook = (connectorId?: string): Hook =>
      connectorId
        ? {
            path: `/api/webhooks/github/issues/c/${connectorId}`,
            secret: secretOf(connectorId, `nonce-${connectorId}`),
          }
        : { path: "/api/webhooks/github/issues", secret: SECRET };

    const deliver = (hook: Hook, body: string, guid: string, event = "pull_request") =>
      request(app)
        .post(hook.path)
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", event)
        .set("X-GitHub-Delivery", guid)
        .set("X-Hub-Signature-256", `sha256=${hmac(hook.secret, body)}`)
        .send(body);

    const keys = async () =>
      (await db.prReviewWebhookDelivery.findMany({ select: { deliveryId: true } }))
        .map((r) => r.deliveryId)
        .sort();

    beforeAll(async () => {
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      sqlite = createMigratedSqlite("1506-webhook-delivery-dedup-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1", username: "u-1", displayName: "u-1", email: "u-1@example.test" },
      });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      const [ownerOrOrg, repoName] = REPO.split("/");
      for (const [id, createdAt] of [
        [PA, new Date("2026-01-01T00:00:00.000Z")],
        [PB, new Date("2026-02-01T00:00:00.000Z")],
        [PC, new Date("2026-03-01T00:00:00.000Z")],
      ] as const) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "u-1",
            workspaceId: WS,
            status: "active",
            autoReviewPrs: true,
          },
        });
        await db.repoConnection.create({
          data: {
            id: `repo-${id}`,
            projectId: id,
            label: "app",
            ownerOrOrg,
            repoName,
            isPrimary: true,
            status: "connected",
            repoPermission: "admin", // #1488 — eligible for shared-secret routing
            provider: "github",
            createdAt,
          },
        });
      }
      for (const id of [PA, PB]) {
        const feature = await db.specKitFeature.create({
          data: { projectId: id, slug: "001-feat", title: "Feat", status: "tasked" },
        });
        await db.specKitFeatureArtifact.create({
          data: { featureId: feature.id, key: "tasks.md", content: TASKS, version: 1 },
        });
      }
      await db.project.create({
        data: {
          id: PD,
          name: PD,
          slug: PD,
          createdById: "u-1",
          workspaceId: WS,
          status: "active",
          autoReviewPrs: true,
        },
      });
      const [dOwner, dRepo] = REPO_D.split("/");
      for (const [id, label, isPrimary, createdAt] of [
        // D2 is bound FIRST: by bind order alone it would win the shared hook.
        [D2, "legacy", false, new Date("2026-01-01T00:00:00.000Z")],
        [D1, "app", true, new Date("2026-02-01T00:00:00.000Z")],
      ] as const) {
        await db.repoConnection.create({
          data: {
            id,
            projectId: PD,
            label,
            ownerOrOrg: dOwner,
            repoName: dRepo,
            isPrimary,
            status: "connected",
            repoPermission: "admin",
            provider: "github",
            createdAt,
          },
        });
      }
      // Projects B and C each registered their own webhook (#1475), and D did
      // through D1 only.
      for (const c of [CB, CC, D1]) {
        await db.repoConnection.update({
          where: { id: c },
          data: { webhookSecretNonce: `nonce-${c}`, webhookSecretCheck: checkOf(c, `nonce-${c}`) },
        });
      }
      app = buildApp();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.VAULT_MASTER_KEY;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      enqueued.length = 0;
      failNextEnqueue = false;
      await db.webhookPayloadDigest.deleteMany({});
      await db.prReviewWebhookDelivery.deleteMany({});
      await db.specKitTaskExport.deleteMany({});
      await db.specKitFeatureArtifact.updateMany({ data: { content: TASKS } });
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    it("the same GUID at /github/pr and /github/pr/c/:id for one repository: both are processed", async () => {
      const body = prBody(1);
      const shared = await deliver(prHook(), body, "guid-1");
      const own = await deliver(prHook(CB), body, "guid-1");
      expect(shared.status).toBe(200);
      expect(own.status).toBe(200);
      expect(shared.body).toMatchObject({ ok: true, handled: true });
      expect(own.body).toMatchObject({ ok: true, handled: true });
      expect(enqueued.map((j) => j.projectId).sort()).toEqual([PA, PB]);
      // The job still carries GitHub's own GUID: it is what an operator searches for.
      expect(enqueued.map((j) => j.deliveryId)).toEqual(["guid-1", "guid-1"]);
      expect(await keys()).toEqual([`github-pr:c:${CB}:guid-1`, "github-pr:deployment:guid-1"]);
    });

    it("the same GUID at two connectors' URLs: both are processed", async () => {
      const body = prBody(2);
      const b = await deliver(prHook(CB), body, "guid-2");
      const c = await deliver(prHook(CC), body, "guid-2");
      expect(b.body).toMatchObject({ ok: true, handled: true });
      expect(c.body).toMatchObject({ ok: true, handled: true });
      expect(enqueued.map((j) => j.projectId).sort()).toEqual([PB, PC]);
      expect(await keys()).toEqual([`github-pr:c:${CB}:guid-2`, `github-pr:c:${CC}:guid-2`]);
    });

    it("the same GUID resent to the same receiver is still deduped, per receiver", async () => {
      // A different body each time, so the signed-body claim (#1484) cannot be
      // what refuses the resend: only the delivery-id dedup can.
      for (const hook of [prHook(), prHook(CB)]) {
        const first = await deliver(hook, prBody(3), "guid-3");
        expect(first.body).toMatchObject({ ok: true, handled: true });
        const resent = await deliver(hook, prBody(4), "guid-3");
        expect(resent.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
      }
      expect(enqueued.map((j) => [j.projectId, j.prNumber])).toEqual([
        [PA, 3],
        [PB, 3],
      ]);
    });

    it("a row recorded under the bare GUID before this change does not block the scoped key", async () => {
      await db.prReviewWebhookDelivery.create({
        data: { deliveryId: "guid-5", eventType: "pull_request" },
      });
      const res = await deliver(prHook(CB), prBody(5), "guid-5");
      expect(res.body).toMatchObject({ ok: true, handled: true });
      expect(enqueued.map((j) => j.projectId)).toEqual([PB]);
    });

    it("a failed delivery gives back only its own key: Redeliver is processed, the other hook's row stays", async () => {
      const body = prBody(6);
      expect((await deliver(prHook(), body, "guid-6")).body).toMatchObject({ handled: true });
      failNextEnqueue = true;
      const failed = await deliver(prHook(CB), body, "guid-6");
      expect(failed.status).toBe(500);
      expect(await keys()).toEqual(["github-pr:deployment:guid-6"]);

      const redelivered = await deliver(prHook(CB), body, "guid-6");
      expect(redelivered.body).toMatchObject({ ok: true, handled: true });
      expect(enqueued.map((j) => j.projectId)).toEqual([PA, PB]);
      // And the deployment hook's retry is still a duplicate.
      const retry = await deliver(prHook(), body, "guid-6");
      expect(retry.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
    });

    it("a project with an own-secret connector never also wins the shared hook through another connector: reviewed once", async () => {
      const body = prBody(10, REPO_D);
      const shared = await deliver(prHook(), body, "guid-10");
      const own = await deliver(prHook(D1), body, "guid-10");
      expect(shared.status).toBe(200);
      expect(own.body).toMatchObject({ ok: true, handled: true });
      // D2 (no own secret, bound first) would have won the shared hook for D,
      // and D would have been reviewed twice for one event.
      expect(enqueued.map((j) => j.projectId)).toEqual([PD]);
    });

    it("issues: the same GUID at /github/issues and /github/issues/c/:id is processed by each, and a resend is deduped", async () => {
      // B (own secret) exported the task EARLIER than A: by row order alone the
      // shared hook would pick B. It must pick A, and B takes it at its own hook.
      for (const [projectId, createdAt] of [
        [PB, new Date("2026-01-01T00:00:00.000Z")],
        [PA, new Date("2026-02-01T00:00:00.000Z")],
      ] as const) {
        const [repoOwner, repoName] = REPO.split("/");
        await db.specKitTaskExport.create({
          data: {
            projectId,
            featureSlug: "001-feat",
            taskId: "T01",
            issueNumber: 7,
            repoOwner,
            repoName,
            createdAt,
          },
        });
      }
      const body = issuesBody(7, "closed");
      const shared = await deliver(issuesHook(), body, "guid-7", "issues");
      expect(shared.status).toBe(200);
      expect(shared.body).toMatchObject({ ok: true, handled: true });
      expect(await ticked(PA)).toBe(true);
      expect(await ticked(PB)).toBe(false);

      const own = await deliver(issuesHook(CB), body, "guid-7", "issues");
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ ok: true, handled: true });
      expect(await ticked(PB)).toBe(true);
      expect(await keys()).toEqual([
        `github-issues:c:${CB}:guid-7`,
        "github-issues:deployment:guid-7",
      ]);
      const resent = await deliver(issuesHook(CB), issuesBody(8), "guid-7", "issues");
      expect(resent.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
    });

    it("Jira's delivery id is its own namespace: it never collides with a GitHub row", async () => {
      expect((await deliver(prHook(), prBody(9), "shared-id")).body).toMatchObject({
        handled: true,
      });
      const body = JSON.stringify({ webhookEvent: "jira:worklog_updated", timestamp: Date.now() });
      const jira = () =>
        request(app)
          .post("/api/webhooks/jira/issues")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature", `sha256=${hmac(JIRA_SECRET, body)}`)
          .set("X-Atlassian-Webhook-Id", "shared-id")
          .send(body);
      expect((await jira()).body.reason).toBe("UNSUPPORTED_EVENT");
      expect(await keys()).toEqual([
        "github-pr:deployment:shared-id",
        "jira-issues:deployment:shared-id",
      ]);
      // Jira's own retry of that id is still deduped.
      expect((await jira()).body.reason).toBe("DUPLICATE_DELIVERY");
    });
  },
);
