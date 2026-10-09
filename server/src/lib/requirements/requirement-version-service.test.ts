/**
 * Epic #770 / Issue #771 — Requirement version-history service tests.
 */
import { describe, expect, it, vi } from "vitest";
import { CRITERIA_FLAG_LINE } from "../analysis/clarification-criteria-flag.js";
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
  requirement: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  requirementVersion: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
} {
  const requirement = {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
    requirement.findUnique.mockResolvedValueOnce({
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
    requirement.findUnique.mockResolvedValueOnce({
      id: "r1",
      version: 3,
      updatedAt: new Date(),
    });

    const result = await updateRequirementWithHistory(client, {
      requirementId: "r1",
      patch: { title: "New" },
      actorId: "user-1",
      reason: "fix typo",
    });

    expect(result.changed).toBe(true);
    expect(result.version).toBe(3);
    // #871 — the write is conditional on the version read in the transaction.
    expect(requirement.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", version: 2, deletedAt: null },
      data: { title: "New", version: 3 },
    });
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

  describe("#1000 — editing the criteria clears the clarification criteria flag", () => {
    const FLAGGED = `Body.\n\n_Preamble._\n\n${CRITERIA_FLAG_LINE}\n\n- **Q:** q\n  **A:** a`;
    const row = (over: Record<string, unknown> = {}) => ({
      id: "r1",
      version: 1,
      title: "T",
      body: FLAGGED,
      priority: "low",
      type: "feature",
      labels: "[]",
      storyPoints: null,
      reviewStatus: null,
      acceptanceCriteria: JSON.stringify(["old"]),
      ...over,
    });
    const run = async (patch: Record<string, unknown>, current = row()) => {
      const { client, requirement } = makeClient();
      requirement.findUnique.mockResolvedValueOnce(current);
      requirement.findUnique.mockResolvedValueOnce({ id: "r1", version: 2, updatedAt: new Date() });
      await updateRequirementWithHistory(client, { requirementId: "r1", patch });
      return requirement.updateMany.mock.calls[0]?.[0] as
        { data: Record<string, unknown> } | undefined;
    };

    it("removes the flag from the stored body when the criteria change", async () => {
      const call = await run({ acceptanceCriteria: JSON.stringify(["new"]) });
      expect(call?.data.body).toBe("Body.\n\n_Preamble._\n\n- **Q:** q\n  **A:** a");
    });

    it("removes it from a body sent in the same edit", async () => {
      const call = await run({
        acceptanceCriteria: JSON.stringify(["new"]),
        body: `${FLAGGED}\nmore`,
      });
      expect(call?.data.body).toBe("Body.\n\n_Preamble._\n\n- **Q:** q\n  **A:** a\nmore");
    });

    it("keeps it when the criteria are unchanged or not edited", async () => {
      expect(await run({ acceptanceCriteria: JSON.stringify(["old"]), title: "T2" })).toEqual({
        where: { id: "r1", version: 1, deletedAt: null },
        data: { acceptanceCriteria: JSON.stringify(["old"]), title: "T2", version: 2 },
      });
      expect((await run({ title: "T2" }))?.data.body).toBeUndefined();
    });

    it("writes no body when there is no flag to clear", async () => {
      const call = await run({ acceptanceCriteria: "[]" }, row({ body: "Plain." }));
      expect(call?.data).toEqual({ acceptanceCriteria: "[]", version: 2 });
    });
  });

  it("does NOT append a version row for a no-op patch", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValueOnce({
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
    requirement.findUnique.mockResolvedValueOnce({ id: "r1", version: 2, updatedAt: new Date() });

    const result = await updateRequirementWithHistory(client, {
      requirementId: "r1",
      patch: { title: "Same" },
    });

    expect(result.changed).toBe(false);
    expect(result.version).toBe(2);
    expect(requirementVersion.create).not.toHaveBeenCalled();
    // #877 — a no-op writes nothing: an empty conditional UPDATE matches 0 rows
    // on a real database and would be misread as a lost race.
    expect(requirement.updateMany).not.toHaveBeenCalled();
  });

  const ROW_V2 = {
    id: "r1",
    version: 2,
    title: "Old",
    body: "Body",
    priority: "low",
    type: "feature",
    labels: "[]",
    storyPoints: null,
    reviewStatus: null,
  };

  it("#871 — throws VERSION_CONFLICT when the in-transaction version differs from expectedVersion", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValue(ROW_V2);

    await expect(
      updateRequirementWithHistory(client, {
        requirementId: "r1",
        patch: { title: "New" },
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ name: "RequirementVersionError", code: "VERSION_CONFLICT" });
    expect(requirement.updateMany).not.toHaveBeenCalled();
    expect(requirementVersion.create).not.toHaveBeenCalled();
  });

  it("#871 — throws VERSION_CONFLICT when a concurrent writer wins the conditional update", async () => {
    // Postgres READ COMMITTED: both transactions read version 2; the loser's
    // conditional UPDATE re-evaluates against the winner's row and matches 0.
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValue(ROW_V2);
    requirement.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      updateRequirementWithHistory(client, {
        requirementId: "r1",
        patch: { title: "New" },
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(requirement.updateMany).toHaveBeenCalledTimes(1);
    expect(requirementVersion.create).not.toHaveBeenCalled();
  });

  it("#871 — an unversioned edit that loses the race retries on the winner's row", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique
      .mockResolvedValueOnce(ROW_V2)
      .mockResolvedValueOnce({ ...ROW_V2, version: 3, title: "Winner" })
      .mockResolvedValueOnce({ id: "r1", version: 4, updatedAt: new Date() });
    requirement.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const result = await updateRequirementWithHistory(client, {
      requirementId: "r1",
      patch: { title: "Mine" },
    });

    expect(result.version).toBe(4);
    expect(requirement.updateMany).toHaveBeenLastCalledWith({
      where: { id: "r1", version: 3, deletedAt: null },
      data: { title: "Mine", version: 4 },
    });
    expect(requirementVersion.create).toHaveBeenCalledTimes(1);
    const created = requirementVersion.create.mock.calls[0][0] as {
      data: { version: number; changedFields: string };
    };
    expect(created.data.version).toBe(4);
    expect(JSON.parse(created.data.changedFields)).toEqual({
      title: { from: "Winner", to: "Mine" },
    });
  });

  it("#871 — an unversioned edit gives up after bounded retries", async () => {
    const { client, requirement } = makeClient();
    requirement.findUnique.mockResolvedValue(ROW_V2);
    requirement.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      updateRequirementWithHistory(client, { requirementId: "r1", patch: { title: "Mine" } }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(requirement.updateMany).toHaveBeenCalledTimes(3);
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
    requirement.findUnique.mockResolvedValueOnce({
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
    requirement.findUnique.mockResolvedValueOnce({ id: "r1", version: 4, updatedAt: new Date() });

    const result = await restoreRequirementVersion(client, {
      requirementId: "r1",
      targetVersion: 1,
      actorId: "admin-1",
    });

    expect(result.version).toBe(4);
    expect(result.restoredFrom).toBe(1);
    // State at v1 is title B, body C.
    const updateArg = requirement.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
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

  const ROW_V3 = {
    id: "r1",
    version: 3,
    title: "E",
    body: "D",
    priority: "low",
    type: "feature",
    labels: "[]",
    storyPoints: null,
    reviewStatus: null,
  };
  const HISTORY = [
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

  it("#871 — writes conditionally on the version read in the transaction", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique
      .mockResolvedValueOnce(ROW_V3)
      .mockResolvedValueOnce({ id: "r1", version: 4, updatedAt: new Date() });
    requirementVersion.findMany.mockResolvedValue(HISTORY);

    await restoreRequirementVersion(client, { requirementId: "r1", targetVersion: 1 });

    expect(requirement.update).not.toHaveBeenCalled();
    expect(requirement.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", version: 3, deletedAt: null },
      data: expect.objectContaining({ title: "B", body: "C", version: 4 }),
    });
  });

  it("#871 — a restore that loses the race re-reads and restores on top of the winner's row", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    // A concurrent edit committed v4 (body D -> Z) between restore's read and write.
    const winnerRow = { ...ROW_V3, version: 4, body: "Z" };
    const winnerHistory = [
      {
        version: 4,
        changedFields: JSON.stringify({ body: { from: "D", to: "Z" } }),
        actorId: null,
        reason: null,
        createdAt: new Date(),
      },
      ...HISTORY,
    ];
    requirement.findUnique
      .mockResolvedValueOnce(ROW_V3)
      .mockResolvedValueOnce(winnerRow)
      .mockResolvedValueOnce({ id: "r1", version: 5, updatedAt: new Date() });
    requirementVersion.findMany.mockResolvedValueOnce(HISTORY).mockResolvedValueOnce(winnerHistory);
    requirement.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const result = await restoreRequirementVersion(client, {
      requirementId: "r1",
      targetVersion: 1,
    });

    expect(result.version).toBe(5);
    expect(requirement.updateMany).toHaveBeenLastCalledWith({
      where: { id: "r1", version: 4, deletedAt: null },
      data: expect.objectContaining({ title: "B", body: "C", version: 5 }),
    });
    // Exactly one history row, numbered after the winner's, diffed against the winner's row.
    expect(requirementVersion.create).toHaveBeenCalledTimes(1);
    const created = requirementVersion.create.mock.calls[0][0] as {
      data: { version: number; changedFields: string };
    };
    expect(created.data.version).toBe(5);
    expect(JSON.parse(created.data.changedFields)).toEqual({
      title: { from: "E", to: "B" },
      body: { from: "Z", to: "C" },
    });
  });

  it("#871 — a restore gives up with VERSION_CONFLICT after bounded retries", async () => {
    const { client, requirement, requirementVersion } = makeClient();
    requirement.findUnique.mockResolvedValue(ROW_V3);
    requirementVersion.findMany.mockResolvedValue(HISTORY);
    requirement.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      restoreRequirementVersion(client, { requirementId: "r1", targetVersion: 1 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(requirement.updateMany).toHaveBeenCalledTimes(3);
    expect(requirementVersion.create).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the requirement is missing", async () => {
    const { client, requirement } = makeClient();
    requirement.findUnique.mockResolvedValue(null);
    await expect(
      restoreRequirementVersion(client, { requirementId: "missing", targetVersion: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
