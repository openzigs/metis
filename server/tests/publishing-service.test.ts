/**
 * Publishing service — RBAC + draft validation + audit emissions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DraftRow {
  id: string;
  projectId: string;
  status: string;
  deletedAt: Date | null;
  requirementId?: string | null;
  metadata?: string | null;
}

interface BatchRow {
  id: string;
  projectId: string;
  status: string;
  targetOwner: string;
  targetRepo: string;
  targetBaseUrl: string | null;
  provider: string;
  dryRun: boolean;
  totalDrafts: number;
  publishedCount: number;
  failedCount: number;
  dedupSkipped: number;
  archived: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  archivedById: string | null;
  dryRunPlan: string | null;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const drafts = new Map<string, DraftRow>();
const batches = new Map<string, BatchRow>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    issueDraft: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [...drafts.values()].filter((d) => where.id.in.includes(d.id) && !d.deletedAt),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => drafts.get(where.id) ?? null,
      ),
      // #1072 — approveDraft now scopes by { id, projectId }.
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = drafts.get(where.id);
        if (!row) return null;
        return where.projectId !== undefined && row.projectId !== where.projectId ? null : row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        const r = drafts.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data };
        drafts.set(where.id, next);
        return next;
      }),
    },
    repoConnection: {
      findFirst: vi.fn(async () => null),
    },
    // #619 — approval gate off by default so pre-existing service tests keep
    // their original (ungated) behavior. The gate describe flips this.
    project: {
      findUnique: vi.fn(async () => ({
        publishDestination: "github",
        jiraConnectionId: null,
        jiraProjectKey: null,
        requireApprovedReview: false,
      })),
    },
    requirement: { findMany: vi.fn(async () => []) },
    reviewRequestItem: { findMany: vi.fn(async () => []) },
    publishBatch: {
      create: vi.fn(async ({ data }: { data: Partial<BatchRow> }) => {
        nextId += 1;
        const row: BatchRow = {
          id: `batch_${nextId}`,
          projectId: "proj_1",
          status: "pending",
          targetOwner: "acme",
          targetRepo: "metis",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          totalDrafts: 0,
          publishedCount: 0,
          failedCount: 0,
          dedupSkipped: 0,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archivedById: null,
          dryRunPlan: null,
          startedById: "user_1",
          startedAt: new Date(),
          completedAt: null,
          errorMessage: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as BatchRow),
        };
        batches.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => batches.get(where.id) ?? null,
      ),
      // #1072 — archiveBatch/getBatch now scope by { id, projectId }.
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = batches.get(where.id);
        if (!row) return null;
        return where.projectId !== undefined && row.projectId !== where.projectId ? null : row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<BatchRow> }) => {
        const r = batches.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() };
        batches.set(where.id, next);
        return next;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { audit } from "../src/lib/audit/audit-service.js";
import { approveDraft, createBatch } from "../src/lib/publishing/publishing-service.js";
import { PublishError } from "../src/lib/publishing/types.js";

beforeEach(() => {
  // A bypassed guard must not leave its one-shot result for the next test.
  vi.resetAllMocks();
  drafts.clear();
  batches.clear();
  nextId = 0;
});

afterEach(() => vi.clearAllMocks());

describe("createBatch", () => {
  it("rejects when one or more drafts not found", async () => {
    drafts.set("d1", { id: "d1", projectId: "proj_1", status: "approved", deletedAt: null });
    await expect(
      createBatch({
        actorId: "user_1",
        input: {
          projectId: "proj_1",
          targetOwner: "acme",
          targetRepo: "metis",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          draftIds: ["d1", "d-missing"],
          additionalLabels: [],
          milestone: null,
          secretRef: "${vault:gh}",
        },
      }),
    ).rejects.toMatchObject({ code: "DRAFT_MISMATCH" });
  });

  it("rejects when a draft is in an ineligible status", async () => {
    drafts.set("d1", { id: "d1", projectId: "proj_1", status: "publishing", deletedAt: null });
    await expect(
      createBatch({
        actorId: "user_1",
        input: {
          projectId: "proj_1",
          targetOwner: "acme",
          targetRepo: "metis",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          draftIds: ["d1"],
          additionalLabels: [],
          milestone: null,
          secretRef: "${vault:gh}",
        },
      }),
    ).rejects.toMatchObject({ code: "DRAFT_INELIGIBLE" });
  });

  it("creates the batch and emits the right audit action for dry-run", async () => {
    drafts.set("d1", { id: "d1", projectId: "proj_1", status: "approved", deletedAt: null });
    const batch = await createBatch({
      actorId: "user_1",
      input: {
        projectId: "proj_1",
        targetOwner: "acme",
        targetRepo: "metis",
        targetBaseUrl: null,
        provider: "github",
        dryRun: true,
        draftIds: ["d1"],
        additionalLabels: [],
        milestone: null,
        secretRef: "${vault:gh}",
      },
    });
    expect(batch.dryRun).toBe(true);
    const actions = (audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("publish.batch.preview");
  });
});

describe("approveDraft", () => {
  it("flips status to approved and audits", async () => {
    drafts.set("d1", { id: "d1", projectId: "proj_1", status: "draft", deletedAt: null });
    await approveDraft({ draftId: "d1", projectId: "proj_1", actorId: "user_1" });
    expect(drafts.get("d1")!.status).toBe("approved");
    const actions = (audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("publish.draft.approve");
  });

  it("rejects on missing draft", async () => {
    await expect(
      approveDraft({ draftId: "nope", projectId: "proj_1", actorId: "u" }),
    ).rejects.toBeInstanceOf(PublishError);
  });

  it("noops on already-published drafts", async () => {
    drafts.set("d1", { id: "d1", projectId: "proj_1", status: "published", deletedAt: null });
    const out = await approveDraft({ draftId: "d1", projectId: "proj_1", actorId: "u" });
    expect(out.status).toBe("published");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review fix-up tests — F5 + F6
// ─────────────────────────────────────────────────────────────────────────

import { archiveBatch } from "../src/lib/publishing/publishing-service.js";

describe("F5 — archive RBAC at the service layer", () => {
  beforeEach(() => {
    batches.set("batch_arch_1", {
      id: "batch_arch_1",
      projectId: "proj_1",
      status: "completed",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      dryRun: true, // dryRun=true so archiveBatchImpl skips the token branch
      totalDrafts: 0,
      publishedCount: 0,
      failedCount: 0,
      dedupSkipped: 0,
      archived: false,
      archivedAt: null,
      archiveReason: null,
      archivedById: null,
      dryRunPlan: null,
      startedById: "user_owner",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("admin can archive any batch", async () => {
    await expect(
      archiveBatch({
        batchId: "batch_arch_1",
        projectId: "proj_1",
        input: { reason: "cleanup", closeIssues: false },
        actorId: "admin_user",
        actorRole: "admin",
      }),
    ).resolves.toBeTruthy();
  });

  it("the batch owner can archive their own batch", async () => {
    await expect(
      archiveBatch({
        batchId: "batch_arch_1",
        projectId: "proj_1",
        input: { reason: "owner-cleanup", closeIssues: false },
        actorId: "user_owner",
        actorRole: "coordinator",
      }),
    ).resolves.toBeTruthy();
  });

  it("a non-owner non-admin is rejected with PUBLISH_BATCH_FORBIDDEN", async () => {
    await expect(
      archiveBatch({
        batchId: "batch_arch_1",
        projectId: "proj_1",
        input: { reason: "nope", closeIssues: false },
        actorId: "other_user",
        actorRole: "coordinator",
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_BATCH_FORBIDDEN", status: 403 });
  });
});

describe("F6 — cross-project guard at the service layer", () => {
  beforeEach(() => {
    drafts.set("d_cp", {
      id: "d_cp",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
    });
  });

  it("rejects when targetOwner/targetRepo is owned by another project", async () => {
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: { repoConnection: { findFirst: ReturnType<typeof vi.fn> } };
    };
    prisma.repoConnection.findFirst.mockResolvedValueOnce({ id: "repo_other" });
    await expect(
      createBatch({
        actorId: "user_1",
        input: {
          projectId: "proj_1",
          targetOwner: "acme",
          targetRepo: "metis",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          draftIds: ["d_cp"],
          additionalLabels: [],
          milestone: null,
          secretRef: "${vault:gh}",
        },
      }),
    ).rejects.toMatchObject({ code: "REPO_CROSS_PROJECT", status: 409 });
  });

  it("allows when confirmCrossProject=true is passed in", async () => {
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: { repoConnection: { findFirst: ReturnType<typeof vi.fn> } };
    };
    prisma.repoConnection.findFirst.mockResolvedValueOnce({ id: "repo_other" });
    const out = await createBatch({
      actorId: "user_1",
      confirmCrossProject: true,
      input: {
        projectId: "proj_1",
        targetOwner: "acme",
        targetRepo: "metis",
        targetBaseUrl: null,
        provider: "github",
        dryRun: false,
        draftIds: ["d_cp"],
        additionalLabels: [],
        milestone: null,
        secretRef: "${vault:gh}",
      },
    });
    expect(out.targetOwner).toBe("acme");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #619 — approval gate (requireApprovedReview) at the service layer
// ─────────────────────────────────────────────────────────────────────────

import { executeBatch } from "../src/lib/publishing/publishing-service.js";

describe("approval gate (#619) at the service layer", () => {
  const liveInput = {
    projectId: "proj_1",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github",
    dryRun: false,
    draftIds: ["d1"],
    additionalLabels: [],
    milestone: null,
    secretRef: "${vault:gh}",
  } as const;

  async function flipGateOn(): Promise<void> {
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: { project: { findUnique: ReturnType<typeof vi.fn> } };
    };
    prisma.project.findUnique.mockImplementation(async () => ({
      publishDestination: "github",
      jiraConnectionId: null,
      jiraProjectKey: null,
      requireApprovedReview: true,
    }));
  }

  async function restoreGateOff(): Promise<void> {
    const { prisma } = (await import("../src/lib/prisma.js")) as unknown as {
      prisma: { project: { findUnique: ReturnType<typeof vi.fn> } };
    };
    prisma.project.findUnique.mockImplementation(async () => ({
      publishDestination: "github",
      jiraConnectionId: null,
      jiraProjectKey: null,
      requireApprovedReview: false,
    }));
  }

  afterEach(async () => {
    await restoreGateOff();
  });

  it("createBatch (LIVE) is blocked with 409 APPROVAL_REQUIRED for an unreviewed requirement", async () => {
    await flipGateOn();
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirementId: "req_1",
    });
    await expect(createBatch({ actorId: "user_1", input: { ...liveInput } })).rejects.toMatchObject(
      {
        statusCode: 409,
        code: "APPROVAL_REQUIRED",
        details: expect.objectContaining({ requirementIds: ["req_1"] }),
      },
    );
    // No batch row was created.
    expect(batches.size).toBe(0);
  });

  it("createBatch (dry-run) stays exempt with the gate on", async () => {
    await flipGateOn();
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirementId: "req_1",
    });
    const batch = await createBatch({
      actorId: "user_1",
      input: { ...liveInput, dryRun: true },
    });
    expect(batch.dryRun).toBe(true);
  });

  it("executeBatch re-checks the gate at execution time (blocks a stale-created batch)", async () => {
    await flipGateOn();
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "approved",
      deletedAt: null,
      requirementId: "req_1",
    });
    batches.set("batch_exec", {
      id: "batch_exec",
      projectId: "proj_1",
      status: "pending",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      dryRun: false,
      totalDrafts: 1,
      publishedCount: 0,
      failedCount: 0,
      dedupSkipped: 0,
      archived: false,
      archivedAt: null,
      archiveReason: null,
      archivedById: null,
      dryRunPlan: null,
      startedById: "user_1",
      startedAt: new Date(),
      completedAt: null,
      errorMessage: null,
      metadata: JSON.stringify({ draftIds: ["d1"], secretRef: "${vault:gh}" }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(executeBatch({ batchId: "batch_exec", actorId: "user_1" })).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
    });
  });

  it("approveDraft is blocked when the gate is on and the requirement is unreviewed", async () => {
    await flipGateOn();
    drafts.set("d1", {
      id: "d1",
      projectId: "proj_1",
      status: "draft",
      deletedAt: null,
      requirementId: "req_1",
    });
    await expect(
      approveDraft({ draftId: "d1", projectId: "proj_1", actorId: "user_1" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
    });
    expect(drafts.get("d1")!.status).toBe("draft");
  });
});
