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
const { previewTasksExport, exportTasksToGitHub, clearStuckTasksExport } =
  await import("../src/lib/spec-kit/commands/taskstoissues-github.js");
const { writeFeatureArtifact } = await import("../src/lib/spec-kit/feature-artifacts.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../src/lib/publishing/octokit-factory.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
type ClearOut = Awaited<ReturnType<typeof clearStuckTasksExport>>;

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

/** The token's GitHub user, who files the export's issues. */
const BOT = "metis-export-bot";

interface FakeIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#953 — live Spec Kit issue export (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const prevKey = process.env.VAULT_MASTER_KEY;
    const calls: Call[] = [];
    let respond: (c: Call) => { status: number; data: unknown } | undefined = () => undefined;
    let nextIssue = 100;
    /** #962 — the issues the fake GitHub holds, for the reconcile list call. */
    const filed: FakeIssue[] = [];
    /** #962 — the token's GitHub login, served by `GET /user`. */
    let botLogin = BOT;
    /** #962 — a fake that ignores `creator=`, to prove the client checks `user.login` too. */
    let ignoreCreatorFilter = false;
    /** File an issue on the fake GitHub, as a successful POST does. */
    function fileIssue(c: Call, opts: { by?: string; at?: Date; updatedAt?: Date } = {}) {
      nextIssue += 1;
      const d = c.data as { title: string; body: string };
      const at = (opts.at ?? new Date()).toISOString();
      const issue: FakeIssue = {
        id: 9_000 + nextIssue,
        number: nextIssue,
        title: d.title,
        body: d.body,
        html_url: `https://github.com/openzigs/flux-v2/issues/${nextIssue}`,
        user: { login: opts.by ?? botLogin },
        created_at: at,
        updated_at: (opts.updatedAt ?? opts.at ?? new Date()).toISOString(),
      };
      filed.push(issue);
      return issue;
    }
    /**
     * `GET /repos/{o}/{r}/issues` as GitHub serves it: `creator`, `since`
     * (updated at or after), `sort=created&direction=asc`, `per_page`, `page`.
     */
    function listIssues(url: string): FakeIssue[] {
      const q = new URL(url, "https://api.github.com").searchParams;
      const since = q.get("since") ? Date.parse(q.get("since")!) : -Infinity;
      const creator = q.get("creator");
      const perPage = Number(q.get("per_page") ?? 30);
      const page = Number(q.get("page") ?? 1);
      const asc = q.get("direction") === "asc";
      const rows = filed
        .filter((i) => Date.parse(i.updated_at) >= since)
        .filter((i) => ignoreCreatorFilter || !creator || i.user.login === creator)
        .sort((a, b) => (Date.parse(a.created_at) - Date.parse(b.created_at)) * (asc ? 1 : -1));
      return rows.slice((page - 1) * perPage, page * perPage);
    }
    const listCalls = () => calls.filter((c) => c.method === "GET" && c.url.includes("/issues?"));

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
            // #962 — status 0: the connection dropped, no HTTP status at all.
            if (custom.status === 0) throw new Error("socket hang up");
            if (custom.status >= 400) {
              throw Object.assign(new Error(`HttpError ${TOKEN} leaked?`), {
                status: custom.status,
                response: { data: custom.data },
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
            data = fileIssue(call);
          } else if (args.method === "GET" && u.includes("/issues?")) {
            data = listIssues(u);
          } else if (args.method === "GET" && u === "/user") {
            data = { login: botLogin };
          }
          return { status: 201, headers: {}, data: data as T };
        },
      }));
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      calls.length = 0;
      filed.length = 0;
      nextIssue = 100;
      botLogin = BOT;
      ignoreCreatorFilter = false;
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
      delete process.env.SPECKIT_EXPORT_CLAIM_TTL_MS;
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

    it("#988 — publishes a feature with an 80-character slug: every label fits GitHub's 50", async () => {
      // GitHub as it behaves: a label name over 50 characters is a 422.
      respond = (c) => {
        if (c.method !== "POST" || !c.url.endsWith("/issues")) return undefined;
        const labels = (c.data as { labels: string[] }).labels;
        return labels.some((l) => [...l].length > 50)
          ? {
              status: 422,
              data: {
                message: "Validation Failed",
                errors: [{ value: labels[0], resource: "Label", field: "name", code: "invalid" }],
              },
            }
          : undefined;
      };
      const longSlug = `002-${"mark-all-entries-as-read-older-than-n-days-".repeat(2)}`.slice(
        0,
        84,
      );
      expect(longSlug.length).toBe(84);
      const f = await db.specKitFeature.create({
        data: { projectId: P, slug: longSlug, title: "Long" },
      });
      for (const [key, content] of [
        ["spec.md", "x"],
        ["plan.md", "x"],
        ["tasks.md", TASKS],
      ] as const) {
        await db.specKitFeatureArtifact.create({ data: { featureId: f.id, key, content } });
      }
      const input = { ...base(), featureSlug: longSlug };
      const plan = await previewTasksExport(input);
      const out = await exportTasksToGitHub({
        ...input,
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      });
      expect(out.created.map((c) => c.state)).toEqual(["new", "new"]);
      const posted = issuePosts().map((c) => c.data as { labels: string[]; body: string });
      expect(posted).toHaveLength(2);
      for (const p of posted) {
        expect(p.labels.every((l) => [...l].length <= 50)).toBe(true);
        expect(p.labels[0]).toMatch(/^speckit:002-mark-all-entries-as-read-olde-[0-9a-f]{8}$/);
        expect(p.body).toContain(`Source: specs/${longSlug}/tasks.md#`);
      }
      const rows = await db.specKitTaskExport.findMany({ where: { featureSlug: longSlug } });
      expect(rows.map((r) => r.issueNumber).sort()).toEqual([101, 102]);
    });

    it("#988 — a 422 names the rejected label field instead of blaming the token", async () => {
      respond = (c) =>
        c.method === "POST" && c.url.endsWith("/issues")
          ? {
              status: 422,
              data: {
                message: "Validation Failed",
                errors: [{ value: "speckit:x", resource: "Label", field: "name", code: "invalid" }],
              },
            }
          : undefined;
      const err = (await planThenPublish().catch((e: unknown) => e)) as Err;
      expect(err).toMatchObject({ status: 502, code: "GITHUB_REQUEST_FAILED" });
      expect(err.message).toContain("rejected invalid Label name");
      expect(err.message).toContain("not the vault secret");
      expect(err.message).not.toContain(TOKEN);
      expect(await db.specKitTaskExport.count()).toBe(0);
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
      // #962 — a 500 is ambiguous: T02's claim is kept, owned by no run.
      const rows = await db.specKitTaskExport.findMany({ orderBy: { taskId: "asc" } });
      expect(rows.map((r) => [r.taskId, r.issueNumber, r.claimRunId])).toEqual([
        ["T01", 101, null],
        ["T02", 0, null],
      ]);
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
      // Force the race deterministically: the first write of T01's export row
      // waits until BOTH runs have reached one (or the other run has settled).
      // Both runs have then read the plan — and passed `assertPlanUnchanged` —
      // before either has stored anything: exactly the window a
      // read, create-on-GitHub, then-record ordering loses in.
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const exportRows = db.specKitTaskExport;
      state.db = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "specKitTaskExport") return Reflect.get(target, prop, receiver);
          return new Proxy(exportRows, {
            get(t, key) {
              const v = Reflect.get(t, key, t) as unknown;
              if (typeof v !== "function") return v;
              if (key !== "create") return v.bind(t);
              return async (args: { data: { taskId: string } }) => {
                if (args.data.taskId === "T01") {
                  arrived += 1;
                  if (arrived >= 2) release();
                  await barrier;
                }
                return (v as (a: unknown) => Promise<unknown>).call(t, args);
              };
            },
          });
        },
      });
      const run = () =>
        exportTasksToGitHub({
          ...base(),
          expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
        }).finally(() => release());
      let results: PromiseSettledResult<unknown>[];
      try {
        results = await Promise.allSettled([run(), run()]);
      } finally {
        state.db = db;
      }
      expect(arrived).toBe(2);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ status: 409, code: "SPECKIT_EXPORT_IN_PROGRESS" });
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

    // ── #962: claims are reconciled, never stuck and never duplicated ──────────

    async function plantClaim(
      taskId: string,
      claim: { claimedAt: Date | null; claimRunId: string | null; firstClaimedAt?: Date | null },
    ) {
      await db.specKitTaskExport.create({
        data: {
          projectId: P,
          featureSlug: SLUG,
          taskId,
          issueNumber: 0,
          repoOwner: "openzigs",
          repoName: "flux-v2",
          ...claim,
        },
      });
    }
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const publish = (plan: { tasksVersion: number; planDigest: string }) =>
      exportTasksToGitHub({
        ...base(),
        expectedPlan: { tasksVersion: plan.tasksVersion, digest: plan.planDigest },
      });
    /** An issue an earlier, interrupted run filed for `taskId` of `slug`. */
    function preFiled(
      taskId: string,
      title: string,
      slug = SLUG,
      opts: { by?: string; at?: Date; updatedAt?: Date } = {},
    ) {
      return fileIssue(
        {
          method: "POST",
          url: "/repos/openzigs/flux-v2/issues",
          data: {
            title,
            body: `Source: specs/${slug}/tasks.md#${taskId}\n\nParallelizable: no\n`,
          },
          token: TOKEN,
          baseUrl: "https://api.github.com",
        },
        opts,
      );
    }

    it("a definitive GitHub refusal (4xx) releases the claim, so a retry creates the task", async () => {
      respond = (c) =>
        c.method === "POST" && c.url.endsWith("/issues") ? { status: 422, data: {} } : undefined;
      await expect(publish(await previewTasksExport(base()))).rejects.toMatchObject({
        code: "GITHUB_REQUEST_FAILED",
      });
      expect(await db.specKitTaskExport.count()).toBe(0);
      respond = () => undefined;
      calls.length = 0;
      const out = await publish(await previewTasksExport(base()));
      expect(out.created.map((c) => c.state)).toEqual(["new", "new"]);
      // Nothing was claimed, so nothing is looked up before creating.
      expect(listCalls()).toEqual([]);
    });

    for (const [kind, reply] of [
      ["a 5xx", { status: 502, data: {} }],
      ["a network error", { status: 0, data: undefined }],
      ["a 2xx with no issue in it", { status: 201, data: { message: "ok?" } }],
    ] as const) {
      it(`${kind} after GitHub filed the issue keeps the claim, and the retry adopts it — no duplicate (#962)`, async () => {
        let first = true;
        respond = (c) => {
          if (first && c.method === "POST" && c.url.endsWith("/issues")) {
            first = false;
            fileIssue(c); // GitHub did create it; the answer is what got lost.
            return reply;
          }
          return undefined;
        };
        await expect(publish(await previewTasksExport(base()))).rejects.toMatchObject({
          code: "GITHUB_REQUEST_FAILED",
        });
        const kept = await db.specKitTaskExport.findMany();
        expect(kept.map((r) => [r.taskId, r.issueNumber, r.claimRunId])).toEqual([
          ["T01", 0, null],
        ]);

        const plan = await previewTasksExport(base());
        expect(plan.created.map((c) => [c.taskId, c.state])).toEqual([
          ["T01", "reconcile"],
          ["T02", "new"],
        ]);
        const out = await publish(plan);
        expect(out.created.map((c) => [c.taskId, c.state, c.issueNumber])).toEqual([
          ["T01", "adopted", 101],
          ["T02", "new", 102],
        ]);
        expect(listCalls().length).toBeGreaterThan(0);
        expect(listCalls().every((c) => c.url.startsWith("/repos/openzigs/flux-v2/issues?"))).toBe(
          true,
        );
        // One POST per task, ever: the lost one and T02's.
        expect(issuePosts().map((c) => (c.data as { title: string }).title)).toEqual([
          "[T01] Build A",
          "[T02] Build B",
        ]);
        expect(filed).toHaveLength(2);
        const rows = await db.specKitTaskExport.findMany({
          orderBy: { taskId: "asc" },
        });
        expect(rows.map((r) => [r.taskId, r.issueNumber])).toEqual([
          ["T01", 101],
          ["T02", 102],
        ]);
      });
    }

    it("a kept claim whose issue GitHub never filed is re-created after the search (#962)", async () => {
      await plantClaim("T01", { claimedAt: minutesAgo(1), claimRunId: null });
      const out = await publish(await previewTasksExport(base()));
      expect(out.created.map((c) => [c.taskId, c.state])).toEqual([
        ["T01", "new"],
        ["T02", "new"],
      ]);
      expect(listCalls()).toHaveLength(1);
      expect(issuePosts()).toHaveLength(2);
    });

    it("does not adopt another feature's issue for the same task id (#962)", async () => {
      preFiled("T01", "[T01] Build A", "002-other");
      await plantClaim("T01", { claimedAt: minutesAgo(1), claimRunId: null });
      const out = await publish(await previewTasksExport(base()));
      expect(out.created[0]).toMatchObject({
        taskId: "T01",
        state: "new",
        issueNumber: 102,
      });
    });

    it("a claim whose run died is abandoned after SPECKIT_EXPORT_CLAIM_TTL_MS and reconciled (#962)", async () => {
      await plantClaim("T01", {
        claimedAt: minutesAgo(11),
        claimRunId: "dead-run",
      });
      preFiled("T01", "[T01] Build A");
      // Within a longer TTL the same claim is still in progress.
      process.env.SPECKIT_EXPORT_CLAIM_TTL_MS = String(60 * 60_000);
      expect((await previewTasksExport(base())).created.map((c) => c.state)).toEqual([
        "in_progress",
        "new",
      ]);
      delete process.env.SPECKIT_EXPORT_CLAIM_TTL_MS;
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.state)).toEqual(["reconcile", "new"]);
      const out = await publish(plan);
      expect(out.created.map((c) => [c.state, c.issueNumber])).toEqual([
        ["adopted", 101],
        ["new", 102],
      ]);
      expect(issuePosts().map((c) => (c.data as { title: string }).title)).toEqual([
        "[T02] Build B",
      ]);
    });

    it("refuses (409) at plan time, audited, while another run holds a claim — before any POST", async () => {
      // On T02, not T01: T01 is planned first, so only the plan-time guard can
      // stop T01's POST; the claim-time unique row would fire after it.
      await plantClaim("T02", { claimedAt: new Date(), claimRunId: "other-run" });
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => [c.taskId, c.state])).toEqual([
        ["T01", "new"],
        ["T02", "in_progress"],
      ]);
      await expect(publish(plan)).rejects.toMatchObject({
        status: 409,
        code: "SPECKIT_EXPORT_IN_PROGRESS",
      });
      expect(issuePosts()).toEqual([]);
      expect(calls.filter((c) => c.method === "POST")).toEqual([]);
      const rows = await db.specKitTaskExport.findMany();
      expect(rows.map((r) => [r.taskId, r.issueNumber, r.claimRunId])).toEqual([
        ["T02", 0, "other-run"],
      ]);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "speckit.tasks_export_refused",
          metadata: expect.objectContaining({ code: "SPECKIT_EXPORT_IN_PROGRESS" }),
        }),
      );
    });

    it("Clear stuck export adopts what GitHub has, deletes what it lacks, and leaves a live claim (#962)", async () => {
      await plantClaim("T01", {
        claimedAt: minutesAgo(30),
        claimRunId: "dead-run",
      });
      await plantClaim("T02", { claimedAt: new Date(), claimRunId: "live-run" });
      preFiled("T01", "[T01] Build A");
      const first = await clearStuckTasksExport(base());
      expect(first).toMatchObject({
        adopted: [{ taskId: "T01", issueNumber: 101 }],
        cleared: [],
        inProgress: ["T02"],
      });
      await db.specKitTaskExport.update({
        where: {
          projectId_featureSlug_taskId: {
            projectId: P,
            featureSlug: SLUG,
            taskId: "T02",
          },
        },
        data: { claimedAt: minutesAgo(30) },
      });
      const second = await clearStuckTasksExport(base());
      expect(second).toMatchObject({
        adopted: [],
        cleared: ["T02"],
        inProgress: [],
      });
      const rows = await db.specKitTaskExport.findMany();
      expect(rows.map((r) => [r.taskId, r.issueNumber])).toEqual([["T01", 101]]);
      expect(writes()).toEqual([]);
      expect(calls.every((c) => c.url.startsWith("/repos/") || c.url === "/user")).toBe(true);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "speckit.tasks_export_claims_cleared",
          metadata: expect.objectContaining({ cleared: ["T02"], inProgress: [] }),
        }),
      );
      // The next dry run plans T02 as new, and publishing creates only it.
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.state)).toEqual(["exported", "new"]);
    });

    it("Clear stuck export keeps the claim when GitHub cannot be searched (#962)", async () => {
      await plantClaim("T01", {
        claimedAt: minutesAgo(30),
        claimRunId: "dead-run",
      });
      respond = (c) =>
        c.method === "GET" && c.url.includes("/issues?") ? { status: 503, data: {} } : undefined;
      await expect(clearStuckTasksExport(base())).rejects.toMatchObject({
        code: "GITHUB_REQUEST_FAILED",
      });
      const rows = await db.specKitTaskExport.findMany();
      expect(rows.map((r) => [r.taskId, r.issueNumber, r.claimRunId])).toEqual([["T01", 0, null]]);
    });

    it("Clear stuck export is refused, and audited, without a vault secret or on an analysed target", async () => {
      await expect(
        clearStuckTasksExport({ ...base(), secretRef: undefined }),
      ).rejects.toMatchObject({ code: "TOKEN_REQUIRED" });
      await db.project.update({
        where: { id: P },
        data: { publishGithubOwner: "miniflux", publishGithubRepo: "v2" },
      });
      await expect(clearStuckTasksExport(base())).rejects.toMatchObject({
        code: "PUBLISH_TARGET_IS_ANALYSED_REPO",
      });
      const refused = vi
        .mocked(audit)
        .mock.calls.map((c) => c[0])
        .filter((a) => a.action === "speckit.tasks_export_refused");
      expect(refused.map((a) => [a.metadata?.operation, a.metadata?.code])).toEqual([
        ["clear", "TOKEN_REQUIRED"],
        ["clear", "PUBLISH_TARGET_IS_ANALYSED_REPO"],
      ]);
      expect(calls).toEqual([]);
    });

    // ── #962 cycle 2: takeover keeps the first claim time; creator; races ──────

    const ABANDONED = () => ({
      claimedAt: minutesAgo(30),
      firstClaimedAt: minutesAgo(30),
      claimRunId: "dead-run",
    });
    const failLookups = () => {
      respond = (c) =>
        c.method === "GET" && c.url.includes("/issues?") ? { status: 503, data: {} } : undefined;
    };
    const postedTitles = () => issuePosts().map((c) => (c.data as { title: string }).title);

    for (const [kind, legacy] of [
      ["", false],
      [" (a claim written before firstClaimedAt existed)", true],
    ] as const) {
      it(`a lookup that fails after a takeover keeps the first claim time; the retry adopts the first run's issue${kind}`, async () => {
        const first = minutesAgo(60);
        await plantClaim("T01", {
          claimedAt: first,
          firstClaimedAt: legacy ? null : first,
          claimRunId: "dead-run",
        });
        // Filed — and last updated — by the first run, an hour ago.
        preFiled("T01", "[T01] Build A", SLUG, { at: first });
        failLookups();
        await expect(publish(await previewTasksExport(base()))).rejects.toMatchObject({
          code: "GITHUB_REQUEST_FAILED",
        });
        const kept = await db.specKitTaskExport.findFirstOrThrow({
          where: { taskId: "T01" },
        });
        expect(kept.claimRunId).toBeNull();
        expect(kept.firstClaimedAt?.getTime()).toBe(first.getTime());

        respond = () => undefined;
        calls.length = 0;
        const out = await publish(await previewTasksExport(base()));
        expect(out.created.map((c) => [c.taskId, c.state, c.issueNumber])).toEqual([
          ["T01", "adopted", 101],
          ["T02", "new", 102],
        ]);
        expect(postedTitles()).toEqual(["[T02] Build B"]);
        expect(filed).toHaveLength(2);
      });
    }

    it("Clear stuck export: a failed lookup after a takeover keeps the first claim time; the retry adopts", async () => {
      const first = minutesAgo(60);
      await plantClaim("T01", {
        claimedAt: first,
        firstClaimedAt: first,
        claimRunId: "dead-run",
      });
      preFiled("T01", "[T01] Build A", SLUG, { at: first });
      failLookups();
      await expect(clearStuckTasksExport(base())).rejects.toMatchObject({
        code: "GITHUB_REQUEST_FAILED",
      });
      respond = () => undefined;
      const out = await clearStuckTasksExport(base());
      expect(out).toMatchObject({
        adopted: [{ taskId: "T01", issueNumber: 101 }],
        cleared: [],
      });
      expect(issuePosts()).toEqual([]);
    });

    it("a failed lookup on the export path releases ownership: the next run reconciles at once, not after the TTL", async () => {
      await plantClaim("T01", ABANDONED());
      preFiled("T01", "[T01] Build A");
      failLookups();
      await expect(publish(await previewTasksExport(base()))).rejects.toMatchObject({
        code: "GITHUB_REQUEST_FAILED",
      });
      respond = () => undefined;
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.state)).toEqual(["reconcile", "new"]);
      const out = await publish(plan);
      expect(out.created.map((c) => [c.state, c.issueNumber])).toEqual([
        ["adopted", 101],
        ["new", 102],
      ]);
    });

    it("searches only the token user's issues, and does not adopt a third party's look-alike (#962)", async () => {
      await plantClaim("T01", ABANDONED());
      // Older than the claim but recently updated, same title prefix and Source line.
      preFiled("T01", "[T01] Build A", SLUG, {
        by: "mallory",
        at: minutesAgo(120),
        updatedAt: new Date(),
      });
      const out = await publish(await previewTasksExport(base()));
      expect(out.created.map((c) => [c.taskId, c.state, c.issueNumber])).toEqual([
        ["T01", "new", 102],
        ["T02", "new", 103],
      ]);
      expect(calls.filter((c) => c.url === "/user")).toHaveLength(1);
      expect(listCalls()).toHaveLength(1);
      expect(listCalls()[0]!.url).toContain(`&creator=${BOT}&`);
    });

    it("checks the issue's author itself, even when GitHub ignores the creator filter (#962)", async () => {
      ignoreCreatorFilter = true;
      await plantClaim("T01", ABANDONED());
      preFiled("T01", "[T01] Build A", SLUG, {
        by: "mallory",
        at: minutesAgo(120),
        updatedAt: new Date(),
      });
      const out = await publish(await previewTasksExport(base()));
      expect(out.created[0]).toMatchObject({
        taskId: "T01",
        state: "new",
        issueNumber: 102,
      });
    });

    it("refuses to reconcile, keeping the claim, when the token's user cannot be read (#962)", async () => {
      await plantClaim("T01", ABANDONED());
      respond = (c) => (c.url === "/user" ? { status: 401, data: {} } : undefined);
      await expect(publish(await previewTasksExport(base()))).rejects.toMatchObject({
        code: "GITHUB_REQUEST_FAILED",
      });
      expect(issuePosts()).toEqual([]);
      expect(listCalls()).toEqual([]);
      const rows = await db.specKitTaskExport.findMany();
      expect(rows.map((r) => [r.taskId, r.issueNumber, r.claimRunId])).toEqual([["T01", 0, null]]);
    });

    it("finds the first run's issue on the second page of the list (#962)", async () => {
      const first = minutesAgo(30);
      await plantClaim("T01", {
        claimedAt: first,
        firstClaimedAt: first,
        claimRunId: "dead-run",
      });
      for (let i = 0; i < 100; i++) {
        preFiled(`T${500 + i}`, `[T${500 + i}] filler`, SLUG, { at: first });
      }
      preFiled("T01", "[T01] Build A", SLUG, {
        at: new Date(first.getTime() + 1_000),
      });
      const out = await publish(await previewTasksExport(base()));
      expect(out.created[0]).toMatchObject({
        taskId: "T01",
        state: "adopted",
        issueNumber: 201,
      });
      expect(listCalls().map((c) => new URL(c.url, "https://x").searchParams.get("page"))).toEqual([
        "1",
        "2",
      ]);
      expect(postedTitles()).toEqual(["[T02] Build B"]);
    });

    it("counts a reconcile task toward SPECKIT_EXPORT_MAX_ISSUES (422 before any GitHub call)", async () => {
      await plantClaim("T01", ABANDONED());
      process.env.SPECKIT_EXPORT_MAX_ISSUES = "1";
      const plan = await previewTasksExport(base());
      calls.length = 0;
      await expect(publish(plan)).rejects.toMatchObject({
        status: 422,
        code: "SPECKIT_EXPORT_TOO_LARGE",
      });
      expect(listCalls()).toEqual([]);
      expect(issuePosts()).toEqual([]);
    });

    it("refuses (409) when a reconcile task was resolved between the dry run and the live run", async () => {
      await plantClaim("T01", ABANDONED());
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.state)).toEqual(["reconcile", "new"]);
      await db.specKitTaskExport.updateMany({
        where: { taskId: "T01" },
        data: { issueNumber: 77, claimRunId: null },
      });
      await expect(publish(plan)).rejects.toMatchObject({
        status: 409,
        code: "SPECKIT_EXPORT_PLAN_CHANGED",
      });
      expect(issuePosts()).toEqual([]);
    });

    it("refuses (409) when an in-progress task finished between the dry run and the live run", async () => {
      await plantClaim("T01", { claimedAt: new Date(), claimRunId: "live-run" });
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.state)).toEqual(["in_progress", "new"]);
      await db.specKitTaskExport.updateMany({
        where: { taskId: "T01" },
        data: { issueNumber: 77, claimRunId: null },
      });
      await expect(publish(plan)).rejects.toMatchObject({
        status: 409,
        code: "SPECKIT_EXPORT_PLAN_CHANGED",
      });
      expect(issuePosts()).toEqual([]);
    });

    /**
     * Run `runs` concurrently, holding each one's compare-and-swap takeover (an
     * `updateMany` that sets a run id) until every run has reached it. Keyed on
     * the write, not the predicate, so removing the predicate still races.
     */
    async function raceTakeovers<T>(runs: Array<() => Promise<T>>) {
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((r) => (release = r));
      const rows = db.specKitTaskExport;
      state.db = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "specKitTaskExport") return Reflect.get(target, prop, receiver);
          return new Proxy(rows, {
            get(t, key) {
              const v = Reflect.get(t, key, t) as unknown;
              if (typeof v !== "function") return v;
              if (key !== "updateMany") return v.bind(t);
              return async (args: { data: { claimRunId?: string | null } }) => {
                if (typeof args.data.claimRunId === "string") {
                  arrived += 1;
                  if (arrived >= runs.length) release();
                  await barrier;
                }
                return (v as (a: unknown) => Promise<unknown>).call(t, args);
              };
            },
          });
        },
      });
      try {
        const results = await Promise.allSettled(runs.map((r) => r().finally(() => release())));
        return { results, arrived };
      } finally {
        state.db = db;
      }
    }

    it("two live runs racing to take over one abandoned claim: one wins, the other gets 409, one create per task", async () => {
      await plantClaim("T01", ABANDONED());
      const plan = await previewTasksExport(base());
      expect(plan.created.map((c) => c.state)).toEqual(["reconcile", "new"]);
      const { results, arrived } = await raceTakeovers([() => publish(plan), () => publish(plan)]);
      expect(arrived).toBe(2);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({
        status: 409,
        code: "SPECKIT_EXPORT_IN_PROGRESS",
      });
      // Only the winner looked the task up, and GitHub saw each task created once.
      expect(listCalls()).toHaveLength(1);
      expect(postedTitles()).toEqual(["[T01] Build A", "[T02] Build B"]);
      const rows = await db.specKitTaskExport.findMany({
        orderBy: { taskId: "asc" },
      });
      expect(rows.map((r) => [r.taskId, r.issueNumber])).toEqual([
        ["T01", 101],
        ["T02", 102],
      ]);
    });

    it("two Clear-stuck runs racing on one abandoned claim: one resolves it, the other reports it in progress", async () => {
      await plantClaim("T01", ABANDONED());
      preFiled("T01", "[T01] Build A");
      const { results, arrived } = await raceTakeovers([
        () => clearStuckTasksExport(base()),
        () => clearStuckTasksExport(base()),
      ]);
      expect(arrived).toBe(2);
      const outs = results.map((r) => (r as PromiseFulfilledResult<ClearOut>).value);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const winners = outs.filter((o) => o.adopted.length === 1);
      const losers = outs.filter((o) => o.inProgress.includes("T01"));
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.adopted).toEqual([]);
      expect(losers[0]!.cleared).toEqual([]);
      expect(listCalls()).toHaveLength(1);
      expect(issuePosts()).toEqual([]);
      const rows = await db.specKitTaskExport.findMany();
      expect(rows.map((r) => [r.taskId, r.issueNumber])).toEqual([["T01", 101]]);
    });
    // ── #953: every refusal of a live export is audited, plan stage included ──

    const DUMMY_PLAN = { tasksVersion: 1, digest: "0".repeat(64) };
    async function expectRefusedAudited(code: string, run: () => Promise<unknown>) {
      vi.mocked(audit).mockClear();
      await expect(run()).rejects.toMatchObject({ code });
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "speckit.tasks_export_refused",
          metadata: expect.objectContaining({ code, featureSlug: SLUG }),
        }),
      );
      expect(issuePosts()).toEqual([]);
    }

    it("audits the tasks gate's 412 refusal of a live export", async () => {
      await db.specKitFeatureArtifact.deleteMany({ where: { key: "tasks.md" } });
      await expectRefusedAudited("SPECKIT_GATE_UNMET", () =>
        exportTasksToGitHub({ ...base(), expectedPlan: DUMMY_PLAN }),
      );
    });

    it("audits the missing-tasks.md 412 refusal of a forced live export", async () => {
      await db.specKitFeatureArtifact.deleteMany({ where: { key: "tasks.md" } });
      await expectRefusedAudited("SPECKIT_GATE_UNMET", () =>
        exportTasksToGitHub({ ...base(), force: true, expectedPlan: DUMMY_PLAN }),
      );
    });

    it("audits the dependency-cycle 400 refusal of a live export", async () => {
      await db.specKitFeatureArtifact.updateMany({
        where: { key: "tasks.md" },
        data: {
          content: [
            "| ID | Title | SP | Deps | Notes |",
            "| --- | --- | --- | --- | --- |",
            "| T01 | Build A | 3 | T02 |  |",
            "| T02 | Build B | 2 | T01 |  |",
          ].join("\n"),
        },
      });
      await expectRefusedAudited("SPECKIT_TASKS_CYCLE", () =>
        exportTasksToGitHub({ ...base(), expectedPlan: DUMMY_PLAN }),
      );
    });

    it("audits the 422 refusal of an oversized live export", async () => {
      process.env.SPECKIT_EXPORT_MAX_ISSUES = "1";
      await expectRefusedAudited("SPECKIT_EXPORT_TOO_LARGE", () => planThenPublish());
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
