/**
 * #1483 — a GitHub `issues` delivery acts only on the project it is for.
 *
 * Two workspaces, each with a project that exported a Spec Kit task to, and
 * published an issue into, the SAME tracker repository (the repository issues
 * are published to, which is usually not a connected one). Driven against a REAL SQLite database built by the migration
 * chain, through the real webhook router; nothing reaches GitHub.
 *
 * - `/github/issues/c/:connectorId` takes that connector's own secret and
 *   acts on its project only (on `main` the route did not exist).
 * - `/github/issues` (deployment secret) never acts on a project that took
 *   its own secret, follows the #1475 owner rule for a connected repository,
 *   and otherwise picks the earliest matching row in a live project (on
 *   `main`: the first row SQLite returned, deleted project or not, and the
 *   newest publication across all projects).
 * - A3: the event is the one the signed body is. On `main` the drift half
 *   dispatched on the unsigned `X-GitHub-Event` header, so a captured
 *   `issue_comment` body re-sent as `issues` wrote a drift event.
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
const { updateRepoConnector } = await import("../src/lib/connectors/repo/repo-service.js");

const DEPLOYMENT_SECRET = "deployment-secret-1483";
const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
const WS_A = "ws-a-1483";
const WS_B = "ws-b-1483";
const PA = "project-a-1483";
const PB = "project-b-1483";
const TRACKER_OWNER = "acme-1483";
const TRACKER = `${TRACKER_OWNER}/tracker`;
const T1 = new Date("2026-01-01T00:00:00.000Z");
const T2 = new Date("2026-02-01T00:00:00.000Z");
const TASKS = "# Tasks\n\n- [ ] T01 Build the thing\n";

function derive(info: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(MASTER_KEY, "base64"), Buffer.alloc(0), info, 32),
  );
}
function secretOf(connectorId: string, nonce: string): string {
  return crypto
    .createHmac("sha256", derive("metis.github-webhook-secret.v1"))
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
const issuesUrl = (connectorId: string) => `/api/webhooks/github/issues/c/${connectorId}`;
const SHARED = "/api/webhooks/github/issues";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1483 — GitHub issue events act only on the project they are for",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const webhookApp = () => {
      const a = express();
      a.use(
        express.json({
          verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
            req.rawBody = buf.toString("utf8");
          },
        }),
      );
      // The real replay guard runs (no `skipDedup`): every body is unique.
      a.use("/api/webhooks", githubPrWebhookRouter());
      return a;
    };

    /** A fresh `issues` body: `updated_at` now, so never stale, and unique. */
    const issuesBody = (
      issueNumber: number,
      opts: { action?: string; nodeId?: string; title?: string; extra?: object } = {},
    ) =>
      JSON.stringify({
        action: opts.action ?? "closed",
        issue: {
          number: issueNumber,
          node_id: opts.nodeId ?? `node-${issueNumber}`,
          title: opts.title ?? `[T01] Build the thing`,
          body: "b",
          state: opts.action === "edited" ? "open" : "closed",
          updated_at: new Date().toISOString(),
          labels: [],
          assignees: [],
        },
        repository: { full_name: TRACKER, html_url: `https://github.com/${TRACKER}` },
        nonce: ++seq,
        ...opts.extra,
      });

    const deliver = (secret: string, body: string, path = SHARED, event = "issues") =>
      request(webhookApp())
        .post(path)
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", event)
        .set("X-GitHub-Delivery", crypto.randomUUID())
        .set(
          "X-Hub-Signature-256",
          "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"),
        )
        .send(body);

    const ownSecret = async (connectorId: string, nonce: string) => {
      await db.repoConnection.update({
        where: { id: connectorId },
        data: { webhookSecretNonce: nonce, webhookSecretCheck: checkOf(connectorId, nonce) },
      });
      return secretOf(connectorId, nonce);
    };

    const tasksOf = async (projectId: string) => {
      const feature = await db.specKitFeature.findUniqueOrThrow({
        where: { projectId_slug: { projectId, slug: "001-feat" } },
      });
      const art = await db.specKitFeatureArtifact.findUniqueOrThrow({
        where: { featureId_key: { featureId: feature.id, key: "tasks.md" } },
      });
      return art.content;
    };
    const checked = async (projectId: string) => (await tasksOf(projectId)).includes("[x] T01");
    const driftFor = async (projectId: string) => db.driftEvent.count({ where: { projectId } });

    const exportTask = (projectId: string, issueNumber: number, createdAt: Date) =>
      db.specKitTaskExport.create({
        data: {
          projectId,
          featureSlug: "001-feat",
          taskId: `T01`,
          issueNumber,
          repoOwner: TRACKER_OWNER,
          repoName: "tracker",
          createdAt,
        },
      });

    const publish = (projectId: string, nodeId: string, issueNumber: number, at: Date) =>
      db.publishedIssue.create({
        data: {
          batchId: `batch-${projectId}`,
          draftId: `draft-${projectId}-${nodeId}`,
          issueNumber,
          issueId: nodeId,
          htmlUrl: `https://github.com/${TRACKER}/issues/${issueNumber}`,
          destination: "github",
          publishedAt: at,
        },
      });
    const draftFor = (projectId: string, nodeId: string) =>
      db.issueDraft.create({
        data: {
          id: `draft-${projectId}-${nodeId}`,
          projectId,
          requirementId: `req-${projectId}`,
          title: "Draft title",
          body: "b",
          status: "published",
        },
      });

    const seedProject = async (id: string, workspaceId: string) => {
      await db.project.create({
        data: { id, name: id, slug: id, createdById: "u-1", workspaceId, status: "active" },
      });
      // The project's analysed repository: its connector is what carries the
      // project's own webhook secret. Not the tracker.
      await db.repoConnection.create({
        data: {
          id: `repo-${id}`,
          projectId: id,
          label: "code",
          ownerOrOrg: "acme-1483",
          repoName: `code-${id}`,
          isPrimary: true,
          status: "connected",
          provider: "github",
          createdAt: T1,
        },
      });
      const feature = await db.specKitFeature.create({
        data: { projectId: id, slug: "001-feat", title: "Feat", status: "tasked" },
      });
      await db.specKitFeatureArtifact.create({
        data: { featureId: feature.id, key: "tasks.md", content: TASKS, version: 1 },
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
    };

    beforeAll(async () => {
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      sqlite = createMigratedSqlite("1483-issue-attribution");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1", username: "u-1", displayName: "u-1", email: "u-1@example.test" },
      });
      for (const ws of [WS_A, WS_B]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await seedProject(PA, WS_A);
      await seedProject(PB, WS_B);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.VAULT_MASTER_KEY;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      process.env.GITHUB_WEBHOOK_SECRET = DEPLOYMENT_SECRET;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      await db.specKitTaskExport.deleteMany({});
      await db.webhookPayloadDigest.deleteMany({});
      await db.driftEvent.deleteMany({});
      await db.publishedIssue.deleteMany({});
      await db.issueDraft.deleteMany({});
      await db.specKitFeatureArtifact.updateMany({ data: { content: TASKS } });
      await db.project.updateMany({ data: { deletedAt: null } });
      await db.repoConnection.deleteMany({ where: { label: "tracker" } });
      await db.repoConnection.updateMany({
        data: { webhookSecretNonce: null, webhookSecretCheck: null, deletedAt: null },
      });
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    describe("a connector's own issues receiver", () => {
      it("syncs tasks.md and records drift for the signing project only", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        // B exported and published to the same issue number EARLIER: the
        // first row any unscoped lookup finds.
        await exportTask(PB, 7, T1);
        await exportTask(PA, 7, T2);
        await draftFor(PB, "node-7");
        await draftFor(PA, "node-7");
        await publish(PB, "node-7", 7, T1);
        await publish(PA, "node-7", 7, T2);

        const closed = await deliver(secretA, issuesBody(7), issuesUrl(`repo-${PA}`));
        expect(closed.status).toBe(200);
        expect(closed.body).toMatchObject({ ok: true, handled: true, change: "checkbox" });
        expect(await checked(PA)).toBe(true);
        expect(await checked(PB)).toBe(false);
        expect(closed.body.drift).toMatchObject({ handled: true });
        expect(await driftFor(PA)).toBe(1);
        expect(await driftFor(PB)).toBe(0);
      });

      it("takes an issue in any repository: the hook is on the publish target, not the connected repo", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        await exportTask(PA, 8, T1);
        const res = await deliver(secretA, issuesBody(8), issuesUrl(`repo-${PA}`));
        expect(res.body).toMatchObject({ handled: true });
        expect(await checked(PA)).toBe(true);
      });

      it("refuses another project's secret, the deployment secret, and a connector without its own", async () => {
        await ownSecret(`repo-${PA}`, "nonce-a");
        const secretB = await ownSecret(`repo-${PB}`, "nonce-b");
        await exportTask(PA, 9, T1);
        for (const secret of [secretB, DEPLOYMENT_SECRET]) {
          const res = await deliver(secret, issuesBody(9), issuesUrl(`repo-${PA}`));
          expect(res.status).toBe(401);
        }
        await db.repoConnection.update({
          where: { id: `repo-${PA}` },
          data: { webhookSecretNonce: null, webhookSecretCheck: null },
        });
        const none = await deliver(
          secretOf(`repo-${PA}`, "nonce-a"),
          issuesBody(9),
          issuesUrl(`repo-${PA}`),
        );
        expect(none.status).toBe(401);
        expect(await checked(PA)).toBe(false);
      });

      it("refuses a connector in a soft-deleted project", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        await exportTask(PA, 10, T1);
        await db.project.update({ where: { id: PA }, data: { deletedAt: new Date() } });
        const res = await deliver(secretA, issuesBody(10), issuesUrl(`repo-${PA}`));
        expect(res.status).toBe(401);
        expect(await checked(PA)).toBe(false);
      });

      it("repointing the connector drops the secret, so its issues URL stops verifying", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        await exportTask(PA, 11, T1);
        try {
          await updateRepoConnector(PA, `repo-${PA}`, { repoName: "moved-1483" }, "u-1");
          const res = await deliver(secretA, issuesBody(11), issuesUrl(`repo-${PA}`));
          expect(res.status).toBe(401);
          expect(await checked(PA)).toBe(false);
        } finally {
          await db.repoConnection.update({
            where: { id: `repo-${PA}` },
            data: { repoName: `code-${PA}`, status: "connected" },
          });
        }
      });
    });

    describe("the shared receiver (deployment secret)", () => {
      it("never acts on a project that took its own secret: the shared secret cannot forge into it", async () => {
        await ownSecret(`repo-${PB}`, "nonce-b");
        await exportTask(PB, 20, T1);
        await draftFor(PB, "node-20");
        await publish(PB, "node-20", 20, T1);
        const res = await deliver(DEPLOYMENT_SECRET, issuesBody(20, { nodeId: "node-20" }));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ handled: false, reason: "NO_TASK_EXPORT" });
        expect(await checked(PB)).toBe(false);
        expect(await driftFor(PB)).toBe(0);
      });

      it("picks the earliest export in a live project, whatever order the rows were written in", async () => {
        // A's row is written first but exported LATER than B's.
        await exportTask(PA, 21, T2);
        await exportTask(PB, 21, T1);
        const res = await deliver(DEPLOYMENT_SECRET, issuesBody(21));
        expect(res.body).toMatchObject({ handled: true });
        expect(await checked(PB)).toBe(true);
        expect(await checked(PA)).toBe(false);
      });

      it("never writes a soft-deleted project's tasks.md", async () => {
        await exportTask(PB, 22, T1);
        await db.project.update({ where: { id: PB }, data: { deletedAt: new Date() } });
        const res = await deliver(DEPLOYMENT_SECRET, issuesBody(22));
        expect(res.body).toMatchObject({ handled: false, reason: "NO_TASK_EXPORT" });
        expect(await checked(PB)).toBe(false);
      });

      it("skips a soft-deleted project's export for the live one behind it", async () => {
        await exportTask(PB, 23, T1);
        await exportTask(PA, 23, T2);
        await db.project.update({ where: { id: PB }, data: { deletedAt: new Date() } });
        await deliver(DEPLOYMENT_SECRET, issuesBody(23));
        expect(await checked(PA)).toBe(true);
        expect(await checked(PB)).toBe(false);
      });

      it("drift goes to the project that published the issue first, never a deleted one", async () => {
        await draftFor(PA, "node-24");
        await draftFor(PB, "node-24");
        await publish(PA, "node-24", 24, T1);
        await publish(PB, "node-24", 24, T2); // newer
        const edit = () =>
          deliver(
            DEPLOYMENT_SECRET,
            issuesBody(24, {
              action: "edited",
              nodeId: "node-24",
              title: "Renamed on GitHub",
              extra: { changes: { title: { from: "Draft title" } } },
            }),
          );
        expect((await edit()).body.drift).toMatchObject({ handled: true });
        expect(await driftFor(PA)).toBe(1);
        expect(await driftFor(PB)).toBe(0);

        await db.project.update({ where: { id: PA }, data: { deletedAt: new Date() } });
        expect((await edit()).body.drift).toMatchObject({ handled: true });
        expect(await driftFor(PB)).toBe(1);
        expect(await driftFor(PA)).toBe(1);

        await db.project.update({ where: { id: PB }, data: { deletedAt: new Date() } });
        expect((await edit()).body.drift).toMatchObject({
          handled: false,
          reason: "NO_PUBLISHED_ISSUE",
        });
      });

      it("the export's project gets the event even when another project connects the tracker", async () => {
        // A connects the tracker (first connected, then only pending): neither
        // pins B's issue to A nor blocks it. The row names the project.
        await db.repoConnection.create({
          data: {
            id: "tracker-a-1483",
            projectId: PA,
            label: "tracker",
            ownerOrOrg: TRACKER_OWNER,
            repoName: "tracker",
            status: "connected",
            provider: "github",
            createdAt: T1,
          },
        });
        await exportTask(PB, 25, T1);
        const res = await deliver(DEPLOYMENT_SECRET, issuesBody(25));
        expect(res.body).toMatchObject({ handled: true });
        expect(await checked(PB)).toBe(true);
        expect(await checked(PA)).toBe(false);

        await db.specKitFeatureArtifact.updateMany({ data: { content: TASKS } });
        await db.repoConnection.update({
          where: { id: "tracker-a-1483" },
          data: { status: "pending" },
        });
        const pending = await deliver(DEPLOYMENT_SECRET, issuesBody(25));
        expect(pending.body).toMatchObject({ handled: true });
        expect(await checked(PB)).toBe(true);
      });

      it("a single-project install is unchanged", async () => {
        await exportTask(PA, 27, T1);
        const res = await deliver(DEPLOYMENT_SECRET, issuesBody(27));
        expect(res.body).toMatchObject({ handled: true, change: "checkbox" });
        expect(await checked(PA)).toBe(true);
      });
    });

    describe("A3 — the event is the one the signed body is", () => {
      it("a captured issue_comment body re-sent as an `issues` event does nothing", async () => {
        await draftFor(PA, "node-30");
        await publish(PA, "node-30", 30, T1);
        const comment = issuesBody(30, {
          action: "edited",
          nodeId: "node-30",
          title: "Renamed on GitHub",
          extra: { comment: { id: 1, body: "x" }, changes: { body: { from: "y" } } },
        });
        const res = await deliver(DEPLOYMENT_SECRET, comment, SHARED, "issues");
        expect(res.status).toBe(200);
        // The effect first: on `main` the drift half took the header's word.
        expect(await driftFor(PA)).toBe(0);
        expect(res.body).toMatchObject({ handled: false, reason: "NOT_ISSUES_EVENT" });
        expect(res.body.drift).toEqual({ handled: false, reason: "NOT_ISSUES_EVENT" });
      });

      it("a pull-request body captured at /github/pr is neither acted on nor claimed at /github/issues", async () => {
        const pr = JSON.stringify({
          action: "opened",
          issue: undefined,
          pull_request: { number: 31, updated_at: new Date().toISOString() },
          repository: { full_name: TRACKER },
          nonce: ++seq,
        });
        const res = await deliver(DEPLOYMENT_SECRET, pr, SHARED, "issues");
        expect(await db.webhookPayloadDigest.count({ where: { receiver: "github-issues" } })).toBe(
          0,
        );
        expect(res.body).toMatchObject({ handled: false, reason: "NOT_ISSUES_EVENT" });
      });

      it("an `issues` body sent to /github/pr is not claimed there, so the issues receiver still takes it once", async () => {
        await exportTask(PA, 32, T1);
        const body = issuesBody(32);
        const atPr = await deliver(
          DEPLOYMENT_SECRET,
          body,
          "/api/webhooks/github/pr",
          "pull_request",
        );
        expect(atPr.body).toMatchObject({ handled: false, reason: "NOT_PULL_REQUEST_EVENT" });
        expect(await db.webhookPayloadDigest.count({ where: { receiver: "github-pr" } })).toBe(0);

        const first = await deliver(DEPLOYMENT_SECRET, body);
        expect(first.body).toMatchObject({ handled: true });
        const again = await deliver(DEPLOYMENT_SECRET, body);
        expect(again.body).toMatchObject({ handled: false, reason: "DUPLICATE_PAYLOAD" });
      });

      it("a connector-signed body is claimed per connector receiver", async () => {
        const secretA = await ownSecret(`repo-${PA}`, "nonce-a");
        await exportTask(PA, 33, T1);
        const body = issuesBody(33);
        await deliver(secretA, body, issuesUrl(`repo-${PA}`));
        const again = await deliver(secretA, body, issuesUrl(`repo-${PA}`));
        expect(again.body).toMatchObject({ handled: false, reason: "DUPLICATE_PAYLOAD" });
        expect(
          await db.webhookPayloadDigest.count({
            where: { receiver: `github-issues:c:repo-${PA}`, eventType: "issues" },
          }),
        ).toBe(1);
      });
    });
  },
);
