/**
 * #1511 — a drift event is unique per (project, delivery id), not on the bare
 * delivery id.
 *
 * GitHub gives ONE `X-GitHub-Delivery` GUID to every webhook subscribed to an
 * event. #1506 scoped the delivery-id dedup by receiver and signer, so both
 * hooks now get through it, but `drift_events.deliveryId` was still unique on
 * its own: the second project's drift event collided with the first and was
 * reported as `DUPLICATE`, so that project never saw the drift.
 *
 * Driven against a REAL SQLite database built by the migration chain, through
 * the real webhook router; nothing reaches GitHub.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueChangeEvent } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX = "100000";
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
const { reconcileIssueChange } = await import("../src/lib/sync/reconcile-service.js");

const DEPLOYMENT_SECRET = "deployment-secret-1511";
const MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
const WS = "ws-1511";
const PA = "project-a-1511";
const PB = "project-b-1511";
const PC = "project-c-1511";
const TRACKER_OWNER = "acme-1511";
const TRACKER = `${TRACKER_OWNER}/tracker`;
const NODE = "node-7";

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

type Hook = { path: string; secret: string };
const ownHook = (projectId: string): Hook => ({
  path: `/api/webhooks/github/issues/c/repo-${projectId}`,
  secret: secretOf(`repo-${projectId}`, `nonce-${projectId}`),
});
const sharedHook: Hook = { path: "/api/webhooks/github/issues", secret: DEPLOYMENT_SECRET };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1511 — one GitHub delivery GUID records drift in every project it reaches",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(
        express.json({
          verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
            req.rawBody = buf.toString("utf8");
          },
        }),
      );
      // The real delivery-id dedup and signed-body claim both run.
      a.use("/api/webhooks", githubPrWebhookRouter());
      return a;
    };

    /** An `edited` body that differs from every project's draft title: drift. */
    const editedBody = () =>
      JSON.stringify({
        action: "edited",
        changes: { title: { from: "Draft title" } },
        issue: {
          number: 7,
          node_id: NODE,
          title: "Renamed on GitHub",
          body: "b",
          state: "open",
          updated_at: new Date().toISOString(),
          labels: [],
          assignees: [],
        },
        repository: { full_name: TRACKER, html_url: `https://github.com/${TRACKER}` },
        nonce: ++seq,
      });

    /** GitHub sends the SAME body under the SAME GUID to every subscribed hook. */
    const deliver = (hook: Hook, body: string, guid: string) =>
      request(app())
        .post(hook.path)
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", "issues")
        .set("X-GitHub-Delivery", guid)
        .set(
          "X-Hub-Signature-256",
          "sha256=" + crypto.createHmac("sha256", hook.secret).update(body).digest("hex"),
        )
        .send(body);

    const driftRows = async () =>
      (
        await db.driftEvent.findMany({
          select: { projectId: true, deliveryId: true },
          orderBy: { projectId: "asc" },
        })
      ).map((r) => [r.projectId, r.deliveryId]);

    const seedProject = async (id: string, publishedAt: Date) => {
      await db.project.create({
        data: { id, name: id, slug: id, createdById: "u-1", workspaceId: WS, status: "active" },
      });
      await db.repoConnection.create({
        data: {
          id: `repo-${id}`,
          projectId: id,
          label: "code",
          ownerOrOrg: TRACKER_OWNER,
          repoName: `code-${id}`,
          isPrimary: true,
          status: "connected",
          provider: "github",
        },
      });
      await db.analysis.create({ data: { id: `an-${id}`, projectId: id, startedById: "u-1" } });
      await db.requirement.create({
        data: { id: `req-${id}`, projectId: id, analysisId: `an-${id}`, title: "R", body: "b" },
      });
      await db.publishBatch.create({
        data: {
          id: `batch-${id}`,
          projectId: id,
          targetOwner: TRACKER_OWNER,
          targetRepo: "tracker",
          startedById: "u-1",
          status: "completed",
        },
      });
      await db.issueDraft.create({
        data: {
          id: `draft-${id}`,
          projectId: id,
          requirementId: `req-${id}`,
          title: "Draft title",
          body: "b",
          status: "published",
        },
      });
      // Every project published into the SAME tracker issue.
      await db.publishedIssue.create({
        data: {
          batchId: `batch-${id}`,
          draftId: `draft-${id}`,
          issueNumber: 7,
          issueId: NODE,
          htmlUrl: `https://github.com/${TRACKER}/issues/7`,
          destination: "github",
          publishedAt,
        },
      });
    };

    const ownSecret = (id: string) =>
      db.repoConnection.update({
        where: { id: `repo-${id}` },
        data: {
          webhookSecretNonce: `nonce-${id}`,
          webhookSecretCheck: checkOf(`repo-${id}`, `nonce-${id}`),
        },
      });

    beforeAll(async () => {
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      sqlite = createMigratedSqlite("1511-drift-delivery-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1", username: "u-1", displayName: "u-1", email: "u-1@example.test" },
      });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await seedProject(PA, new Date("2026-01-01T00:00:00.000Z"));
      await seedProject(PB, new Date("2026-02-01T00:00:00.000Z"));
      await seedProject(PC, new Date("2026-03-01T00:00:00.000Z"));
      // B and C registered their own issue hooks (#1483); A takes the shared one.
      await ownSecret(PB);
      await ownSecret(PC);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.VAULT_MASTER_KEY;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      process.env.GITHUB_WEBHOOK_SECRET = DEPLOYMENT_SECRET;
      await db.driftEvent.deleteMany({});
      await db.webhookPayloadDigest.deleteMany({});
      await db.prReviewWebhookDelivery.deleteMany({});
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    it("the same GUID at two projects' own issue hooks: both record drift", async () => {
      const body = editedBody();
      const b = await deliver(ownHook(PB), body, "guid-1511-a");
      const c = await deliver(ownHook(PC), body, "guid-1511-a");
      expect(b.status).toBe(200);
      expect(c.status).toBe(200);
      expect(b.body.drift).toMatchObject({ handled: true });
      // On main: `{ handled: false, reason: "DUPLICATE" }` — the unique index on
      // the bare deliveryId refused C's row.
      expect(c.body.drift).toMatchObject({ handled: true });
      // The row still carries GitHub's own GUID: it is what an operator searches for.
      expect(await driftRows()).toEqual([
        [PB, "guid-1511-a"],
        [PC, "guid-1511-a"],
      ]);
    });

    it("the same GUID at the shared hook and a project's own hook: both projects record drift", async () => {
      const body = editedBody();
      const shared = await deliver(sharedHook, body, "guid-1511-b");
      const own = await deliver(ownHook(PB), body, "guid-1511-b");
      expect(shared.body.drift).toMatchObject({ handled: true });
      expect(own.body.drift).toMatchObject({ handled: true });
      expect(await driftRows()).toEqual([
        [PA, "guid-1511-b"],
        [PB, "guid-1511-b"],
      ]);
    });

    it("the same delivery id twice in ONE project is still recorded once", async () => {
      // Straight at the reconciler, so neither webhook-level guard (the
      // delivery-id dedup, the signed-body claim) is what refuses the second:
      // only the (projectId, deliveryId) index can.
      const event: IssueChangeEvent = {
        deliveryId: "guid-1511-c",
        source: "github",
        externalId: NODE,
        externalRef: "7",
        action: "edited",
        changes: { title: "Renamed on GitHub" },
        current: {
          title: "Renamed on GitHub",
          body: "b",
          state: "open",
          labels: [],
          assignees: [],
        },
        timestamp: new Date().toISOString(),
      };
      const deps = { emitDrift: () => undefined };
      const forB = { kind: "project", projectId: PB } as const;
      const forC = { kind: "project", projectId: PC } as const;
      expect(await reconcileIssueChange(event, deps, forB)).toMatchObject({ handled: true });
      expect(await reconcileIssueChange(event, deps, forB)).toEqual({
        handled: false,
        reason: "DUPLICATE",
      });
      expect(await reconcileIssueChange(event, deps, forC)).toMatchObject({ handled: true });
      expect(await driftRows()).toEqual([
        [PB, "guid-1511-c"],
        [PC, "guid-1511-c"],
      ]);
    });
  },
);
