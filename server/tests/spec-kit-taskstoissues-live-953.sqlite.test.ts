/**
 * #953 — the live `/speckit.taskstoissues` export: a vault-bound GitHub issue
 * client, refused on the analysed repository and its upstream, and held to
 * exactly the dry run it was approved from.
 *
 * Real SQLite built by the migration chain, the real `VaultService`, the real
 * runner and the real target guard; only GitHub is faked (the publish Octokit
 * factory seam). Every assertion about stored state reads the row back from
 * the database.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { VaultService, __resetVaultSingleton } = await import("../src/lib/vault/vault-service.js");
const { previewTasksExport, exportTasksToGitHub } =
  await import("../src/lib/spec-kit/commands/taskstoissues-github.js");
const { writeFeatureArtifact } = await import("../src/lib/spec-kit/feature-artifacts.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../src/lib/publishing/octokit-factory.js");
const { audit } = await import("../src/lib/audit/audit-service.js");

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const USER = "u953";
const OTHER = "u953-other";
const P = "p953";
/** Analyses the FORK `me/v2` of the upstream `miniflux/v2`. */
const PF = "p953-fork";
const TOKEN = "ghp_speckit_export_token_953";
const OTHER_TOKEN = "ghp_someone_elses_token_953";
const REF = "${vault:github-flux-v2-sandbox}";
/** No `vault.reveal`: may use only secrets it created (#344). */
const ROLE = "coordinator" as const;
const SLUG = "001-foo";
const KNOWN_REPOS = new Set(["openzigs/flux-v2", "miniflux/v2", "me/v2"]);
const TASKS = [
  "| ID | Title | SP | Deps | Notes |",
  "| --- | --- | --- | --- | --- |",
  "| T01 | Build A | 3 |  | files: src/a.ts |",
  "| T02 | Build B | 2 | T01 | files: src/b.ts |",
].join("\n");

interface Call {
  method: string;
  url: string;
  data?: unknown;
  token: string;
  baseUrl: string;
}

type Err = Error & { status?: number; statusCode?: number; code?: string };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#953 — live Spec Kit issue export (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const prevKey = process.env.VAULT_MASTER_KEY;
    const calls: Call[] = [];
    let respond: (c: Call) => { status: number; data: unknown } | undefined = () => undefined;
    let nextIssue = 100;

    const issuePosts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));
    const writes = () => calls.filter((c) => c.method !== "GET");

    async function seedFeature(projectId: string): Promise<string> {
      const f = await db.specKitFeature.create({
        data: { projectId, slug: SLUG, title: "Foo" },
      });
      for (const [key, content] of [
        ["spec.md", "x"],
        ["plan.md", "x"],
        ["tasks.md", TASKS],
      ] as const) {
        await db.specKitFeatureArtifact.create({ data: { featureId: f.id, key, content } });
      }
      return f.id;
    }

    function base(projectId = P) {
      return {
        projectId,
        featureSlug: SLUG,
        actorId: USER,
        actorRole: ROLE,
        force: false,
        secretRef: REF,
      };
    }

    async function planThenPublish(projectId = P) {
      const plan = await previewTasksExport(base(projectId));
      return exportTasksToGitHub({
        ...base(projectId),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("953-speckit-live-export");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      const vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      for (const id of [USER, OTHER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      for (const id of [P, PF]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
      // The analysed upstream — never an export target.
      await db.repoConnection.create({
        data: {
          projectId: P,
          label: "upstream",
          ownerOrOrg: "miniflux",
          repoName: "v2",
          status: "connected",
        },
      });
      await db.repoConnection.create({
        data: {
          projectId: PF,
          label: "fork",
          ownerOrOrg: "me",
          repoName: "v2",
          status: "connected",
        },
      });
      await vault.create("github-flux-v2-sandbox", TOKEN, "global", { createdById: USER });
      await vault.create("someone-elses-github", OTHER_TOKEN, "global", { createdById: OTHER });
      __setPublishOctokitFactory(async ({ token, baseUrl }) => ({
        async request<T>(args: { method: string; url: string; data?: unknown }) {
          const call: Call = { ...args, token, baseUrl };
          calls.push(call);
          const custom = respond(call);
          if (custom) {
            if (custom.status >= 400) {
              throw Object.assign(new Error(`HttpError ${TOKEN} leaked?`), {
                status: custom.status,
              });
            }
            return { status: custom.status, headers: {}, data: custom.data as T };
          }
          const u = args.url;
          let data: unknown = {};
          if (args.method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(u)) {
            const name = u.slice("/repos/".length).toLowerCase();
            if (!KNOWN_REPOS.has(name))
              throw Object.assign(new Error("Not Found"), { status: 404 });
            data = name === "me/v2" ? { parent: { full_name: "miniflux/v2" } } : {};
          } else if (args.method === "POST" && u.endsWith("/issues")) {
            nextIssue += 1;
            data = {
              id: 9_000 + nextIssue,
              number: nextIssue,
              html_url: `https://github.com/openzigs/flux-v2/issues/${nextIssue}`,
            };
          }
          return { status: 201, headers: {}, data: data as T };
        },
      }));
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      calls.length = 0;
      nextIssue = 100;
      respond = () => undefined;
      __resetPublishOctokitCache();
      vi.mocked(audit).mockClear();
      await db.specKitTaskExport.deleteMany({});
      await db.specKitFeature.deleteMany({});
      await db.specKitConfig.deleteMany({});
      await db.project.update({
        where: { id: P },
        data: { publishGithubOwner: "openzigs", publishGithubRepo: "flux-v2" },
      });
      await seedFeature(P);
    });

    afterEach(() => {
      delete process.env.SPECKIT_EXPORT_MAX_ISSUES;
    });

    afterAll(async () => {
      __setPublishOctokitFactory(null);
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    it("a dry run plans, reports the credential, and touches neither GitHub nor the database", async () => {
      const plan = await previewTasksExport(base());
      expect(plan.repo).toEqual({ owner: "openzigs", name: "flux-v2" });
      expect(plan.created.map((c) => c.title)).toEqual(["[T01] Build A", "[T02] Build B"]);
      expect(plan.publishAvailable).toBe(true);
      expect(plan.credentialCheck).toBe("resolved");
      expect(plan.tasksVersion).toBe(1);
      expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(calls).toEqual([]);
      expect(await db.specKitTaskExport.count()).toBe(0);
      const missing = await previewTasksExport({ ...base(), secretRef: undefined });
      expect(missing.credentialCheck).toBe("missing");
      const unresolved = await previewTasksExport({ ...base(), secretRef: "${vault:nope}" });
      expect(unresolved.credentialCheck).toBe("unresolved");
    });

    it("publishes exactly the previewed issues to the saved target with the vault token", async () => {
      const out = await planThenPublish();
      expect(issuePosts().map((c) => (c.data as { title: string }).title)).toEqual([
        "[T01] Build A",
        "[T02] Build B",
      ]);
      expect(issuePosts().every((c) => c.url === "/repos/openzigs/flux-v2/issues")).toBe(true);
      expect(calls.every((c) => c.token === TOKEN && c.baseUrl === "https://api.github.com")).toBe(
        true,
      );
      expect(out.created.map((c) => c.url)).toEqual([
        "https://github.com/openzigs/flux-v2/issues/101",
        "https://github.com/openzigs/flux-v2/issues/102",
      ]);
      const rows = await db.specKitTaskExport.findMany({ orderBy: { taskId: "asc" } });
      expect(rows.map((r) => [r.taskId, r.issueNumber, r.repoOwner, r.repoName])).toEqual([
        ["T01", 101, "openzigs", "flux-v2"],
        ["T02", 102, "openzigs", "flux-v2"],
      ]);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "speckit.tasks_exported",
          metadata: expect.objectContaining({
            dryRun: false,
            created: 2,
            repo: "openzigs/flux-v2",
          }),
        }),
      );
    });

    it("a second publish creates nothing: the next dry run plans no new issues", async () => {
      await planThenPublish();
      calls.length = 0;
      const plan = await previewTasksExport(base());
      expect(plan.created.every((c) => c.upserted)).toBe(true);
      await exportTasksToGitHub({
        ...base(),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      });
      expect(issuePosts()).toEqual([]);
      expect(await db.specKitTaskExport.count()).toBe(2);
    });

    it("refuses (409) when tasks.md changed after the dry run, before any issue is created", async () => {
      const plan = await previewTasksExport(base());
      const feature = await db.specKitFeature.findFirstOrThrow({ where: { projectId: P } });
      await writeFeatureArtifact({
        featureId: feature.id,
        key: "tasks.md",
        content: `${TASKS}\n| T03 | Build C | 1 |  |  |`,
        actorId: USER,
      });
      const err = (await exportTasksToGitHub({
        ...base(),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      }).catch((e: unknown) => e)) as Err;
      expect(err).toMatchObject({ status: 409, code: "SPECKIT_EXPORT_PLAN_CHANGED" });
      expect(issuePosts()).toEqual([]);
      expect(await db.specKitTaskExport.count()).toBe(0);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "speckit.tasks_export_refused",
          metadata: expect.objectContaining({ code: "SPECKIT_EXPORT_PLAN_CHANGED" }),
        }),
      );
    });

    it("refuses (409) a digest that does not match the plan, at the same tasks.md version", async () => {
      const plan = await previewTasksExport(base());
      await expect(
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: plan.tasksVersion, digest: "0".repeat(64) },
        }),
      ).rejects.toMatchObject({ status: 409, code: "SPECKIT_EXPORT_PLAN_CHANGED" });
      expect(issuePosts()).toEqual([]);
    });

    it("refuses (409) a live run with no dry run, and one without a vault secret (400)", async () => {
      await expect(exportTasksToGitHub(base())).rejects.toMatchObject({
        status: 409,
        code: "SPECKIT_DRY_RUN_REQUIRED",
      });
      await expect(
        exportTasksToGitHub({
          ...base(),
          secretRef: undefined,
          expectedPlan: { tasksVersion: 1, digest: "0".repeat(64) },
        }),
      ).rejects.toMatchObject({ status: 400, code: "TOKEN_REQUIRED" });
      expect(calls).toEqual([]);
    });

    it("refuses a request-chosen repository on a live run (400)", async () => {
      await expect(
        exportTasksToGitHub({
          ...base(),
          repo: { owner: "openzigs", name: "flux-v2" },
          expectedPlan: { tasksVersion: 1, digest: "0".repeat(64) },
        }),
      ).rejects.toMatchObject({ status: 400, code: "SPECKIT_TARGET_OVERRIDE_REFUSED" });
      expect(calls).toEqual([]);
    });

    it("refuses a pasted token without echoing it, before any GitHub call", async () => {
      const plan = await previewTasksExport(base());
      const err = (await exportTasksToGitHub({
        ...base(),
        secretRef: "ghp_raw_token_pasted",
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      }).catch((e: unknown) => e)) as Err;
      expect(err.code).toBe("VAULT_REF_INVALID");
      expect(err.message).not.toContain("ghp_raw_token_pasted");
      expect(calls).toEqual([]);
    });

    it("refuses another user's GitHub secret (403) — the export writes to a repository", async () => {
      const plan = await previewTasksExport(base());
      const err = (await exportTasksToGitHub({
        ...base(),
        secretRef: "${vault:someone-elses-github}",
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      }).catch((e: unknown) => e)) as Err;
      expect(err).toMatchObject({ statusCode: 403, code: "SECRET_BINDING_FORBIDDEN" });
      expect(err.message).not.toContain(OTHER_TOKEN);
      expect(calls).toEqual([]);
    });

    it("refuses the analysed repository as a target, on the dry run and the live run", async () => {
      await db.project.update({
        where: { id: P },
        data: { publishGithubOwner: "Miniflux", publishGithubRepo: "v2" },
      });
      await expect(previewTasksExport(base())).rejects.toMatchObject({
        status: 409,
        code: "PUBLISH_TARGET_IS_ANALYSED_REPO",
      });
      await expect(
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: 1, digest: "0".repeat(64) },
        }),
      ).rejects.toMatchObject({ status: 409, code: "PUBLISH_TARGET_IS_ANALYSED_REPO" });
      expect(calls).toEqual([]);
    });

    it("refuses the upstream of an analysed fork on a live run, with no write", async () => {
      await seedFeature(PF);
      await db.project.update({
        where: { id: PF },
        data: { publishGithubOwner: "miniflux", publishGithubRepo: "v2" },
      });
      const plan = await previewTasksExport(base(PF));
      const err = (await exportTasksToGitHub({
        ...base(PF),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      }).catch((e: unknown) => e)) as Err;
      expect(err).toMatchObject({ status: 409, code: "PUBLISH_TARGET_IS_ANALYSED_REPO" });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /repos/me/v2"]);
      expect(writes()).toEqual([]);
    });

    it("refuses (fails closed) when an analysed repo's upstream cannot be looked up", async () => {
      respond = (c) =>
        c.method === "GET" && c.url === "/repos/miniflux/v2"
          ? { status: 403, data: {} }
          : undefined;
      const plan = await previewTasksExport(base());
      const err = (await exportTasksToGitHub({
        ...base(),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      }).catch((e: unknown) => e)) as Err;
      expect(err).toMatchObject({ status: 502, code: "GITHUB_REQUEST_FAILED" });
      expect(err.message).toContain("miniflux/v2");
      expect(err.message).not.toContain(TOKEN);
      expect(writes()).toEqual([]);
    });

    it("a GitHub failure part-way keeps what was created, audits it, and leaks no token", async () => {
      let posts = 0;
      respond = (c) => {
        if (c.method === "POST" && c.url.endsWith("/issues") && ++posts === 2) {
          return { status: 500, data: {} };
        }
        return undefined;
      };
      const err = (await planThenPublish().catch((e: unknown) => e)) as Err;
      expect(err).toMatchObject({ status: 502, code: "GITHUB_REQUEST_FAILED" });
      expect(err.message).toContain("HTTP 500");
      expect(err.message).not.toContain(TOKEN);
      const rows = await db.specKitTaskExport.findMany();
      expect(rows.map((r) => r.taskId)).toEqual(["T01"]);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "speckit.tasks_export_failed",
          metadata: expect.objectContaining({ createdBeforeFailure: 1 }),
        }),
      );
    });

    it("refuses (422) an export larger than SPECKIT_EXPORT_MAX_ISSUES, creating nothing", async () => {
      process.env.SPECKIT_EXPORT_MAX_ISSUES = "1";
      await expect(planThenPublish()).rejects.toMatchObject({
        status: 422,
        code: "SPECKIT_EXPORT_TOO_LARGE",
      });
      expect(issuePosts()).toEqual([]);
    });

    it("links each new issue under the configured parent epic by its REST id", async () => {
      await db.specKitConfig.create({ data: { projectId: P, tasksToIssuesParentEpic: 9 } });
      await planThenPublish();
      const links = calls.filter((c) => c.url.endsWith("/issues/9/sub_issues"));
      expect(links.map((c) => c.data)).toEqual([{ sub_issue_id: 9101 }, { sub_issue_id: 9102 }]);
    });
    it("two concurrent live runs of one approved plan create each issue once", async () => {
      const plan = await previewTasksExport(base());
      const run = () =>
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
        });
      const results = await Promise.allSettled([run(), run()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      // Either refusal is safe: the loser saw the winner's claim, or its finished row.
      expect(loser.reason).toMatchObject({ status: 409 });
      expect(["SPECKIT_EXPORT_IN_PROGRESS", "SPECKIT_EXPORT_PLAN_CHANGED"]).toContain(
        loser.reason.code,
      );
      expect(issuePosts().map((c) => (c.data as { title: string }).title)).toEqual([
        "[T01] Build A",
        "[T02] Build B",
      ]);
      const rows = await db.specKitTaskExport.findMany({ orderBy: { taskId: "asc" } });
      expect(rows.map((r) => [r.taskId, r.issueNumber])).toEqual([
        ["T01", 101],
        ["T02", 102],
      ]);
    });

    it("a GitHub failure releases the task's claim so a retry can create it", async () => {
      const plan = await previewTasksExport(base());
      respond = (c) =>
        c.method === "POST" && c.url.endsWith("/issues") ? { status: 500, data: {} } : undefined;
      await expect(
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
        }),
      ).rejects.toBeDefined();
      expect(await db.specKitTaskExport.count()).toBe(0);
      respond = () => undefined;
      const out = await exportTasksToGitHub({
        ...base(),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      });
      expect(out.created).toHaveLength(2);
    });

    it("refuses (409) while another run's claim is still unresolved", async () => {
      await db.specKitTaskExport.create({
        data: {
          projectId: P,
          featureSlug: SLUG,
          taskId: "T01",
          issueNumber: 0,
          repoOwner: "openzigs",
          repoName: "flux-v2",
        },
      });
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.title)).toEqual(["[T01] Build A", "[T02] Build B"]);
      await expect(
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
        }),
      ).rejects.toMatchObject({ status: 409, code: "SPECKIT_EXPORT_IN_PROGRESS" });
      expect(issuePosts()).toEqual([]);
    });

    it("refuses (409) when the parent epic changed since the dry run", async () => {
      await db.specKitConfig.create({ data: { projectId: P, tasksToIssuesParentEpic: 9 } });
      const plan = await previewTasksExport(base());
      await db.specKitConfig.update({
        where: { projectId: P },
        data: { tasksToIssuesParentEpic: 10 },
      });
      await expect(
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
        }),
      ).rejects.toMatchObject({ status: 409, code: "SPECKIT_EXPORT_PLAN_CHANGED" });
      expect(issuePosts()).toEqual([]);
    });
  },
);
