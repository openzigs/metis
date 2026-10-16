/**
 * #1220 — the divergence answer's race paths, which a real database cannot
 * stage deterministically: a re-sync that records a newer source between the
 * read and the clear. (The four sync cases and both answers run against a real
 * migrated SQLite in `tests/import-resync-local-edits-1220.sqlite.test.ts`.)
 */
import { describe, expect, it, vi } from "vitest";

const updateRequirementWithHistory = vi.hoisted(() =>
  vi.fn(async () => ({
    id: "r1",
    version: 3,
    updatedAt: new Date(),
    changed: false,
    changedFields: {},
  })),
);
vi.mock("./requirement-version-service.js", () => ({ updateRequirementWithHistory }));
import type { PrismaClient } from "@prisma/client";
import { resolveSourceDivergence, SourceDivergenceError } from "./source-divergence.js";

const pending = JSON.stringify({
  fingerprint: "v1:src",
  title: "T",
  body: "Source body",
  type: "feature",
  priority: "medium",
  labels: [],
  detectedAt: "2026-10-16T10:00:00.000Z",
});

function client(opts: { updateManyCount: number }) {
  const requirement = {
    findFirst: vi.fn(async () => ({
      id: "r1",
      projectId: "p1",
      version: 2,
      sourcePending: pending,
    })),
    updateMany: vi.fn(async () => ({ count: opts.updateManyCount })),
  };
  return { db: { requirement } as unknown as PrismaClient, requirement };
}

describe("resolveSourceDivergence — a newer source recorded meanwhile", () => {
  it("Keep mine refuses: the analyst answered content that is no longer the source's", async () => {
    const { db, requirement } = client({ updateManyCount: 0 });
    await expect(
      resolveSourceDivergence(db, {
        requirementId: "r1",
        choice: "local",
        sourceFingerprint: "v1:src",
        actorId: "u1",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_MOVED" } satisfies Partial<SourceDivergenceError>);
    // Refused before anything reached History.
    expect(updateRequirementWithHistory).not.toHaveBeenCalled();
    // The clear was conditional on the value read, so the newer record survives.
    expect(requirement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "r1", sourcePending: pending }),
      }),
    );
  });

  it("without a project scope, the read is not narrowed", async () => {
    const { db, requirement } = client({ updateManyCount: 1 });
    const result = await resolveSourceDivergence(db, {
      requirementId: "r1",
      choice: "local",
      sourceFingerprint: "v1:src",
      actorId: "u1",
      now: new Date("2026-10-16T11:00:00.000Z"),
    });
    // No version row and no bump: the version read is the version returned.
    expect(result).toEqual({
      id: "r1",
      projectId: "p1",
      choice: "local",
      version: 2,
      changed: false,
      superseded: false,
    });
    expect(updateRequirementWithHistory).not.toHaveBeenCalled();
    expect(requirement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", deletedAt: null } }),
    );
    const data = (
      requirement.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
    )[0].data;
    // The decision is the analyst's: what the #769 guard reads.
    expect(data).toMatchObject({
      sourceDecisionActorId: "u1",
      sourceDecidedAt: new Date("2026-10-16T11:00:00.000Z"),
    });
    expect(JSON.parse(data.sourceDecision as string)).toEqual({
      choice: "local",
      fingerprint: "v1:src",
      actorId: "u1",
      at: "2026-10-16T11:00:00.000Z",
    });
  });
});

describe("resolveSourceDivergence — Take the source version superseded by a newer re-sync", () => {
  it("writes the content but reports the divergence as NOT resolved", async () => {
    updateRequirementWithHistory.mockClear();
    updateRequirementWithHistory.mockResolvedValueOnce({
      id: "r1",
      version: 3,
      updatedAt: new Date(),
      changed: true,
      changedFields: {},
    });
    // The conditional settle matches nothing: a newer source was recorded.
    const { db } = client({ updateManyCount: 0 });

    const result = await resolveSourceDivergence(db, {
      requirementId: "r1",
      choice: "source",
      sourceFingerprint: "v1:src",
      actorId: "u1",
      expectedVersion: 2,
    });

    expect(updateRequirementWithHistory).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ actorId: "u1", expectedVersion: 2, keepHiddenLabels: true }),
    );
    expect(result).toMatchObject({ choice: "source", changed: true, superseded: true });
  });

  it("a settled take-source is not superseded", async () => {
    updateRequirementWithHistory.mockResolvedValueOnce({
      id: "r1",
      version: 3,
      updatedAt: new Date(),
      changed: true,
      changedFields: {},
    });
    const { db } = client({ updateManyCount: 1 });
    const result = await resolveSourceDivergence(db, {
      requirementId: "r1",
      choice: "source",
      sourceFingerprint: "v1:src",
      actorId: "u1",
      expectedVersion: 2,
    });
    expect(result.superseded).toBe(false);
  });
});
