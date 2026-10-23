/**
 * #1131 — #706 run 8, wave B: the three "unreached" requirements each already
 * had a "Could not verify" finding, two with citations. The agent had reached
 * them; the code simply did not settle them, and a larger budget changed
 * nothing. A requirement with a finding of its own is INCONCLUSIVE, not
 * unreached, and only unreached ones are what a continuation re-investigates.
 */
import { describe, expect, it } from "vitest";
import type { AnalysisRetrievalHealth } from "@metis/shared";
import {
  addInvestigationGaps,
  classifyUnverifiedRequirements,
  investigationGapFromHealth,
  mergeRetrievalHealth,
} from "./retrieval-health.js";

const IDS = ["REQ-1", "REQ-2", "REQ-3", "REQ-4"];

describe("classifyUnverifiedRequirements", () => {
  it("splits could-not-verify requirements into unreached and inconclusive", () => {
    const out = classifyUnverifiedRequirements(
      [
        { requirementId: "REQ-1", verdict: "implemented" },
        { requirementId: "REQ-2", verdict: "could-not-verify", codeCited: true },
        { requirementId: "REQ-9", verdict: "implemented" }, // outside the set
        { requirementId: null, verdict: "gap-confirmed" },
      ],
      IDS,
    );
    expect(out).toEqual({ unreached: ["REQ-3", "REQ-4"], inconclusive: ["REQ-2"] });
  });

  it("counts an uncited could-not-verify as unreached: the prompt's placeholder", () => {
    // VERDICT_RULE (prompts.ts) has the model write exactly this for a
    // requirement it ran out of budget before reaching.
    expect(
      classifyUnverifiedRequirements(
        [{ requirementId: "REQ-1", verdict: "could-not-verify" }, { requirementId: "REQ-2" }],
        ["REQ-1", "REQ-2"],
      ),
    ).toEqual({ unreached: ["REQ-1", "REQ-2"], inconclusive: [] });
  });

  it("counts a requirement reached by a settled finding, even beside a placeholder", () => {
    expect(
      classifyUnverifiedRequirements(
        [
          { requirementId: "REQ-1", verdict: "could-not-verify" },
          { requirementId: "REQ-1", verdict: "implemented" },
        ],
        ["REQ-1"],
      ),
    ).toEqual({ unreached: [], inconclusive: ["REQ-1"] });
  });

  it("reports nothing when every requirement has a grounded verdict", () => {
    expect(
      classifyUnverifiedRequirements(
        IDS.map((id) => ({ requirementId: id, verdict: "gap-confirmed" })),
        IDS,
      ),
    ).toEqual({ unreached: [], inconclusive: [] });
  });
});

describe("investigation gaps", () => {
  const exhausted: AnalysisRetrievalHealth = {
    successfulSearches: 3,
    failedSearches: 0,
    erroredCalls: 0,
    totalCalls: 3,
    requirementCount: 19,
    starved: false,
    degraded: false,
    searchedScope: [],
    exhausted: true,
    unverifiedRequirements: 5,
    unreachedRequirements: 3,
  };

  it("reads unreached and inconclusive from a cut-short pass", () => {
    expect(investigationGapFromHealth(exhausted)).toEqual({
      unreached: 3,
      inconclusive: 2,
      total: 19,
    });
  });

  it("is unknown for a pass that was not cut short or did not count", () => {
    expect(investigationGapFromHealth({ ...exhausted, exhausted: undefined })).toBeUndefined();
    expect(
      investigationGapFromHealth({ ...exhausted, unreachedRequirements: undefined }),
    ).toBeUndefined();
  });

  it("adds the passes of one run, either of which may be absent", () => {
    const a = { unreached: 1, inconclusive: 2, total: 5 };
    const b = { unreached: 3, total: 4 };
    expect(addInvestigationGaps(undefined, undefined)).toBeUndefined();
    expect(addInvestigationGaps(undefined, b)).toEqual(b);
    expect(addInvestigationGaps(a, undefined)).toEqual(a);
    expect(addInvestigationGaps(a, b)).toEqual({ unreached: 4, inconclusive: 2, total: 9 });
  });
});

describe("mergeRetrievalHealth sums unreached requirements", () => {
  const pass = (extra: Partial<AnalysisRetrievalHealth>): AnalysisRetrievalHealth => ({
    successfulSearches: 1,
    failedSearches: 0,
    erroredCalls: 0,
    totalCalls: 1,
    requirementCount: 2,
    starved: false,
    degraded: false,
    searchedScope: [],
    ...extra,
  });

  it("adds the passes that recorded a count", () => {
    const merged = mergeRetrievalHealth([
      pass({ exhausted: true, unverifiedRequirements: 2, unreachedRequirements: 1 }),
      pass({ unverifiedRequirements: 1 }),
    ]);
    expect(merged?.unreachedRequirements).toBe(1);
  });

  it("records a zero when an exhausted pass reached everything", () => {
    const merged = mergeRetrievalHealth([pass({ exhausted: true, unreachedRequirements: 0 })]);
    expect(merged?.unreachedRequirements).toBe(0);
  });

  it("leaves it absent when no pass recorded one", () => {
    expect(mergeRetrievalHealth([pass({})])).not.toHaveProperty("unreachedRequirements");
  });
});
