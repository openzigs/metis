/**
 * Issue #1204 — the record of what promotion's title join refused, keyed by the
 * persisted rows.
 */
import { describe, expect, it } from "vitest";
import type { AmbiguousPromotionMatch } from "./approved-requirement-set.js";
import {
  ambiguousPromotionRecords,
  appendPromotionMatching,
  promotionMatchingRecord,
  readPromotionMatchingRecord,
  withoutGivenItems,
} from "./promotion-matching.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const CANDIDATES = [
  { title: "Flush sessions on logout", acceptanceCriteria: ["Logging out ends every session."] },
  { title: "Flush sessions on password reset", acceptanceCriteria: [] },
];
const refused = (structuredId: string, approvedIndex: number): AmbiguousPromotionMatch => ({
  structuredId,
  approvedIndex,
  candidates: CANDIDATES,
  synthesizedIndexes: [0, 1],
});

describe("ambiguousPromotionRecords", () => {
  it("keys each refusal by the row persisted at its approved position", () => {
    expect(ambiguousPromotionRecords([refused("REQ-2", 1)], ["rq_a", "rq_b"])).toEqual([
      { requirementId: "rq_b", structuredId: "REQ-2", candidates: CANDIDATES },
    ]);
  });

  it("leaves out a refusal whose requirement was not written by this call", () => {
    // An append writes only the new rows: position 0 already existed.
    const rows: Array<string | undefined> = [undefined, "rq_new"];
    expect(ambiguousPromotionRecords([refused("REQ-1", 0)], rows)).toEqual([]);
  });
});

describe("promotionMatchingRecord", () => {
  it("counts the entries, mirroring unattributedCount", () => {
    const records = ambiguousPromotionRecords([refused("REQ-1", 0)], ["rq_a"]);
    expect(promotionMatchingRecord(records, NOW)).toEqual({
      ambiguousCount: 1,
      ambiguous: records,
      updatedAt: NOW.toISOString(),
    });
    expect(promotionMatchingRecord([], NOW).ambiguousCount).toBe(0);
  });
});

describe("readPromotionMatchingRecord", () => {
  it("is null when absent or not an object with a list", () => {
    expect(readPromotionMatchingRecord(undefined)).toBeNull();
    expect(readPromotionMatchingRecord([])).toBeNull();
    expect(readPromotionMatchingRecord({ ambiguous: "no" })).toBeNull();
  });

  it("drops malformed entries and recounts", () => {
    const good = { requirementId: "rq_a", structuredId: "REQ-1", candidates: CANDIDATES };
    const read = readPromotionMatchingRecord({
      ambiguousCount: 9,
      ambiguous: [good, null, { requirementId: 3 }, { requirementId: "rq_b" }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(read).toEqual({
      ambiguousCount: 1,
      ambiguous: [good],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("tolerates a missing timestamp", () => {
    expect(readPromotionMatchingRecord({ ambiguous: [] })?.updatedAt).toBe(
      new Date(0).toISOString(),
    );
  });
});

describe("appendPromotionMatching", () => {
  it("keeps earlier entries, adds the new ones, and replaces an entry for the same row", () => {
    const earlier = { requirementId: "rq_a", structuredId: "REQ-1", candidates: [] };
    const stale = { requirementId: "rq_b", structuredId: "REQ-2", candidates: [] };
    const fresh = { requirementId: "rq_b", structuredId: "REQ-2", candidates: CANDIDATES };
    const out = appendPromotionMatching(
      promotionMatchingRecord([earlier, stale], NOW),
      [fresh],
      NOW,
    );
    expect(out).toEqual({
      ambiguousCount: 2,
      ambiguous: [earlier, fresh],
      updatedAt: NOW.toISOString(),
    });
  });

  it("starts a record when there was none", () => {
    expect(appendPromotionMatching(null, [], NOW)).toEqual({
      ambiguousCount: 0,
      ambiguous: [],
      updatedAt: NOW.toISOString(),
    });
  });
});

describe("withoutGivenItems (#1204 review)", () => {
  it("drops an option an existing row already carries, keeping the rest aligned", () => {
    expect(withoutGivenItems([refused("REQ-3", 1)], new Set([0]))).toEqual([
      {
        structuredId: "REQ-3",
        approvedIndex: 1,
        candidates: [CANDIDATES[1]],
        synthesizedIndexes: [1],
      },
    ]);
  });

  it("drops a refusal left with no option, never recording an empty list", () => {
    expect(withoutGivenItems([refused("REQ-3", 1)], new Set([0, 1]))).toEqual([]);
  });

  it("changes nothing when no item was given out", () => {
    expect(withoutGivenItems([refused("REQ-3", 1)], new Set())).toEqual([refused("REQ-3", 1)]);
  });
});
