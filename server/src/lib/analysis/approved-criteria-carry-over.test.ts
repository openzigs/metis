import { describe, expect, it } from "vitest";
import {
  APPROVED_CRITERIA_KEY,
  CRITERIA_PROPOSALS_KEY,
  normalizeCriterion,
  planApprovedCriteria,
  readApprovedCriteriaRecord,
  sameCriteria,
  readCriteriaProposals,
} from "./approved-criteria-carry-over.js";

const APPROVED = ["Installs as a single binary.", "A page renders in under 200 ms."];

describe("planApprovedCriteria (#1389)", () => {
  const plan = (over: Partial<Parameters<typeof planApprovedCriteria>[0]>) =>
    planApprovedCriteria({
      recorded: APPROVED,
      previousRow: undefined,
      fresh: APPROVED,
      dismissed: undefined,
      ...over,
    });

  it("keeps the approved criteria and raises nothing when the re-synthesis gave none", () => {
    expect(plan({ fresh: [] })).toEqual({ criteria: APPROVED, proposed: null });
  });

  it("raises nothing for the same criteria reworded, reordered or citing other lines", () => {
    expect(
      plan({
        fresh: [
          "a page renders in under 200 ms (internal/ui/ui.go:12-17)",
          "INSTALLS AS A SINGLE BINARY (cmd/main.go:3).",
        ],
      }).proposed,
    ).toBeNull();
  });

  it("keeps the approved criteria and proposes the re-synthesis's different ones", () => {
    expect(plan({ fresh: ["Starts in one second."] })).toEqual({
      criteria: APPROVED,
      proposed: ["Starts in one second."],
    });
  });

  it("treats a strict subset as a proposal too", () => {
    expect(plan({ fresh: [APPROVED[0]!] }).proposed).toEqual([APPROVED[0]]);
  });

  it("proposes nothing when the criteria did not change", () => {
    expect(plan({ fresh: [...APPROVED] })).toEqual({ criteria: APPROVED, proposed: null });
  });

  it("anchors on the record, never on what the previous row holds", () => {
    expect(plan({ previousRow: JSON.stringify(["Drifted."]), fresh: ["Drifted."] })).toEqual({
      criteria: APPROVED,
      proposed: ["Drifted."],
    });
  });

  it("falls back to the previous row for a set promoted before the record existed", () => {
    expect(plan({ recorded: undefined, previousRow: JSON.stringify(APPROVED), fresh: [] })).toEqual(
      { criteria: APPROVED, proposed: null },
    );
    expect(plan({ recorded: undefined, previousRow: "[]", fresh: ["New."] })).toEqual({
      criteria: [],
      proposed: ["New."],
    });
  });

  it("takes the fresh criteria as approved on a first promotion", () => {
    expect(plan({ recorded: undefined, fresh: ["New."] })).toEqual({
      criteria: ["New."],
      proposed: null,
    });
  });

  it("a dismissal holds for the requirement, whatever the next suggestion is", () => {
    const dismissed = JSON.stringify(["Starts in one second."]);
    expect(plan({ fresh: ["Starts in one second."], dismissed }).proposed).toBeNull();
    expect(plan({ fresh: ["Starts in two seconds."], dismissed }).proposed).toBeNull();
  });
});

describe("readApprovedCriteriaRecord / readCriteriaProposals (#1389)", () => {
  it("reads the record of its own extraction run only", () => {
    const metadata = {
      [APPROVED_CRITERIA_KEY]: {
        runId: "run-1",
        approved: { "REQ-1": APPROVED, "REQ-2": "not a list" },
        dismissed: { "REQ-1": "[]", "REQ-2": 7 },
      },
    };
    expect(readApprovedCriteriaRecord(metadata, "run-1")).toEqual({
      runId: "run-1",
      approved: { "REQ-1": APPROVED },
      dismissed: { "REQ-1": "[]" },
    });
    expect(readApprovedCriteriaRecord(metadata, "run-2")).toEqual({
      runId: "run-2",
      approved: {},
      dismissed: {},
    });
    expect(readApprovedCriteriaRecord({}, null)).toEqual({
      runId: null,
      approved: {},
      dismissed: {},
    });
  });

  it("reads well-formed proposals and drops the rest", () => {
    expect(
      readCriteriaProposals({
        [CRITERIA_PROPOSALS_KEY]: {
          a: { structuredId: "REQ-1", proposed: ["x"], at: "2026-10-22T00:00:00.000Z" },
          b: { structuredId: "REQ-2", proposed: [] },
          c: { structuredId: 3, proposed: ["y"] },
          d: null,
        },
      }),
    ).toEqual({
      a: { structuredId: "REQ-1", proposed: ["x"], at: "2026-10-22T00:00:00.000Z" },
      b: { structuredId: "REQ-2", proposed: [], at: "" },
    });
    expect(readCriteriaProposals({ [CRITERIA_PROPOSALS_KEY]: "nope" })).toEqual({});
  });
});

describe("normalizeCriterion / sameCriteria (#1389)", () => {
  it("drops cited lines, case, punctuation and extra whitespace", () => {
    expect(normalizeCriterion("GET /v1/feeds is registered (internal/api/api.go:43 and 37).")).toBe(
      "get v1 feeds is registered",
    );
    expect(normalizeCriterion("  Flush   sessions — see `flush_sessions.go:12-17`,")).toBe(
      "flush sessions see",
    );
    // A time of day is not a citation.
    expect(normalizeCriterion("Runs at 10:30")).toBe("runs at 10 30");
  });

  it("compares as sets, ignoring blanks and duplicates", () => {
    expect(sameCriteria(["A.", "b"], ["B", "a", "  "])).toBe(true);
    expect(sameCriteria(["A", "A"], ["a"])).toBe(true);
    expect(sameCriteria(["A"], ["A", "B"])).toBe(false);
    expect(sameCriteria([], [])).toBe(true);
  });
});
