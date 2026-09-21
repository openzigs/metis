/**
 * Epic #770 / Issue #771 — Requirement version-history service tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TRACKED_FIELDS,
  pickTracked,
  computeChangedFields,
  serializeChangedFields,
  parseChangedFields,
  applyReverse,
  reconstructSnapshots,
  buildHistoryEntries,
  updateRequirementWithHistory,
  restoreRequirementVersion,
  RequirementVersionError,
  type VersionPrismaClient,
  type VersionRow,
} from "./requirement-version-service.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pickTracked", () => {
  it("extracts only tracked fields and nullifies undefined", () => {
    const snap = pickTracked({ id: "r1", version: 3, title: "T", extra: "x" });
    expect(Object.keys(snap).sort()).toEqual([...TRACKED_FIELDS].sort());
    expect(snap.title).toBe("T");
    expect(snap.body).toBeNull();
  });
});

describe("computeChangedFields", () => {
  it("returns only the fields that changed (compact)", () => {
    const before = { title: "A", body: "B", priority: "low" };
    const after = { title: "A2", body: "B", priority: "low" };
    const diff = computeChangedFields(before, after);
    expect(Object.keys(diff)).toEqual(["title"]);
    expect(diff.title).toEqual({ from: "A", to: "A2" });
  });

  it("ignores fields not present in `after`", () => {
    const diff = computeChangedFields({ title: "A", body: "B" }, { title: "A2" });
    expect(Object.keys(diff)).toEqual(["title"]);
  });

  it("treats null and undefined as equal (no spurious diff)", () => {
    const diff = computeChangedFields({ reviewStatus: undefined }, { reviewStatus: null });
    expect(diff).toEqual({});
  });

  it("detects a value becoming null", () => {
    const diff = computeChangedFields({ storyPoints: 5 }, { storyPoints: null });
    expect(diff.storyPoints).toEqual({ from: 5, to: null });
  });

  it("returns an empty diff when nothing changed", () => {
    expect(computeChangedFields({ title: "A" }, { title: "A" })).toEqual({});
  });
});

describe("serialize/parse round-trip", () => {
  it("round-trips a diff through JSON", () => {
    const diff = computeChangedFields(
      { title: "Old", labels: '["a"]', storyPoints: 3 },
      { title: "New", labels: '["a","b"]', storyPoints: 8 },
    );
    const restored = parseChangedFields(serializeChangedFields(diff));
    expect(restored).toEqual(diff);
  });

  it("parses bad / empty input to an empty object", () => {
    expect(parseChangedFields(null)).toEqual({});
    expect(parseChangedFields("")).toEqual({});
    expect(parseChangedFields("not json")).toEqual({});
    expect(parseChangedFields("[1,2,3]")).toEqual({});
  });
});

describe("applyReverse", () => {
  it("reverts changed fields to their `from` value", () => {
    const state = pickTracked({ title: "New", body: "B" });
    const reverted = applyReverse(state, { title: { from: "Old", to: "New" } });
    expect(reverted.title).toBe("Old");
    expect(reverted.body).toBe("B");
  });

  it("ignores unknown fields in the diff", () => {
    const state = pickTracked({ title: "X" });
    const reverted = applyReverse(state, { bogus: { from: 1, to: 2 } });
    expect(reverted.title).toBe("X");
  });
});

describe("reconstructSnapshots", () => {
  it("rebuilds the snapshot at every version from the current state", () => {
    // History: v1 set title A→B, v2 set body C→D, v3 set title B→E
    const current = pickTracked({ title: "E", body: "D", priority: "low" });
    const rows: VersionRow[] = [
      {
        version: 3,
        changedFields: JSON.stringify({ title: { from: "B", to: "E" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
      {
        version: 2,
        changedFields: JSON.stringify({ body: { from: "C", to: "D" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
      {
        version: 1,
        changedFields: JSON.stringify({ title: { from: "A", to: "B" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
    ];
    const snaps = reconstructSnapshots(current, rows);
    expect(snaps.get(3)).toMatchObject({ title: "E", body: "D" });
    expect(snaps.get(2)).toMatchObject({ title: "B", body: "D" });
    expect(snaps.get(1)).toMatchObject({ title: "B", body: "C" });
  });
});

describe("buildHistoryEntries", () => {
  it("returns newest-first entries with parsed diffs and snapshots", () => {
    const current = pickTracked({ title: "B" });
    const rows: VersionRow[] = [
      {
        version: 1,
        changedFields: JSON.stringify({ title: { from: "A", to: "B" } }),
        actorId: "u1",
        reason: "edit",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    const entries = buildHistoryEntries(current, rows);
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe(1);
    expect(entries[0].actorId).toBe("u1");
    expect(entries[0].changedFields.title).toEqual({ from: "A", to: "B" });
    expect(entries[0].snapshot.title).toBe("B");
    expect(entries[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// DB operations (mocked Prisma)
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<Record<string, unknown>> = {}): {
  client: VersionPrismaClient;
  requirement: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  requirementVersion: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
} {
  const requirement = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const requirementVersion = {
    create: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
  const client = {
    requirement,
    requirementVersion,
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(client)),
    ...overrides,
  } as unknown as VersionPrismaClient;
  return { client, requirement, requirementVersion };
}

describe("updateRequirementWithHistory", () => {
  it("appends a version row when fields change", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValue({
      id: "r1",
      version: 2,
      title: "Old",
      body: "Body",
      priority: "low",
      type: "feature",
      labels: "[]",
      storyPoints: null,
      reviewStatus: null,
    });
    requirement.update.mockResolvedValue({ id: "r1", version: 3, updatedAt: new Date() });

    const result = await updateRequirementWithHistory(client, {
      requirementId: "r1",
      patch: { title: "New" },
      actorId: "user-1",
      reason: "fix typo",
    });

    expect(result.changed).toBe(true);
    expect(result.version).toBe(3);
    expect(requirementVersion.create).toHaveBeenCalledTimes(1);
    const createArg = requirementVersion.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.version).toBe(3);
    expect(createArg.data.actorId).toBe("user-1");
    expect(createArg.data.reason).toBe("fix typo");
    expect(JSON.parse(createArg.data.changedFields as string)).toEqual({
      title: { from: "Old", to: "New" },
    });
  });

  it("does NOT append a version row for a no-op patch", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValue({
      id: "r1",
      version: 2,
      title: "Same",
      body: "Body",
      priority: "low",
      type: "feature",
      labels: "[]",
      storyPoints: null,
      reviewStatus: null,
    });
    requirement.update.mockResolvedValue({ id: "r1", version: 2, updatedAt: new Date() });

    const result = await updateRequirementWithHistory(client, {
      requirementId: "r1",
      patch: { title: "Same" },
    });

    expect(result.changed).toBe(false);
    expect(requirementVersion.create).not.toHaveBeenCalled();
    const updateArg = requirement.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data).not.toHaveProperty("version");
  });

  it("throws NOT_FOUND when the requirement is missing", async () => {
    const { client, requirement } = makeClient();
    requirement.findUnique.mockResolvedValue(null);
    await expect(
      updateRequirementWithHistory(client, { requirementId: "missing", patch: { title: "x" } }),
    ).rejects.toBeInstanceOf(RequirementVersionError);
  });
});

describe("restoreRequirementVersion", () => {
  it("reconstructs the target state and appends version N+1 without mutating history", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    // current state: title E (v3); history rows below.
    requirement.findUnique.mockResolvedValue({
      id: "r1",
      version: 3,
      title: "E",
      body: "D",
      priority: "low",
      type: "feature",
      labels: "[]",
      storyPoints: null,
      reviewStatus: null,
    });
    requirementVersion.findMany.mockResolvedValue([
      {
        version: 3,
        changedFields: JSON.stringify({ title: { from: "B", to: "E" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
      {
        version: 2,
        changedFields: JSON.stringify({ body: { from: "C", to: "D" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
      {
        version: 1,
        changedFields: JSON.stringify({ title: { from: "A", to: "B" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
    ]);
    requirement.update.mockResolvedValue({ id: "r1", version: 4, updatedAt: new Date() });

    const result = await restoreRequirementVersion(client, {
      requirementId: "r1",
      targetVersion: 1,
      actorId: "admin-1",
    });

    expect(result.version).toBe(4);
    expect(result.restoredFrom).toBe(1);
    // State at v1 is title B, body C.
    const updateArg = requirement.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data.title).toBe("B");
    expect(updateArg.data.body).toBe("C");
    expect(updateArg.data.version).toBe(4);
    // A new (N+1) version row is appended; history rows are untouched.
    expect(requirementVersion.create).toHaveBeenCalledTimes(1);
    const createArg = requirementVersion.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.version).toBe(4);
    expect(createArg.data.reason).toContain("Restored to version 1");
  });

  it("throws INVALID_VERSION for an unknown target version", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValue({
      id: "r1",
      version: 1,
      title: "X",
      body: "Y",
      priority: "low",
      type: "feature",
      labels: "[]",
      storyPoints: null,
      reviewStatus: null,
    });
    requirementVersion.findMany.mockResolvedValue([
      { version: 1, changedFields: "{}", actorId: null, reason: null, createdAt: new Date() },
    ]);
    await expect(
      restoreRequirementVersion(client, { requirementId: "r1", targetVersion: 99 }),
    ).rejects.toMatchObject({ code: "INVALID_VERSION" });
  });

  it("throws NOT_FOUND when the requirement is missing", async () => {
    const { client, requirement } = makeClient();
    requirement.findUnique.mockResolvedValue(null);
    await expect(
      restoreRequirementVersion(client, { requirementId: "missing", targetVersion: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
