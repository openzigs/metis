/**
 * #1104 (F) — cancelling a stranded publish batch.
 *
 * A `pending` batch left behind by an aborted run (the reported fixture was
 * created before #1092) had no remedy at all: it rendered as in-progress
 * forever and the only offered action was "Watch". `cancelBatch` settles the
 * row — and refuses to settle one that may still be writing to GitHub, since
 * cancelling recalls nothing that was already written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLISH_BATCH_IN_FLIGHT_GRACE_MS } from "@metis/shared";

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

const batches = new Map<string, BatchRow>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    publishBatch: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = batches.get(where.id);
        if (!row) return null;
        return where.projectId !== undefined && row.projectId !== where.projectId ? null : row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => batches.get(where.id) ?? null,
      ),
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
import { cancelBatch } from "../src/lib/publishing/publishing-service.js";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function seedBatch(over: Partial<BatchRow> = {}): BatchRow {
  const row: BatchRow = {
    id: "batch_stranded",
    projectId: "proj_1",
    status: "pending",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github",
    dryRun: false,
    totalDrafts: 14,
    publishedCount: 0,
    failedCount: 0,
    dedupSkipped: 0,
    archived: false,
    archivedAt: null,
    archiveReason: null,
    archivedById: null,
    dryRunPlan: null,
    startedById: "user_owner",
    startedAt: new Date(NOW - 13 * 60 * 60 * 1000),
    completedAt: null,
    errorMessage: null,
    metadata: null,
    createdAt: new Date(NOW - 13 * 60 * 60 * 1000),
    updatedAt: new Date(NOW - 13 * 60 * 60 * 1000),
    ...over,
  };
  batches.set(row.id, row);
  return row;
}

beforeEach(() => batches.clear());
afterEach(() => vi.clearAllMocks());

describe("cancelBatch", () => {
  it("settles a stranded pending batch as cancelled", async () => {
    seedBatch();
    const result = await cancelBatch({
      batchId: "batch_stranded",
      projectId: "proj_1",
      actorId: "user_owner",
      actorRole: "developer",
      now: NOW,
    });
    expect(result.status).toBe("cancelled");
    expect(result.completedAt).not.toBeNull();
    // No user-supplied text is echoed into the row (#1065).
    expect(result.errorMessage).toBe("publish batch cancelled by a user");
    const actions = (audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("publish.batch.cancelled");
  });

  it("refuses to cancel a batch that may still be in flight", async () => {
    seedBatch({ status: "running", startedAt: new Date(NOW - 60_000) });
    await expect(
      cancelBatch({
        batchId: "batch_stranded",
        projectId: "proj_1",
        actorId: "user_owner",
        actorRole: "admin",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "BATCH_IN_FLIGHT", status: 409 });
    // Critically: the row is untouched, so the live run still owns it.
    expect(batches.get("batch_stranded")!.status).toBe("running");
  });

  it("cancels a running batch once it is past the in-flight grace window", async () => {
    seedBatch({
      status: "running",
      startedAt: new Date(NOW - PUBLISH_BATCH_IN_FLIGHT_GRACE_MS - 1000),
    });
    const result = await cancelBatch({
      batchId: "batch_stranded",
      projectId: "proj_1",
      actorId: "user_owner",
      actorRole: "developer",
      now: NOW,
    });
    expect(result.status).toBe("cancelled");
  });

  it("rejects a batch that has already settled", async () => {
    seedBatch({ status: "completed", completedAt: new Date(NOW) });
    await expect(
      cancelBatch({
        batchId: "batch_stranded",
        projectId: "proj_1",
        actorId: "user_owner",
        actorRole: "admin",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "BATCH_NOT_CANCELLABLE", status: 409 });
  });

  it("404s for a batch owned by another project (no existence oracle)", async () => {
    seedBatch({ projectId: "proj_other" });
    await expect(
      cancelBatch({
        batchId: "batch_stranded",
        projectId: "proj_1",
        actorId: "user_owner",
        actorRole: "admin",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "BATCH_NOT_FOUND", status: 404 });
  });

  it("403s for a non-admin who did not start the batch, and audits the denial", async () => {
    seedBatch();
    await expect(
      cancelBatch({
        batchId: "batch_stranded",
        projectId: "proj_1",
        actorId: "user_stranger",
        actorRole: "developer",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "PUBLISH_BATCH_FORBIDDEN", status: 403 });
    const actions = (audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("publish.batch.cancel_denied");
    expect(batches.get("batch_stranded")!.status).toBe("pending");
  });

  it("lets an admin cancel a batch someone else started", async () => {
    seedBatch();
    const result = await cancelBatch({
      batchId: "batch_stranded",
      projectId: "proj_1",
      actorId: "user_admin",
      actorRole: "admin",
      now: NOW,
    });
    expect(result.status).toBe("cancelled");
  });

  it("preserves an existing errorMessage rather than overwriting it", async () => {
    seedBatch({ errorMessage: "publish batch aborted (VAULT_REF_UNRESOLVED)" });
    const result = await cancelBatch({
      batchId: "batch_stranded",
      projectId: "proj_1",
      actorId: "user_owner",
      actorRole: "admin",
      now: NOW,
    });
    expect(result.errorMessage).toBe("publish batch aborted (VAULT_REF_UNRESOLVED)");
  });
});
