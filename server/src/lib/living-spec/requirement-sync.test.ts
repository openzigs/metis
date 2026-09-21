/**
 * Epic #192 (A.5) — living-spec sync tests.
 */
import { describe, expect, it, vi } from "vitest";
import { syncMergedPR } from "./requirement-sync.js";

interface PrismaStub {
  publishedIssue: { findMany: ReturnType<typeof vi.fn> };
  requirement: { updateMany: ReturnType<typeof vi.fn> };
  requirementImplementation: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
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
  };
}

const repo = { full_name: "acme/proj", html_url: "https://github.com/acme/proj" };

describe("syncMergedPR", () => {
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
      where: { issueNumber: { in: [5] } },
      include: { draft: true },
    });
  });

  it("updates linked requirements and creates implementation rows from the diff", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" } },
          { issueNumber: 7, draft: { requirementId: "req2", projectId: "proj1" } },
          // duplicate requirement id should be deduped
          { issueNumber: 7, draft: { requirementId: "req2", projectId: "proj1" } },
          // null requirementId should be skipped
          { issueNumber: 9, draft: { requirementId: null, projectId: "proj1" } },
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
  });

  it("is idempotent — skips existing implementation rows on re-merge", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" } },
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
  });

  it("falls back to head.sha when merge_commit_sha is missing", async () => {
    const prisma = mkPrisma({
      publishedIssue: {
        findMany: vi.fn(async () => [
          { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" } },
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
