/**
 * Issue #1321 — the online-eval envelope schemas.
 *
 * These schemas ARE the privacy boundary: `store.assertContentFree` is the belt
 * and `.strict()` + the length bounds here are the braces. The bound on
 * `drift.reason` is tested here rather than only through the writer, because
 * the writer's guard would mask its removal.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONLINE_EVAL_ENABLED,
  DEFAULT_ONLINE_EVAL_SAMPLE_RATE,
  ONLINE_EVAL_MAX_REASON_CHARS,
  onlineEvalDriftSchema,
  onlineEvalWindowSchema,
} from "./online-eval.js";

const drift = (reason: string) => ({
  metric: "faithfulness" as const,
  previous: 0.9,
  delta: -0.3,
  thresholdPct: 0.05,
  alert: false,
  reason,
});

describe("onlineEvalDriftSchema", () => {
  it("accepts a reason at the bound", () => {
    expect(
      onlineEvalDriftSchema.safeParse(drift("z".repeat(ONLINE_EVAL_MAX_REASON_CHARS))).success,
    ).toBe(true);
  });

  it("rejects a reason past the bound — the one unbounded free-text field would be a leak", () => {
    // `reason: `drift on ${question}`` is the shape this bound exists to stop.
    const parsed = onlineEvalDriftSchema.safeParse(
      drift(`drift on ${"q".repeat(ONLINE_EVAL_MAX_REASON_CHARS)}`),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown field", () => {
    expect(
      onlineEvalDriftSchema.safeParse({ ...drift("DRIFT"), question: "how do refunds work?" })
        .success,
    ).toBe(false);
  });
});

describe("onlineEvalWindowSchema", () => {
  const window = (over: Record<string, unknown> = {}) => ({
    windowId: "online-2026-08-15",
    schemaVersion: 1,
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T01:00:00.000Z",
    judge: "StubRagasJudge",
    judgeMeaningful: false,
    sampleCount: 0,
    meanScores: {
      context_precision: 1,
      context_recall: 1,
      faithfulness: 0.9,
      answer_relevancy: 0.8,
    },
    scored: { context_precision: 1, context_recall: 1, faithfulness: 1, answer_relevancy: 1 },
    unverifiable: {
      context_precision: 0,
      context_recall: 0,
      faithfulness: 0,
      answer_relevancy: 0,
    },
    trendedMetrics: ["faithfulness", "answer_relevancy"],
    drift: drift("DRIFT"),
    budget: { monthBucket: "2026-08", tokensUsed: 1, tokensCap: 2, calls: 1 },
    samples: [],
    ...over,
  });

  it("round-trips a content-free envelope", () => {
    expect(onlineEvalWindowSchema.safeParse(window()).success).toBe(true);
  });

  it("rejects an envelope whose drift.reason carries interpolated text", () => {
    expect(
      onlineEvalWindowSchema.safeParse(window({ drift: drift("x".repeat(5_000)) })).success,
    ).toBe(false);
  });

  it("rejects any field the schema does not know about", () => {
    expect(onlineEvalWindowSchema.safeParse(window({ transcript: "hi" })).success).toBe(false);
  });

  // #1329 — UNVERIFIABLE has to be REPRESENTABLE in the envelope. If the schema
  // still demanded a number here, the writer's only way to satisfy it would be
  // to invent one, and the number it would invent is 0.
  it("accepts a null mean for a metric nothing in the window scored", () => {
    const parsed = onlineEvalWindowSchema.safeParse(
      window({
        meanScores: {
          context_precision: null,
          context_recall: null,
          faithfulness: null,
          answer_relevancy: null,
        },
        scored: { context_precision: 0, context_recall: 0, faithfulness: 0, answer_relevancy: 0 },
        unverifiable: {
          context_precision: 5,
          context_recall: 5,
          faithfulness: 5,
          answer_relevancy: 5,
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("requires the verifiability counts — a mean without them is not readable", () => {
    const { scored: _scored, ...noScored } = window();
    expect(onlineEvalWindowSchema.safeParse(noScored).success).toBe(false);
    const { unverifiable: _unverifiable, ...noUnverifiable } = window();
    expect(onlineEvalWindowSchema.safeParse(noUnverifiable).success).toBe(false);
  });
});

describe("defaults ship the feature OFF", () => {
  it("is disabled by default at a conservative rate", () => {
    expect(DEFAULT_ONLINE_EVAL_ENABLED).toBe(false);
    expect(DEFAULT_ONLINE_EVAL_SAMPLE_RATE).toBe(0.01);
  });
});
