/**
 * #1484 — a captured signed delivery cannot be replayed under a fresh
 * delivery id and timestamp.
 *
 * GitHub (and Jira) sign the body only. `X-GitHub-Delivery` and
 * `X-Webhook-Timestamp` are unsigned, so on `main` before this change a
 * replay that changed both was verified and processed again. Every receiver
 * now also claims (receiver, route event, SHA-256 of the signed body) in a
 * durable table, and refuses a GitHub event whose signed `updated_at` is
 * older than the replay window.
 *
 * Driven against a REAL SQLite database built by the migration chain, through
 * the real routers. "Restart" closes the Prisma client and opens a new one on
 * the same file with a freshly built router: nothing in memory survives it.
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
const { purgeOldPayloadDigests, PAYLOAD_DIGEST_RETENTION_MS, SIGNED_EVENT_MAX_AGE_MS } =
  await import("../src/lib/webhooks/payload-replay.js");

const SECRET = "deployment-secret-1484";
const JIRA_SECRET = "jira-secret-1484";
const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
const WS = "ws-1484";
const PA = "project-a-1484";
const PB = "project-b-1484";
const REPO = "acme-1484/app";
const DAY = 24 * 60 * 60 * 1000;

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
  "#1484 — a signed delivery is processed once, whatever its unsigned headers say",
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

    const app = () => {
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
    let current: express.Express;

    /** Close the client, reopen the same file, rebuild the routers. */
    const restart = async () => {
      await db.$disconnect();
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      current = app();
    };

    const prBody = (n: number, updatedAt = new Date().toISOString()) =>
      JSON.stringify({
        action: "opened",
        pull_request: {
          number: n,
          title: `PR #${n}`,
          body: "",
          updated_at: updatedAt,
          head: { sha: `sha-${n}`, ref: "feature" },
          html_url: `https://github.com/${REPO}/pull/${n}`,
        },
        repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
      });

    const post = (
      path: string,
      body: string,
      secret: string,
      headers: Record<string, string> = {},
      event = "pull_request",
    ) => {
      const r = request(current)
        .post(path)
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", event)
        .set("X-Hub-Signature-256", `sha256=${hmac(secret, body)}`);
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      return r.send(body);
    };
    const pr = (body: string, delivery: string | null, extra: Record<string, string> = {}) =>
      post("/api/webhooks/github/pr", body, SECRET, {
        ...(delivery ? { "X-GitHub-Delivery": delivery } : {}),
        ...extra,
      });
    const nowTs = () => String(Math.floor(Date.now() / 1000));
    const digestRows = () => db.webhookPayloadDigest.count();

    beforeAll(async () => {
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      sqlite = createMigratedSqlite("1484-webhook-payload-replay");
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
            provider: "github",
            createdAt,
          },
        });
      }
      // Project B registered its own webhook (#1475): `/github/pr/c/repo-B`.
      await db.repoConnection.update({
        where: { id: `repo-${PB}` },
        data: {
          webhookSecretNonce: "nonce-b",
          webhookSecretCheck: checkOf(`repo-${PB}`, "nonce-b"),
        },
      });
      current = app();
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
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    it("same body + new delivery id + new timestamp is not processed twice, across a restart", async () => {
      const body = prBody(1);
      const first = await pr(body, "delivery-1", { "X-Webhook-Timestamp": nowTs() });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ handled: true, kind: "reviewable" });
      expect(enqueued).toHaveLength(1);

      await restart();

      const replay = await pr(body, "delivery-forged", { "X-Webhook-Timestamp": nowTs() });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_PAYLOAD" });
      // …with no delivery id at all, and with a different (unsigned) event header.
      expect((await pr(body, null)).body.reason).toBe("DUPLICATE_PAYLOAD");
      const relabelled = await post(
        "/api/webhooks/github/pr",
        body,
        SECRET,
        { "X-GitHub-Delivery": "delivery-forged-2" },
        "pull_request_review",
      );
      expect(relabelled.body.reason).toBe("DUPLICATE_PAYLOAD");
      expect(enqueued).toHaveLength(1);
    });

    it("different bodies are still processed", async () => {
      await pr(prBody(2), "delivery-2");
      await restart();
      await pr(prBody(3), "delivery-3");
      expect(enqueued.map((j) => j.prNumber)).toEqual([2, 3]);
      expect(await digestRows()).toBe(2);
    });

    it("GitHub's own redelivery of a processed delivery is acknowledged, not re-run", async () => {
      const body = prBody(4);
      await pr(body, "delivery-4");
      const redelivered = await pr(body, "delivery-4");
      expect(redelivered.body.reason).toBe("DUPLICATE_DELIVERY");
      expect(enqueued).toHaveLength(1);
    });

    it("a delivery whose processing failed is processed when GitHub redelivers it", async () => {
      const body = prBody(5);
      failNextEnqueue = true;
      const failed = await pr(body, "delivery-5");
      expect(failed.status).toBe(500);
      expect(await digestRows()).toBe(0);
      expect(await db.prReviewWebhookDelivery.count()).toBe(0);

      const redelivered = await pr(body, "delivery-5");
      expect(redelivered.status).toBe(200);
      expect(redelivered.body).toMatchObject({ handled: true });
      expect(enqueued.map((j) => j.prNumber)).toEqual([5]);
    });

    it("an event whose signed updated_at is past the replay window is refused before any write", async () => {
      const old = new Date(Date.now() - SIGNED_EVENT_MAX_AGE_MS - DAY).toISOString();
      const res = await pr(prBody(6, old), "delivery-6", { "X-Webhook-Timestamp": nowTs() });
      expect(res.body).toEqual({ ok: true, handled: false, reason: "STALE_DELIVERY" });
      expect(enqueued).toEqual([]);
      expect(await digestRows()).toBe(0);
      expect(await db.prReviewWebhookDelivery.count()).toBe(0);
      // Inside GitHub's 3-day redelivery window it is still accepted.
      const recent = new Date(Date.now() - 3 * DAY).toISOString();
      expect((await pr(prBody(7, recent), "delivery-7")).body).toMatchObject({ handled: true });
    });

    it("an unsigned replay does no database work: refused at the signature", async () => {
      const body = prBody(8);
      const res = await request(current)
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", `sha256=${hmac("wrong-secret", body)}`)
        .send(body);
      expect(res.status).toBe(401);
      expect(await digestRows()).toBe(0);
    });

    it("the per-connector receiver dedupes on its own scope", async () => {
      const body = prBody(9);
      const ownSecret = secretOf(`repo-${PB}`, "nonce-b");
      const conn = "/api/webhooks/github/pr/c/repo-" + PB;
      // The same repository event reaches both registrations: both are processed.
      await pr(body, "delivery-9-shared");
      const viaConnector = await post(conn, body, ownSecret, {
        "X-GitHub-Delivery": "delivery-9-c",
      });
      expect(viaConnector.body).toMatchObject({ handled: true });
      expect(enqueued.map((j) => j.projectId)).toEqual([PA, PB]);

      await restart();
      const replay = await post(conn, body, ownSecret, {
        "X-GitHub-Delivery": "delivery-9-forged",
        "X-Webhook-Timestamp": nowTs(),
      });
      expect(replay.body.reason).toBe("DUPLICATE_PAYLOAD");
      expect(enqueued).toHaveLength(2);
    });

    it("the issues receiver: same body + new delivery id is not processed twice", async () => {
      const body = JSON.stringify({
        action: "edited",
        issue: { number: 11, title: "T", updated_at: new Date().toISOString() },
        repository: { full_name: REPO },
      });
      const issues = (delivery: string) =>
        post(
          "/api/webhooks/github/issues",
          body,
          SECRET,
          { "X-GitHub-Delivery": delivery },
          "issues",
        );
      const first = await issues("issues-1");
      expect(first.status).toBe(200);
      expect(first.body.reason).not.toBe("DUPLICATE_PAYLOAD");
      await restart();
      const replay = await issues("issues-forged");
      expect(replay.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_PAYLOAD" });
    });

    it("the Jira receiver: same body + new webhook id is not processed twice", async () => {
      const body = JSON.stringify({ webhookEvent: "jira:worklog_updated", timestamp: Date.now() });
      const jira = (id: string) =>
        request(current)
          .post("/api/webhooks/jira/issues")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature", `sha256=${hmac(JIRA_SECRET, body)}`)
          .set("X-Atlassian-Webhook-Id", id)
          .send(body);
      expect((await jira("jira-1")).body.reason).toBe("UNSUPPORTED_EVENT");
      await restart();
      expect((await jira("jira-forged")).body.reason).toBe("DUPLICATE_PAYLOAD");
    });

    it("storage is bounded: claims past the retention window are purged, younger ones kept", async () => {
      const old = prBody(12);
      const young = prBody(13);
      await pr(old, "delivery-12");
      await pr(young, "delivery-13");
      const sha = (b: string) => crypto.createHash("sha256").update(b).digest("hex");
      await db.webhookPayloadDigest.updateMany({
        where: { bodySha256: sha(old) },
        data: { receivedAt: new Date(Date.now() - PAYLOAD_DIGEST_RETENTION_MS - DAY) },
      });
      expect(await purgeOldPayloadDigests()).toBe(1);
      const left = await db.webhookPayloadDigest.findMany({ select: { bodySha256: true } });
      expect(left).toEqual([{ bodySha256: sha(young) }]);
      // The retention window outlives the age limit, so no body is ever both
      // young enough to be accepted and already purged.
      expect(PAYLOAD_DIGEST_RETENTION_MS).toBeGreaterThan(SIGNED_EVENT_MAX_AGE_MS + DAY);
    });
  },
);
