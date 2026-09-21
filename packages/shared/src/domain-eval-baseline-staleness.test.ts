import { describe, expect, it } from "vitest";

import {
  STALE_BASELINE_DAYS,
  describeBaselineStaleness,
  domainDriftSchema,
  domainEvalRunResultSchema,
  type DomainDrift,
} from "./domain-eval.js";

/**
 * Issue #1333 — the reporting half.
 *
 * `eval-domain-nightly.yml` committed no envelope between 2026-07-21 and the
 * #1333 fix, so `selectBaseline` kept picking the 2026-07-21 run and every
 * nightly reported "WITHIN_THRESHOLD" against a five-week-old number. The
 * greens in between are not evidence of stability — they are the same
 * comparison repeated. A drift verdict must therefore say how old the baseline
 * it used actually is, everywhere it is reported.
 */

const drift = (over: Partial<DomainDrift> = {}): DomainDrift => ({
  previousF1: 0.8,
  deltaF1: 0.01,
  thresholdPct: 0.05,
  alert: false,
  reason: "WITHIN_THRESHOLD",
  baselineRunId: "2026-07-21T03-00-00-000Z",
  baselineAgeDays: 39,
  staleBaseline: true,
  ...over,
});

describe("domainDriftSchema — backwards compatibility", () => {
  it("parses a pre-#1333 envelope's drift block, defaulting the new fields", () => {
    // The 66 committed envelopes carry only the original five keys. `readRun`
    // uses `safeParse` and DROPS anything that fails, so a required field here
    // would silently delete the entire drift history — the exact failure this
    // fix exists to end.
    const parsed = domainDriftSchema.parse({
      previousF1: 0.8,
      deltaF1: -0.01,
      thresholdPct: 0.05,
      alert: false,
      reason: "WITHIN_THRESHOLD",
    });
    expect(parsed.baselineRunId).toBeNull();
    expect(parsed.baselineAgeDays).toBeNull();
    expect(parsed.staleBaseline).toBe(false);
  });

  it("keeps a whole pre-#1333 run envelope parseable", () => {
    const legacy = {
      runId: "2026-07-21T03-00-00-000Z",
      schemaVersion: 1,
      model: "offline-heuristic",
      startedAt: "2026-07-21T03:00:00.000Z",
      completedAt: "2026-07-21T03:00:09.000Z",
      itemCount: 3,
      corpusPrecision: 0.8,
      corpusRecall: 0.7,
      corpusF1: 0.75,
      meanRougeL: 0.6,
      totalTokens: 0,
      totalCostCents: 0,
      commit: null,
      calibration: [],
      drift: {
        previousF1: 0.75,
        deltaF1: 0,
        thresholdPct: 0.05,
        alert: false,
        reason: "WITHIN_THRESHOLD",
      },
      items: [],
    };
    const parsed = domainEvalRunResultSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.drift.staleBaseline).toBe(false);
  });

  it("round-trips the new fields when they are present", () => {
    const parsed = domainDriftSchema.parse(drift());
    expect(parsed.staleBaseline).toBe(true);
    expect(parsed.baselineAgeDays).toBe(39);
    expect(parsed.baselineRunId).toBe("2026-07-21T03-00-00-000Z");
  });
});

describe("describeBaselineStaleness", () => {
  it("returns null for a healthy week-over-week baseline", () => {
    expect(
      describeBaselineStaleness(drift({ staleBaseline: false, baselineAgeDays: 7 })),
    ).toBeNull();
  });

  it("returns null when there is no baseline at all", () => {
    expect(
      describeBaselineStaleness(
        drift({ staleBaseline: false, baselineAgeDays: null, baselineRunId: null }),
      ),
    ).toBeNull();
  });

  it("names the age, the baseline run, and that the gap is missing history", () => {
    const text = describeBaselineStaleness(drift());
    expect(text).toContain("39");
    expect(text).toContain("2026-07-21T03-00-00-000Z");
    expect(text).toMatch(/not a week-over-week/i);
    expect(text).toMatch(/missing|gap|no envelope/i);
  });

  it("does not claim staleness when flagged but the age is unknown", () => {
    expect(describeBaselineStaleness(drift({ baselineAgeDays: null }))).toBeNull();
  });

  it("uses the configured window, so the threshold is not a magic literal", () => {
    expect(STALE_BASELINE_DAYS).toBeGreaterThan(7);
  });
});
