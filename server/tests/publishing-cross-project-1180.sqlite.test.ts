/**
 * #1180 — finding publish and draft-PR creation apply the cross-project rule
 * batch publish has (#1171): a live write into a repository ANOTHER project
 * has connected is refused with `REPO_CROSS_PROJECT` until the caller
 * confirms, and the other project is named only to a caller who may open it.
 *
 * Both routes run through their REAL routers, REAL auth and REAL services
 * against a REAL SQLite database built by the migration chain. Only GitHub is
 * faked (the publish Octokit factory seam), and every fake call is recorded:
 * a refusal is proven by the absence of any GitHub call, and each confirm by
 * the write it lets through — so a missing guard turns the refusal cases red.
 */
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
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    /** Every Jira issue the fake Jira client was asked to create. */
    jiraIssues: [] as unknown[],
  };
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

// #1180 — the Jira edge: record each issue, and let the Jira host through.
vi.mock("../src/lib/connectors/jira/jira-client.js", () => ({
  createJiraClient: () => ({
    createIssue: async (fields: unknown) => {
      state.jiraIssues.push(fields);
      return { key: `IMP-${state.jiraIssues.length}` };
    },
  }),
}));
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertConnectorHostAllowed: async () => undefined };
});

const { publishingRouter } = await import("../src/routes/publishing.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../src/lib/publishing/octokit-factory.js");

const MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
const COORD_ID = "u1180-coord";
const P = "proj-1180-cross-project";
/** In the caller's workspace — may be named. */
const VISIBLE = "p1180-visible";
const VISIBLE_NAME = "Flux sandbox 1180";
/** In a workspace the caller is not a member of — never named, never id'd. */
const HIDDEN = "p1180-hidden";
const HIDDEN_NAME = "Acquisition target 1180";
/** Connected to VISIBLE. */
const SHARED_VISIBLE = { owner: "sandbox-org", repo: "shared-1180" };
/** Connected to HIDDEN. */
const SHARED_HIDDEN = { owner: "secret-org", repo: "shared-1180" };
/** #1180 — the same repositories, typed in another case: GitHub names are case-insensitive. */
const SHARED_VISIBLE_CASED = { owner: "Sandbox-ORG", repo: "Shared-1180" };
const SHARED_HIDDEN_CASED = { owner: "SECRET-org", repo: "SHARED-1180" };
/** Connected to no other project. */
const OWN = { owner: "sandbox-org", repo: "own-1180" };
const TOKEN = "ghp_publish_token_1180";
const SECRET_LABEL = "github-1180";

interface Call {
  method: string;
  url: string;
}

const DRAFT = {
  title: "Add audit logging to all mutations",
  problemStatement: "Mutations are not audited.",
  affected: { files: ["src/routes/users.ts"], requirementIds: ["REQ-1"] },
  acceptanceCriteria: ["Every mutation writes an AuditLog row"],
  suggestedLabels: ["security"],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1180 — the cross-project guard on finding publish and draft PRs (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let COORD = "";
    let secretId = "";
    const calls: Call[] = [];
    let seq = 0;
    const prevKey = process.env.VAULT_MASTER_KEY;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/publishing", publishingRouter());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (url: string, body: unknown) =>
      request(app())
        .post(url)
        .set("Authorization", `Bearer ${COORD}`)
        .send(body as object);

    const writes = () => calls.filter((c) => c.method !== "GET");

    async function setTarget(t: { owner: string; repo: string }) {
      await db.project.update({
        where: { id: P },
        data: { publishGithubOwner: t.owner, publishGithubRepo: t.repo },
      });
    }

    async function issueDraft() {
      seq += 1;
      return db.issueDraft.create({
        data: { projectId: P, title: `Draft 1180 ${seq}`, body: "Spec body.", status: "draft" },
      });
    }

    async function finding() {
      seq += 1;
      const analysis = await db.analysis.create({
        data: { projectId: P, status: "completed", startedById: COORD_ID },
      });
      const result = await db.agentResult.create({
        data: { analysisId: analysis.id, agentKey: "code", status: "completed" },
      });
      const f = await db.finding.create({
        data: {
          agentResultId: result.id,
          category: "security",
          severity: "high",
          title: `No audit logging ${seq}`,
          body: "User mutations are not recorded.",
        },
      });
      return {
        id: f.id,
        url: `/api/projects/${P}/analyses/${analysis.id}/findings/${f.id}/publish`,
      };
    }

    function expectRefusal(res: request.Response, repo: string, names: string[]) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("REPO_CROSS_PROJECT");
      expect(res.body.error.details).toEqual({ repo, projects: names });
      // Nothing was sent to GitHub: the refusal comes before any write.
      expect(writes()).toEqual([]);
    }

    function expectNoHiddenLeak(res: request.Response) {
      const wire = JSON.stringify(res.body);
      expect(wire).toContain("another project");
      expect(wire).not.toContain(HIDDEN);
      expect(wire).not.toContain(HIDDEN_NAME);
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1180-cross-project-routes");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });

      await db.user.create({
        data: { id: COORD_ID, username: COORD_ID, displayName: COORD_ID, email: "c@x.test" },
      });
      await db.workspace.create({ data: { id: "ws-1180", name: "ws-1180", slug: "ws-1180" } });
      await db.workspace.create({
        data: { id: "ws-1180-other", name: "ws-1180-other", slug: "ws-1180-other" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1180", userId: COORD_ID, role: "member" },
      });
      for (const [id, name, workspaceId] of [
        [P, P, "ws-1180"],
        [VISIBLE, VISIBLE_NAME, "ws-1180"],
        [HIDDEN, HIDDEN_NAME, "ws-1180-other"],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: COORD_ID, workspaceId },
        });
      }
      const secret = await vault.create(SECRET_LABEL, TOKEN, "global", {
        createdById: COORD_ID,
      });
      secretId = secret.id;
      // This project's analysed repository; its bound secret is the finding
      // publisher's credential.
      await db.repoConnection.create({
        data: {
          projectId: P,
          label: "upstream",
          ownerOrOrg: "miniflux",
          repoName: "v2",
          isPrimary: true,
          status: "connected",
          secretId: secret.id,
        },
      });
      await db.repoConnection.create({
        data: {
          projectId: VISIBLE,
          label: "shared",
          ownerOrOrg: SHARED_VISIBLE.owner,
          repoName: SHARED_VISIBLE.repo,
          status: "connected",
        },
      });
      await db.repoConnection.create({
        data: {
          projectId: HIDDEN,
          label: "shared",
          ownerOrOrg: SHARED_HIDDEN.owner,
          repoName: SHARED_HIDDEN.repo,
          status: "connected",
        },
      });

      __setPublishOctokitFactory(async () => ({
        async request<T>(args: { method: string; url: string; data?: unknown }) {
          calls.push({ method: args.method, url: args.url });
          const u = args.url;
          let data: unknown = {};
          if (args.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(u)) {
            data = { default_branch: "main" };
          } else if (u.includes("/git/ref/heads/")) {
            data = { object: { sha: "base-sha" } };
          } else if (u.includes("/contents/")) {
            if (args.method === "GET") throw Object.assign(new Error("Not Found"), { status: 404 });
            data = { content: { sha: "file-sha" } };
          } else if (u.endsWith("/pulls") && args.method === "POST") {
            data = { number: 7, html_url: `https://github.com${u.replace("/repos", "")}/7` };
          } else if (u.endsWith("/issues") && args.method === "POST") {
            data = { number: 9, html_url: `https://github.com${u.replace("/repos", "")}/9` };
          }
          return { status: 200, headers: {}, data: data as T };
        },
      }));

      COORD = issueTokens({
        userId: COORD_ID,
        username: COORD_ID,
        role: "coordinator",
        permissions: [],
        workspaces: ["ws-1180"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      calls.length = 0;
      __resetPublishOctokitCache();
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

    // ---- POST /drafts/:id/pull-request ---------------------------------------

    describe("POST /publishing/drafts/:id/pull-request", () => {
      const prUrl = (id: string) => `/api/projects/${P}/publishing/drafts/${id}/pull-request`;
      const live = { dryRun: false, secretRef: `\${vault:${SECRET_LABEL}}` };

      it("refuses a live PR into a repo another project connects, naming a project the caller may open", async () => {
        await setTarget(SHARED_VISIBLE);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), live);
        expectRefusal(res, "sandbox-org/shared-1180", [VISIBLE_NAME]);
        expect(res.body.error.message).toContain(`"${VISIBLE_NAME}"`);
        const row = await db.issueDraft.findUniqueOrThrow({ where: { id: d.id } });
        expect(row.metadata ?? "").not.toContain("pullRequest");
      });

      it("never names (or ids) a conflicting project the caller cannot open", async () => {
        await setTarget(SHARED_HIDDEN);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), live);
        expectRefusal(res, "secret-org/shared-1180", []);
        expectNoHiddenLeak(res);
      });

      it("refuses a case variant of a repo another project connects (GitHub names are case-insensitive)", async () => {
        await setTarget(SHARED_VISIBLE_CASED);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), live);
        expectRefusal(res, "Sandbox-ORG/Shared-1180", [VISIBLE_NAME]);
      });

      it("opens the PR once the caller confirms", async () => {
        await setTarget(SHARED_VISIBLE);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), { ...live, confirmCrossProject: true });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.data.pullRequest.number).toBe(7);
        expect(writes().some((c) => c.url === "/repos/sandbox-org/shared-1180/pulls")).toBe(true);
      });

      it("accepts only a boolean confirm — a string 'true' is not a confirmation", async () => {
        await setTarget(SHARED_VISIBLE);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), { ...live, confirmCrossProject: "true" });
        expect(res.status).toBe(400);
        expect(writes()).toEqual([]);
      });

      it("a confirm of false is refused like no confirm", async () => {
        await setTarget(SHARED_VISIBLE);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), { ...live, confirmCrossProject: false });
        expectRefusal(res, "sandbox-org/shared-1180", [VISIBLE_NAME]);
      });

      it("a dry run is not refused — it writes nothing", async () => {
        await setTarget(SHARED_VISIBLE);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), { dryRun: true });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data.dryRun).toBe(true);
        expect(calls).toEqual([]);
      });

      it("a target no other project connects needs no confirm", async () => {
        await setTarget(OWN);
        const d = await issueDraft();
        const res = await post(prUrl(d.id), live);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      });
    });

    // ---- POST /analyses/:id/findings/:findingId/publish ----------------------

    describe("POST /analyses/:id/findings/:findingId/publish", () => {
      beforeEach(async () => {
        await setTarget(OWN);
      });

      it("refuses an explicit target another project connects, naming a project the caller may open", async () => {
        const f = await finding();
        const res = await post(f.url, { draft: DRAFT, target: SHARED_VISIBLE });
        expectRefusal(res, "sandbox-org/shared-1180", [VISIBLE_NAME]);
        expect(await db.issueLink.count({ where: { findingId: f.id } })).toBe(0);
      });

      it("never names (or ids) a conflicting project the caller cannot open", async () => {
        const f = await finding();
        const res = await post(f.url, { draft: DRAFT, target: SHARED_HIDDEN });
        expectRefusal(res, "secret-org/shared-1180", []);
        expectNoHiddenLeak(res);
      });

      it("refuses a case variant of a repo another project connects, and names none it may not", async () => {
        const f = await finding();
        const visible = await post(f.url, { draft: DRAFT, target: SHARED_VISIBLE_CASED });
        expectRefusal(visible, "Sandbox-ORG/Shared-1180", [VISIBLE_NAME]);
        const hidden = await post(f.url, { draft: DRAFT, target: SHARED_HIDDEN_CASED });
        expectRefusal(hidden, "SECRET-org/SHARED-1180", []);
        expectNoHiddenLeak(hidden);
      });

      it("guards the saved target too, when the request names none", async () => {
        await setTarget(SHARED_VISIBLE);
        const f = await finding();
        const res = await post(f.url, { draft: DRAFT });
        expectRefusal(res, "sandbox-org/shared-1180", [VISIBLE_NAME]);
      });

      it("files the issue once the caller confirms", async () => {
        const f = await finding();
        const res = await post(f.url, {
          draft: DRAFT,
          target: SHARED_VISIBLE,
          confirmCrossProject: true,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data.links[0].url).toBe(
          "https://github.com/sandbox-org/shared-1180/issues/9",
        );
        expect(writes()).toEqual([
          { method: "POST", url: "/repos/sandbox-org/shared-1180/issues" },
        ]);
        expect(await db.issueLink.count({ where: { findingId: f.id } })).toBe(1);
      });

      it("accepts only a boolean confirm — a string 'true' is not a confirmation", async () => {
        const f = await finding();
        const res = await post(f.url, {
          draft: DRAFT,
          target: SHARED_VISIBLE,
          confirmCrossProject: "true",
        });
        expect(res.status).toBe(400);
        expect(writes()).toEqual([]);
      });

      it("an already-published finding returns its link without asking again", async () => {
        const f = await finding();
        const first = await post(f.url, {
          draft: DRAFT,
          target: SHARED_VISIBLE,
          confirmCrossProject: true,
        });
        expect(first.status).toBe(200);
        calls.length = 0;
        const again = await post(f.url, { draft: DRAFT, target: SHARED_VISIBLE });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(again.body.data.links[0].url).toBe(first.body.data.links[0].url);
        expect(writes()).toEqual([]);
      });

      it("a target no other project connects needs no confirm", async () => {
        const f = await finding();
        const res = await post(f.url, { draft: DRAFT, target: OWN });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });

      it("a re-publish to a DIFFERENT, cross-project repo returns the original link and files nothing", async () => {
        const f = await finding();
        const first = await post(f.url, { draft: DRAFT, target: OWN });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.data.links[0].url).toBe(
          "https://github.com/sandbox-org/own-1180/issues/9",
        );
        calls.length = 0;
        // Idempotency is per (finding, provider): the existing link wins, so
        // nothing is written to the other project's repository either.
        const again = await post(f.url, { draft: DRAFT, target: SHARED_VISIBLE });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(again.body.data.links).toEqual(first.body.data.links);
        expect(writes()).toEqual([]);
        expect(await db.issueLink.count({ where: { findingId: f.id } })).toBe(1);
      });

      describe("GitHub + Jira destination", () => {
        beforeEach(async () => {
          state.jiraIssues.length = 0;
          const jira = await db.jiraConnection.upsert({
            where: { projectId_label: { projectId: P, label: "jira-1180" } },
            update: {},
            create: {
              projectId: P,
              label: "jira-1180",
              edition: "cloud",
              baseUrl: "https://jira-1180.example.test",
              username: "svc",
              secretId,
              status: "ok",
              createdById: COORD_ID,
            },
          });
          await db.project.update({
            where: { id: P },
            data: { publishDestination: "both", jiraConnectionId: jira.id, jiraProjectKey: "IMP" },
          });
        });
        afterEach(async () => {
          await db.project.update({
            where: { id: P },
            data: { publishDestination: "github", jiraConnectionId: null, jiraProjectKey: null },
          });
        });

        it("a refused GitHub publish writes no Jira issue either", async () => {
          const f = await finding();
          const res = await post(f.url, { draft: DRAFT, target: SHARED_VISIBLE });
          expectRefusal(res, "sandbox-org/shared-1180", [VISIBLE_NAME]);
          expect(state.jiraIssues).toEqual([]);
          expect(await db.issueLink.count({ where: { findingId: f.id } })).toBe(0);
        });

        it("once confirmed, both are filed (the harness can reach Jira)", async () => {
          const f = await finding();
          const res = await post(f.url, {
            draft: DRAFT,
            target: SHARED_VISIBLE,
            confirmCrossProject: true,
          });
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.data.links.map((l: { provider: string }) => l.provider)).toEqual([
            "github",
            "jira",
          ]);
          expect(state.jiraIssues).toHaveLength(1);
          expect(await db.issueLink.count({ where: { findingId: f.id } })).toBe(2);
        });
      });
    });

    // ---- POST /batches (#1171's path, #1180's case fix) ----------------------

    describe("POST /publishing/batches", () => {
      it("refuses a live batch into a case variant of a repo another project connects", async () => {
        const d = await db.issueDraft.create({
          data: { projectId: P, title: `Batch 1180 ${++seq}`, body: "b", status: "approved" },
        });
        const res = await post(`/api/projects/${P}/publishing/batches`, {
          targetOwner: SHARED_VISIBLE_CASED.owner,
          targetRepo: SHARED_VISIBLE_CASED.repo,
          provider: "github",
          draftIds: [d.id],
          dryRun: false,
          secretRef: `\${vault:${SECRET_LABEL}}`,
        });
        expectRefusal(res, "Sandbox-ORG/Shared-1180", [VISIBLE_NAME]);
        expect(await db.publishBatch.count({ where: { projectId: P } })).toBe(0);
      });
    });
  },
);
