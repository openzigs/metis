/**
 * #1488 — shared-secret pull request routing goes only to a connector whose
 * token GitHub says can write to the repository, and a Test that hits a rate
 * limit or a 5xx never hands an incumbent's deliveries to someone else.
 *
 * Two workspaces connect the SAME public repository. Driven against a REAL
 * SQLite database built by the migration chain, through the real `apiRouter()`
 * (the connector Test endpoint, with its project-scope chokepoint) and the real
 * webhook router. The fake GitHub behaves as GitHub does for a public
 * repository: `repos.get` succeeds with no token and then reports no
 * `permissions`; with a token it reports that token's permissions. Credentials
 * are real vault secrets. Nothing reaches GitHub and nothing is reviewed.
 *
 * On `main` before this change:
 *   - a tokenless connector in another workspace, Tested before the owner's,
 *     became the earliest `connected` connector and took every delivery;
 *   - a rate-limited Test wrote `error` on the incumbent, handing its
 *     deliveries to the next connected connector.
 */
import crypto from "node:crypto";
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
// No DNS: the allow-list is exercised elsewhere; here it admits the API host.
vi.mock("../src/lib/connectors/network-allowlist.js", async (original) => ({
  ...(await original<typeof import("../src/lib/connectors/network-allowlist.js")>()),
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async (hostname: string) => ({
    address: "192.0.2.1",
    family: 4,
    hostname,
  })),
}));

const { githubPrWebhookRouter } = await import("../src/routes/webhooks-github.js");
const { apiRouter } = await import("../src/routes/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { __setOctokitFactory } = await import("../src/lib/connectors/repo/repo-service.js");

const DEPLOYMENT_SECRET = "deployment-secret-1488";
const MASTER_KEY = Buffer.alloc(32, 14).toString("base64");
const WS_OWNER = "ws-owner-1488";
const WS_OTHER = "ws-other-1488";
/** The repository's owner, who registered the shared-secret webhook. */
const OWNER_P = "project-owner-1488";
/** Another workspace connecting the same public repository. */
const OTHER_P = "project-other-1488";
const ORG = "acme-1488";
const REPO = `${ORG}/public-app`;
const OWNER_TOKEN = "ghp_owner_admin_token_1488";
const READER_TOKEN = "ghp_other_read_token_1488";
const T_EARLY = new Date("2026-01-01T00:00:00.000Z");
const T_LATE = new Date("2026-02-01T00:00:00.000Z");

/** What GitHub reports for each token on the public repository. */
const PERMISSIONS: Record<string, Record<string, boolean>> = {
  [OWNER_TOKEN]: { admin: true, maintain: true, push: true, triage: true, pull: true },
  [READER_TOKEN]: { admin: false, maintain: false, push: false, triage: false, pull: true },
};

/** How the fake GitHub answers the next `repos.get`: normally, or with a failure. */
let failure: null | (() => Error) = null;
/** Runs inside the next `repos.get`, before it answers: a PATCH racing a Test. */
let duringGet: null | (() => Promise<void>) = null;
const rateLimited = () =>
  Object.assign(new Error("API rate limit exceeded for 192.0.2.10."), {
    status: 403,
    response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "60" } },
  });
const serverError = () => Object.assign(new Error("Server Error"), { status: 502 });
const badCredentials = () => Object.assign(new Error("Bad credentials"), { status: 401 });

function fakeGithub(args: { token?: string }) {
  return {
    rest: {
      repos: {
        get: async () => {
          if (duringGet) {
            const hook = duringGet;
            duringGet = null;
            await hook();
          }
          if (failure) throw failure();
          const permissions = args.token ? PERMISSIONS[args.token] : undefined;
          return {
            data: {
              id: 1488,
              name: "public-app",
              full_name: REPO,
              default_branch: "main",
              private: false,
              archived: false,
              size: 10,
              language: "TypeScript",
              ...(permissions ? { permissions } : {}),
            },
          };
        },
        // The rest of a metadata sync's reads: an empty repository.
        listLanguages: async () => ({ data: {} }),
        listCommits: async () => ({ data: [{ sha: "a".repeat(40) }] }),
        getContent: async () => ({ data: [] }),
        getReadme: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      },
      git: { getRef: async () => ({ data: {} }) },
    },
  } as never;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1488 — shared-secret deliveries need a token that can write to the repository",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let api: express.Express;
    let ownerSecretId: string;
    let readerSecretId: string;
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
    const asOwner = () => bearer("u-owner", "coordinator", [WS_OWNER]);
    const asOther = () => bearer("u-other", "coordinator", [WS_OTHER]);

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
      const payload = JSON.stringify({
        action: "opened",
        pull_request: {
          number: prNumber,
          title: `PR #${prNumber}`,
          body: "",
          head: { sha: `sha-${prNumber}`, ref: "feature" },
          html_url: `https://github.com/${REPO}/pull/${prNumber}`,
        },
        repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
      });
      return request(webhookApp())
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", "pull_request")
        .set(
          "X-Hub-Signature-256",
          "sha256=" + crypto.createHmac("sha256", DEPLOYMENT_SECRET).update(payload).digest("hex"),
        )
        .send(payload);
    };
    const deliveredTo = async (prNumber: number) => {
      enqueued.length = 0;
      const res = await deliver(prNumber);
      expect(res.status).toBe(200);
      return enqueued.map((j) => j.projectId);
    };

    /** Click Test on the connections page, as that project's member. */
    const clickTest = (projectId: string, auth: string) =>
      request(api)
        .post(`/api/projects/${projectId}/connectors/repos/repo-${projectId}/test`)
        .set("Authorization", auth);
    const card = async (projectId: string, auth: string) => {
      const res = await request(api)
        .get(`/api/projects/${projectId}/connectors/repos/repo-${projectId}`)
        .set("Authorization", auth);
      expect(res.status).toBe(200);
      return res.body.data as { status: string; repoPermission: string | null };
    };

    /** A fresh, untested connector, bound to the repository at `boundAt`. */
    const connect = (projectId: string, boundAt: Date, secretId: string | null) =>
      db.repoConnection.upsert({
        where: { id: `repo-${projectId}` },
        create: {
          id: `repo-${projectId}`,
          projectId,
          label: "app",
          ownerOrOrg: ORG,
          repoName: "public-app",
          isPrimary: true,
          secretId,
          createdAt: boundAt,
          repoBoundAt: boundAt,
        },
        update: {
          secretId,
          status: "pending",
          repoPermission: null,
          errorMessage: null,
          createdAt: boundAt,
          repoBoundAt: boundAt,
        },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1488-webhook-permission");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      for (const id of ["u-owner", "u-other"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const [ws, user] of [
        [WS_OWNER, "u-owner"],
        [WS_OTHER, "u-other"],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: user, role: "member" },
        });
      }
      for (const [id, ws, user] of [
        [OWNER_P, WS_OWNER, "u-owner"],
        [OTHER_P, WS_OTHER, "u-other"],
      ] as const) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: user,
            workspaceId: ws,
            status: "active",
            autoReviewPrs: true,
          },
        });
      }
      ownerSecretId = (
        await vault.create("owner-pat-1488", OWNER_TOKEN, "global", { createdById: "u-owner" })
      ).id;
      readerSecretId = (
        await vault.create("reader-pat-1488", READER_TOKEN, "global", { createdById: "u-other" })
      ).id;
      __setOctokitFactory(fakeGithub);

      api = express();
      api.use(express.json());
      api.use("/api", apiRouter());
      api.use(notFoundHandler);
      api.use(errorHandler);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __setOctokitFactory(null);
      __resetVaultSingleton();
      delete process.env.VAULT_MASTER_KEY;
      delete process.env.GITHUB_WEBHOOK_SECRET;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.repoConnection.deleteMany({
        where: { id: { in: [`repo-${OWNER_P}`, `repo-${OTHER_P}`] } },
      });
      process.env.GITHUB_WEBHOOK_SECRET = DEPLOYMENT_SECRET;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      failure = null;
      duringGet = null;
      enqueued.length = 0;
    });

    // Each test asserts the routing outcome BEFORE the recorded permission, so on
    // main (which records none) the failure is the delivery, not a missing field.
    describe("a squatter in another workspace", () => {
      it("a tokenless connector Tested before the owner's takes no delivery", async () => {
        // The squatter connects the public repository before its owner onboards.
        await connect(OTHER_P, T_EARLY, null);
        const squat = await clickTest(OTHER_P, asOther());
        expect(squat.status).toBe(200);
        expect(squat.body.data.ok).toBe(true);
        // Before the owner connects, nobody takes the delivery: on main, the squatter did.
        expect(await deliveredTo(1)).toEqual([]);

        await connect(OWNER_P, T_LATE, ownerSecretId);
        expect((await clickTest(OWNER_P, asOwner())).body.data.ok).toBe(true);
        // The owner, though bound later, gets it: on main the earlier squatter did.
        expect(await deliveredTo(2)).toEqual([OWNER_P]);

        expect(await card(OTHER_P, asOther())).toMatchObject({
          status: "connected",
          repoPermission: "none",
        });
        expect(await card(OWNER_P, asOwner())).toMatchObject({
          status: "connected",
          repoPermission: "admin",
        });
      });

      it("a squatter whose token can only read the repository takes no delivery either", async () => {
        await connect(OTHER_P, T_EARLY, readerSecretId);
        await connect(OWNER_P, T_LATE, ownerSecretId);
        await clickTest(OTHER_P, asOther());
        await clickTest(OWNER_P, asOwner());
        expect(await deliveredTo(3)).toEqual([OWNER_P]);
        expect((await card(OTHER_P, asOther())).repoPermission).toBe("read");
      });

      it("a connector tested before #1488 takes nothing until it is tested again", async () => {
        // As the migration leaves an existing row: connected, permission not recorded.
        for (const [p, at, secret] of [
          [OWNER_P, T_EARLY, ownerSecretId],
          [OTHER_P, T_LATE, null],
        ] as const) {
          await connect(p, at, secret);
          await db.repoConnection.update({
            where: { id: `repo-${p}` },
            data: { status: "connected", repoPermission: null },
          });
        }
        expect(await deliveredTo(4)).toEqual([]);
        await clickTest(OWNER_P, asOwner());
        expect(await deliveredTo(5)).toEqual([OWNER_P]);
      });
    });

    describe("a Test racing a PATCH (review of #1494)", () => {
      it("an admin read of the attacker's own repository never lands on a row repointed at the victim's", async () => {
        // The attacker's connector names their OWN repository, with an admin token.
        await connect(OTHER_P, T_EARLY, ownerSecretId);
        await db.repoConnection.update({
          where: { id: `repo-${OTHER_P}` },
          data: { ownerOrOrg: "attacker-1488", repoName: "own" },
        });
        // While Test waits on GitHub, the connector is repointed at the victim's
        // public repository and its token removed.
        duringGet = async () => {
          const patch = await request(api)
            .patch(`/api/projects/${OTHER_P}/connectors/repos/repo-${OTHER_P}`)
            .set("Authorization", asOther())
            .send({ ownerOrOrg: ORG, repoName: "public-app", secretRef: "" });
          expect(patch.status, patch.text).toBe(200);
        };
        const res = await clickTest(OTHER_P, asOther());
        expect(duringGet).toBeNull(); // the PATCH ran inside the Test
        // Before the fix, Test wrote `connected` + `admin` onto the repointed row,
        // and the next shared-secret delivery for the victim's repository went to it.
        expect(await deliveredTo(30)).toEqual([]);
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${OTHER_P}` } });
        expect(row).toMatchObject({
          ownerOrOrg: ORG,
          repoName: "public-app",
          secretId: null,
          status: "pending",
          repoPermission: null,
        });
        expect(res.body.data).toMatchObject({ ok: false, code: "REPO_CONNECTOR_CHANGED" });
      });

      it("a failing Test never marks a connector that was changed under it", async () => {
        await connect(OWNER_P, T_EARLY, ownerSecretId);
        await clickTest(OWNER_P, asOwner());
        duringGet = async () => {
          await db.repoConnection.update({
            where: { id: `repo-${OWNER_P}` },
            data: { secretId: readerSecretId },
          });
        };
        failure = badCredentials;
        await clickTest(OWNER_P, asOwner());
        failure = null;
        // The 401 was for the old token; the row now holds another one.
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${OWNER_P}` } });
        expect(row?.status).toBe("connected");
      });
    });

    describe("a sync after an error (review of #1494)", () => {
      it("an errored connector made connected again by a metadata sync carries the permission that sync read", async () => {
        await connect(OTHER_P, T_EARLY, readerSecretId);
        await connect(OWNER_P, T_LATE, ownerSecretId);
        // Plant the stale state the review describes: once admin, then errored.
        await db.repoConnection.update({
          where: { id: `repo-${OTHER_P}` },
          data: { status: "error", repoPermission: "admin" },
        });
        await clickTest(OWNER_P, asOwner());
        const sync = await request(api)
          .post(`/api/projects/${OTHER_P}/connectors/repos/repo-${OTHER_P}/metadata`)
          .set("Authorization", asOther());
        expect(sync.status, sync.text).toBeLessThan(500);
        const row = await db.repoConnection.findUnique({ where: { id: `repo-${OTHER_P}` } });
        expect(row).toMatchObject({ status: "connected", repoPermission: "read" });
        expect(await deliveredTo(31)).toEqual([OWNER_P]);
      });

      it("a Test that marks a connector error forgets its permission", async () => {
        await connect(OWNER_P, T_EARLY, ownerSecretId);
        await clickTest(OWNER_P, asOwner());
        failure = badCredentials;
        await clickTest(OWNER_P, asOwner());
        failure = null;
        expect(await card(OWNER_P, asOwner())).toMatchObject({
          status: "error",
          repoPermission: null,
        });
      });
    });

    describe("a rate-limited incumbent", () => {
      /** The incumbent, and a later rival that would take over if it dropped out. */
      const incumbentAndRival = async () => {
        await connect(OWNER_P, T_EARLY, ownerSecretId);
        // The rival is eligible too (an admin token), so only the incumbent's
        // status decides who gets the delivery.
        await connect(OTHER_P, T_LATE, ownerSecretId);
        expect((await clickTest(OWNER_P, asOwner())).body.data.ok).toBe(true);
        expect((await clickTest(OTHER_P, asOther())).body.data.ok).toBe(true);
        expect(await deliveredTo(10)).toEqual([OWNER_P]);
      };

      it.each([
        ["an exhausted unauthenticated quota (403)", rateLimited],
        ["a GitHub 5xx", serverError],
      ])("%s during Test keeps its deliveries", async (_name, fail) => {
        await incumbentAndRival();
        failure = fail;
        const res = await clickTest(OWNER_P, asOwner());
        failure = null;
        expect(res.status).toBe(200);
        expect(res.body.data.ok).toBe(false);
        // On main the Test wrote `error` and the rival took this one.
        expect(await deliveredTo(11)).toEqual([OWNER_P]);
        expect((await card(OWNER_P, asOwner())).status).toBe("connected");
        expect(res.body.data.message).toMatch(/left unchanged/);
        expect((await card(OWNER_P, asOwner())).repoPermission).toBe("admin");
      });

      it("a 401 still marks it error, and the next eligible connector takes over", async () => {
        await incumbentAndRival();
        failure = badCredentials;
        await clickTest(OWNER_P, asOwner());
        failure = null;
        expect((await card(OWNER_P, asOwner())).status).toBe("error");
        expect(await deliveredTo(12)).toEqual([OTHER_P]);
      });
    });
  },
);
