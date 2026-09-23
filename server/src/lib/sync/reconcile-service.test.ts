/**
 * Epic #739 — Tests for the reconciliation service.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  reconcileIssueChange,
  resolveDriftEvent,
  getDriftEventProjectId,
  listDriftEvents,
  getDriftCount,
} from "./reconcile-service.js";
import type { IssueChangeEvent } from "@metis/shared";
import { prisma } from "../prisma.js";
import { registerSocketServer } from "../socket/registry.js";

// Mock prisma
vi.mock("../prisma.js", () => ({
  prisma: {
    publishedIssue: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    driftEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    issueDraft: {
      update: vi.fn(),
    },
  },
}));

vi.mock("../audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeEvent(overrides: Partial<IssueChangeEvent> = {}): IssueChangeEvent {
  return {
    deliveryId: "delivery-123",
    source: "github",
    externalId: "node-id-abc",
    externalRef: "42",
    action: "edited",
    changes: { title: "New Title" },
    current: {
      title: "New Title",
      body: "Updated body",
      state: "open",
      labels: ["bug"],
      assignees: ["user1"],
    },
    timestamp: "2026-01-01T00:00:00Z",
    actor: "octocat",
    ...overrides,
  };
}

describe("reconcileIssueChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not handled when no published issue found", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(null);

    const result = await reconcileIssueChange(makeEvent());

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("NO_PUBLISHED_ISSUE");
  });

  it("creates drift event when changes are detected", async () => {
    const mockPublished = {
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "https://github.com/org/repo/issues/42",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: {
        id: "batch-1",
        projectId: "proj-1",
        project: { id: "proj-1", name: "Test" },
      },
      draft: {
        id: "draft-1",
        title: "Old Title",
        body: "Old body",
        labels: "[]",
        requirementId: "req-1",
      },
    };
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(mockPublished as never);

    const mockDriftEvent = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "delivery-123",
      action: "edited",
      fieldDiffs: JSON.stringify([
        { field: "title", local: "Old Title", external: "New Title" },
        { field: "body", local: "Old body", external: "Updated body" },
      ]),
      externalSnapshot: JSON.stringify({
        title: "New Title",
        body: "Updated body",
        state: "open",
        labels: ["bug"],
        assignees: ["user1"],
      }),
      localSnapshot: JSON.stringify({
        title: "Old Title",
        body: "Old body",
        state: "open",
        labels: [],
        assignees: [],
      }),
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.create).mockResolvedValue(mockDriftEvent as never);

    const emitDrift = vi.fn();
    const result = await reconcileIssueChange(makeEvent(), { emitDrift });

    expect(result.handled).toBe(true);
    expect(result.driftEventId).toBe("drift-1");
    expect(emitDrift).toHaveBeenCalledWith("proj-1", expect.objectContaining({ id: "drift-1" }));
  });

  /**
   * Issue #78 — the injected `emitDrift` above was the ONLY thing that ever
   * called it: every real caller (both webhook receivers and the Jira poll
   * worker) passed no deps, so the broadcast never happened in production while
   * this suite stayed green. Assert the default path, with no deps at all.
   */
  it("broadcasts drift:detected with no injected emitter (#78)", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1", name: "Test" } },
      draft: {
        id: "draft-1",
        title: "Old Title",
        body: "Old body",
        labels: "[]",
        requirementId: "req-1",
      },
    } as never);
    vi.mocked(prisma.driftEvent.create).mockResolvedValue({
      id: "drift-2",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "delivery-2",
      action: "edited",
      fieldDiffs: JSON.stringify([]),
      externalSnapshot: JSON.stringify({}),
      localSnapshot: JSON.stringify({}),
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const emit = vi.fn();
    registerSocketServer({ to: vi.fn(() => ({ emit })) } as never);
    try {
      const result = await reconcileIssueChange(makeEvent());
      expect(result.handled).toBe(true);
      expect(emit).toHaveBeenCalledWith(
        "drift:detected",
        expect.objectContaining({ projectId: "proj-1", driftEventId: "drift-2" }),
      );
    } finally {
      registerSocketServer(null as never);
    }
  });

  it("returns not handled on duplicate deliveryId", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: { id: "draft-1", title: "Different", body: "Diff", labels: "[]", requirementId: null },
    } as never);

    const prismaError = new Error("Unique constraint") as Error & { code: string };
    prismaError.code = "P2002";
    vi.mocked(prisma.driftEvent.create).mockRejectedValue(prismaError);

    const result = await reconcileIssueChange(makeEvent());
    expect(result.handled).toBe(false);
    expect(result.reason).toBe("DUPLICATE");
  });

  it("returns no_diff when fields match", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: {
        id: "draft-1",
        title: "New Title",
        body: "Updated body",
        labels: JSON.stringify(["bug"]),
        requirementId: null,
      },
    } as never);

    // Event with same fields as local
    const event = makeEvent({
      current: {
        title: "New Title",
        body: "Updated body",
        state: "open",
        labels: ["bug"],
        assignees: [],
      },
    });
    const result = await reconcileIssueChange(event);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe("NO_DIFF");
  });
});

describe("getDriftEventProjectId (#102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the owning project of the drift addressed by id", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue({ projectId: "proj-7" } as never);
    await expect(getDriftEventProjectId("drift-7")).resolves.toBe("proj-7");
    expect(prisma.driftEvent.findUnique).toHaveBeenCalledWith({
      where: { id: "drift-7" },
      select: { projectId: true },
    });
  });

  it("returns null for an unknown drift", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(null);
    await expect(getDriftEventProjectId("nope")).resolves.toBeNull();
  });
});

describe("resolveDriftEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws DRIFT_NOT_FOUND for unknown id", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(null);
    await expect(resolveDriftEvent("unknown", "adopt", "user-1")).rejects.toThrow(
      "DRIFT_NOT_FOUND",
    );
  });

  it("throws ALREADY_RESOLVED if already resolved", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue({
      id: "drift-1",
      status: "resolved",
    } as never);
    await expect(resolveDriftEvent("drift-1", "adopt", "user-1")).rejects.toThrow(
      "ALREADY_RESOLVED",
    );
  });

  it("resolves with adopt action and updates draft", async () => {
    const existing = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "del-1",
      action: "edited",
      fieldDiffs: JSON.stringify([{ field: "title", local: "Old", external: "New" }]),
      externalSnapshot: JSON.stringify({
        title: "New",
        body: "Body",
        state: "open",
        labels: [],
        assignees: [],
      }),
      localSnapshot: JSON.stringify({
        title: "Old",
        body: "Body",
        state: "open",
        labels: [],
        assignees: [],
      }),
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "adopt",
      resolvedById: "user-1",
      resolvedAt: new Date(),
    } as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockResolvedValue({
      id: "pub-1",
      draftId: "draft-1",
    } as never);
    vi.mocked(prisma.issueDraft.update).mockResolvedValue({} as never);

    const result = await resolveDriftEvent("drift-1", "adopt", "user-1");
    expect(result.status).toBe("resolved");
    expect(result.resolution).toBe("adopt");
    expect(prisma.issueDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "draft-1" } }),
    );
  });

  it("resolves with divergent action without updating draft", async () => {
    const existing = {
      id: "drift-2",
      publishedIssueId: "pub-2",
      projectId: "proj-1",
      requirementId: null,
      source: "jira",
      deliveryId: "del-2",
      action: "closed",
      fieldDiffs: JSON.stringify([{ field: "state", local: "open", external: "closed" }]),
      externalSnapshot: JSON.stringify({
        title: "T",
        body: "B",
        state: "closed",
        labels: [],
        assignees: [],
      }),
      localSnapshot: null,
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "divergent",
      resolvedById: "user-1",
      resolvedAt: new Date(),
    } as never);

    const result = await resolveDriftEvent("drift-2", "divergent", "user-1");
    expect(result.resolution).toBe("divergent");
    expect(prisma.issueDraft.update).not.toHaveBeenCalled();
  });
});

describe("listDriftEvents", () => {
  it("returns paginated results", async () => {
    const items = [
      {
        id: "d-1",
        publishedIssueId: "pub-1",
        projectId: "proj-1",
        requirementId: null,
        source: "github",
        deliveryId: "del-1",
        action: "edited",
        fieldDiffs: "[]",
        externalSnapshot: "{}",
        localSnapshot: null,
        status: "pending",
        resolution: null,
        resolvedById: null,
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    vi.mocked(prisma.driftEvent.findMany).mockResolvedValue(items as never);
    vi.mocked(prisma.driftEvent.count).mockResolvedValue(1);

    const result = await listDriftEvents("proj-1", { page: 1, perPage: 10 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("getDriftCount", () => {
  it("returns pending count", async () => {
    vi.mocked(prisma.driftEvent.count).mockResolvedValue(5);
    const count = await getDriftCount("proj-1");
    expect(count).toBe(5);
  });
});
