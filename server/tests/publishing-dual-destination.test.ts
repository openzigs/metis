/**
 * executeBatch — dual-destination (destination="both") tests.
 *
 * Verifies that when a project has publishDestination="both", executeBatch
 * creates both a GitHub and a Jira PublishedIssue row for the same batch+draft
 * without violating the unique constraint.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// ── In-memory stores ────────────────────────────────────────────────────────
interface PublishedIssueRow {
  id: string;
  batchId: string;
  draftId: string;
  issueNumber: number;
  issueId: string;
  htmlUrl: string;
  status: string;
  destination: string;
  parentIssueNumber: number | null;
  dedupHash: string | null;
  bodyHash: string | null;
  errorMessage: string | null;
  publishedAt: Date;
}

const publishedIssues: PublishedIssueRow[] = [];
let nextPubId = 0;

// Track calls for assertions
const createCalls: PublishedIssueRow[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    publishBatch: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "batch_dual") {
          return {
            id: "batch_dual",
            projectId: "proj_dual",
            status: "pending",
            dryRun: false,
            metadata: JSON.stringify({
              draftIds: ["draft_1", "draft_2"],
              additionalLabels: ["sprint-42"],
              secretRef: null,
            }),
            startedById: "user_1",
          };
        }
        // #1103 — a dry run, whose GitHub leg already stored its plan (or, for
        // `batch_jira_dry`, a Jira-only project's, which has none).
        if (where.id === "batch_dual_dry" || where.id === "batch_jira_dry") {
          return {
            id: where.id,
            projectId: "proj_dual",
            status: "pending",
            dryRun: true,
            targetOwner: "acme",
            targetRepo: "metis",
            targetBaseUrl: null,
            provider: "github",
            dryRunPlan:
              where.id === "batch_dual_dry"
                ? JSON.stringify({ batchId: "batch_dual_dry", actions: [], totalActions: 0 })
                : null,
            metadata: JSON.stringify({ draftIds: ["draft_1"], additionalLabels: ["sprint-42"] }),
            startedById: "user_1",
          };
        }
        return null;
      }),
      update: vi.fn(async () => ({})),
    },
    issueDraft: {
      findMany: vi.fn(async () => [
        {
          id: "draft_1",
          projectId: "proj_dual",
          requirementId: "req_1",
          title: "Login",
          body: "Body",
          draftType: "feature",
          labels: '["feature"]',
          storyPoints: null,
          metadata: JSON.stringify({ analysisId: "an_1" }),
        },
      ]),
    },
    project: {
      // #619 — gate off so dual-destination behavior stays under test.
      findUnique: vi.fn(async () => ({
        publishDestination: "both",
        jiraConnectionId: "jc_1",
        jiraProjectKey: "MET",
        requireApprovedReview: false,
      })),
    },
    publishedIssue: {
      create: vi.fn(async ({ data }: { data: Partial<PublishedIssueRow> }) => {
        nextPubId += 1;
        // Enforce the unique constraint [batchId, draftId, destination]
        const dup = publishedIssues.find(
          (r) =>
            r.batchId === data.batchId &&
            r.draftId === data.draftId &&
            r.destination === data.destination,
        );
        if (dup) {
          const err = new Error(
            `Unique constraint failed on (batchId, draftId, destination)`,
          ) as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row: PublishedIssueRow = {
          id: `pi_${nextPubId}`,
          batchId: data.batchId!,
          draftId: data.draftId!,
          issueNumber: data.issueNumber ?? 0,
          issueId: data.issueId ?? "",
          htmlUrl: data.htmlUrl ?? "",
          status: data.status ?? "created",
          destination: data.destination ?? "github",
          parentIssueNumber: data.parentIssueNumber ?? null,
          dedupHash: data.dedupHash ?? null,
          bodyHash: data.bodyHash ?? null,
          errorMessage: data.errorMessage ?? null,
          publishedAt: new Date(),
        };
        publishedIssues.push(row);
        createCalls.push(row);
        return row;
      }),
    },
  },
}));

vi.mock("../src/lib/publishing/publisher.js", () => ({
  runBatch: vi.fn(async () => ({ status: "completed" })),
  archiveBatch: vi.fn(),
}));

vi.mock("../src/lib/publishing/jira-publisher.js", async (importOriginal) => ({
  // The dry run's Jira plan is built by the real mapping (#1103).
  ...(await importOriginal<typeof import("../src/lib/publishing/jira-publisher.js")>()),
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
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { executeBatch } from "../src/lib/publishing/publishing-service.js";
import { publishBatchToJira } from "../src/lib/publishing/jira-publisher.js";

beforeEach(() => {
  publishedIssues.length = 0;
  createCalls.length = 0;
  nextPubId = 0;
});
afterEach(() => vi.clearAllMocks());

describe("executeBatch — destination=both, dry run (#1103)", () => {
  it("adds the Jira leg to the stored plan, with the source property, and writes nothing to Jira", async () => {
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: { publishBatch: { update: Mock<(args: unknown) => Promise<unknown>> } };
    };
    await executeBatch({ batchId: "batch_dual_dry", actorId: "user_1" });
    expect(publishBatchToJira).not.toHaveBeenCalled();
    const write = prisma.publishBatch.update.mock.calls
      .map((c) => c[0] as { data: { dryRunPlan?: string } })
      .find((a) => a.data.dryRunPlan);
    const plan = JSON.parse(write!.data.dryRunPlan!) as {
      batchId: string;
      jira: { projectKey: string; issues: Array<Record<string, unknown>> };
    };
    // The GitHub leg's plan is kept; the Jira leg is added beside it.
    expect(plan.batchId).toBe("batch_dual_dry");
    expect(plan.jira.projectKey).toBe("MET");
    expect(plan.jira.issues).toEqual([
      expect.objectContaining({
        draftId: "draft_1",
        title: "Login",
        labels: ["feature", "sprint-42"],
        sourceProperty: {
          key: "metis.source",
          value: { projectId: "proj_dual", analysisId: "an_1", requirementId: "req_1" },
        },
      }),
    ]);
  });

  it("a Jira-only project's dry run gets a plan of its Jira leg alone", async () => {
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: {
        project: { findUnique: Mock<(args: unknown) => Promise<unknown>> };
        publishBatch: { update: Mock<(args: unknown) => Promise<unknown>> };
      };
    };
    prisma.project.findUnique.mockResolvedValueOnce({
      publishDestination: "jira",
      jiraConnectionId: "jc_1",
      jiraProjectKey: "MET",
      requireApprovedReview: false,
    });
    const result = await executeBatch({ batchId: "batch_jira_dry", actorId: "user_1" });
    expect(result.status).toBe("completed");
    const write = prisma.publishBatch.update.mock.calls
      .map((c) => c[0] as { data: { dryRunPlan?: string } })
      .find((a) => a.data.dryRunPlan);
    const plan = JSON.parse(write!.data.dryRunPlan!) as {
      actions: unknown[];
      targetOwner: string;
      jira: { issues: unknown[] };
    };
    expect(plan.actions).toEqual([]);
    expect(plan.targetOwner).toBe("acme");
    expect(plan.jira.issues).toHaveLength(1);
    expect(publishBatchToJira).not.toHaveBeenCalled();
  });
});

describe("executeBatch — destination=both", () => {
  it("#1049 — hands the batch's Additional labels to the Jira leg", async () => {
    await executeBatch({ batchId: "batch_dual", actorId: "user_1" });
    expect(publishBatchToJira).toHaveBeenCalledWith(
      expect.objectContaining({ additionalLabels: ["sprint-42"] }),
    );
  });

  it("creates separate GitHub and Jira PublishedIssue rows for the same batch+draft", async () => {
    const result = await executeBatch({ batchId: "batch_dual", actorId: "user_1" });

    expect(result.status).toBe("completed");

    // The Jira path should have created rows for both drafts
    const jiraRows = createCalls.filter((r) => r.destination === "jira");
    expect(jiraRows).toHaveLength(2);
    expect(jiraRows[0].draftId).toBe("draft_1");
    expect(jiraRows[1].draftId).toBe("draft_2");

    // Verify no P2002 was thrown — both GitHub (via runBatch mock) and Jira
    // rows coexist for the same batchId+draftId pair
    expect(jiraRows.every((r) => r.batchId === "batch_dual")).toBe(true);
  });

  it("allows multiple Jira rows with issueNumber=0 in the same batch", async () => {
    // This test validates that Jira rows with issueNumber=0 can coexist.
    // The old @@unique([batchId, issueNumber]) would block this.
    // The new schema uses @@index (non-unique) for [batchId, issueNumber, destination]
    // because Jira issues don't have numeric issue numbers.
    const result = await executeBatch({ batchId: "batch_dual", actorId: "user_1" });

    expect(result.status).toBe("completed");

    const jiraRows = createCalls.filter((r) => r.destination === "jira");
    // Both Jira rows have issueNumber=0 — that's fine because the unique
    // constraint is (batchId, issueNumber, destination) and destination
    // differs from any GitHub row (which would have issueNumber > 0)
    expect(jiraRows.every((r) => r.issueNumber === 0)).toBe(true);
    expect(jiraRows).toHaveLength(2);
  });

  it("would fail with old @@unique([batchId, draftId]) if both destinations wrote the same draftId", async () => {
    // Simulate what would happen with the OLD schema: manually insert a
    // "github" row, then try to insert a "jira" row with same batchId+draftId
    // but different destination — should succeed with the new schema.
    publishedIssues.push({
      id: "pi_pre",
      batchId: "batch_dual",
      draftId: "draft_1",
      issueNumber: 42,
      issueId: "GH-42",
      htmlUrl: "https://github.com/acme/metis/issues/42",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
    });

    // Same batchId+draftId, different destination — must NOT throw
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: { publishedIssue: { create: Mock<(args: unknown) => Promise<unknown>> } };
    };
    await expect(
      prisma.publishedIssue.create({
        data: {
          batchId: "batch_dual",
          draftId: "draft_1",
          issueNumber: 0,
          issueId: "JIRA-1",
          htmlUrl: "https://jira.example.com/browse/MET-1",
          status: "created",
          destination: "jira",
        },
      }),
    ).resolves.toBeTruthy();
  });
});
