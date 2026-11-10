/**
 * #2156 — the shared compare-and-set fake keeps the real store's contract
 * (`clarification-dialog-store.ts`), so the six suites that use it test the
 * dialog against the behaviour it will meet.
 */
import { describe, expect, it, vi } from "vitest";
import { dialogStoreCasFakes, jsonClone } from "./dialog-store-cas-fake.js";

const round = (n: number) => ({ analysisId: "a-1", currentRound: n });

describe("dialogStoreCasFakes", () => {
  describe("readDialogStateRevision", () => {
    it.each([
      ["structured clone", undefined],
      ["JSON clone", jsonClone],
    ])("hands out a revision both writers accept, with a %s copy", async (_name, clone) => {
      const store = new Map<string, unknown>([["a-1", round(1)]]);
      const fakes = dialogStoreCasFakes(store, clone);
      const read = await fakes.readDialogStateRevision("a-1");
      expect(read?.state).toEqual(round(1));
      expect(read?.state).not.toBe(store.get("a-1"));
      expect(await fakes.replaceDialogState("a-1", read?.revision, round(2))).not.toBeNull();
      const reread = await fakes.readDialogStateRevision("a-1");
      expect(
        await fakes.commitDialogState("a-1", reread!.revision, round(3), async () => {}),
      ).not.toBeNull();
    });

    it("reads nothing for a missing row", async () => {
      expect(await dialogStoreCasFakes(new Map()).readDialogStateRevision("a-1")).toBeUndefined();
    });
  });

  describe("replaceDialogState", () => {
    it("with no revision, creates the row only while there is none", async () => {
      const store = new Map<string, unknown>();
      const { replaceDialogState } = dialogStoreCasFakes(store);
      expect(await replaceDialogState("a-1", undefined, round(1))).toBe(JSON.stringify(round(1)));
      expect(await replaceDialogState("a-1", undefined, round(2))).toBeNull();
      expect(store.get("a-1")).toEqual(round(1));
    });

    it("with a revision, writes only over the row it was read from", async () => {
      const store = new Map<string, unknown>([["a-1", round(1)]]);
      const { replaceDialogState } = dialogStoreCasFakes(store);
      expect(await replaceDialogState("a-1", JSON.stringify(round(9)), round(2))).toBeNull();
      expect(await replaceDialogState("a-1", JSON.stringify(round(1)), round(2))).toBe(
        JSON.stringify(round(2)),
      );
      expect(store.get("a-1")).toEqual(round(2));
    });
  });

  describe("commitDialogState", () => {
    it("refuses a stale revision and runs nothing alongside", async () => {
      const store = new Map<string, unknown>([["a-1", round(1)]]);
      const { commitDialogState } = dialogStoreCasFakes(store);
      const alongside = vi.fn(async () => {});
      expect(
        await commitDialogState("a-1", JSON.stringify(round(9)), round(2), alongside),
      ).toBeNull();
      expect(alongside).not.toHaveBeenCalled();
      expect(store.get("a-1")).toEqual(round(1));
    });

    it("puts the row back as it was read when alongside throws, and rethrows", async () => {
      const store = new Map<string, unknown>([["a-1", round(1)]]);
      const { commitDialogState } = dialogStoreCasFakes(store);
      await expect(
        commitDialogState("a-1", JSON.stringify(round(1)), round(2), async () => {
          // Inside the transaction the new round is already written.
          expect(store.get("a-1")).toEqual(round(2));
          throw new Error("REQUIREMENTS_REPLACED");
        }),
      ).rejects.toThrow("REQUIREMENTS_REPLACED");
      expect(store.get("a-1")).toEqual(round(1));
    });

    it("commits the round and returns its revision when alongside succeeds", async () => {
      const store = new Map<string, unknown>([["a-1", round(1)]]);
      const { commitDialogState } = dialogStoreCasFakes(store);
      expect(
        await commitDialogState("a-1", JSON.stringify(round(1)), round(2), async () => {}),
      ).toBe(JSON.stringify(round(2)));
      expect(store.get("a-1")).toEqual(round(2));
    });
  });
});
