/**
 * #19 — an analysis whose code agent made ONE tool call and verified 0 of 16
 * requirements was recorded as healthy:
 *
 *   "retrieval": { "successfulSearches": 1, "totalCalls": 1, "requirementCount": 16,
 *                  "starved": false, "degraded": false }
 *
 * The #773 run-level threshold asks only "did retrieval physically work at least
 * once?" — and one working search answers yes. That is the right question for the
 * VERDICT gate (a pass-wide quota made gaps mathematically impossible at scale, so
 * it must stay scale-free), but the wrong one for the HEALTH REPORT, which exists
 * to tell the user that code grounding failed. `assessInvestigationCoverage` is the
 * report-side check: applied after verdicts are gated, it never changes a verdict.
 */
import { describe, expect, it } from "vitest";
import type { AnalysisRetrievalHealth } from "@metis/shared";
import {
  MAX_UNVERIFIED_REQUIREMENT_SHARE,
  MIN_SEARCHES_PER_REQUIREMENT,
  assessInvestigationCoverage,
  countUnverifiedRequirements,
  mergeRetrievalHealth,
  summarizeRetrieval,
} from "./retrieval-health.js";

const hit = (tool: string, query: string) => ({
  tool,
  args: { query },
  result: "function foo — src/foo.ts:1-9 [typescript]",
  resultPreview: "function foo",
  resultCount: 1,
});

/** Real summariser output for `calls` working searches over `requirementCount` requirements. */
function healthOf(
  calls: number,
  requirementCount: number,
  extra: { exhausted?: boolean } = {},
): AnalysisRetrievalHealth {
  return summarizeRetrieval({
    toolCalls: Array.from({ length: calls }, (_, i) => hit("search_code_graph", `q${i}`)),
    requirementCount,
    ...extra,
  });
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `REQ-${i + 1}`);
const cnv = (requirementId: string) => ({ requirementId, verdict: "could-not-verify" });

describe("#19 assessInvestigationCoverage — the reported incident", () => {
  it("marks one search for 16 requirements, all could-not-verify, as starved AND degraded", () => {
    // The #773 threshold alone calls this healthy — which is the bug.
    const before = healthOf(1, 16);
    expect(before.starved).toBe(false);
    expect(before.degraded).toBe(false);

    const unverified = countUnverifiedRequirements(ids(16).map(cnv), ids(16));
    const after = assessInvestigationCoverage(before, { unverifiedRequirements: unverified });

    expect(after.starved).toBe(true);
    expect(after.degraded).toBe(true);
    expect(after.unverifiedRequirements).toBe(16);
  });
});

describe("#19 search starvation — far fewer searches than requirements", () => {
  it("asserts starved: true for one search across many requirements", () => {
    const after = assessInvestigationCoverage(healthOf(1, 12), { unverifiedRequirements: 0 });
    expect(after.starved).toBe(true);
    expect(after.degraded).toBe(true);
  });

  it(`uses ${MIN_SEARCHES_PER_REQUIREMENT} searches per requirement as the floor`, () => {
    // 20 requirements ⇒ 5 searches clear the floor, 4 do not.
    expect(
      assessInvestigationCoverage(healthOf(5, 20), { unverifiedRequirements: 0 }).starved,
    ).toBe(false);
    expect(
      assessInvestigationCoverage(healthOf(4, 20), { unverifiedRequirements: 0 }).starved,
    ).toBe(true);
  });

  it("counts a pass that searched NOTHING as starved", () => {
    const after = assessInvestigationCoverage(healthOf(0, 3), { unverifiedRequirements: 0 });
    expect(after.starved).toBe(true);
  });

  it("leaves a pass with no requirements alone", () => {
    const before = healthOf(0, 0);
    expect(assessInvestigationCoverage(before, { unverifiedRequirements: 0 })).toEqual(before);
  });
});

describe("#19 most requirements could-not-verify", () => {
  it(`degrades a pass where more than ${MAX_UNVERIFIED_REQUIREMENT_SHARE * 100}% are unverified`, () => {
    // Plenty of searches (not starved), but 3 of 4 requirements came back unverified.
    const after = assessInvestigationCoverage(healthOf(8, 4), { unverifiedRequirements: 3 });
    expect(after.starved).toBe(false);
    expect(after.degraded).toBe(true);
    expect(after.unverifiedRequirements).toBe(3);
  });

  it('does not degrade at exactly half ("most" means more than half)', () => {
    const after = assessInvestigationCoverage(healthOf(8, 4), { unverifiedRequirements: 2 });
    expect(after.degraded).toBe(false);
  });

  it("keeps a healthy, well-verified pass healthy and unchanged but for the count", () => {
    const before = healthOf(8, 4);
    const after = assessInvestigationCoverage(before, { unverifiedRequirements: 1 });
    expect(after).toEqual({ ...before, unverifiedRequirements: 1 });
  });

  it("omits the count when nothing was unverified (no churn on a clean run)", () => {
    const before = healthOf(8, 4);
    expect(assessInvestigationCoverage(before, { unverifiedRequirements: 0 })).toEqual(before);
  });

  it("clamps an out-of-range count to the requirement count", () => {
    const after = assessInvestigationCoverage(healthOf(8, 4), { unverifiedRequirements: 99 });
    expect(after.unverifiedRequirements).toBe(4);
  });
});

describe("#19 exhaustion keeps its own signal (#1236)", () => {
  it("does not brand a budget-exhausted pass starved or degraded", () => {
    // #1236: running out of turns says the investigation was cut short, which the
    // record already reports as `exhausted` — it is not retrieval failure.
    const before = healthOf(1, 16, { exhausted: true });
    const after = assessInvestigationCoverage(before, { unverifiedRequirements: 16 });
    expect(after.exhausted).toBe(true);
    expect(after.starved).toBe(false);
    expect(after.degraded).toBe(false);
    expect(after.unverifiedRequirements).toBe(16);
  });
});

describe("#19 the check never feeds back into the verdict record", () => {
  it("returns a new record and leaves its input untouched", () => {
    const before = healthOf(1, 16);
    const snapshot = structuredClone(before);
    const after = assessInvestigationCoverage(before, { unverifiedRequirements: 16 });
    expect(after).not.toBe(before);
    expect(before).toEqual(snapshot);
  });

  it("never clears a degradation the threshold already found", () => {
    const broken = summarizeRetrieval({ toolCalls: [], requirementCount: 1 });
    expect(broken.degraded).toBe(true);
    expect(assessInvestigationCoverage(broken, { unverifiedRequirements: 0 }).degraded).toBe(true);
  });
});

describe("#19 countUnverifiedRequirements", () => {
  it("counts a requirement only when EVERY finding for it is could-not-verify", () => {
    const findings = [
      cnv("REQ-1"),
      { requirementId: "REQ-1", verdict: "implemented" }, // REQ-1 was verified
      cnv("REQ-2"),
      cnv("REQ-2"), // REQ-2 was not
      { requirementId: "REQ-3", verdict: "gap-confirmed" },
    ];
    expect(countUnverifiedRequirements(findings, ids(3))).toBe(1);
  });

  it("ignores findings for requirements outside the pass, or with no requirement", () => {
    const findings = [cnv("REQ-99"), { verdict: "could-not-verify" }, cnv("REQ-1")];
    expect(countUnverifiedRequirements(findings, ids(2))).toBe(1);
  });

  it("does not count requirements the agent reported nothing for", () => {
    expect(countUnverifiedRequirements([], ids(5))).toBe(0);
  });

  it("does not count a finding with no verdict as unverified", () => {
    expect(countUnverifiedRequirements([{ requirementId: "REQ-1", verdict: null }], ids(1))).toBe(
      0,
    );
  });
});

describe("#19 merging passes", () => {
  it("sums the unverified count and keeps a starved pass starved", () => {
    const starved = assessInvestigationCoverage(healthOf(1, 16), { unverifiedRequirements: 16 });
    const fine = assessInvestigationCoverage(healthOf(4, 2), { unverifiedRequirements: 1 });
    const merged = mergeRetrievalHealth([starved, fine]);
    expect(merged?.unverifiedRequirements).toBe(17);
    expect(merged?.starved).toBe(true);
    expect(merged?.degraded).toBe(true);
  });

  it("omits the count when no pass had one", () => {
    const merged = mergeRetrievalHealth([healthOf(4, 2), healthOf(4, 2)]);
    expect(merged).not.toHaveProperty("unverifiedRequirements");
  });
});
