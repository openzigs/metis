/**
 * Issue #1204 — the record of what promotion's title join refused, keyed by the
 * persisted rows.
 */
import { describe, expect, it } from "vitest";
import type { SharedCriteriaRecord } from "@metis/shared";
import type { AmbiguousPromotionMatch, SharedPromotionMatch } from "./approved-requirement-set.js";
import {
  ambiguousPromotionRecords,
  appendPromotionMatching,
  promotionMatchingRecord,
  readPromotionMatchingRecord,
  sharedCriteriaRecords,
  sharedRowsByStructuredId,
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
    expect(promotionMatchingRecord(records, [], NOW)).toEqual({
      ambiguousCount: 1,
      ambiguous: records,
      shared: [],
      updatedAt: NOW.toISOString(),
    });
    expect(promotionMatchingRecord([], [], NOW).ambiguousCount).toBe(0);
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
      shared: [],
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
      promotionMatchingRecord([earlier, stale], [], NOW),
      { ambiguous: [fresh] },
      NOW,
    );
    expect(out).toEqual({
      ambiguousCount: 2,
      ambiguous: [earlier, fresh],
      shared: [],
      updatedAt: NOW.toISOString(),
    });
  });

  it("starts a record when there was none", () => {
    expect(appendPromotionMatching(null, { ambiguous: [] }, NOW)).toEqual({
      ambiguousCount: 0,
      ambiguous: [],
      shared: [],
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

describe("#1203 — shared criteria, keyed by the rows", () => {
  const CRITERIA = ["Logging out ends every session.", "A reset ends every session."];
  /** REQ-1, REQ-2 and REQ-3 approved at positions 0..2; REQ-9 was not approved. */
  const match = (
    structuredId: string,
    approvedIndex: number,
    siblings: Array<[string, number | null]>,
  ): SharedPromotionMatch => ({
    structuredId,
    approvedIndex,
    sharedWith: siblings.map(([id, idx]) => ({
      structuredId: id,
      title: `Title ${id}`,
      approvedIndex: idx,
    })),
    sharedCriteria: CRITERIA,
    promotedCriteria: CRITERIA,
  });
  const sib = (structuredId: string, requirementId: string | null, approved = true) => ({
    structuredId,
    title: `Title ${structuredId}`,
    requirementId,
    approved,
  });
  const entry = (
    requirementId: string,
    structuredId: string,
    sharedWith: ReturnType<typeof sib>[],
  ): SharedCriteriaRecord => ({
    requirementId,
    structuredId,
    sharedWith,
    sharedCriteria: CRITERIA,
    promotedCriteria: CRITERIA,
  });

  it("keys the entry and each approved sibling by the row at its approved position", () => {
    const out = sharedCriteriaRecords(
      [
        match("REQ-1", 0, [
          ["REQ-2", 1],
          ["REQ-9", null],
        ]),
      ],
      ["rq_1", "rq_2"],
    );
    expect(out).toEqual([
      entry("rq_1", "REQ-1", [sib("REQ-2", "rq_2"), sib("REQ-9", null, false)]),
    ]);
  });

  it("leaves out an entry whose row this call did not write, and finds an earlier sibling's row", () => {
    const rows: Array<string | undefined> = [undefined, "rq_new"];
    const earlier = new Map([["REQ-1", "rq_old"]]);
    expect(
      sharedCriteriaRecords(
        [match("REQ-1", 0, [["REQ-2", 1]]), match("REQ-2", 1, [["REQ-1", 0]])],
        rows,
        earlier,
      ),
    ).toEqual([entry("rq_new", "REQ-2", [sib("REQ-1", "rq_old")])]);
  });

  it("an approved sibling with no known row has no link but still reads as approved", () => {
    expect(sharedCriteriaRecords([match("REQ-2", 1, [["REQ-1", 0]])], [undefined, "rq_2"])).toEqual(
      [entry("rq_2", "REQ-2", [sib("REQ-1", null, true)])],
    );
  });

  it("reads the rows an earlier record knows, from entries and their siblings", () => {
    const record = promotionMatchingRecord(
      [],
      [entry("rq_1", "REQ-1", [sib("REQ-2", "rq_2"), sib("REQ-9", null, false)])],
      NOW,
    );
    expect([...sharedRowsByStructuredId(record)]).toEqual([
      ["REQ-1", "rq_1"],
      ["REQ-2", "rq_2"],
    ]);
    expect(sharedRowsByStructuredId(null).size).toBe(0);
  });

  it("an append links an earlier row's note to the sibling appended now", () => {
    const earlier = promotionMatchingRecord(
      [],
      [entry("rq_1", "REQ-1", [sib("REQ-2", null, false), sib("REQ-3", null, false)])],
      NOW,
    );
    const added = entry("rq_2", "REQ-2", [sib("REQ-1", "rq_1"), sib("REQ-3", null, false)]);
    const out = appendPromotionMatching(
      earlier,
      { ambiguous: [], shared: [added], rowsByStructuredId: new Map([["REQ-2", "rq_2"]]) },
      NOW,
    );
    expect(out.shared).toEqual([
      entry("rq_1", "REQ-1", [sib("REQ-2", "rq_2", true), sib("REQ-3", null, false)]),
      added,
    ]);
  });

  it("an append replaces an entry for the same row rather than doubling it", () => {
    const earlier = promotionMatchingRecord(
      [],
      [entry("rq_2", "REQ-2", [sib("REQ-1", null)])],
      NOW,
    );
    const fresh = entry("rq_2", "REQ-2", [sib("REQ-1", "rq_1")]);
    expect(
      appendPromotionMatching(earlier, { ambiguous: [], shared: [fresh] }, NOW).shared,
    ).toEqual([fresh]);
  });

  it("reads stored entries defensively: malformed ones are dropped, absence is empty", () => {
    const good = entry("rq_1", "REQ-1", [sib("REQ-2", "rq_2")]);
    const read = readPromotionMatchingRecord({
      ambiguous: [],
      shared: [good, null, { requirementId: "rq_x" }],
      updatedAt: "x",
    });
    expect(read?.shared).toEqual([good]);
    expect(readPromotionMatchingRecord({ ambiguous: [] })?.shared).toEqual([]);
  });
});
