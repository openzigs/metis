/**
 * PR #638 security review, finding M2 — executeBatch must gate exactly the
 * draft set the Jira leg will publish.
 *
 * `publishBatchToJira` pushes EVERY id in the batch's `meta.draftIds`
 * regardless of draft status, while the #619 execution-time gate used to
 * load drafts filtered to publishable statuses. On a retried, partially
 * completed `destination=both` batch (GitHub leg already flipped drafts to
 * `published`), those drafts were invisible to the gate but still pushed to
 * Jira ungated. These tests pin gate-set == publish-set for Jira-bound
 * destinations, and that the GitHub-only destination keeps mirroring
 * runBatch's own status-filtered resolution (runBatch re-gates its exact
 * set itself).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DraftRow {
  id: string;
  projectId: string;
  status: string;
  deletedAt: Date | null;
  requirementId: string | null;
  metadata: string | null;
}

interface ProjectRow {
  publishDestination: string;
  jiraConnectionId: string | null;
  jiraProjectKey: string | null;
  requireApprovedReview: boolean;
}

let draftRows: DraftRow[] = [];
let requirementRows: { id: string; version: number }[] = [];
let reviewItems: { requirementId: string | null; pinnedVersion: number }[] = [];
let projectRow: ProjectRow;
let batchMetadata: string;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    publishBatch: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "batch_retry"
          ? {
              id: "batch_retry",
              projectId: "proj_1",
              status: "pending",
              dryRun: false,
              metadata: batchMetadata,
              startedById: "user_1",
            }
          : null,
      ),
      update: vi.fn(async () => ({})),
    },
    project: {
      findUnique: vi.fn(async () => projectRow),
    },
    issueDraft: {
      // Honors the filters the gate loader actually sends (projectId,
      // deletedAt, optional status.in, optional id.in) so the status-filter
      // divergence under test is faithfully reproduced.
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            projectId?: string;
            status?: { in: string[] };
            id?: { in: string[] };
          };
        }) =>
          draftRows
            .filter(
              (d) =>
                (!where.projectId || d.projectId === where.projectId) &&
                !d.deletedAt &&
                (!where.status || where.status.in.includes(d.status)) &&
                (!where.id || where.id.in.includes(d.id)),
            )
            .map(({ id, requirementId, metadata }) => ({ id, requirementId, metadata })),
      ),
    },
    requirement: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        requirementRows.filter((r) => where.id.in.includes(r.id)),
      ),
    },
    reviewRequestItem: {
      findMany: vi.fn(async () => reviewItems),
    },
    publishedIssue: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
  },
}));

vi.mock("../src/lib/publishing/publisher.js", () => ({
  runBatch: vi.fn(async () => ({ status: "completed" })),
  archiveBatch: vi.fn(),
}));

vi.mock("../src/lib/publishing/jira-publisher.js", () => ({
  publishBatchToJira: vi.fn(async (opts: { draftIds: string[] }) => ({
    results: opts.draftIds.map((id: string) => ({
      status: "created" as const,
      issueId: `JIRA-${id}`,
      issueKey: `MET-${id}`,
      htmlUrl: `https://jira.example.com/browse/MET-${id}`,
    })),
    publishedCount: opts.draftIds.length,
    failedCount: 0,
  })),
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { prisma } from "../src/lib/prisma.js";
import { runBatch } from "../src/lib/publishing/publisher.js";
import { publishBatchToJira } from "../src/lib/publishing/jira-publisher.js";
import { executeBatch } from "../src/lib/publishing/publishing-service.js";

beforeEach(() => {
  // Retried partially-completed batch: the GitHub leg of a previous attempt
  // already flipped d_pub to `published`; d_new is still pending.
  draftRows = [
    {
      id: "d_pub",
      projectId: "proj_1",
      status: "published",
      deletedAt: null,
      requirementId: "req_pub",
      metadata: null,
    },
    {
      id: "d_new",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirementId: "req_new",
      metadata: null,
    },
  ];
  requirementRows = [
    { id: "req_pub", version: 2 },
    { id: "req_new", version: 1 },
  ];
  // Only req_new has an approved, still-current review; req_pub's approval
  // is stale (pinned to a superseded version).
  reviewItems = [
    { requirementId: "req_new", pinnedVersion: 1 },
    { requirementId: "req_pub", pinnedVersion: 1 },
  ];
  projectRow = {
    publishDestination: "both",
    jiraConnectionId: "jc_1",
    jiraProjectKey: "MET",
    requireApprovedReview: true,
  };
  batchMetadata = JSON.stringify({ draftIds: ["d_pub", "d_new"], secretRef: null });
});

afterEach(() => vi.clearAllMocks());

describe("executeBatch — gate set == Jira publish set (PR #638 M2)", () => {
  it("blocks a retried destination=both batch when an already-published draft's approval is stale", async () => {
    await expect(executeBatch({ batchId: "batch_retry", actorId: "user_1" })).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "APPROVAL_REQUIRED",
        details: expect.objectContaining({ requirementIds: ["req_pub"] }),
      },
    );
    // Neither leg may run: the Jira leg would have pushed d_pub ungated.
    expect(runBatch).not.toHaveBeenCalled();
    expect(publishBatchToJira).not.toHaveBeenCalled();
  });

  it("blocks a jira-only destination on the raw meta.draftIds set (status filter dropped)", async () => {
    projectRow = { ...projectRow, publishDestination: "jira" };
    draftRows = [draftRows[0]]; // only the already-published, stale-approved draft
    batchMetadata = JSON.stringify({ draftIds: ["d_pub"], secretRef: null });
    await expect(executeBatch({ batchId: "batch_retry", actorId: "user_1" })).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "APPROVAL_REQUIRED",
        details: expect.objectContaining({ requirementIds: ["req_pub"] }),
      },
    );
    expect(publishBatchToJira).not.toHaveBeenCalled();
  });

  it("publishes the exact meta.draftIds set to Jira when every draft is approved-current", async () => {
    reviewItems = [
      { requirementId: "req_new", pinnedVersion: 1 },
      { requirementId: "req_pub", pinnedVersion: 2 },
    ];
    const result = await executeBatch({ batchId: "batch_retry", actorId: "user_1" });
    expect(result.status).toBe("completed");
    expect(publishBatchToJira).toHaveBeenCalledTimes(1);
    expect(publishBatchToJira).toHaveBeenCalledWith(
      expect.objectContaining({ draftIds: ["d_pub", "d_new"] }),
    );
  });

  it("github-only destination keeps the status-filtered gate set (published drafts are runBatch's concern)", async () => {
    projectRow = {
      publishDestination: "github",
      jiraConnectionId: null,
      jiraProjectKey: null,
      requireApprovedReview: true,
    };
    // d_pub is stale-approved but already `published` — runBatch will not
    // republish it, so the execution-time gate must not block on it.
    const result = await executeBatch({ batchId: "batch_retry", actorId: "user_1" });
    expect(result.status).toBe("completed");
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(publishBatchToJira).not.toHaveBeenCalled();
    // The gate loader queried with runBatch's publishable-status mirror.
    const loaderCall = vi.mocked(prisma.issueDraft.findMany).mock.calls[0]?.[0] as {
      where: { status?: { in: string[] } };
    };
    expect(loaderCall.where.status).toEqual({
      in: ["draft", "approved", "publishing", "failed"],
    });
  });

  it("gate off: no draft query runs and both legs publish (lazy loader preserved)", async () => {
    projectRow = { ...projectRow, requireApprovedReview: false };
    const result = await executeBatch({ batchId: "batch_retry", actorId: "user_1" });
    expect(result.status).toBe("completed");
    expect(prisma.issueDraft.findMany).not.toHaveBeenCalled();
    expect(publishBatchToJira).toHaveBeenCalledWith(
      expect.objectContaining({ draftIds: ["d_pub", "d_new"] }),
    );
  });
});
