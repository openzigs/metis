/**
 * Issue #1117 (findings B + C) — the degradation contract.
 *
 * The walkthrough that filed #1117 saw 16/16 requirements typed `feature` and
 * 0/16 carrying acceptance criteria, and filed them as two separate defects
 * with two separate suspected causes. Both were one cause: synthesis silently
 * fell back to the deterministic clusterer, which hardcodes both fields.
 *
 * These tests pin the copy to the thing that would have prevented that: the
 * message must name BOTH consequences, not just the failure.
 */
import { describe, expect, it } from "vitest";
import {
  SYNTHESIS_DEGRADATION_REASONS,
  describeSynthesisDegradation,
  type SynthesisDegradation,
} from "./analysis.js";

const degradation = (over: Partial<SynthesisDegradation> = {}): SynthesisDegradation => ({
  reason: "non-json",
  attempts: 2,
  requirementCount: 16,
  at: "2026-07-28T11:38:00.000Z",
  ...over,
});

describe("describeSynthesisDegradation", () => {
  it("names both output consequences, not just the failure", () => {
    const message = describeSynthesisDegradation(degradation());
    // The two findings that were filed separately.
    expect(message).toContain('typed "feature"');
    expect(message).toContain("no acceptance criteria");
    // And the reassurance that matters: this is a classification loss, not data loss.
    expect(message).toContain("Nothing was dropped");
  });

  it("states the requirement count and the retry count", () => {
    expect(describeSynthesisDegradation(degradation())).toContain("16 requirements");
    expect(describeSynthesisDegradation(degradation())).toContain("after 2 attempts");
  });

  it("omits the attempt clause when only one attempt was made", () => {
    const message = describeSynthesisDegradation(degradation({ attempts: 1 }));
    expect(message).not.toContain("attempts");
  });

  it("singularises a one-requirement fallback", () => {
    const message = describeSynthesisDegradation(degradation({ requirementCount: 1 }));
    expect(message).toContain("1 requirement below");
  });

  it("produces a distinct, non-empty cause for every reason", () => {
    const causes = SYNTHESIS_DEGRADATION_REASONS.map((reason) =>
      describeSynthesisDegradation(degradation({ reason })),
    );
    expect(new Set(causes).size).toBe(SYNTHESIS_DEGRADATION_REASONS.length);
    for (const cause of causes) expect(cause.length).toBeGreaterThan(0);
  });

  it("describes a provider error differently from a parse failure", () => {
    expect(describeSynthesisDegradation(degradation({ reason: "provider-error" }))).toContain(
      "the model call failed",
    );
    expect(describeSynthesisDegradation(degradation({ reason: "empty-requirements" }))).toContain(
      "returned no requirements",
    );
  });
});
