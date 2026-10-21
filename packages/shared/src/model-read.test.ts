/**
 * Issue #1081 — the wording of an unread model step, and the narrowing that
 * keeps a malformed metadata blob from reaching the screen.
 */
import { describe, expect, it } from "vitest";
import {
  UNREAD_ANALYSIS_STEPS,
  describeUnreadAnalysisStep,
  readUnreadAnalysisSteps,
  type UnreadAnalysisStep,
} from "./model-read.js";

const step = (over: Partial<UnreadAnalysisStep>): UnreadAnalysisStep => ({
  step: "completeness-check",
  reason: "unparseable",
  failedCalls: 1,
  totalCalls: 1,
  ...over,
});

describe("describeUnreadAnalysisStep", () => {
  it("says an empty gap list does not mean nothing is missing", () => {
    const text = describeUnreadAnalysisStep(step({}));
    expect(text).toContain("could not be read");
    expect(text).toContain("does not mean none are missing");
  });

  it("separates a failed call from an unreadable reply", () => {
    expect(describeUnreadAnalysisStep(step({ reason: "provider-error" }))).toContain(
      "the model call failed",
    );
    expect(describeUnreadAnalysisStep(step({ reason: "schema-invalid" }))).toContain(
      "not in the expected format",
    );
  });

  it("counts the contradiction checks that could not be read", () => {
    expect(
      describeUnreadAnalysisStep(
        step({ step: "contradiction-check", failedCalls: 2, totalCalls: 7 }),
      ),
    ).toContain("2 of 7 contradiction checks");
    expect(describeUnreadAnalysisStep(step({ step: "contradiction-check" }))).toContain(
      "the contradiction check",
    );
  });

  it("words every step", () => {
    for (const s of UNREAD_ANALYSIS_STEPS) {
      expect(describeUnreadAnalysisStep(step({ step: s })).length).toBeGreaterThan(20);
    }
  });
});

describe("readUnreadAnalysisSteps", () => {
  it("keeps valid entries and drops unknown ones", () => {
    const read = readUnreadAnalysisSteps({
      steps: [step({}), { step: "made-up", reason: "unparseable", failedCalls: 1, totalCalls: 1 }],
      at: "2026-10-21T00:00:00.000Z",
    });
    expect(read?.steps).toEqual([step({})]);
  });

  it("returns null for absent or malformed values", () => {
    expect(readUnreadAnalysisSteps(undefined)).toBeNull();
    expect(readUnreadAnalysisSteps("x")).toBeNull();
    expect(readUnreadAnalysisSteps({ steps: "x" })).toBeNull();
    expect(readUnreadAnalysisSteps({ steps: [{ step: "completeness-check" }] })).toBeNull();
  });
});
