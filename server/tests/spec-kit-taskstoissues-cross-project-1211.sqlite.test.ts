/**
 * #1211 — the Spec Kit tasks-to-issues export applies the cross-project rule
 * batch publish (#1171), finding publish and the draft pull request (#1180)
 * have: a LIVE export into a repository ANOTHER project has connected is
 * refused with `REPO_CROSS_PROJECT` until the caller confirms, the other
 * project is named only to a caller who may open it, and the dry run is not
 * refused — it carries a notice instead.
 *
 * Driven through the REAL Spec Kit router, REAL auth and the REAL export
 * service against a REAL SQLite database built by the migration chain. Only
 * GitHub is faked (the publish Octokit factory seam) and every call to it is
 * recorded: a refusal is proven by the absence of any GitHub write and of any
 * task-export row, a confirm by the issues it lets through.
 */
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

const { specKitRouter } = await import("../src/routes/spec-kit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../src/lib/publishing/octokit-factory.js");

const MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
const COORD_ID = "u1211-coord";
const P = "proj-1211-speckit";
/** In the caller's workspace — may be named. */
const VISIBLE = "p1211-visible";
const VISIBLE_NAME = "Flux sandbox 1211";
/** In a workspace the caller is not a member of — never named, never id'd. */
const HIDDEN = "p1211-hidden";
const HIDDEN_NAME = "Acquisition target 1211";
const SHARED_VISIBLE = { owner: "sandbox-org", repo: "shared-1211" };
const SHARED_HIDDEN = { owner: "secret-org", repo: "shared-1211" };
/** Connected to no other project. */
const OWN = { owner: "sandbox-org", repo: "own-1211" };
const SECRET_LABEL = "github-1211";
const REF = `\${vault:${SECRET_LABEL}}`;
const SLUG = "001-foo";
const TASKS = [
  "| ID | Title | SP | Deps | Notes |",
  "| --- | --- | --- | --- | --- |",
  "| T01 | Build A | 3 |  | files: src/a.ts |",
].join("\n");
const ROUTE = `/api/projects/${P}/spec-kit/commands/speckit.taskstoissues`;

interface Call {
  method: string;
  url: string;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1211 — the cross-project guard on the Spec Kit tasks-to-issues export (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let COORD = "";
    const calls: Call[] = [];
    let nextIssue = 100;
    const prevKey = process.env.VAULT_MASTER_KEY;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/spec-kit", specKitRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (body: Record<string, unknown>) =>
      request(app())
        .post(ROUTE)
        .set("Authorization", `Bearer ${COORD}`)
        .send({ featureSlug: SLUG, ...body });

    const writes = () => calls.filter((c) => c.method !== "GET");

    async function setTarget(t: { owner: string; repo: string }) {
      await db.project.update({
        where: { id: P },
        data: { publishGithubOwner: t.owner, publishGithubRepo: t.repo },
      });
    }

    /** The dry run's plan, which a live export must present. */
    async function plan(): Promise<{ tasksVersion: number; digest: string }> {
      const res = await post({ dryRun: true, secretRef: REF });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { tasksVersion: res.body.data.tasksVersion, digest: res.body.data.planDigest };
    }

    async function liveBody(extra: Record<string, unknown> = {}) {
      return { secretRef: REF, expectedPlan: await plan(), ...extra };
    }

    async function expectRefusal(res: request.Response, repo: string, names: string[]) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("REPO_CROSS_PROJECT");
      expect(res.body.error.details).toEqual({ repo, projects: names });
      // Nothing reached GitHub, and no task was claimed.
      expect(writes()).toEqual([]);
      expect(await db.specKitTaskExport.count()).toBe(0);
    }

    function expectNoHiddenLeak(res: request.Response) {
      const wire = JSON.stringify(res.body);
      expect(wire).not.toContain(HIDDEN);
      expect(wire).not.toContain(HIDDEN_NAME);
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1211-speckit-cross-project");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });

      await db.user.create({
        data: { id: COORD_ID, username: COORD_ID, displayName: COORD_ID, email: "c@x.test" },
      });
      await db.workspace.create({ data: { id: "ws-1211", name: "ws-1211", slug: "ws-1211" } });
      await db.workspace.create({
        data: { id: "ws-1211-other", name: "ws-1211-other", slug: "ws-1211-other" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1211", userId: COORD_ID, role: "member" },
      });
      for (const [id, name, workspaceId] of [
        [P, P, "ws-1211"],
        [VISIBLE, VISIBLE_NAME, "ws-1211"],
        [HIDDEN, HIDDEN_NAME, "ws-1211-other"],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: COORD_ID, workspaceId, specKitEnabled: true },
        });
      }
      await vault.create(SECRET_LABEL, "ghp_speckit_token_1211", "global", {
        createdById: COORD_ID,
      });
      // This project's analysed repository — never an export target.
      await db.repoConnection.create({
        data: {
          projectId: P,
          label: "upstream",
          ownerOrOrg: "miniflux",
          repoName: "v2",
          status: "connected",
        },
      });
      for (const [projectId, t] of [
        [VISIBLE, SHARED_VISIBLE],
        [HIDDEN, SHARED_HIDDEN],
      ] as const) {
        await db.repoConnection.create({
          data: {
            projectId,
            label: "shared",
            ownerOrOrg: t.owner,
            repoName: t.repo,
            status: "connected",
          },
        });
      }

      __setPublishOctokitFactory(async () => ({
        async request<T>(args: { method: string; url: string; data?: unknown }) {
          calls.push({ method: args.method, url: args.url });
          let data: unknown = {};
          if (args.method === "POST" && args.url.endsWith("/issues")) {
            nextIssue += 1;
            data = {
              id: 9_000 + nextIssue,
              number: nextIssue,
              html_url: `https://github.com${args.url.replace("/repos", "")}/${nextIssue}`,
            };
          } else if (args.method === "GET" && args.url.includes("/issues?")) {
            data = [];
          } else if (args.method === "GET" && args.url === "/user") {
            data = { login: "metis-bot" };
          }
          return { status: 201, headers: {}, data: data as T };
        },
      }));

      COORD = issueTokens({
        userId: COORD_ID,
        username: COORD_ID,
        role: "coordinator",
        permissions: [],
        workspaces: ["ws-1211"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      calls.length = 0;
      __resetPublishOctokitCache();
      await db.specKitTaskExport.deleteMany({});
      await db.specKitFeature.deleteMany({});
      const f = await db.specKitFeature.create({
        data: { projectId: P, slug: SLUG, title: "Foo" },
      });
      for (const [key, content] of [
        ["spec.md", "x"],
        ["plan.md", "x"],
        ["tasks.md", TASKS],
      ] as const) {
        await db.specKitFeatureArtifact.create({ data: { featureId: f.id, key, content } });
      }
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __setPublishOctokitFactory(null);
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
    });

    it("refuses a live export into a repo another project connects, naming a project the caller may open", async () => {
      await setTarget(SHARED_VISIBLE);
      const res = await post(await liveBody());
      await expectRefusal(res, "sandbox-org/shared-1211", [VISIBLE_NAME]);
      expect(res.body.error.message).toContain(`"${VISIBLE_NAME}"`);
    });

    it("never names (or ids) a conflicting project the caller cannot open", async () => {
      await setTarget(SHARED_HIDDEN);
      const res = await post(await liveBody());
      await expectRefusal(res, "secret-org/shared-1211", []);
      expect(res.body.error.message).toContain("another project");
      expectNoHiddenLeak(res);
    });

    it("refuses a case variant of a repo another project connects", async () => {
      await setTarget({ owner: "Sandbox-ORG", repo: "Shared-1211" });
      const res = await post(await liveBody());
      await expectRefusal(res, "Sandbox-ORG/Shared-1211", [VISIBLE_NAME]);
    });

    it("exports the tasks once the caller confirms", async () => {
      await setTarget(SHARED_VISIBLE);
      const res = await post(await liveBody({ confirmCrossProject: true }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(writes()).toEqual([{ method: "POST", url: "/repos/sandbox-org/shared-1211/issues" }]);
      expect(await db.specKitTaskExport.count()).toBe(1);
    });

    it("accepts only a boolean confirm — a string 'true' is not a confirmation", async () => {
      await setTarget(SHARED_VISIBLE);
      const res = await post(await liveBody({ confirmCrossProject: "true" }));
      expect(res.status).toBe(400);
      expect(writes()).toEqual([]);
    });

    it("a confirm of false is refused like no confirm", async () => {
      await setTarget(SHARED_VISIBLE);
      const res = await post(await liveBody({ confirmCrossProject: false }));
      await expectRefusal(res, "sandbox-org/shared-1211", [VISIBLE_NAME]);
    });

    it("the dry run is not refused, and says the live export will ask", async () => {
      await setTarget(SHARED_VISIBLE);
      const res = await post({ dryRun: true, secretRef: REF });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.crossProject).toEqual({
        repo: "sandbox-org/shared-1211",
        projects: [VISIBLE_NAME],
      });
      expect(calls).toEqual([]);
    });

    it("the dry run's notice names no project the caller cannot open", async () => {
      await setTarget(SHARED_HIDDEN);
      const res = await post({ dryRun: true, secretRef: REF });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.crossProject).toEqual({
        repo: "secret-org/shared-1211",
        projects: [],
      });
      expectNoHiddenLeak(res);
    });

    it("a target no other project connects needs no confirm, and its dry run carries no notice", async () => {
      await setTarget(OWN);
      const body = await liveBody();
      calls.length = 0;
      const res = await post(body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(writes()).toEqual([{ method: "POST", url: "/repos/sandbox-org/own-1211/issues" }]);
      const dry = await post({ dryRun: true, secretRef: REF });
      expect(dry.body.data.crossProject).toBeUndefined();
    });
  },
);
