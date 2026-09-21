/**
 * Epic #475 (Phase 1, #479) — promote-message-to-requirement tests.
 *
 * The load-bearing decision here is the **analysisId derivation** (a Requirement
 * needs a non-null analysisId). The cascade is:
 *   1. the thread's anchored `analysisId` (if any),
 *   2. else the project's latest non-deleted Analysis,
 *   3. else a freshly-created synthetic "discussion" Analysis.
 * These tests pin all three paths plus the Requirement + initial
 * RequirementVersion creation and the AuditLog provenance row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const threadFindFirst = vi.fn();
const messageFindFirst = vi.fn();
const analysisFindFirst = vi.fn();
const analysisCreate = vi.fn();
const requirementCreate = vi.fn();
const requirementVersionCreate = vi.fn();
const txn = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    discussionThread: { findFirst: (...a: unknown[]) => threadFindFirst(...a) },
    discussionMessage: { findFirst: (...a: unknown[]) => messageFindFirst(...a) },
    analysis: {
      findFirst: (...a: unknown[]) => analysisFindFirst(...a),
      create: (...a: unknown[]) => analysisCreate(...a),
    },
    requirement: { create: (...a: unknown[]) => requirementCreate(...a) },
    requirementVersion: { create: (...a: unknown[]) => requirementVersionCreate(...a) },
    $transaction: (fn: unknown) => txn(fn),
  },
}));

const audit = vi.fn();
vi.mock("../audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

const { promoteMessageToRequirement, deriveAnalysisId, PromoteError } =
  await import("./promote.js");

beforeEach(() => {
  vi.clearAllMocks();
  // Default: $transaction runs the callback with a tx client that proxies the
  // same mocked methods.
  txn.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      requirement: { create: (...a: unknown[]) => requirementCreate(...a) },
      requirementVersion: { create: (...a: unknown[]) => requirementVersionCreate(...a) },
    }),
  );
});

describe("deriveAnalysisId", () => {
  it("prefers the thread's anchored analysisId", async () => {
    const result = await deriveAnalysisId({
      projectId: "p1",
      threadAnalysisId: "anchor-a",
      actorId: "u1",
    });
    expect(result).toEqual({ analysisId: "anchor-a", source: "thread-anchor" });
    expect(analysisFindFirst).not.toHaveBeenCalled();
    expect(analysisCreate).not.toHaveBeenCalled();
  });

  it("falls back to the project's latest analysis when not anchored", async () => {
    analysisFindFirst.mockResolvedValue({ id: "latest-a" });
    const result = await deriveAnalysisId({
      projectId: "p1",
      threadAnalysisId: null,
      actorId: "u1",
    });
    expect(result).toEqual({ analysisId: "latest-a", source: "latest-analysis" });
    expect(analysisFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1", deletedAt: null },
        orderBy: { startedAt: "desc" },
      }),
    );
    expect(analysisCreate).not.toHaveBeenCalled();
  });

  it("creates a synthetic discussion analysis when the project has none", async () => {
    analysisFindFirst.mockResolvedValue(null);
    analysisCreate.mockResolvedValue({ id: "synthetic-a" });
    const result = await deriveAnalysisId({
      projectId: "p1",
      threadAnalysisId: null,
      actorId: "u1",
    });
    expect(result).toEqual({ analysisId: "synthetic-a", source: "synthetic-discussion" });
    const data = analysisCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ projectId: "p1", startedById: "u1", status: "completed" });
    expect(JSON.parse(data.metadata)).toMatchObject({ origin: "discussion" });
  });
});

describe("promoteMessageToRequirement", () => {
  const actor = { id: "u1", role: "member" as const };

  it("promotes a human-authored message, writes an initial version + audit", async () => {
    threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", analysisId: null });
    messageFindFirst.mockResolvedValue({
      id: "m1",
      threadId: "t1",
      authorKind: "human",
      authorUserId: "u1",
      body: "We must support SSO",
    });
    analysisFindFirst.mockResolvedValue({ id: "latest-a" });
    requirementCreate.mockResolvedValue({ id: "req-1" });
    requirementVersionCreate.mockResolvedValue({ id: "v0" });

    const result = await promoteMessageToRequirement({
      actor,
      threadId: "t1",
      messageId: "m1",
      title: "SSO support",
      type: "feature",
      priority: "high",
    });

    expect(result).toMatchObject({ requirementId: "req-1", analysisId: "latest-a" });

    expect(requirementCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          analysisId: "latest-a",
          title: "SSO support",
          body: "We must support SSO",
          type: "feature",
          priority: "high",
        }),
      }),
    );
    // Initial version row (version 0).
    expect(requirementVersionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requirementId: "req-1", version: 0, actorId: "u1" }),
      }),
    );
    // Provenance audit row.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "discussion.message.promote",
        target: { type: "Requirement", id: "req-1" },
        metadata: expect.objectContaining({
          sourceMessageId: "m1",
          threadId: "t1",
          authorKind: "human",
        }),
      }),
    );
  });

  it("promotes an AI-authored message and records authorKind=ai in provenance", async () => {
    threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", analysisId: "anchor-a" });
    messageFindFirst.mockResolvedValue({
      id: "m2",
      threadId: "t1",
      authorKind: "ai",
      aiModel: "gpt-4",
      body: "Suggest: rate-limit the login endpoint",
    });
    requirementCreate.mockResolvedValue({ id: "req-2" });
    requirementVersionCreate.mockResolvedValue({ id: "v0" });

    const result = await promoteMessageToRequirement({
      actor,
      threadId: "t1",
      messageId: "m2",
      title: "Rate-limit login",
    });

    expect(result).toMatchObject({ requirementId: "req-2", analysisId: "anchor-a" });
    // Anchored analysis used — no lookup/create.
    expect(analysisFindFirst).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ authorKind: "ai", sourceMessageId: "m2" }),
      }),
    );
  });

  it("throws MESSAGE_NOT_FOUND when the message is missing or not in the thread", async () => {
    threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", analysisId: null });
    messageFindFirst.mockResolvedValue(null);
    await expect(
      promoteMessageToRequirement({ actor, threadId: "t1", messageId: "ghost", title: "x" }),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
    expect(requirementCreate).not.toHaveBeenCalled();
  });

  it("throws THREAD_NOT_FOUND when the thread is missing / soft-deleted", async () => {
    threadFindFirst.mockResolvedValue(null);
    await expect(
      promoteMessageToRequirement({ actor, threadId: "ghost", messageId: "m1", title: "x" }),
    ).rejects.toBeInstanceOf(PromoteError);
  });
});
