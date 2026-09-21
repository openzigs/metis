/**
 * Issue #1342 — the answer-correctness headline stops being a single blended
 * number that reads as "percent correct".
 *
 * The first real run (#1338's wiring, four human gold answers) produced
 * `mean=0.531` at `recall=1.000`: METIS entailed EVERY claim of every gold
 * answer, and the 0.531 was precision loss from being more complete than a
 * deliberately terse 1–3 sentence reference. These tests pin the reporting
 * change decided in ADR 0013 — and the replay block re-derives the new headline
 * from that exact recorded run, so the before/after is measured rather than
 * asserted.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateCorrectness,
  correctnessEnvelope,
  interpretAggregate,
  scoreAnswerCorrectness,
  type AnswerCorrectness,
  type ScoreAnswerCorrectnessDeps,
} from "./metric.js";

const row = (over: Partial<AnswerCorrectness> & { queryId: string }): AnswerCorrectness => ({
  f1: 1,
  precision: 1,
  recall: 1,
  answerClaims: 1,
  referenceClaims: 1,
  ...over,
});

describe("claim counts make the length gap a measured fact (#1342)", () => {
  /** Split at sentence boundaries; no semantics, so the counts are the test. */
  const sentenceDeps: ScoreAnswerCorrectnessDeps = {
    extractor: {
      decompose: async (text: string) => ({
        claims: text
          .split(/(?<=[.!?])\s+/)
          .map((c) => c.trim())
          .filter(Boolean)
          .map((claim) => ({ claim, sourceIds: [] })),
      }),
    },
    judge: {
      judge: async (claims: string[]) =>
        claims.map((claim) => ({ claim, supported: true, sourceIds: [] })),
    },
  };

  it("counts the ANSWER's claims as answerClaims and the REFERENCE's as referenceClaims", async () => {
    // The precision direction decomposes the ANSWER (judged against the
    // reference as evidence) and the recall direction decomposes the REFERENCE,
    // so the two totals map the OPPOSITE way round from the direction names.
    // Swapping them would invert the reported verbosity — the caveat would
    // announce that METIS is terser than the gold, the reverse of what #1342
    // measured, while every ratio stayed identical.
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer: "One. Two. Three. Four.", reference: "Only this." },
      sentenceDeps,
    );
    expect(result.answerClaims).toBe(4);
    expect(result.referenceClaims).toBe(1);
  });

  it("aggregates the claims each side produced, not just the ratios", () => {
    const agg = aggregateCorrectness([
      row({ queryId: "a", answerClaims: 11, referenceClaims: 1 }),
      row({ queryId: "b", answerClaims: 7, referenceClaims: 3 }),
    ]);
    expect(agg.meanAnswerClaims).toBe(9);
    expect(agg.meanReferenceClaims).toBe(2);
  });

  it("excludes unverifiable rows from the claim means as it does from the scores", () => {
    const agg = aggregateCorrectness([
      row({ queryId: "a", answerClaims: 4, referenceClaims: 2 }),
      {
        queryId: "b",
        f1: null,
        precision: null,
        recall: null,
        answerClaims: 0,
        referenceClaims: 0,
        unverifiableReason: "judge-unavailable",
      },
    ]);
    // A 0/0 row averaged in would halve the measured verbosity and make the
    // length gap look smaller than it is.
    expect(agg.meanAnswerClaims).toBe(4);
    expect(agg.meanReferenceClaims).toBe(2);
    expect(agg.scored).toBe(1);
  });

  it("has no claim means when nothing was scored", () => {
    const agg = aggregateCorrectness([]);
    expect(agg.meanAnswerClaims).toBeNull();
    expect(agg.meanReferenceClaims).toBeNull();
  });
});

describe("interpretAggregate — the caveat is computed from the run (#1342)", () => {
  const agg = aggregateCorrectness([
    row({
      queryId: "a",
      f1: 0.25,
      precision: 1 / 7,
      recall: 1,
      answerClaims: 7,
      referenceClaims: 1,
    }),
    row({
      queryId: "b",
      f1: 1 / 6,
      precision: 1 / 11,
      recall: 1,
      answerClaims: 11,
      referenceClaims: 1,
    }),
  ]);

  it("leads with recall and precision, and names F1 as length-sensitive", () => {
    const text = interpretAggregate(agg) ?? "";
    expect(text).toContain("Recall 1.000");
    expect(text).toContain("Precision 0.117"); // (1/7 + 1/11) / 2
    expect(text.indexOf("Recall")).toBeLessThan(text.indexOf("meanF1"));
    expect(text).toContain("LENGTH-SENSITIVE");
    expect(text).toContain('not "percent correct"');
  });

  it("quotes the MEASURED verbosity gap rather than a fixed sentence", () => {
    // 9.0 generated claims per answer against 1.0 in the gold. A hard-coded
    // caveat would still read plausibly after the gap closed.
    const text = interpretAggregate(agg) ?? "";
    expect(text).toContain("9.0 claim(s) per answer against 1.0");
    const tighter = aggregateCorrectness([
      row({ queryId: "a", f1: 1, precision: 1, recall: 1, answerClaims: 2, referenceClaims: 2 }),
    ]);
    expect(interpretAggregate(tighter)).toContain("2.0 claim(s) per answer against 2.0");
  });

  it("is null when nothing was scored — there is no number to caveat", () => {
    expect(interpretAggregate(aggregateCorrectness([]))).toBeNull();
  });

  it("does not fabricate a gap when the claim counts were not recorded", () => {
    // Envelopes written before #1342 carry no claim counts, and replaying one
    // through the new aggregate yields 0/0. Rendering that as "METIS produced
    // 0.0 claim(s) per answer against 0.0 in the gold" states a measurement
    // that was never made — the exact failure mode this issue is about, one
    // layer up. Found by replaying the provenance envelope through the real
    // console path rather than through a test.
    const replayed = aggregateCorrectness([
      row({
        queryId: "a",
        f1: 0.25,
        precision: 0.25,
        recall: 1,
        answerClaims: 0,
        referenceClaims: 0,
      }),
    ]);
    const text = interpretAggregate(replayed) ?? "";
    expect(text).not.toContain("0.0 claim(s)");
    expect(text).toContain("claim counts were not recorded");
    // The rest of the caveat still has to be there — F1 is length-sensitive
    // whether or not this particular run measured by how much.
    expect(text).toContain("LENGTH-SENSITIVE");
    expect(text).toContain("Recall 1.000");
  });
});

describe("the envelope carries the caveat wherever it is quoted (#1342)", () => {
  it("puts the interpretation IN the serialised envelope, so the job summary shows it", () => {
    // The nightly `cat`s this JSON straight into the GitHub step summary. A
    // caveat that lived only in the console line would not survive that hop.
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 1,
      results: [row({ queryId: "a", f1: 0.4, precision: 0.25, recall: 1, answerClaims: 4 })],
    });
    expect(env.reported).toBe(true);
    expect(JSON.parse(JSON.stringify(env)).interpretation).toContain("LENGTH-SENSITIVE");
  });

  it("emits recall and precision AHEAD of the blended figure", () => {
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 1,
      results: [row({ queryId: "a", f1: 0.4, precision: 0.25, recall: 1, answerClaims: 4 })],
    });
    const keys = Object.keys(env.aggregate ?? {});
    expect(keys.indexOf("meanRecall")).toBeLessThan(keys.indexOf("meanF1"));
    expect(keys.indexOf("meanPrecision")).toBeLessThan(keys.indexOf("meanF1"));
  });

  it("does not name the blended figure `mean` — that key read as percent correct", () => {
    const env = correctnessEnvelope({
      corpusId: "c",
      referenceCount: 1,
      results: [row({ queryId: "a" })],
    });
    const json = JSON.stringify(env);
    expect(json).toContain('"meanF1"');
    expect(json).not.toContain('"mean"');
    expect(json).not.toContain('"correctness"');
  });

  it("has no interpretation on a NOT REPORTED run — the reason is the message", () => {
    const env = correctnessEnvelope({ corpusId: "c", referenceCount: 0 });
    expect(env.interpretation).toBeUndefined();
    expect(env.reason).toBeDefined();
  });
});

/**
 * The before/after required by #1342's last acceptance criterion.
 *
 * The decision changes REPORTING only, so no judge call is needed to measure its
 * effect: the recorded envelope carries the per-query precision and recall the
 * live run measured, and the new headline is a pure function of those. This
 * block re-derives it from the committed artifact named in the issue's
 * Provenance rather than from numbers retyped into a fixture.
 */
describe("replay of the recorded first run (#1342 provenance)", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
  // #1382 moved this out of `eval-results/`, which is now untracked nightly output.
  // It is a fixture: this block reads it on every run. See ../provenance/README.md.
  const ENVELOPE = path.join(
    REPO_ROOT,
    "server",
    "src",
    "lib",
    "eval",
    "provenance",
    "answer-correctness-2026-08-30T14-57-51-691Z.json",
  );

  interface RecordedRow {
    queryId: string;
    correctness: number;
    precision: number;
    recall: number;
  }
  interface Recorded {
    aggregate: { mean: number; meanPrecision: number; meanRecall: number };
    perQuery: RecordedRow[];
  }

  /**
   * Read LAZILY, inside each test — never at `describe` scope.
   *
   * The envelope is a committed fixture under `../provenance/` since #1382, so it
   * is no longer one retention policy away from disappearing — but read it lazily
   * anyway. A throw during COLLECTION kills the whole file and surfaces as
   * `Test Files 1 failed` with ZERO failed tests — byte-identical in shape to the
   * `postgres-adapter` teardown flake CLAUDE.md tells you to re-run away. Failing
   * inside a test instead puts the missing path in a test name and a message.
   */
  const loadRecorded = (): Recorded => {
    if (!existsSync(ENVELOPE)) {
      throw new Error(
        `#1342 provenance envelope is missing: ${ENVELOPE}\n` +
          "This block replays a committed run rather than retyped numbers. If the " +
          "envelope was pruned, restore it from git history or retire this describe " +
          "block — do not delete the assertions and keep the file. It is a tracked " +
          "fixture (server/src/lib/eval/provenance/), never regenerated output.",
      );
    }
    return JSON.parse(readFileSync(ENVELOPE, "utf8")) as Recorded;
  };

  it("BEFORE — the run was reported as a single blended `mean` of 0.531", () => {
    const recorded = loadRecorded();
    expect(recorded.aggregate.mean).toBeCloseTo(0.531, 3);
    expect(recorded.perQuery).toHaveLength(4);
    // The old per-query key is literally the word a reader mistook for
    // "percent correct".
    expect(Object.keys(recorded.perQuery[0] as object)).toContain("correctness");
  });

  it("AFTER — the same measurements report recall 1.000 / precision 0.433, F1 unmoved", () => {
    const recorded = loadRecorded();
    const replayed = aggregateCorrectness(
      recorded.perQuery.map((r) => ({
        queryId: r.queryId,
        f1: r.correctness,
        precision: r.precision,
        recall: r.recall,
        // Not recorded by the pre-#1342 envelope; the counts start being
        // emitted from the next run.
        answerClaims: 0,
        referenceClaims: 0,
      })),
    );
    expect(replayed.meanRecall).toBe(1);
    expect(replayed.meanPrecision).toBeCloseTo(0.433, 3);
    // No score moved: this decision changes what is led with, not the maths.
    expect(replayed.meanF1).toBeCloseTo(recorded.aggregate.mean, 12);
  });
});
