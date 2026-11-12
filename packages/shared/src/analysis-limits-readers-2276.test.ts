/**
 * Issue #2276 — the capability record is a JSON blob read unchecked, so the
 * limits panel reads its two lists through shape-checking readers, as
 * `readDroppedCitations` (#1155) does for dropped citations.
 */
import { describe, expect, it } from "vitest";
import { readFindingsLeftOut, readRequirementsLeftOut } from "./analysis.js";

const NOTICE = {
  stage: "governing-applicability",
  analysedCount: 24,
  totalCount: 26,
  leftOut: [
    { id: "REQ-025", excerpt: "Export the audit log." },
    { id: "REQ-026", excerpt: "Keep it for seven years." },
  ],
};

const CUT = {
  agentKey: "document",
  producedCount: 52,
  keptCount: 50,
  leftOutTitles: ["Finding 51", "Finding 52"],
};

describe("readRequirementsLeftOut", () => {
  it("keeps a well-formed notice as it is", () => {
    expect(readRequirementsLeftOut([NOTICE])).toEqual([NOTICE]);
  });

  it.each([undefined, null, "x", 3, {}])("reads %j as no notices", (value) => {
    expect(readRequirementsLeftOut(value)).toEqual([]);
  });

  it("drops a notice with an unknown stage, a non-count, or no list", () => {
    expect(
      readRequirementsLeftOut([
        null,
        "x",
        { ...NOTICE, stage: "made-up" },
        { ...NOTICE, analysedCount: "24" },
        { ...NOTICE, totalCount: -1 },
        { ...NOTICE, analysedCount: 1.5 },
        { ...NOTICE, leftOut: "REQ-025" },
      ]),
    ).toEqual([]);
  });

  it("keeps only well-formed entries, and drops a notice none of whose entries are", () => {
    expect(
      readRequirementsLeftOut([
        { ...NOTICE, leftOut: [null, { id: 25 }, { id: "REQ-025" }, NOTICE.leftOut[0]] },
        { ...NOTICE, stage: "requirement-grounded-code", leftOut: [{ id: "REQ-1" }] },
      ]),
    ).toEqual([{ ...NOTICE, leftOut: [NOTICE.leftOut[0]] }]);
  });
});

describe("readFindingsLeftOut", () => {
  it("keeps a well-formed notice as it is", () => {
    expect(readFindingsLeftOut([CUT])).toEqual([CUT]);
  });

  it.each([undefined, null, "x", 3, {}])("reads %j as no notices", (value) => {
    expect(readFindingsLeftOut(value)).toEqual([]);
  });

  it("drops a notice with no agent, a non-count, nothing cut, or no title list", () => {
    expect(
      readFindingsLeftOut([
        null,
        7,
        { ...CUT, agentKey: "" },
        { ...CUT, agentKey: 3 },
        { ...CUT, producedCount: "52" },
        { ...CUT, keptCount: null },
        { ...CUT, producedCount: 50 },
        { ...CUT, leftOutTitles: "Finding 51" },
      ]),
    ).toEqual([]);
  });

  it("keeps only the string titles", () => {
    expect(readFindingsLeftOut([{ ...CUT, leftOutTitles: ["Finding 51", 52, null] }])).toEqual([
      { ...CUT, leftOutTitles: ["Finding 51"] },
    ]);
  });
});
