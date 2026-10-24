/**
 * #1471 — automatic PR review runs on a deployment: `createServer()`'s DEFAULT
 * worker wiring (no `prReviewProcessorDeps`) resolves a judge from the
 * project's model provider and a GitHub client from its repository connector
 * credential, per job.
 *
 * End to end over a REAL SQLite database built from the migration chain and
 * the real `VaultService`: a signed `pull_request` delivery to the server's own
 * `/api/webhooks/github/pr` → the worker singleton `createServer()` started →
 * the real `AnthropicProvider` (the project's configured provider) talking to a
 * loopback HTTP server, so no model is billed → a stubbed GitHub API behind the
 * real `acquirePublishOctokit` (its factory is replaced; the target validation
 * and connector lookup are real) → the `PrReviewState` row, the posted review
 * and the `TokenUsage` spend row, all read back from the database.
 */
import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
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

const { createServer } = await import("../src/server.js");
const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../src/lib/publishing/octokit-factory.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const SECRET = "webhook-secret-1471";
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const GH_TOKEN = "ghp_test_token_1471_never_logged";
const USER = "u-1471";
const P = "project-1471";
const OWNER = "acme-1471";
const NOCRED = "project-1471-nocred";
const NOCRED_OWNER = "nocred-1471";
const MODEL = "claude-sonnet-4-6";

const JUDGE_REPLY = JSON.stringify({
  verdicts: [
    { acId: "AC-1", verdict: "satisfied", reasoning: "It works", evidenceFiles: ["a.ts"] },
  ],
  comments: [],
  overallVerdict: "approve",
  summary: "Looks good",
});
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n+x\n";

type Body = Record<string, unknown>;
function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => resolve(raw ? (JSON.parse(raw) as Body) : {}));
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1471 — createServer()'s default wiring reviews a pull request",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let server: ReturnType<typeof createServer>;
    let modelServer: http.Server;
    const modelCalls: Body[] = [];
    /** Every request the stubbed GitHub API received, with the token it carried. */
    const github: Array<{ method: string; url: string; accept?: string; token: string }> = [];
    let prHeadSha = "sha-current-1471";
    const savedEnv: Record<string, string | undefined> = {};
    const ENV = [
      "AI_OFFLINE",
      "AI_PROVIDER",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "GITHUB_WEBHOOK_SECRET",
      "VAULT_MASTER_KEY",
      "AI_RETRY_BASE_DELAY_MS",
      "ANTHROPIC_BASE_URL_BILLS_AS",
    ];

    let delivery = 0;
    const deliver = async (owner: string, prNumber: number, body: string) => {
      const payload = JSON.stringify({
        action: "opened",
        pull_request: {
          number: prNumber,
          title: `PR #${prNumber}`,
          body,
          head: { sha: `sha-webhook-${prNumber}`, ref: "feature" },
          html_url: `https://github.com/${owner}/app/pull/${prNumber}`,
        },
        repository: { full_name: `${owner}/app`, html_url: `https://github.com/${owner}/app` },
      });
      const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
      const res = await request(server.http)
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", sig)
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", `delivery-1471-${++delivery}`)
        .send(payload);
      expect(res.status, res.text).toBe(200);
      await server.prReviewWorker.queue.drain();
    };

    const rowOf = (projectId: string, owner: string, prNumber: number) =>
      db.prReviewState.findUnique({
        where: {
          projectId_repoOwner_repoName_prNumber: {
            projectId,
            repoOwner: owner,
            repoName: "app",
            prNumber,
          },
        },
      });

    const seedProject = async (id: string, owner: string, secretId: string | null) => {
      await db.project.create({
        data: {
          id,
          name: id,
          slug: id,
          createdById: USER,
          status: "active",
          autoReviewPrs: true,
          aiProviderId: "anthropic",
          aiModel: MODEL,
        },
      });
      await db.repoConnection.create({
        data: {
          projectId: id,
          label: "main",
          provider: "github",
          ownerOrOrg: owner,
          repoName: "app",
          isPrimary: true,
          status: "connected",
          secretId,
        },
      });
      await db.analysis.create({ data: { id: `an-${id}`, projectId: id, startedById: USER } });
      await db.requirement.create({
        data: { id: `req-${id}`, projectId: id, analysisId: `an-${id}`, title: "R", body: "b" },
      });
      await db.issueDraft.create({
        data: {
          id: `draft-${id}`,
          projectId: id,
          requirementId: `req-${id}`,
          title: "Draft",
          body: "## Acceptance criteria\n- [ ] It works",
          status: "published",
        },
      });
      await db.publishBatch.create({
        data: {
          id: `batch-${id}`,
          projectId: id,
          targetOwner: owner,
          targetRepo: "app",
          startedById: USER,
          status: "completed",
        },
      });
      await db.publishedIssue.create({
        data: {
          batchId: `batch-${id}`,
          draftId: `draft-${id}`,
          issueNumber: 5,
          issueId: `node-${id}`,
          htmlUrl: `https://github.com/${owner}/app/issues/5`,
          destination: "github",
        },
      });
    };

    beforeAll(async () => {
      for (const k of ENV) savedEnv[k] = process.env[k];
      sqlite = createMigratedSqlite("1471-pr-review-wiring");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      modelServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        void readBody(req).then((body) => {
          modelCalls.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_1471",
              type: "message",
              role: "assistant",
              model: MODEL,
              content: [{ type: "text", text: JUDGE_REPLY }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 2000, output_tokens: 300 },
            }),
          );
        });
      });
      await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", () => r()));

      delete process.env.AI_OFFLINE;
      process.env.AI_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "k-anthropic-1471";
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;
      process.env.AI_RETRY_BASE_DELAY_MS = "1";
      // The loopback stands in for Anthropic itself, so its calls are priced.
      process.env.ANTHROPIC_BASE_URL_BILLS_AS = "anthropic";
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();

      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      const secret = await vault.create("github-acme-1471", GH_TOKEN, "global", {
        createdById: USER,
      });
      await seedProject(P, OWNER, secret.id);
      await seedProject(NOCRED, NOCRED_OWNER, null);

      __resetPublishOctokitCache();
      __setPublishOctokitFactory(async (args) => ({
        request: async (a: { method: string; url: string; headers?: Record<string, string> }) => {
          github.push({
            method: a.method,
            url: a.url,
            ...(a.headers?.accept ? { accept: a.headers.accept } : {}),
            token: args.token,
          });
          if (a.method === "POST" && /\/pulls\/\d+\/reviews$/.test(a.url)) {
            const n = Number(/pulls\/(\d+)/.exec(a.url)![1]);
            return {
              status: 200,
              headers: {},
              data: {
                id: 7000 + n,
                html_url: `https://github.com/${OWNER}/app/pull/${n}#pullrequestreview-${7000 + n}`,
              },
            } as never;
          }
          if (a.method === "GET" && a.headers?.accept === "application/vnd.github.diff") {
            return { status: 200, headers: {}, data: DIFF } as never;
          }
          if (a.method === "GET" && /\/pulls\/\d+$/.test(a.url)) {
            const n = Number(/pulls\/(\d+)$/.exec(a.url)![1]);
            return {
              status: 200,
              headers: {},
              data: {
                number: n,
                title: `PR #${n} (from GitHub)`,
                body: "Closes #5",
                html_url: `https://github.com/${OWNER}/app/pull/${n}`,
                head: { sha: prHeadSha, ref: "feature" },
              },
            } as never;
          }
          throw Object.assign(new Error("unexpected GitHub call"), { status: 500 });
        },
      }));

      // The default wiring under test: no `prReviewProcessorDeps`.
      server = createServer({ skipMCPBootstrap: true });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await server?.prReviewWorker.shutdown();
      await server?.io.close();
      __setPublishOctokitFactory(null);
      __resetVaultSingleton();
      modelServer?.closeAllConnections();
      await new Promise<void>((r) => (modelServer ? modelServer.close(() => r()) : r()));
      for (const k of ENV) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      modelCalls.length = 0;
      github.length = 0;
    });

    it("a delivery is reviewed with the project's model and posted with its connector's token", async () => {
      await deliver(OWNER, 31, "Closes #5");

      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0].model).toBe(MODEL);
      const posts = github.filter((g) => g.method === "POST");
      expect(posts).toEqual([
        { method: "POST", url: `/repos/${OWNER}/app/pulls/31/reviews`, token: GH_TOKEN },
      ]);
      expect(github.every((g) => g.token === GH_TOKEN)).toBe(true);

      const row = await rowOf(P, OWNER, 31);
      expect(row).toMatchObject({
        lastStatus: "reviewed",
        lastVerdict: "approve",
        lastSkipReason: null,
        lastReviewedSha: "sha-webhook-31",
        lastReviewUrl: `https://github.com/${OWNER}/app/pull/31#pullrequestreview-7031`,
      });

      // The spend went through the budget path: a priced `pr-review-*` row.
      const spend = await db.tokenUsage.findMany({
        where: { projectId: P, sessionId: { startsWith: "pr-review-" } },
      });
      expect(spend).toHaveLength(1);
      expect(spend[0]).toMatchObject({
        provider: "anthropic",
        model: MODEL,
        inputTokens: 2000,
        outputTokens: 300,
        agentStep: "pr-review",
      });
      expect(Number(spend[0].costUsd)).toBeGreaterThan(0);
    });

    it("a manual Re-run reads the PR from GitHub and records the head it reviewed", async () => {
      prHeadSha = "sha-after-push-1471";
      const admin = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: getPermissionsForRole("admin"),
      }).accessToken;
      const res = await request(server.http)
        .post(`/api/projects/${P}/pr-reviews/31/re-review`)
        .set("Authorization", `Bearer ${admin}`)
        .send({ owner: OWNER, repo: "app" });
      expect(res.status, res.text).toBe(202);
      await server.prReviewWorker.queue.drain();

      expect(github[0]).toEqual({
        method: "GET",
        url: `/repos/${OWNER}/app/pulls/31`,
        token: GH_TOKEN,
      });
      expect(modelCalls).toHaveLength(1);
      // The description read from GitHub links the issue: not a false `no_linked_issue`.
      expect(JSON.stringify(modelCalls[0])).toContain("PR #31 (from GitHub)");
      expect(await rowOf(P, OWNER, 31)).toMatchObject({
        lastStatus: "reviewed",
        lastSkipReason: null,
        lastReviewedSha: "sha-after-push-1471",
      });
    });

    it("past the monthly limit nothing is sent to the model or GitHub, and the row says why", async () => {
      await db.project.update({ where: { id: P }, data: { prReviewMonthlyBudgetCents: 100 } });
      await db.tokenUsage.create({
        data: {
          projectId: P,
          sessionId: "pr-review-1471-earlier",
          provider: "anthropic",
          model: MODEL,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          costCents: 150,
          costUsd: 1.5,
          agentStep: "pr-review",
        },
      });
      try {
        await deliver(OWNER, 32, "Closes #5");
        expect(modelCalls).toHaveLength(0);
        expect(github.filter((g) => g.method === "POST")).toHaveLength(0);
        expect(await rowOf(P, OWNER, 32)).toMatchObject({
          lastStatus: "skipped",
          lastSkipReason: "budget_exceeded",
        });
      } finally {
        await db.project.update({ where: { id: P }, data: { prReviewMonthlyBudgetCents: null } });
      }
    });

    it("a project whose connector has no credential stays review_not_configured, with no model call", async () => {
      await deliver(NOCRED_OWNER, 41, "Closes #5");
      expect(modelCalls).toHaveLength(0);
      expect(github).toHaveLength(0);
      expect(await rowOf(NOCRED, NOCRED_OWNER, 41)).toMatchObject({
        lastStatus: "skipped",
        lastSkipReason: "review_not_configured",
        lastRunId: null,
      });
    });
  },
);
