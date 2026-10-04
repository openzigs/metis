/**
 * #776 — batch issue drafts can be edited before publish, and a single draft
 * can become a DRAFT pull request against the configured publish target.
 *
 * Real SQLite built by the migration chain, the real `VaultService` and the
 * real generator; only GitHub is faked (the publish Octokit factory seam).
 * Every assertion about stored state reads the row back from the database.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const { editDraft } = await import("../src/lib/publishing/draft-edit.js");
const { openDraftPullRequest, draftPullRequestBranch, draftPullRequestPath } =
  await import("../src/lib/publishing/draft-pull-request.js");
const { generateDrafts } = await import("../src/lib/publishing/draft-generator.js");
const { __setPublishOctokitFactory, __resetPublishOctokitCache } =
  await import("../src/lib/publishing/octokit-factory.js");
const { audit } = await import("../src/lib/audit/audit-service.js");

const MASTER_KEY = Buffer.alloc(32, 6).toString("base64");
const USER = "u776";
const P = "p776";
const TOKEN = "ghp_publish_token_776";
/** No `vault.reveal`: may use only secrets it created (#344). */
const ROLE = "coordinator" as const;
const OTHER = "u776-other";
const OTHER_TOKEN = "ghp_someone_elses_token_776";

interface Call {
  method: string;
  url: string;
  data?: unknown;
  token: string;
  baseUrl: string;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#776 — editable drafts and the draft-PR path (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let vault: InstanceType<typeof VaultService>;
    const prevKey = process.env.VAULT_MASTER_KEY;
    let seq = 0;
    const calls: Call[] = [];
    /** Per-test override of the fake GitHub's answer to one request. */
    let respond: (c: Call) => { status: number; data: unknown } | undefined = () => undefined;

    async function draft(over: Record<string, unknown> = {}) {
      seq += 1;
      return db.issueDraft.create({
        data: {
          projectId: P,
          draftType: "feature",
          title: `[Feature] Migrations race ${seq}`,
          body: "_No acceptance criteria were derived from the analysis evidence._",
          labels: JSON.stringify(["feature", "finding:cmurn1ree0v9vns9k9utay9ks"]),
          status: "draft",
          dedupHash: `hash-${seq}`,
          metadata: JSON.stringify({ analysisId: "an-1", targetOwner: "openzigs" }),
          ...over,
        },
      });
    }

    async function setTarget(owner: string | null, repo: string | null) {
      await db.project.update({
        where: { id: P },
        data: { publishGithubOwner: owner, publishGithubRepo: repo },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("776-draft-edit-pr");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.VAULT_MASTER_KEY = MASTER_KEY;
      __resetVaultSingleton();
      vault = new VaultService({ masterKey: MASTER_KEY, isProduction: false });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      for (const id of [P, "p-other"]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
      // The analysed upstream — never a publish target.
      await db.repoConnection.create({
        data: {
          projectId: P,
          label: "upstream",
          ownerOrOrg: "miniflux",
          repoName: "v2",
          isPrimary: true,
          status: "connected",
        },
      });
      await vault.create("github-flux-v2-sandbox", TOKEN, "global", { createdById: USER });
      await db.user.create({
        data: { id: OTHER, username: OTHER, displayName: OTHER, email: `${OTHER}@x.test` },
      });
      await vault.create("someone-elses-github", OTHER_TOKEN, "global", { createdById: OTHER });
      // A connector removed after analysis: the project still holds its analysis.
      await db.repoConnection.create({
        data: {
          projectId: P,
          label: "removed",
          ownerOrOrg: "oldorg",
          repoName: "gone",
          status: "connected",
          deletedAt: new Date(),
        },
      });
      // An uploaded clone: no owner/repo, so it identifies no GitHub repository.
      await db.repoConnection.create({
        data: { projectId: P, label: "uploaded", provider: "upload", status: "connected" },
      });
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
          if (args.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(u)) {
            data = { default_branch: "main" };
          } else if (u.includes("/git/ref/heads/")) {
            data = { object: { sha: "base-sha" } };
          } else if (u.includes("/contents/")) {
            if (args.method === "GET") {
              throw Object.assign(new Error("Not Found"), { status: 404 });
            }
            data = { content: { sha: "file-sha" } };
          } else if (u.endsWith("/pulls") && args.method === "POST") {
            data = { number: 7, html_url: "https://github.com/openzigs/flux-v2/pull/7" };
          }
          return { status: 200, headers: {}, data: data as T };
        },
      }));
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      calls.length = 0;
      respond = () => undefined;
      __resetPublishOctokitCache();
      vi.mocked(audit).mockClear();
      await setTarget("openzigs", "flux-v2");
    });

    afterAll(async () => {
      __setPublishOctokitFactory(null);
      await db?.$disconnect();
      sqlite?.cleanup();
      if (prevKey === undefined) delete process.env.VAULT_MASTER_KEY;
      else process.env.VAULT_MASTER_KEY = prevKey;
      __resetVaultSingleton();
    });

    // ---- 1. editable drafts --------------------------------------------------

    describe("editDraft", () => {
      it("refuses (409) and writes nothing when a batch claims the draft mid-edit", async () => {
        const d = await draft({ status: "approved" });
        const realFindFirst = db.issueDraft.findFirst.bind(db.issueDraft);
        // A batch moves the draft to `publishing` between editDraft's read and write.
        const spy = vi.spyOn(db.issueDraft, "findFirst").mockImplementationOnce((async (
          args: Parameters<typeof realFindFirst>[0],
        ) => {
          const row = await realFindFirst(args);
          await db.issueDraft.update({ where: { id: d.id }, data: { status: "publishing" } });
          return row;
        }) as unknown as typeof realFindFirst);
        try {
          await expect(
            editDraft({ draftId: d.id, projectId: P, actorId: USER, input: { body: "late edit" } }),
          ).rejects.toMatchObject({ status: 409, code: "DRAFT_NOT_EDITABLE" });
        } finally {
          spy.mockRestore();
        }
        const row = await db.issueDraft.findUniqueOrThrow({ where: { id: d.id } });
        // The batch's claim stands and the in-flight text is untouched.
        expect(row.status).toBe("publishing");
        expect(row.body).toBe(d.body);
        expect(vi.mocked(audit)).not.toHaveBeenCalled();
      });

      it("leaves a failed draft's status alone (no stale status write-back)", async () => {
        const d = await draft({ status: "failed" });
        const out = await editDraft({
          draftId: d.id,
          projectId: P,
          actorId: USER,
          input: { body: "fixed body" },
        });
        expect(out.status).toBe("failed");
        expect(out.body).toBe("fixed body");
      });

      it("changes title, body and labels, keeps the dedup key and records the edit", async () => {
        const d = await draft();
        const out = await editDraft({
          draftId: d.id,
          projectId: P,
          actorId: USER,
          input: {
            title: "[metis-706 re-run] Lock migrations",
            body: "## Acceptance criteria\n- [ ] a lock is taken",
            labels: ["feature"],
          },
        });
        expect(out.title).toBe("[metis-706 re-run] Lock migrations");
        const row = await db.issueDraft.findUniqueOrThrow({ where: { id: d.id } });
        expect(row.title).toBe("[metis-706 re-run] Lock migrations");
        expect(row.body).toContain("a lock is taken");
        expect(JSON.parse(row.labels)).toEqual(["feature"]);
        expect(row.dedupHash).toBe(d.dedupHash);
        const meta = JSON.parse(row.metadata ?? "{}");
        expect(meta.userEdited).toBe(true);
        expect(meta.analysisId).toBe("an-1");
        expect(vi.mocked(audit)).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "publish.draft.edit",
            metadata: expect.objectContaining({ fields: ["title", "body", "labels"] }),
          }),
        );
      });

      it("sends an edited approved draft back to draft, so the sign-off covers the new text", async () => {
        const d = await draft({ status: "approved" });
        const out = await editDraft({
          draftId: d.id,
          projectId: P,
          actorId: USER,
          input: { body: "new body" },
        });
        expect(out.status).toBe("draft");
      });

      it("refuses to edit a published or in-flight draft", async () => {
        for (const status of ["published", "publishing"]) {
          const d = await draft({ status });
          await expect(
            editDraft({ draftId: d.id, projectId: P, actorId: USER, input: { body: "x" } }),
          ).rejects.toMatchObject({ status: 409, code: "DRAFT_NOT_EDITABLE" });
        }
      });

      it("404s a draft of another project, or a deleted one", async () => {
        const foreign = await draft({ projectId: "p-other" });
        const gone = await draft({ deletedAt: new Date() });
        for (const id of [foreign.id, gone.id, "nope"]) {
          await expect(
            editDraft({ draftId: id, projectId: P, actorId: USER, input: { body: "x" } }),
          ).rejects.toMatchObject({ status: 404, code: "DRAFT_NOT_FOUND" });
        }
      });

      it("refuses a title another live draft in the project already uses", async () => {
        const a = await draft();
        const b = await draft();
        await expect(
          editDraft({
            draftId: b.id,
            projectId: P,
            actorId: USER,
            input: { title: `  ${a.title.toUpperCase()} ` },
          }),
        ).rejects.toMatchObject({ status: 409, code: "DRAFT_TITLE_TAKEN" });
      });

      it("a regenerate keeps the reviewer's edit instead of overwriting it", async () => {
        const an = await db.analysis.create({
          data: { projectId: P, status: "completed", startedById: USER },
        });
        const req = await db.requirement.create({
          data: {
            analysisId: an.id,
            projectId: P,
            title: `Migrations are applied without a lock ${++seq}`,
            body: "Generated body",
            type: "feature",
            priority: "high",
          },
        });
        const gen = {
          projectId: P,
          analysisId: an.id,
          targetOwner: "openzigs",
          targetRepo: "flux-v2",
        };
        await generateDrafts(gen);
        const feature = await db.issueDraft.findFirstOrThrow({
          where: { projectId: P, requirementId: req.id },
        });
        await editDraft({
          draftId: feature.id,
          projectId: P,
          actorId: USER,
          input: { title: "Edited title 776", body: "Edited body 776", labels: ["edited"] },
        });
        await generateDrafts(gen);
        const after = await db.issueDraft.findUniqueOrThrow({ where: { id: feature.id } });
        expect(after.title).toBe("Edited title 776");
        expect(after.body).toBe("Edited body 776");
        expect(JSON.parse(after.labels)).toEqual(["edited"]);
        expect(JSON.parse(after.metadata ?? "{}").userEdited).toBe(true);
        // No duplicate draft was created for the generated title.
        expect(
          await db.issueDraft.count({
            where: { projectId: P, deletedAt: null, requirement: { analysisId: an.id } },
          }),
        ).toBe(1);
      });
    });

    // ---- 2. draft pull request -----------------------------------------------

    describe("openDraftPullRequest", () => {
      it("a dry run plans against the SAVED target and touches nothing", async () => {
        const d = await draft();
        const plan = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: true,
          secretRef: "${vault:github-flux-v2-sandbox}",
        });
        expect(plan.dryRun).toBe(true);
        expect(plan.target).toEqual({ owner: "openzigs", repo: "flux-v2" });
        expect(plan.branch).toBe(draftPullRequestBranch(d.id));
        expect(plan.path).toBe(draftPullRequestPath(d.id));
        expect(plan.actions.map((a) => a.kind)).toEqual([
          "branch.create",
          "file.commit",
          "pullRequest.createDraft",
        ]);
        expect(plan.credentialCheck).toBe("resolved");
        expect(plan.pullRequest).toBeNull();
        expect(calls).toEqual([]);
        expect(JSON.stringify(plan)).not.toContain(TOKEN);
      });

      it("a dry run reports a missing or unresolvable credential without failing", async () => {
        const d = await draft();
        const missing = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: true,
        });
        expect(missing.credentialCheck).toBe("missing");
        const bad = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: true,
          secretRef: "${vault:no-such}",
        });
        expect(bad.credentialCheck).toBe("unresolved");
      });

      it("refuses when no publish target is saved — it never falls back to the analysed repo", async () => {
        await setTarget(null, null);
        const d = await draft();
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: d.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: true,
          }),
        ).rejects.toMatchObject({ status: 409, code: "PUBLISH_TARGET_NOT_CONFIGURED" });
        expect(calls).toEqual([]);
      });

      it("refuses a saved target that IS the analysed upstream repository", async () => {
        await setTarget("MiniFlux", "V2");
        const d = await draft();
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: d.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: true,
          }),
        ).rejects.toMatchObject({ status: 409, code: "PUBLISH_TARGET_IS_ANALYSED_REPO" });
        expect(calls).toEqual([]);
      });

      it("refuses a target that is a SOFT-DELETED connection — the analysis outlives the connector", async () => {
        await setTarget("OldOrg", "Gone");
        const d = await draft();
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: d.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: true,
          }),
        ).rejects.toMatchObject({ status: 409, code: "PUBLISH_TARGET_IS_ANALYSED_REPO" });
        expect(calls).toEqual([]);
      });

      it("an upload/local connection (no owner/repo) matches no target, and the dry run says what it checked", async () => {
        const uploaded = await db.repoConnection.findFirstOrThrow({
          where: { projectId: P, label: "uploaded" },
        });
        expect([uploaded.ownerOrOrg, uploaded.repoName]).toEqual([null, null]);
        const d = await draft();
        const plan = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: true,
        });
        expect(plan.target).toEqual({ owner: "openzigs", repo: "flux-v2" });
        expect(plan.upstreamCheck.forkNetworkChecked).toBe(false);
        expect(plan.upstreamCheck.note).toMatch(/repository connections only/);
        expect(calls).toEqual([]);
      });

      it.each([
        ["parent", { parent: { full_name: "MiniFlux/V2" }, source: { full_name: "MiniFlux/V2" } }],
        ["source", { parent: { full_name: "someone/v2" }, source: { full_name: "miniflux/v2" } }],
        ["deleted connection", { parent: { full_name: "oldorg/gone" } }],
      ])(
        "a live run refuses a target whose fork %s is an analysed repo, before any write",
        async (_case, network) => {
          const d = await draft();
          respond = (c) =>
            c.method === "GET" && c.url === "/repos/openzigs/flux-v2"
              ? { status: 200, data: { default_branch: "main", fork: true, ...network } }
              : undefined;
          await expect(
            openDraftPullRequest({
              projectId: P,
              draftId: d.id,
              actorId: USER,
              actorRole: ROLE,
              dryRun: false,
              secretRef: "${vault:github-flux-v2-sandbox}",
            }),
          ).rejects.toMatchObject({ status: 409, code: "PUBLISH_TARGET_IS_ANALYSED_REPO" });
          expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /repos/openzigs/flux-v2"]);
        },
      );

      it("refuses another user's GitHub secret for a live run (repository writes need ownership)", async () => {
        const d = await draft();
        const err = (await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: false,
          secretRef: "${vault:someone-elses-github}",
        }).catch((e: unknown) => e)) as Error & { code?: string; statusCode?: number };
        expect(err).toMatchObject({ statusCode: 403, code: "SECRET_BINDING_FORBIDDEN" });
        expect(err.message).not.toContain(OTHER_TOKEN);
        expect(calls).toEqual([]);
        expect(vi.mocked(audit)).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "vault.binding_refused",
            target: { type: "issue_draft", id: d.id },
          }),
        );
      });

      it("an admin (vault.reveal) may use another user's secret, as on every binding path", async () => {
        const d = await draft();
        const out = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: "admin",
          dryRun: false,
          secretRef: "${vault:someone-elses-github}",
        });
        expect(out.pullRequest?.number).toBe(7);
        expect(calls.every((c) => c.token === OTHER_TOKEN)).toBe(true);
      });

      it("a live run needs a credential", async () => {
        const d = await draft();
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: d.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: false,
          }),
        ).rejects.toMatchObject({ status: 400, code: "TOKEN_REQUIRED" });
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: d.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: false,
            secretRef: "ghp_raw_token_pasted",
          }),
        ).rejects.toSatisfy(
          (e: Error & { code?: string }) =>
            e.code === "VAULT_REF_INVALID" && !e.message.includes("ghp_raw_token_pasted"),
        );
        expect(calls).toEqual([]);
      });

      it("a live run branches, commits the spec and opens a DRAFT PR on the saved target only", async () => {
        const d = await draft();
        const out = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: false,
          secretRef: "${vault:github-flux-v2-sandbox}",
        });
        expect(out.pullRequest).toEqual({
          number: 7,
          htmlUrl: "https://github.com/openzigs/flux-v2/pull/7",
          reused: false,
        });
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) {
          expect(c.url.startsWith("/repos/openzigs/flux-v2")).toBe(true);
          expect(c.token).toBe(TOKEN);
          expect(c.baseUrl).toBe("https://api.github.com");
        }
        const ref = calls.find((c) => c.url.endsWith("/git/refs") && c.method === "POST");
        expect(ref?.data).toEqual({ ref: `refs/heads/${out.branch}`, sha: "base-sha" });
        const put = calls.find((c) => c.method === "PUT");
        expect(put?.url).toContain(`/contents/${out.path}`);
        expect((put?.data as { branch: string }).branch).toBe(out.branch);
        const pr = calls.find((c) => c.url.endsWith("/pulls") && c.method === "POST");
        expect(pr?.data).toMatchObject({ head: out.branch, base: "main", draft: true });
        expect(JSON.stringify(out)).not.toContain(TOKEN);
        const meta = JSON.parse(
          (await db.issueDraft.findUniqueOrThrow({ where: { id: d.id } })).metadata ?? "{}",
        );
        expect(meta.pullRequest).toMatchObject({ number: 7, owner: "openzigs", repo: "flux-v2" });
        expect(out.upstreamCheck.forkNetworkChecked).toBe(true);
      });

      it("a re-run reuses the existing branch and open PR instead of failing", async () => {
        const d = await draft();
        respond = (c) => {
          if (c.url.endsWith("/git/refs") && c.method === "POST") return { status: 422, data: {} };
          if (c.url.endsWith("/pulls") && c.method === "POST") return { status: 422, data: {} };
          if (c.method === "GET" && c.url.includes("/pulls?")) {
            return {
              status: 200,
              data: [{ number: 9, html_url: "https://github.com/openzigs/flux-v2/pull/9" }],
            };
          }
          return undefined;
        };
        const out = await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: false,
          secretRef: "${vault:github-flux-v2-sandbox}",
        });
        expect(out.pullRequest).toEqual({
          number: 9,
          htmlUrl: "https://github.com/openzigs/flux-v2/pull/9",
          reused: true,
        });
      });

      it("a live run is refused by the approval gate, as a batch is (#619)", async () => {
        await db.project.update({ where: { id: P }, data: { requireApprovedReview: true } });
        try {
          const d = await draft();
          await expect(
            openDraftPullRequest({
              projectId: P,
              draftId: d.id,
              actorId: USER,
              actorRole: ROLE,
              dryRun: false,
              secretRef: "${vault:github-flux-v2-sandbox}",
            }),
          ).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_REQUIRED" });
          expect(calls).toEqual([]);
        } finally {
          await db.project.update({ where: { id: P }, data: { requireApprovedReview: false } });
        }
      });

      it("a live run is refused while its analysis has a pending approval (#257)", async () => {
        const an = await db.analysis.create({
          data: { projectId: P, status: "completed", startedById: USER },
        });
        const req = await db.requirement.create({
          data: {
            analysisId: an.id,
            projectId: P,
            title: `Gated ${++seq}`,
            body: "b",
            type: "feature",
            priority: "high",
          },
        });
        await db.approvalRequest.create({
          data: { analysisId: an.id, type: "requirement", itemId: req.id, status: "pending" },
        });
        const d = await draft({ requirementId: req.id });
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: d.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: false,
            secretRef: "${vault:github-flux-v2-sandbox}",
          }),
        ).rejects.toMatchObject({ status: 409, code: "PROMOTION_BLOCKED" });
        expect(calls).toEqual([]);
      });

      it("a GitHub failure surfaces as a fixed, token-free message", async () => {
        const d = await draft();
        respond = (c) => (c.method === "PUT" ? { status: 403, data: {} } : undefined);
        const err = (await openDraftPullRequest({
          projectId: P,
          draftId: d.id,
          actorId: USER,
          actorRole: ROLE,
          dryRun: false,
          secretRef: "${vault:github-flux-v2-sandbox}",
        }).catch((e: unknown) => e)) as Error & { code?: string; status?: number };
        expect(err).toMatchObject({ status: 502, code: "GITHUB_REQUEST_FAILED" });
        expect(err.message).not.toContain(TOKEN);
        expect(err.message).toContain("403");
      });

      it("404s a draft of another project and refuses an in-flight one", async () => {
        const foreign = await draft({ projectId: "p-other" });
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: foreign.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: true,
          }),
        ).rejects.toMatchObject({ status: 404, code: "DRAFT_NOT_FOUND" });
        const busy = await draft({ status: "publishing" });
        await expect(
          openDraftPullRequest({
            projectId: P,
            draftId: busy.id,
            actorId: USER,
            actorRole: ROLE,
            dryRun: true,
          }),
        ).rejects.toMatchObject({ status: 409, code: "DRAFT_NOT_EDITABLE" });
      });
    });
  },
);
