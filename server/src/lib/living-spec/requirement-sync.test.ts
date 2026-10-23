/**
 * Epic #192 (A.5) — living-spec sync tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const noteRequirementCodeLinksChanged = vi.hoisted(() => vi.fn());
vi.mock("../docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged,
}));

import { syncMergedPR } from "./requirement-sync.js";

beforeEach(() => noteRequirementCodeLinksChanged.mockReset());

interface PrismaStub {
  publishedIssue: { findMany: ReturnType<typeof vi.fn> };
  requirement: { updateMany: ReturnType<typeof vi.fn> };
  requirementImplementation: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  repoConnection: { findMany: ReturnType<typeof vi.fn> };
}

function mkPrisma(overrides: Partial<PrismaStub> = {}): PrismaStub {
  return {
    publishedIssue: { findMany: vi.fn(async () => []), ...overrides.publishedIssue },
    requirement: { updateMany: vi.fn(async () => ({ count: 0 })), ...overrides.requirement },
    requirementImplementation: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      ...overrides.requirementImplementation,
    },
    // #1246 — proj1 connects acme/proj, the repository the PRs below are in.
    repoConnection: {
      findMany: vi.fn(async () => [
        { id: "conn1", projectId: "proj1", ownerOrOrg: "acme", repoName: "proj" },
      ]),
      ...overrides.repoConnection,
    },
  };
}

const repo = { full_name: "acme/proj", html_url: "https://github.com/acme/proj" };
/** #1289 — the publish batch target of an issue published to acme/proj, the PRs' repository. */
const ACME = { targetOwner: "acme", targetRepo: "proj" };
const DIFF = `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n`;

describe("syncMergedPR", () => {
  it("checks only the projects that connect the PR's repository, for requirements that gained a row (#1246)", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        // #5 of acme/proj is also published by another project, one that
        // does not connect acme/proj.
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req-mine", projectId: "proj1" }, batch: ACME },
          {
            issueNumber: 5,
            draft: { requirementId: "req-theirs", projectId: "proj-other" },
            batch: ACME,
          },
          { issueNumber: 6, draft: { requirementId: "req-done", projectId: "proj1" }, batch: ACME },
        ]),
      },
      requirementImplementation: {
        // req-done already has this PR's row: it gains nothing.
        findFirst: vi.fn(async ({ where }: { where: { requirementId: string } }) =>
          where.requirementId === "req-done" ? { id: "existing" } : null,
        ),
        create: vi.fn(async () => ({})),
      },
      repoConnection: {
        findMany: vi.fn(async () => [
          { id: "conn1", projectId: "proj1", ownerOrOrg: "acme", repoName: "proj" },
          { id: "conn2", projectId: "proj-other", ownerOrOrg: "else", repoName: "where" },
        ]),
      },
    });
    const out = await syncMergedPR(
      {
        pr: {
          number: 42,
          merged: true,
          body: "Closes #5\nCloses #6",
          merge_commit_sha: "abc",
          html_url: "https://github.com/acme/proj/pull/42",
        },
        repo,
        diff: `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.implementationsCreated).toBe(2);
    expect(prisma.repoConnection.findMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["proj1", "proj-other"] }, deletedAt: null },
      select: { id: true, projectId: true, ownerOrOrg: true, repoName: true },
    });
    expect(noteRequirementCodeLinksChanged).toHaveBeenCalledTimes(1);
    expect(noteRequirementCodeLinksChanged).toHaveBeenCalledWith(["req-mine"]);
  });

  it("still syncs the PR when the connection lookup for the check fails (PR #1287 review)", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req-mine", projectId: "proj1" }, batch: ACME },
        ]),
      },
      repoConnection: { findMany: vi.fn(async () => Promise.reject(new Error("db down"))) },
    });
    const out = await syncMergedPR(
      {
        pr: {
          number: 42,
          merged: true,
          body: "Closes #5",
          merge_commit_sha: "abc",
          html_url: "https://github.com/acme/proj/pull/42",
        },
        repo,
        diff: `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.implementationsCreated).toBe(1);
    expect(noteRequirementCodeLinksChanged).not.toHaveBeenCalled();
  });

  it("checks nothing when no project connects the PR's repository (#1246)", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          {
            issueNumber: 5,
            draft: { requirementId: "req-theirs", projectId: "proj-other" },
            batch: ACME,
          },
        ]),
      },
      repoConnection: { findMany: vi.fn(async () => []) },
    });
    const out = await syncMergedPR(
      {
        pr: {
          number: 42,
          merged: true,
          body: "Closes #5",
          merge_commit_sha: "abc",
          html_url: "https://github.com/acme/proj/pull/42",
        },
        repo,
        diff: `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n`,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.implementationsCreated).toBe(1);
    expect(noteRequirementCodeLinksChanged).not.toHaveBeenCalled();
  });

  it("no-ops when PR is not merged", async () => {
    const prisma = mkPrisma();
    const out = await syncMergedPR(
      {
        pr: { number: 1, merged: false, body: "Closes #5", html_url: "" },
        repo,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.requirementsUpdated).toBe(0);
    expect(prisma.publishedIssue.findMany).not.toHaveBeenCalled();
  });

  it("returns 0 when PR body has no Closes # links", async () => {
    const prisma = mkPrisma();
    const out = await syncMergedPR(
      {
        pr: {
          number: 1,
          merged: true,
          body: "no links here",
          merged_at: "2026-04-26T00:00:00Z",
        },
        repo,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.requirementsUpdated).toBe(0);
  });

  it("returns 0 when no PublishedIssue matches the closed issue numbers", async () => {
    const prisma = mkPrisma({
      publishedIssue: { findMany: vi.fn(async () => []) },
    });
    const out = await syncMergedPR(
      {
        pr: { number: 1, merged: true, body: "Closes #5" },
        repo,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.requirementsUpdated).toBe(0);
    expect(prisma.publishedIssue.findMany).toHaveBeenCalledWith({
      // #1438 — a soft-deleted project's issues are never matched.
      where: {
        issueNumber: { in: [5] },
        destination: "github",
        draft: { project: { deletedAt: null } },
      },
      include: { draft: true, batch: { select: { targetOwner: true, targetRepo: true } } },
    });
  });

  it("links only issues published to the PR's repository, owner and name case-insensitive (#1289)", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          {
            issueNumber: 5,
            draft: { requirementId: "req-mine", projectId: "proj1" },
            batch: { targetOwner: "ACME", targetRepo: "Proj.git" },
          },
          {
            issueNumber: 5,
            draft: { requirementId: "req-other-repo", projectId: "proj2" },
            batch: { targetOwner: "acme", targetRepo: "proj-fork" },
          },
          {
            issueNumber: 5,
            draft: { requirementId: "req-other-owner", projectId: "proj3" },
            batch: { targetOwner: "evil", targetRepo: "proj" },
          },
        ]),
      },
    });
    const out = await syncMergedPR(
      {
        pr: {
          number: 42,
          merged: true,
          body: "Closes #5",
          merge_commit_sha: "abc",
          html_url: "https://github.com/Acme/PROJ/pull/42",
        },
        repo,
        diff: DIFF,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.requirementsUpdated).toBe(1);
    expect(prisma.requirement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["req-mine"] }, implementedAt: null } }),
    );
    expect(prisma.requirementImplementation.create).toHaveBeenCalledTimes(1);
    expect(prisma.requirementImplementation.create.mock.calls[0][0].data.requirementId).toBe(
      "req-mine",
    );
  });

  it("links nothing, and reads no published issue, when the PR's repository is unknown (#1289)", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" }, batch: ACME },
        ]),
      },
    });
    const out = await syncMergedPR(
      // No PR URL and no repository URL: nothing names the repository.
      { pr: { number: 1, merged: true, body: "Closes #5" }, repo: {}, diff: DIFF },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out).toEqual({ requirementsUpdated: 0, implementationsCreated: 0, driftedFiles: [] });
    expect(prisma.publishedIssue.findMany).not.toHaveBeenCalled();
    expect(prisma.requirement.updateMany).not.toHaveBeenCalled();
  });

  it.each([["acme"], ["acme/proj/extra"], ["acme/ "], [""]])(
    "links nothing when the payload's full_name %j names no repository (#1289)",
    async (fullName) => {
      const prisma = mkPrisma({
        publishedIssue: {
          findMany: vi.fn(async () => [
            { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" }, batch: ACME },
          ]),
        },
      });
      const out = await syncMergedPR(
        { pr: { number: 1, merged: true, body: "Closes #5" }, repo: { full_name: fullName } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { prisma: prisma as any },
      );
      expect(out.requirementsUpdated).toBe(0);
      expect(prisma.publishedIssue.findMany).not.toHaveBeenCalled();
    },
  );

  it("reads the repository from full_name when the payload carries no URL (#1289)", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" }, batch: ACME },
          {
            issueNumber: 5,
            draft: { requirementId: "req-elsewhere", projectId: "proj2" },
            batch: { targetOwner: "else", targetRepo: "where" },
          },
        ]),
      },
    });
    const out = await syncMergedPR(
      { pr: { number: 1, merged: true, body: "Closes #5" }, repo: { full_name: "Acme/Proj" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.requirementsUpdated).toBe(1);
    expect(prisma.requirement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["req1"] }, implementedAt: null } }),
    );
  });

  it("updates linked requirements and creates implementation rows from the diff", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" }, batch: ACME },
          { issueNumber: 7, draft: { requirementId: "req2", projectId: "proj1" }, batch: ACME },
          // duplicate requirement id should be deduped
          { issueNumber: 7, draft: { requirementId: "req2", projectId: "proj1" }, batch: ACME },
          // null requirementId should be skipped
          { issueNumber: 9, draft: { requirementId: null, projectId: "proj1" }, batch: ACME },
        ]),
      },
    });
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@
+x
--- a/random.txt
+++ b/random.txt
@@ -1 +1 @@
-x
+y
`;
    const out = await syncMergedPR(
      {
        pr: {
          number: 42,
          merged: true,
          body: "Closes #5\nFixes #7\nCloses #9",
          merged_at: "2026-04-26T00:00:00Z",
          merge_commit_sha: "abc123",
          html_url: "https://github.com/acme/proj/pull/42",
        },
        repo,
        diff,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(prisma.requirement.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["req1", "req2"] }, implementedAt: null },
      data: expect.objectContaining({
        implementedByPr: 42,
        implementedBySha: "abc123",
      }),
    });
    expect(out.requirementsUpdated).toBe(2);
    // 2 requirements * 2 hunks = 4 implementation rows
    expect(out.implementationsCreated).toBe(4);
    expect(out.driftedFiles).toEqual(["random.txt"]);
    // #1246 — new code links can move a scoped reader BRD's approved list.
    expect(noteRequirementCodeLinksChanged).toHaveBeenCalledTimes(1);
    expect(noteRequirementCodeLinksChanged).toHaveBeenCalledWith(["req1", "req2"]);
  });

  it("is idempotent — skips existing implementation rows on re-merge", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" }, batch: ACME },
        ]),
      },
      requirementImplementation: {
        findFirst: vi.fn(async () => ({ id: "existing" })),
        create: vi.fn(async () => ({})),
      },
    });
    const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
+x
`;
    const out = await syncMergedPR(
      {
        pr: { number: 42, merged: true, body: "Closes #5", merge_commit_sha: "abc" },
        repo,
        diff,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    expect(out.implementationsCreated).toBe(0);
    expect(prisma.requirementImplementation.create).not.toHaveBeenCalled();
    // #1246 — no new code link: nothing to check.
    expect(noteRequirementCodeLinksChanged).not.toHaveBeenCalled();
  });

  it("falls back to head.sha when merge_commit_sha is missing", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" }, batch: ACME },
        ]),
      },
    });
    await syncMergedPR(
      {
        pr: { number: 1, merged: true, body: "Closes #5", head: { sha: "fallback" } },
        repo,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { prisma: prisma as any },
    );
    const update = prisma.requirement.updateMany.mock.calls[0][0];
    expect(update.data.implementedBySha).toBe("fallback");
  });
});
