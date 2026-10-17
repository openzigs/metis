/**
 * Issue #1203 — the shared-criteria record's reader, the "edited since
 * promotion" rule, and the published issue's note.
 */
import { describe, expect, it } from "vitest";
import {
  criteriaAsPromoted,
  findSharedCriteria,
  joinNames,
  readSharedCriteriaRecord,
  readSharedCriteriaRecords,
  renderSharedCriteriaIssueNote,
  sharedCriteriaToMark,
  sharedSiblingLabel,
  type SharedCriteriaRecord,
} from "./shared-criteria.js";

const GROUP = ["Logging out ends every session.", "A reset ends every session."];
const RECORD: SharedCriteriaRecord = {
  requirementId: "rq_1",
  structuredId: "REQ-1",
  sharedWith: [
    { structuredId: "REQ-2", title: "Flush on reset", requirementId: "rq_2", approved: true },
    { structuredId: "REQ-3", title: "Flush on revoke", requirementId: null, approved: false },
  ],
  sharedCriteria: GROUP,
  promotedCriteria: GROUP,
};
const metadata = { promotionMatching: { ambiguous: [], shared: [RECORD], updatedAt: "x" } };

describe("readSharedCriteriaRecord", () => {
  it("accepts a well-formed entry", () => {
    expect(readSharedCriteriaRecord(RECORD)).toEqual(RECORD);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["no requirement id", { ...RECORD, requirementId: 1 }],
    ["no structured id", { ...RECORD, structuredId: undefined }],
    ["no sibling list", { ...RECORD, sharedWith: "REQ-2" }],
    ["criteria not strings", { ...RECORD, sharedCriteria: [1] }],
    ["no promoted list", { ...RECORD, promotedCriteria: undefined }],
    ["no valid sibling", { ...RECORD, sharedWith: [null, { structuredId: "REQ-2" }] }],
    ["no shared criteria", { ...RECORD, sharedCriteria: [] }],
  ])("rejects %s", (_label, raw) => {
    expect(readSharedCriteriaRecord(raw)).toBeNull();
  });

  it("reads a sibling's missing row and approval defensively", () => {
    const read = readSharedCriteriaRecord({
      ...RECORD,
      sharedWith: [{ structuredId: "REQ-2", title: "T", requirementId: 5 }, "junk"],
    });
    expect(read?.sharedWith).toEqual([
      { structuredId: "REQ-2", title: "T", requirementId: null, approved: false },
    ]);
  });
});

describe("readSharedCriteriaRecords / findSharedCriteria", () => {
  it("is empty for an older record or anything malformed", () => {
    expect(readSharedCriteriaRecords(undefined)).toEqual([]);
    expect(readSharedCriteriaRecords({ ambiguous: [] })).toEqual([]);
    expect(readSharedCriteriaRecords({ shared: "no" })).toEqual([]);
    expect(readSharedCriteriaRecords({ shared: [RECORD, { bad: true }] })).toEqual([RECORD]);
  });

  it("finds the entry for one row in analysis metadata", () => {
    expect(findSharedCriteria(metadata, "rq_1")).toEqual(RECORD);
    expect(findSharedCriteria(metadata, "rq_9")).toBeNull();
    expect(findSharedCriteria(null, "rq_1")).toBeNull();
    expect(findSharedCriteria({}, "rq_1")).toBeNull();
  });
});

describe("criteriaAsPromoted / sharedCriteriaToMark", () => {
  it("holds for the promoted list, ignoring surrounding whitespace and blanks", () => {
    expect(criteriaAsPromoted(RECORD, [` ${GROUP[0]} `, GROUP[1]!, " "])).toBe(true);
  });

  it.each([
    ["an edited criterion", [GROUP[0]!, "Edited."]],
    ["an added criterion", [...GROUP, "Added."]],
    ["a removed criterion", [GROUP[0]!]],
    ["a reordered list", [GROUP[1]!, GROUP[0]!]],
    ["a cleared list", []],
  ])("fails after %s", (_label, current) => {
    expect(criteriaAsPromoted(RECORD, current)).toBe(false);
    expect(sharedCriteriaToMark(metadata, "rq_1", current)).toBeNull();
  });

  it("marks the row while its criteria are unedited", () => {
    expect(sharedCriteriaToMark(metadata, "rq_1", GROUP)).toEqual(RECORD);
    expect(sharedCriteriaToMark(metadata, "rq_2", GROUP)).toBeNull();
  });
});

describe("wording", () => {
  it("joins names the way a sentence does", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("says when a sibling was not approved", () => {
    expect(sharedSiblingLabel(RECORD.sharedWith[0]!)).toBe("“Flush on reset”");
    expect(sharedSiblingLabel(RECORD.sharedWith[1]!)).toBe("“Flush on revoke” (not approved)");
    expect(sharedSiblingLabel(RECORD.sharedWith[0]!, "Renamed")).toBe("“Renamed”");
  });

  it("names siblings by their current title in the issue note", () => {
    expect(
      renderSharedCriteriaIssueNote(RECORD, (id) => (id === "rq_2" ? "Renamed" : undefined)),
    ).toBe(
      "> Shared with “Renamed” and “Flush on revoke” (not approved): the analysis wrote these acceptance criteria for the group, so some may belong to those requirements rather than this one.",
    );
    expect(renderSharedCriteriaIssueNote(RECORD)).toContain("“Flush on reset”");
  });

  it("points at the marked criteria when only some are shared", () => {
    const partial = { ...RECORD, promotedCriteria: [...GROUP, "Own."] };
    expect(renderSharedCriteriaIssueNote(partial)).toMatch(
      /^> The criteria marked _\(shared\)_ are shared with /,
    );
  });
});
