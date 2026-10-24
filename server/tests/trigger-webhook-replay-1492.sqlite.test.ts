/**
 * #1492 — the async GitHub trigger receiver (`POST /api/webhooks/github`)
 * fires a signed delivery once, whatever its unsigned headers say.
 *
 * GitHub signs the body only: `X-GitHub-Delivery` and `X-GitHub-Event` are
 * unsigned. On `main` before this change the receiver had no replay guard and
 * matched each trigger's event filter against `X-GitHub-Event`, so a captured
 * delivery resent under a fresh id fired every matching trigger again, and a
 * `push` body resent as `pull_request` fired the repository's `pull_request`
 * triggers.
 *
 * Driven against a REAL SQLite database built by the migration chain, through
 * the real router. Only the async runner is replaced, so no run executes (and
 * no model is called); its submit is what "fired" means here.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.WEBHOOK_RECEIVER_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    submitted: [] as Array<{ projectId: string; payload: { triggerId: string; event?: unknown } }>,
    failSubmitFor: null as string | null,
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/async/runner.js", () => ({
  getAsyncRunner: () => ({
    submit: async (input: { projectId: string; payload: { triggerId: string } }) => {
      if (state.failSubmitFor === input.payload.triggerId) {
        state.failSubmitFor = null;
        throw new Error("database is locked");
      }
      state.submitted.push(input);
      return { id: `run-${state.submitted.length}` };
    },
  }),
}));

const { triggersWebhookRouter } = await import("../src/routes/triggers.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");
const { SIGNED_EVENT_MAX_AGE_MS } = await import("../src/lib/webhooks/payload-replay.js");

const PROJECT = "project-1492";
const REPO = "acme-1492/app";
const SECRET = "trigger-secret-1492";
const OTHER_SECRET = "second-registration-secret-1492";
const DAY = 24 * 60 * 60 * 1000;

const hmac = (secret: string, body: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const pushBody = (n: number, pushedAt = Math.floor(Date.now() / 1000)) =>
  JSON.stringify({
    ref: "refs/heads/main",
    before: `before-${n}`,
    after: `after-${n}`,
    commits: [{ id: `after-${n}`, message: `commit ${n}` }],
    pusher: { name: "octo" },
    repository: { full_name: REPO, pushed_at: pushedAt },
  });

const prBody = (n: number, updatedAt = new Date().toISOString()) =>
  JSON.stringify({
    action: "opened",
    pull_request: { number: n, updated_at: updatedAt },
    repository: { full_name: REPO },
  });

const releaseBody = (n: number) =>
  JSON.stringify({
    action: "published",
    release: { id: n, tag_name: `v${n}` },
    repository: { full_name: REPO },
  });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1492 — a signed trigger delivery fires each trigger once, whatever its unsigned headers say",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const app = () => {
      const a = express();
      a.use(
        express.json({
          verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
            req.rawBody = buf.toString("utf8");
          },
        }),
      );
      a.use("/api/webhooks", triggersWebhookRouter());
      a.use(errorHandler);
      return a;
    };

    const deliver = (
      body: string,
      event: string,
      delivery: string | null,
      secret: string = SECRET,
    ) => {
      const r = request(app())
        .post("/api/webhooks/github")
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", event)
        .set("X-Hub-Signature-256", `sha256=${hmac(secret, body)}`);
      if (delivery) r.set("X-GitHub-Delivery", delivery);
      return r.send(body);
    };

    const trigger = (id: string, config: Record<string, unknown>) =>
      db.trigger.create({
        data: {
          id,
          projectId: PROJECT,
          name: id,
          source: "github",
          config: JSON.stringify({ repo: REPO, secret: SECRET, kind: "custom", ...config }),
        },
      });

    const firedTriggers = () => state.submitted.map((s) => s.payload.triggerId);
    const writes = async () => ({
      digests: await db.webhookPayloadDigest.count(),
      deliveries: await db.prReviewWebhookDelivery.count(),
      fired: state.submitted.length,
      lastFired: await db.trigger.count({ where: { lastFiredAt: { not: null } } }),
    });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1492-trigger-webhook-replay");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1492", username: "u-1492", displayName: "u", email: "u-1492@example.test" },
      });
      await db.workspace.create({ data: { id: "ws-1492", name: "ws", slug: "ws-1492" } });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: "u-1492",
          workspaceId: "ws-1492",
          status: "active",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      state.db = db;
      state.submitted.length = 0;
      state.failSubmitFor = null;
      await db.trigger.deleteMany({});
      await db.webhookPayloadDigest.deleteMany({});
      await db.prReviewWebhookDelivery.deleteMany({});
    });

    it("the same body under a new delivery id fires nothing; GitHub's own retry is deduped by id", async () => {
      await trigger("t-push", { event: "push" });
      const body = pushBody(1);

      const first = await deliver(body, "push", "delivery-1");
      expect(first.status).toBe(200);
      expect(first.body.data.fired).toHaveLength(1);

      const retry = await deliver(body, "push", "delivery-1");
      expect(retry.body.data).toMatchObject({ fired: [], reason: "DUPLICATE_DELIVERY" });

      const replay = await deliver(body, "push", "delivery-forged");
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({ fired: [], duplicate: 1 });
      expect((await deliver(body, "push", null)).body.data.fired).toEqual([]);

      expect(firedTriggers()).toEqual(["t-push"]);
    });

    it("the event filter is matched on the signed body, not a relabelled X-GitHub-Event", async () => {
      await trigger("t-push", { event: "push" });
      await trigger("t-pr", { event: "pull_request" });

      // A push body labelled `pull_request` — on first sight, before any claim —
      // is a push: the push trigger fires, the pull_request trigger does not.
      const relabelledFirst = await deliver(pushBody(2), "pull_request", "delivery-2");
      expect(relabelledFirst.status).toBe(200);
      expect(firedTriggers()).toEqual(["t-push"]);
      expect(state.submitted[0].payload.event).toBe("push");

      // And a genuine push body replayed relabelled fires neither.
      const body = pushBody(3);
      await deliver(body, "push", "delivery-3");
      expect(firedTriggers()).toEqual(["t-push", "t-push"]);
      const relabelled = await deliver(body, "pull_request", "delivery-forged-3");
      expect(relabelled.body.data.fired).toEqual([]);
      expect(firedTriggers()).toEqual(["t-push", "t-push"]);

      // A pull_request body still fires the pull_request trigger, whatever the header says.
      await deliver(prBody(4), "push", "delivery-4");
      expect(firedTriggers()).toEqual(["t-push", "t-push", "t-pr"]);
    });

    it("multi-trigger fan-out fires each trigger once, including over a second registration's secret", async () => {
      await trigger("t-a", { event: "push" });
      await trigger("t-b", {});
      await trigger("t-c", { event: "push", secret: OTHER_SECRET });
      const body = pushBody(5);

      // One registration signs with SECRET, the other with OTHER_SECRET: GitHub
      // sends the same body once to each.
      const viaFirst = await deliver(body, "push", "delivery-5a");
      expect(viaFirst.body.data.fired).toHaveLength(2);
      const viaSecond = await deliver(body, "push", "delivery-5b", OTHER_SECRET);
      expect(viaSecond.body.data.fired).toHaveLength(1);
      expect(firedTriggers().sort()).toEqual(["t-a", "t-b", "t-c"]);

      // Replays over either secret fire none of them.
      await deliver(body, "push", "delivery-5a-forged");
      await deliver(body, "push", "delivery-5b-forged", OTHER_SECRET);
      expect(firedTriggers().sort()).toEqual(["t-a", "t-b", "t-c"]);
    });

    it("writes nothing when the signature does not verify", async () => {
      await trigger("t-push", { event: "push" });
      const body = pushBody(6);
      const forged = await request(app())
        .post("/api/webhooks/github")
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", "push")
        .set("X-GitHub-Delivery", "delivery-6")
        .set("X-Hub-Signature-256", `sha256=${hmac("wrong-secret", body)}`)
        .send(body);
      expect(forged.status).toBe(200);
      expect(forged.body.data.fired).toEqual([]);
      expect(await writes()).toEqual({ digests: 0, deliveries: 0, fired: 0, lastFired: 0 });

      // …and the genuine delivery is then processed (the forged one claimed nothing).
      expect((await deliver(body, "push", "delivery-6")).body.data.fired).toHaveLength(1);
    });

    it("an event the body cannot be classified as matches on the header, and its replay still fires nothing", async () => {
      await trigger("t-release", { event: "release" });
      await trigger("t-workflow", { event: "workflow_run" });
      await trigger("t-pr", { event: "pull_request" });
      const body = releaseBody(7);

      expect((await deliver(body, "release", "delivery-7")).body.data.fired).toHaveLength(1);
      expect(firedTriggers()).toEqual(["t-release"]);

      // Relabelled as another unclassifiable event: every verified trigger was claimed.
      const relabelled = await deliver(body, "workflow_run", "delivery-7-forged");
      expect(relabelled.body.data.fired).toEqual([]);

      // A header naming an event the body would classify as is contradicted by it.
      const asPr = await deliver(releaseBody(8), "pull_request", "delivery-8");
      expect(asPr.body.data.fired).toEqual([]);
      expect(firedTriggers()).toEqual(["t-release"]);
    });

    it("a stale signed delivery is refused before any write", async () => {
      await trigger("t-push", { event: "push" });
      await trigger("t-pr", { event: "pull_request" });
      const old = Date.now() - SIGNED_EVENT_MAX_AGE_MS - DAY;
      const stalePush = await deliver(pushBody(9, Math.floor(old / 1000)), "push", "delivery-9");
      expect(stalePush.body.data).toMatchObject({ fired: [], reason: "STALE_DELIVERY" });
      const stalePr = await deliver(
        prBody(10, new Date(old).toISOString()),
        "pull_request",
        "delivery-10",
      );
      expect(stalePr.body.data).toMatchObject({ fired: [], reason: "STALE_DELIVERY" });
      expect(await writes()).toEqual({ digests: 0, deliveries: 0, fired: 0, lastFired: 0 });
    });

    it("a failed submit gives back the unfired claims and the delivery id; a redelivery fires only those", async () => {
      await trigger("t-1", { event: "push" });
      await trigger("t-2", { event: "push" });
      const body = pushBody(11);
      const order = (await deliver(pushBody(12), "push", null)).body.data.fired.length;
      expect(order).toBe(2);
      const firstToFire = state.submitted[0].payload.triggerId;
      const secondToFire = state.submitted[1].payload.triggerId;
      state.submitted.length = 0;

      state.failSubmitFor = secondToFire;
      const failed = await deliver(body, "push", "delivery-11");
      expect(failed.status).toBe(500);
      expect(firedTriggers()).toEqual([firstToFire]);

      const redelivered = await deliver(body, "push", "delivery-11");
      expect(redelivered.status).toBe(200);
      expect(redelivered.body.data).toMatchObject({ duplicate: 1 });
      expect(firedTriggers()).toEqual([firstToFire, secondToFire]);
    });

    it("triggers cut off by the fan-out cap stay unclaimed, and each redelivery drains the next batch", async () => {
      for (const id of ["t-1", "t-2", "t-3"]) await trigger(id, { event: "push" });
      process.env.MAX_TRIGGER_FANOUT = "2";
      try {
        const body = pushBody(20);
        const first = await deliver(body, "push", "delivery-20");
        expect(first.body.data).toMatchObject({ matched: 3, capped: 1 });
        expect(first.body.data.fired).toHaveLength(2);
        expect(await db.webhookPayloadDigest.count()).toBe(2);

        // GitHub's Redeliver reuses the delivery id: it reaches the third trigger only.
        const redelivered = await deliver(body, "push", "delivery-20");
        expect(redelivered.body.data.fired).toHaveLength(1);
        expect(redelivered.body.data).toMatchObject({ duplicate: 2 });
        expect(redelivered.body.data.capped).toBeUndefined();
        expect(firedTriggers().sort()).toEqual(["t-1", "t-2", "t-3"]);

        expect((await deliver(body, "push", "delivery-20")).body.data.reason).toBe(
          "DUPLICATE_DELIVERY",
        );
        expect((await deliver(body, "push", "delivery-20-forged")).body.data.fired).toEqual([]);
        expect(firedTriggers()).toHaveLength(3);
      } finally {
        delete process.env.MAX_TRIGGER_FANOUT;
      }
    });

    it("a claim on a body with no signed time outlives the 7-day purge and is dropped after 90 days", async () => {
      const {
        purgeOldPayloadDigests,
        PAYLOAD_DIGEST_RETENTION_MS,
        UNTIMED_PAYLOAD_DIGEST_RETENTION_MS,
      } = await import("../src/lib/webhooks/payload-replay.js");
      await trigger("t-release", { event: "release" });
      await trigger("t-push", { event: "push" });
      const untimed = JSON.stringify({
        action: "edited",
        release: { id: 21, published_at: "2020-01-01T00:00:00Z" },
        repository: { full_name: REPO },
      });
      const timed = pushBody(22);
      expect((await deliver(untimed, "release", "delivery-21")).body.data.fired).toHaveLength(1);
      expect((await deliver(timed, "push", "delivery-22")).body.data.fired).toHaveLength(1);
      const receivers = (await db.webhookPayloadDigest.findMany({ select: { receiver: true } }))
        .map((r) => r.receiver)
        .sort();
      // The release body is unclassified, so the non-matching push trigger is
      // claimed for it too (relabel protection), also untimed.
      expect(receivers).toEqual([
        "github-trigger:t-push",
        "untimed:github-trigger:t-push",
        "untimed:github-trigger:t-release",
      ]);

      const ageAll = (ms: number) =>
        db.webhookPayloadDigest.updateMany({ data: { receivedAt: new Date(Date.now() - ms) } });
      await ageAll(PAYLOAD_DIGEST_RETENTION_MS + DAY);
      expect(await purgeOldPayloadDigests()).toBe(1); // the timed push claim only
      expect((await deliver(untimed, "release", "delivery-21-forged")).body.data.fired).toEqual([]);

      await ageAll(UNTIMED_PAYLOAD_DIGEST_RETENTION_MS + DAY);
      expect(await purgeOldPayloadDigests()).toBe(2);
      expect(await db.webhookPayloadDigest.count()).toBe(0);
    });

    it("an old release publish is refused as stale; the run payload's event stays a string", async () => {
      await trigger("t-any", {});
      const old = new Date(Date.now() - SIGNED_EVENT_MAX_AGE_MS - DAY).toISOString();
      const stale = JSON.stringify({
        action: "published",
        release: { id: 23, published_at: old },
        repository: { full_name: REPO },
      });
      expect((await deliver(stale, "release", "delivery-23")).body.data.reason).toBe(
        "STALE_DELIVERY",
      );

      // A header the signed body contradicts: the unfiltered trigger fires with "unknown".
      expect(
        (await deliver(releaseBody(24), "pull_request", "delivery-24")).body.data.fired,
      ).toHaveLength(1);
      expect(state.submitted[0].payload.event).toBe("unknown");
    });

    it("a claim that cannot be written fails closed (503), fires nothing and records nothing", async () => {
      await trigger("t-1", { event: "push" });
      await trigger("t-2", { event: "push" });
      let creates = 0;
      state.db = new Proxy(db, {
        get(target, prop) {
          if (prop === "webhookPayloadDigest") {
            return {
              create: async (args: unknown) => {
                // The first claim lands, the second fails: the first is given back.
                if (++creates === 2) throw new Error("SQLITE_BUSY: database is locked");
                return db.webhookPayloadDigest.create(args as never);
              },
              deleteMany: (args: unknown) => db.webhookPayloadDigest.deleteMany(args as never),
            };
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const body = pushBody(13);
      const res = await deliver(body, "push", "delivery-13");
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain("REPLAY_GUARD_UNAVAILABLE");
      expect(await writes()).toEqual({ digests: 0, deliveries: 0, fired: 0, lastFired: 0 });

      state.db = db;
      expect((await deliver(body, "push", "delivery-13")).body.data.fired).toHaveLength(2);
    });
  },
);
