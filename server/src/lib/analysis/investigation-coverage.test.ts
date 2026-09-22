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
import type { AnalysisRetrievalHealth, RequirementVerdict } from "@metis/shared";
import { deriveRequirementVerdict } from "./requirement-verdict.js";
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
  it("never brands a budget-exhausted pass starved", () => {
    // #1236: running out of turns says the investigation was cut short, which the
    // record already reports as `exhausted` — it is not retrieval failure.
    const before = healthOf(1, 16, { exhausted: true });
    const after = assessInvestigationCoverage(before, { unverifiedRequirements: 0 });
    expect(after.exhausted).toBe(true);
    expect(after.starved).toBe(false);
    expect(after.degraded).toBe(false);
  });

  it("still degrades an exhausted pass that left most requirements unverified", () => {
    // The unverified share is what the analysis page SHOWS, whatever cut the run
    // short. Exempting exhausted runs let 16 of 16 unverified read as healthy — and
    // with a successful final-answer retry, raise no warning at all (PR #37 review).
    const before = healthOf(1, 16, { exhausted: true });
    const after = assessInvestigationCoverage(before, { unverifiedRequirements: 16 });
    expect(after.exhausted).toBe(true);
    expect(after.starved).toBe(false);
    expect(after.degraded).toBe(true);
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

describe("#19 countUnverifiedRequirements — agrees with the verdict the page shows", () => {
  /** The page's own roll-up for one requirement, over this pass's findings. */
  const pageVerdict = (
    findings: Array<{ requirementId?: string; verdict?: string | null }>,
    id: string,
  ) =>
    deriveRequirementVerdict({
      codeAnalysisRan: true,
      findings: findings
        .filter((f) => f.requirementId === id)
        .map((f) => ({
          agentKey: "code",
          verdict: (f.verdict ?? null) as RequirementVerdict | null,
        })),
    });

  it("counts a requirement the agent reported NOTHING for (the page shows it could-not-verify)", () => {
    // PR #37 review: 3 implemented + 13 with no finding counted 0 — while the page
    // showed 13 of 16 unverified.
    const findings = ids(3).map((requirementId) => ({ requirementId, verdict: "implemented" }));
    expect(countUnverifiedRequirements(findings, ids(16))).toBe(13);
    const after = assessInvestigationCoverage(healthOf(5, 16), {
      unverifiedRequirements: countUnverifiedRequirements(findings, ids(16)),
    });
    expect(after.starved).toBe(false);
    expect(after.degraded).toBe(true);
  });

  it("lets could-not-verify beat implemented on the same requirement, as the page does", () => {
    const findings = ids(16).flatMap((requirementId) => [
      { requirementId, verdict: "implemented" },
      cnv(requirementId),
    ]);
    expect(countUnverifiedRequirements(findings, ids(16))).toBe(16);
  });

  it("counts every requirement of a pass that reported no findings at all", () => {
    expect(countUnverifiedRequirements([], ids(16))).toBe(16);
    // 4 searches for 16 requirements clears the starvation floor; the count still degrades.
    const after = assessInvestigationCoverage(healthOf(4, 16), { unverifiedRequirements: 16 });
    expect(after.starved).toBe(false);
    expect(after.degraded).toBe(true);
  });

  it("does not count a confirmed gap, which beats could-not-verify on the page", () => {
    const findings = [{ requirementId: "REQ-1", verdict: "gap-confirmed" }, cnv("REQ-1")];
    expect(countUnverifiedRequirements(findings, ids(1))).toBe(0);
  });

  it("counts a requirement whose only finding carries no verdict", () => {
    expect(countUnverifiedRequirements([{ requirementId: "REQ-1", verdict: null }], ids(1))).toBe(
      1,
    );
  });

  it("ignores findings for requirements outside the pass, or with no requirement", () => {
    const findings = [
      cnv("REQ-99"),
      { verdict: "could-not-verify" },
      { requirementId: "REQ-1", verdict: "implemented" },
      { requirementId: "REQ-2", verdict: "implemented" },
    ];
    expect(countUnverifiedRequirements(findings, ids(2))).toBe(0);
  });

  it("equals the number of could-not-verify page verdicts over a mixed pass", () => {
    const verdicts = ["implemented", "could-not-verify", "gap-confirmed", null, "bogus"];
    const findings = ids(40).flatMap((requirementId, i) =>
      // 0, 1 or 2 findings per requirement, cycling through every verdict shape.
      Array.from({ length: i % 3 }, (_, k) => ({
        requirementId,
        verdict: verdicts[(i + k) % verdicts.length],
      })),
    );
    const expected = ids(40).filter(
      (id) => pageVerdict(findings, id) === "could-not-verify",
    ).length;
    expect(expected).toBeGreaterThan(0);
    expect(countUnverifiedRequirements(findings, ids(40))).toBe(expected);
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
