/**
 * Epic #1316 / Issue #1319 — the answer-correctness metric.
 *
 * These tests run against the REAL `scoreEvidenceFaithfulness` substrate #1318
 * shipped, with only the claim extractor and the NLI judge faked. Mocking
 * `scoreEvidenceFaithfulness` itself would leave the one integration that can
 * actually break — evidence assembly into a `GroundingContext` — unexercised,
 * and that is the seam where an answer silently becomes "no evidence".
 */
import { describe, expect, it, vi } from "vitest";
import type { GroundingContext } from "../../docs-gen/grounding/grounding-context.js";
import type { ClaimVerdict } from "../../docs-gen/grounding/faithfulness-judge.js";
import {
  aggregateCorrectness,
  buildCorrectness,
  correctnessEnvelope,
  f1,
  scoreAnswerCorrectness,
  type AnswerCorrectness,
  type ScoreAnswerCorrectnessDeps,
} from "./metric.js";
import type { FaithfulnessMetric } from "../../grounding/faithfulness-metric.js";

/** Split a text into "claims" at sentence boundaries — no semantics, on purpose. */
const sentenceExtractor = {
  decompose: async (text: string) => ({
    claims: text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((claim) => ({ claim, sourceIds: [] })),
  }),
};

/**
 * A judge whose verdicts are dictated by the test, keyed by the claim text.
 * Anything not listed is unsupported.
 */
const judgeFrom = (supported: Record<string, boolean>) => ({
  judge: async (claims: string[]): Promise<ClaimVerdict[]> =>
    claims.map((claim) => ({ claim, supported: supported[claim] ?? false, sourceIds: [] })),
});

const deps = (supported: Record<string, boolean>): ScoreAnswerCorrectnessDeps => ({
  extractor: sentenceExtractor,
  judge: judgeFrom(supported),
});

/** Content-word overlap, used only to prove a lexical metric could not pass. */
const tokenOverlap = (a: string, b: string): number => {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const [x, y] = [words(a), words(b)];
  const shared = [...x].filter((w) => y.has(w));
  return shared.length / Math.max(1, Math.min(x.size, y.size));
};

const metric = (over: Partial<FaithfulnessMetric> = {}): FaithfulnessMetric => ({
  faithfulness: 1,
  totalClaims: 1,
  supportedClaims: 1,
  ...over,
});

describe("f1", () => {
  it("is the harmonic mean", () => {
    expect(f1(1, 1)).toBe(1);
    expect(f1(0.5, 0.5)).toBe(0.5);
    expect(f1(1, 0.5)).toBeCloseTo(2 / 3);
  });

  it("is 0 rather than NaN when both sides are 0", () => {
    // A NaN here would be JSON-serialised as `null` into a committed artifact
    // and read as "unverifiable" rather than as "wrong".
    expect(f1(0, 0)).toBe(0);
    expect(Number.isNaN(f1(0, 0))).toBe(false);
  });

  it("punishes a lopsided pair", () => {
    // Precision 1 / recall 0.1 must not read as "0.55, basically fine".
    expect(f1(1, 0.1)).toBeLessThan(0.2);
  });
});

describe("scoreAnswerCorrectness — semantic, not lexical (#1319 AC3)", () => {
  it("scores a correct paraphrase with NO shared vocabulary as correct", async () => {
    const reference = "Up to five minutes of data may be lost.";
    const answer = "The recovery point objective permits a 300 second window.";
    // Stated as an assertion so the test documents WHY this is not a tautology:
    // a lexical comparator has nothing to work with here.
    expect(tokenOverlap(reference, answer)).toBe(0);

    const result = await scoreAnswerCorrectness(
      { queryId: "dq-ops-09", answer, reference },
      deps({ [answer]: true, [reference]: true }),
    );

    expect(result.f1).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it("scores a lexically similar but WRONG answer as incorrect", async () => {
    const reference = "Up to five minutes of data may be lost.";
    const answer = "Up to five hours of data may be lost.";
    // The mirror image: heavy lexical overlap, opposite meaning. A token-overlap
    // metric would call this near-perfect.
    expect(tokenOverlap(reference, answer)).toBeGreaterThan(0.7);

    const result = await scoreAnswerCorrectness(
      { queryId: "dq-ops-09", answer, reference },
      deps({ [answer]: false, [reference]: false }),
    );

    expect(result.f1).toBe(0);
  });

  it("runs BOTH directions — precision and recall come from opposite comparisons", async () => {
    const reference = "The RPO is five minutes. Backups run hourly.";
    const answer = "The RPO is five minutes.";
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer, reference },
      deps({
        "The RPO is five minutes.": true, // entailed in both directions
        "Backups run hourly.": false, // omitted by the answer → recall loss
      }),
    );
    // Nothing invented, but half the reference omitted.
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(0.5);
    expect(result.f1).toBeCloseTo(2 / 3);
  });

  it("penalises an answer that adds an unsupported claim", async () => {
    const reference = "The RPO is five minutes.";
    const answer = "The RPO is five minutes. The cluster runs in three regions.";
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer, reference },
      deps({
        "The RPO is five minutes.": true,
        "The cluster runs in three regions.": false,
      }),
    );
    expect(result.precision).toBe(0.5);
    expect(result.recall).toBe(1);
    expect(result.f1).toBeCloseTo(2 / 3);
  });

  it("scores each direction against the OTHER text, not against itself", async () => {
    // If both directions were accidentally wired to the same evidence, the two
    // judge calls would see identical context and the bug would be invisible in
    // the numbers. Assert on what the judge was actually shown.
    const seen: string[] = [];
    const spyJudge = {
      judge: async (claims: string[], ctx: GroundingContext): Promise<ClaimVerdict[]> => {
        seen.push(ctx.sources.map((s) => s.text).join("\n"));
        return claims.map((claim) => ({ claim, supported: true, sourceIds: [] }));
      },
    };
    await scoreAnswerCorrectness(
      { queryId: "q", answer: "ANSWER TEXT.", reference: "REFERENCE TEXT." },
      { extractor: sentenceExtractor, judge: spyJudge },
    );
    expect(seen).toHaveLength(2);
    const [precisionCtx, recallCtx] = seen as [string, string];
    // Precision judges the ANSWER against the REFERENCE as evidence…
    expect(precisionCtx).toContain("REFERENCE TEXT.");
    expect(precisionCtx).not.toContain("ANSWER TEXT.");
    // …and recall judges the REFERENCE against the ANSWER as evidence.
    expect(recallCtx).toContain("ANSWER TEXT.");
    expect(recallCtx).not.toContain("REFERENCE TEXT.");
  });
});

describe("scoreAnswerCorrectness — unverifiable is not zero", () => {
  it("returns null when the system produced no answer", async () => {
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer: "   ", reference: "The RPO is five minutes." },
      deps({}),
    );
    expect(result.f1).toBeNull();
    expect(result.unverifiableReason).toBe("no-claims");
  });

  it("returns null when there is no reference answer", async () => {
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer: "The RPO is five minutes.", reference: "" },
      deps({}),
    );
    expect(result.f1).toBeNull();
    expect(result.unverifiableReason).toBe("no-evidence");
  });

  it("returns null — not 0 — when the judge cannot return a verdict", async () => {
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer: "A.", reference: "B." },
      { extractor: sentenceExtractor, judge: { judge: async () => null } },
    );
    expect(result.f1).toBeNull();
    expect(result.unverifiableReason).toBe("judge-unavailable");
  });

  it("does not swallow an extractor failure", async () => {
    await expect(
      scoreAnswerCorrectness(
        { queryId: "q", answer: "A.", reference: "B." },
        {
          extractor: { decompose: vi.fn().mockRejectedValue(new Error("provider down")) },
          judge: judgeFrom({}),
        },
      ),
    ).rejects.toThrow("provider down");
  });
});

describe("buildCorrectness", () => {
  it("names the side that failed so a run of nulls is diagnosable", () => {
    const left = buildCorrectness(
      "q",
      metric({ faithfulness: null, unverifiableReason: "no-claims" }),
      metric(),
    );
    expect(left.unverifiableReason).toBe("no-claims");
    const right = buildCorrectness(
      "q",
      metric(),
      metric({ faithfulness: null, unverifiableReason: "judge-unavailable" }),
    );
    expect(right.unverifiableReason).toBe("judge-unavailable");
  });

  it("never computes an F1 from one known and one guessed side", () => {
    const r = buildCorrectness("q", metric({ faithfulness: 0.9 }), metric({ faithfulness: null }));
    expect(r.f1).toBeNull();
    expect(r.precision).toBe(0.9);
    expect(r.recall).toBeNull();
  });
});

describe("aggregateCorrectness", () => {
  const scored = (queryId: string, c: number): AnswerCorrectness => ({
    queryId,
    recall: c,
    precision: c,
    f1: c,
    answerClaims: 1,
    referenceClaims: 1,
  });
  const unscored = (queryId: string): AnswerCorrectness => ({
    queryId,
    recall: null,
    precision: null,
    f1: null,
    answerClaims: 0,
    referenceClaims: 0,
    unverifiableReason: "judge-unavailable",
  });

  it("excludes unverifiable queries from the denominator rather than scoring them 0", () => {
    const agg = aggregateCorrectness([scored("a", 1), scored("b", 1), unscored("c")]);
    expect(agg.meanF1).toBe(1);
    expect(agg.scored).toBe(2);
    expect(agg.unverifiable).toBe(1);
  });

  it("is null, not 0, when nothing was scored", () => {
    const agg = aggregateCorrectness([unscored("a")]);
    expect(agg.meanF1).toBeNull();
    expect(agg.meanPrecision).toBeNull();
    expect(agg.scored).toBe(0);
  });

  it("averages precision and recall independently of the F1 mean", () => {
    const agg = aggregateCorrectness([
      { queryId: "a", recall: 0, precision: 1, f1: 0, answerClaims: 1, referenceClaims: 1 },
      { queryId: "b", recall: 1, precision: 1, f1: 1, answerClaims: 1, referenceClaims: 1 },
    ]);
    expect(agg.meanF1).toBe(0.5);
    expect(agg.meanPrecision).toBe(1);
    expect(agg.meanRecall).toBe(0.5);
  });
});

describe("correctnessEnvelope", () => {
  it("reports NOT REPORTED with a reason when there are no references", () => {
    const env = correctnessEnvelope({ corpusId: "c", referenceCount: 0 });
    expect(env.reported).toBe(false);
    expect(env.reason).toContain("reference");
    // The absence of a number must not be representable as a number.
    expect(env.aggregate).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('"mean"');
  });

  it("reports the aggregate and every per-query score when references exist", () => {
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 1,
      results: [
        { queryId: "a", recall: 1, precision: 1, f1: 1, answerClaims: 1, referenceClaims: 1 },
      ],
    });
    expect(env.reported).toBe(true);
    expect(env.aggregate?.meanF1).toBe(1);
    expect(env.perQuery).toHaveLength(1);
  });

  it("carries corpus findings and the pending-licence flag alongside the score", () => {
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 0,
      licensePending: true,
      findings: [
        { queryId: "z", finding: "quote does not answer it", author: "gh:x", date: "2026-08-27" },
      ],
    });
    // Findings are reported EVEN when the metric is not — they are a fact about
    // the corpus, not about a run.
    expect(env.corpusFindings).toHaveLength(1);
    expect(env.licensePending).toBe(true);
  });

  it("labels itself so a reader of eval-results/ knows what metric this is", () => {
    expect(correctnessEnvelope({ corpusId: "c", referenceCount: 0 }).metric).toBe(
      "answer_correctness",
    );
  });
});

describe("correctnessEnvelope — an all-unverifiable run is NOT REPORTED (#1338)", () => {
  const unverifiable = (queryId: string) => ({
    queryId,
    recall: null,
    precision: null,
    f1: null,
    answerClaims: 0,
    referenceClaims: 0,
    unverifiableReason: "judge-unavailable" as const,
  });

  it("defaults to no-judge with a reason naming the count, not a mean of null", () => {
    // `reported: true, mean: null` would put an empty metric on the same footing
    // as a measured one; a reader charting the mean would see a gap they cannot
    // distinguish from a run that simply did not happen.
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 2,
      results: [unverifiable("a"), unverifiable("b")],
    });
    expect(env.reported).toBe(false);
    expect(env.reasonCode).toBe("no-judge");
    expect(env.reason).toContain("2 paired answer(s) were UNVERIFIABLE");
    expect(env.aggregate?.meanF1).toBeNull();
    expect(env.aggregate?.scored).toBe(0);
    // The rows survive, so the unverifiable reasons are readable.
    expect(env.perQuery?.map((q) => q.unverifiableReason)).toEqual([
      "judge-unavailable",
      "judge-unavailable",
    ]);
  });

  it("reports as soon as ONE query produced a number", () => {
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 2,
      results: [
        unverifiable("a"),
        { queryId: "b", recall: 0.5, precision: 0.5, f1: 0.5, answerClaims: 2, referenceClaims: 2 },
      ],
    });
    expect(env.reported).toBe(true);
    expect(env.reasonCode).toBeUndefined();
    expect(env.aggregate?.scored).toBe(1);
    expect(env.aggregate?.unverifiable).toBe(1);
  });
});
