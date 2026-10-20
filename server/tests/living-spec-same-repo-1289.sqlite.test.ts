/**
 * #1289 — a merged pull request is linked only to requirements whose published
 * issue is in the SAME repository as the pull request.
 *
 * The webhook is global (one secret, no project context), so before this fix a
 * merged pull request in one workspace's repository saying "Closes #5" marked
 * every requirement published as issue #5 anywhere — another project's, in
 * another repository, even a Jira issue numbered 5 — as implemented, and wrote
 * `RequirementImplementation` rows onto it.
 *
 * Proven against a REAL SQLite database built by the real migration chain, so
 * the filter is the one production runs (a stub that ignores the `where` clause
 * could not tell a query filter from no filter at all).
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const noteRequirementCodeLinksChanged = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged,
}));

const { syncMergedPR } = await import("../src/lib/living-spec/requirement-sync.js");

const T0 = "2026-10-01T00:00:00.000Z";
const DIFF = `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1289 — a merged PR links only requirements published to its own repository (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1289-same-repo");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      // Three projects, each with one requirement published as issue #5:
      //   pA → GitHub acme/app, pB → GitHub other/svc, pC → Jira (number 5).
      await seed("pA", { destination: "github", owner: "acme", repo: "app" });
      await seed("pB", { destination: "github", owner: "other", repo: "svc" });
      await seed("pC", { destination: "jira", owner: "other", repo: "svc" });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function seed(
      p: string,
      target: { destination: string; owner: string; repo: string },
    ): Promise<void> {
      await db.project.create({
        data: { id: p, name: p, slug: `slug-${p}`, createdById: "u1" },
      });
      await db.analysis.create({ data: { id: `an_${p}`, projectId: p, startedById: "u1" } });
      await db.requirement.create({
        data: {
          id: `req_${p}`,
          projectId: p,
          analysisId: `an_${p}`,
          title: `Requirement of ${p}`,
          body: "body",
        },
      });
      await db.issueDraft.create({
        data: {
          id: `draft_${p}`,
          projectId: p,
          requirementId: `req_${p}`,
          title: `Draft of ${p}`,
          body: "body",
          status: "published",
        },
      });
      const batch = await db.publishBatch.create({
        data: {
          projectId: p,
          targetOwner: target.owner,
          targetRepo: target.repo,
          startedById: "u1",
          status: "completed",
        },
      });
      await db.publishedIssue.create({
        data: {
          batchId: batch.id,
          draftId: `draft_${p}`,
          issueNumber: 5,
          issueId: `node_${p}`,
          htmlUrl:
            target.destination === "github"
              ? `https://github.com/${target.owner}/${target.repo}/issues/5`
              : "",
          destination: target.destination,
        },
      });
    }

    async function implementationsOf(requirementId: string) {
      return db.requirementImplementation.findMany({ where: { requirementId } });
    }

    it("a PR in other/svc closing #5 links only pB's requirement — not pA's (other repo) nor pC's (Jira)", async () => {
      const out = await syncMergedPR({
        pr: {
          number: 9,
          merged: true,
          merged_at: T0,
          body: "Closes #5",
          merge_commit_sha: "sha9",
          // Owner and name differ in case from the batch target: GitHub treats
          // them case-insensitively, and so must the match.
          html_url: "https://github.com/Other/SVC/pull/9",
        },
        repo: { full_name: "Other/SVC", html_url: "https://github.com/Other/SVC" },
        diff: DIFF,
      });

      expect(out.requirementsUpdated).toBe(1);
      expect(out.implementationsCreated).toBe(1);
      expect(await implementationsOf("req_pB")).toHaveLength(1);
      expect(await implementationsOf("req_pA")).toHaveLength(0);
      expect(await implementationsOf("req_pC")).toHaveLength(0);

      const reqs = await db.requirement.findMany({
        where: { id: { in: ["req_pA", "req_pB", "req_pC"] } },
        select: { id: true, implementedByPr: true },
        orderBy: { id: "asc" },
      });
      expect(reqs).toEqual([
        { id: "req_pA", implementedByPr: null },
        { id: "req_pB", implementedByPr: 9 },
        { id: "req_pC", implementedByPr: null },
      ]);
    });

    it("a PR in acme/app closing #5 links only pA's requirement", async () => {
      const out = await syncMergedPR({
        pr: {
          number: 11,
          merged: true,
          merged_at: T0,
          body: "Fixes #5",
          merge_commit_sha: "sha11",
          html_url: "https://github.com/acme/app/pull/11",
        },
        repo: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
        diff: DIFF,
      });
      expect(out.requirementsUpdated).toBe(1);
      expect((await implementationsOf("req_pA")).map((r) => r.prNumber)).toEqual([11]);
      expect((await implementationsOf("req_pB")).map((r) => r.prNumber)).toEqual([9]);
      expect(await implementationsOf("req_pC")).toHaveLength(0);
    });

    it("a PR in a repository no project published to links nothing", async () => {
      const out = await syncMergedPR({
        pr: {
          number: 12,
          merged: true,
          body: "Closes #5",
          html_url: "https://github.com/stranger/repo/pull/12",
        },
        repo: { full_name: "stranger/repo", html_url: "https://github.com/stranger/repo" },
        diff: DIFF,
      });
      expect(out).toEqual({ requirementsUpdated: 0, implementationsCreated: 0, driftedFiles: [] });
      expect(await db.requirementImplementation.count({ where: { prNumber: 12 } })).toBe(0);
    });
  },
);
