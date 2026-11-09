/**
 * Epic #201 (#210) — durable clarification dialog state store unit tests.
 *
 * Prisma is mocked so these stay fast and DB-free. The store is the only seam
 * that touches the `clarification_dialog_states` table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTable = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
};

const mockPrisma = {
  clarificationDialogState: mockTable,
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

const {
  readDialogState,
  readDialogStateRevision,
  replaceDialogState,
  writeDialogState,
  deleteDialogState,
} = await import("../src/lib/analysis/clarification-dialog-store.js");

import type { ClarificationState } from "../src/lib/analysis/types/requirements.js";

function makeState(): ClarificationState {
  return {
    analysisId: "a-1",
    currentRound: 2,
    maxRounds: 3,
    rounds: [{ round: 1, questions: [], answers: [] }],
    resolvedAmbiguities: ["req-1:field-0"],
    escalatedToSonnet: false,
    completed: false,
  };
}

describe("clarification-dialog-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readDialogState", () => {
    it("returns undefined when no row exists", async () => {
      mockTable.findUnique.mockResolvedValue(null);
      expect(await readDialogState("missing")).toBeUndefined();
      expect(mockTable.findUnique).toHaveBeenCalledWith({
        where: { analysisId: "missing" },
        select: { state: true },
      });
    });

    it("parses and returns the stored state", async () => {
      const state = makeState();
      mockTable.findUnique.mockResolvedValue({ state: JSON.stringify(state) });
      expect(await readDialogState("a-1")).toEqual(state);
    });

    it("returns undefined for a corrupt JSON blob (defensive)", async () => {
      mockTable.findUnique.mockResolvedValue({ state: "{not-json" });
      expect(await readDialogState("a-1")).toBeUndefined();
    });
  });

  describe("writeDialogState", () => {
    it("upserts the serialized state idempotently", async () => {
      const state = makeState();
      mockTable.upsert.mockResolvedValue({});
      await writeDialogState("a-1", state);
      const serialized = JSON.stringify(state);
      expect(mockTable.upsert).toHaveBeenCalledWith({
        where: { analysisId: "a-1" },
        create: { analysisId: "a-1", state: serialized },
        update: { state: serialized },
      });
    });

    it("treats analysisId as a bound parameter, never interpolated (OWASP)", async () => {
      mockTable.upsert.mockResolvedValue({});
      const evil = "a'-1; DROP TABLE analyses;--";
      await writeDialogState(evil, makeState());
      const call = mockTable.upsert.mock.calls[0]![0] as { where: { analysisId: string } };
      expect(call.where.analysisId).toBe(evil);
    });
  });

  // #2101 — the submit's compare-and-set.
  describe("readDialogStateRevision / replaceDialogState", () => {
    it("reads the state with the exact stored row as its revision", async () => {
      const state = makeState();
      // Not JSON.stringify's own spacing: the revision is the row, not a re-serialization.
      const row = JSON.stringify(state, null, 2);
      mockTable.findUnique.mockResolvedValue({ state: row });
      expect(await readDialogStateRevision("a-1")).toEqual({ state, revision: row });
    });

    it("reads no revision for a missing or corrupt row", async () => {
      mockTable.findUnique.mockResolvedValueOnce(null);
      expect(await readDialogStateRevision("a-1")).toBeUndefined();
      mockTable.findUnique.mockResolvedValueOnce({ state: "{not-json" });
      expect(await readDialogStateRevision("a-1")).toBeUndefined();
    });

    it("writes only over the revision it was given, and returns the new one", async () => {
      const state = makeState();
      mockTable.updateMany.mockResolvedValue({ count: 1 });
      expect(await replaceDialogState("a-1", "rev-0", state)).toBe(JSON.stringify(state));
      expect(mockTable.updateMany).toHaveBeenCalledWith({
        where: { analysisId: "a-1", state: "rev-0" },
        data: { state: JSON.stringify(state) },
      });
      expect(mockTable.upsert).not.toHaveBeenCalled();
    });

    it("returns null when the row changed since it was read", async () => {
      mockTable.updateMany.mockResolvedValue({ count: 0 });
      expect(await replaceDialogState("a-1", "rev-0", makeState())).toBeNull();
    });
  });

  describe("deleteDialogState", () => {
    it("deletes by analysisId and is a no-op when absent", async () => {
      mockTable.deleteMany.mockResolvedValue({ count: 0 });
      await deleteDialogState("a-1");
      expect(mockTable.deleteMany).toHaveBeenCalledWith({ where: { analysisId: "a-1" } });
    });
  });
});
