import { describe, expect, it } from "vitest";
import { PRIOR_RUN_QUERY_COUNT } from "./power-sizing.js";
import { MIN_IMPORTANT_DELTA } from "../embed-retrieval/rerank-sweep.js";
import type { QueryScore } from "../embed-retrieval/metrics.js";
import { aggregate } from "../embed-retrieval/metrics.js";
import { chunkMarkdown, maxOverlapFor, resolveChunkParams } from "../../rag/chunker.js";
import {
  armOverlap,
  CHUNK_SIZE_ARMS,
  compareChunkArm,
  CONTROL_CHUNK_SIZE,
  COVERAGE_CLEAN_THRESHOLD,
  describeOverlapPlan,
  DOC_EVAL_K,
  ladderArmsAlreadyRun,
  MIN_IMPORTANT_NDCG_DELTA,
  ndcgByQuery,
  overlapArmsFor,
  OVERLAP_LADDER,
  OVERLAP_RATIO,
  ratioOverlap,
  renderChunkSweep,
  renderOverlapDelivery,
  renderOverlapValue,
  runSizingInputs,
  SIZE_ARM_OVERLAP,
  type ChunkArmComparison,
  type ChunkArmResult,
  type ChunkArmSpec,
} from "./chunk-sweep.js";

function score(queryId: string, ndcg: number): QueryScore {
  return {
    queryId,
    ranked: [],
    relevant: [],
    firstRelevantRank: ndcg > 0 ? 1 : null,
    recallAtK: { 1: 0, 5: 0, 10: ndcg > 0 ? 1 : 0 },
    reciprocalRank: ndcg,
    ndcgAtK: { 1: 0, 5: 0, 10: ndcg },
  };
}

function armResult(
  spec: ChunkArmSpec,
  ndcgs: Record<string, number>,
  extra: Partial<ChunkArmResult> = {},
): ChunkArmResult {
  const perQuery = Object.entries(ndcgs).map(([id, v]) => score(id, v));
  return {
    spec,
    chunkCount: 100,
    reindexSeconds: 10,
    perQuery,
    metrics: aggregate(perQuery),
    meanSpanCoverage: 1,
    // Fully covered unless a test says otherwise, so `coverage-clean` defaults to the
    // whole corpus and a fixture that means to exercise straddling has to say so.
    spanCoverage: Object.fromEntries(Object.keys(ndcgs).map((id) => [id, 1])),
    realisedOverlapChars: 0,
    expectedOverlapChars: 0,
    sensitiveQueryIds: Object.keys(ndcgs),
    uncoveredQueryIds: [],
    ...extra,
  };
}

/**
 * A comparison whose bootstrap interval excludes zero while the sign test does not
 * reject — the disagreement `stats.ts` says to resolve in the sign test's favour.
 */
function disagreeing(armId: string): ChunkArmComparison {
  const paired = {
    label: armId,
    armA: armId,
    armB: "size-2048",
    n: 48,
    meanDelta: -0.111,
    ciLow: -0.214,
    ciHigh: -0.015,
    confidence: 0.95,
    resamples: 20000,
    wins: 10,
    losses: 11,
    ties: 27,
    signTestP: 1,
  };
  return {
    armId,
    chunkSize: 768,
    overlap: 96,
    ndcgAt10: 0.618,
    recallAt10: 0.75,
    mrr: 0.574,
    chunkCount: 763,
    chunkMultiplier: 1.61,
    reindexSeconds: 18.3,
    meanSpanCoverage: 0.861,
    all: { paired, verdict: "NOT-ESTABLISHED", agree: false, nonZeroDeltas: 26 },
    sensitive: null,
    sensitiveCount: 0,
    sensitiveExcluded: null,
    sensitiveExcludedCount: 0,
    rankingOnly: null,
    coverageClean: null,
    coverageCleanCount: 0,
    sensitiveClean: null,
    sensitiveCleanCount: 0,
    uncoveredCount: 0,
    controlUncoveredCount: 0,
    straddledCount: 0,
    realisedOverlapChars: 0,
    expectedOverlapChars: 0,
  };
}

const controlSpec = CHUNK_SIZE_ARMS.find((a) => a.control) as ChunkArmSpec;
const smallSpec = CHUNK_SIZE_ARMS.find((a) => a.id === "size-768") as ChunkArmSpec;

describe("the sweep's arm definitions", () => {
  it("declares exactly one control, and it is the shipped default", () => {
    const controls = CHUNK_SIZE_ARMS.filter((a) => a.control);
    expect(controls).toHaveLength(1);
    expect(controls[0].chunkSize).toBe(CONTROL_CHUNK_SIZE);
    expect(controls[0].chunkSize).toBe(2048);
    expect(controls[0].overlap).toBe(256);
  });

  it("covers the four sizes #1160 names", () => {
    expect(CHUNK_SIZE_ARMS.map((a) => a.chunkSize).sort((a, b) => a - b)).toEqual([
      768, 1024, 2048, 3072,
    ]);
  });

  /** A one-sided sweep would confirm whichever way the prior happened to point. */
  it("tests the hypothesis in BOTH directions", () => {
    expect(CHUNK_SIZE_ARMS.some((a) => a.chunkSize < CONTROL_CHUNK_SIZE)).toBe(true);
    expect(CHUNK_SIZE_ARMS.some((a) => a.chunkSize > CONTROL_CHUNK_SIZE)).toBe(true);
  });

  /**
   * #1184 replaced the constant RATIO with a constant ABSOLUTE overlap. A ratio keeps two
   * parameters moving between an arm and the control, which was defensible only while
   * overlap was unmeasured; #1183 measured it a null at 2048, so the ratio buys nothing
   * and costs attributability. The one exception is visible rather than silent: 768 is
   * clamped to 192 by `maxOverlapFor`, and the artefact prints `CLAMPED from 256`.
   */
  it("holds overlap at a constant ABSOLUTE value so size is the only free variable", () => {
    for (const arm of CHUNK_SIZE_ARMS) {
      expect(arm.overlap, arm.id).toBe(SIZE_ARM_OVERLAP);
    }
    // …and the chunker honours it everywhere the cap permits, which is everywhere but 768.
    const clamped = CHUNK_SIZE_ARMS.filter((a) => armOverlap(a.chunkSize, a.overlap).clamped);
    expect(clamped.map((a) => a.id)).toEqual(["size-768"]);
    expect(armOverlap(768, SIZE_ARM_OVERLAP).effective).toBe(192);
    // The control is the one arm where the constant and the old ratio coincide, which is
    // why holding the absolute value leaves the control's own chunking untouched.
    const control = CHUNK_SIZE_ARMS.find((a) => a.control);
    expect(control?.overlap).toBe(ratioOverlap(control?.chunkSize ?? 0));
    expect((control?.overlap ?? 0) / (control?.chunkSize ?? 1)).toBeCloseTo(OVERLAP_RATIO, 10);
  });

  it("gives every arm a rationale, because the artefact prints it", () => {
    for (const arm of CHUNK_SIZE_ARMS) expect(arm.rationale.length).toBeGreaterThan(20);
  });
});

describe("the pre-registered decision floor", () => {
  it("is #1160's stated target and is the SAME constant #1158 pre-registered", () => {
    expect(MIN_IMPORTANT_NDCG_DELTA).toBe(0.04);
    expect(MIN_IMPORTANT_NDCG_DELTA).toBe(MIN_IMPORTANT_DELTA);
  });
});

describe("overlapArmsFor", () => {
  it("sweeps the pre-registered ladder at the control size, minus the control itself", () => {
    const plan = overlapArmsFor(2048);
    expect(OVERLAP_LADDER).toEqual([0, 128, 256, 512]);
    // 256 IS the control arm at 2048, so re-running it would measure one chunking twice.
    expect(plan.arms.map((a) => a.overlap)).toEqual([0, 128, 512]);
    expect(plan.arms.every((a) => a.chunkSize === 2048)).toBe(true);
    expect(plan.excluded).toEqual([]);
  });

  it("holds chunk size fixed, so overlap is the only variable against the control", () => {
    const plan = overlapArmsFor(CONTROL_CHUNK_SIZE);
    expect(new Set(plan.arms.map((a) => a.chunkSize))).toEqual(new Set([CONTROL_CHUNK_SIZE]));
    expect(new Set(plan.arms.map((a) => a.overlap)).size).toBe(plan.arms.length);
  });

  it("includes a zero-overlap arm, which is what makes the ladder falsifiable", () => {
    expect(overlapArmsFor(2048).arms.some((a) => a.overlap === 0)).toBe(true);
  });

  /**
   * #1183, the whole reason this function changed. The old implementation DERIVED its
   * overlap from the chunk size, so at a 768 winner it asked for 256 against #1185's
   * cap of 192: `chunkMarkdown` clamped it, and the arm id said 256 while the run used
   * 192. A grep-for-literals audit cannot see a computed value, which is how it
   * survived #1185's own caller sweep.
   */
  it("never requests an overlap the chunker would silently clamp", () => {
    for (const size of [768, 1024, 2048, 3072]) {
      for (const arm of overlapArmsFor(size).arms) {
        expect(arm.overlap).toBeLessThanOrEqual(maxOverlapFor(size));
        expect(armOverlap(size, arm.overlap).clamped).toBe(false);
      }
    }
  });

  it("names the ladder values the cap forbids rather than dropping them silently", () => {
    const plan = overlapArmsFor(768);
    expect(maxOverlapFor(768)).toBe(192);
    expect(plan.excluded).toEqual([
      { requested: 256, maxOverlap: 192 },
      { requested: 512, maxOverlap: 192 },
    ]);
    expect(plan.arms.map((a) => a.overlap)).toEqual([0, 128]);
  });

  /** An arm id that names an overlap the run did not use is an unlabelled A/B. */
  it("labels every arm with the overlap it will actually run at", () => {
    for (const size of [768, 1024, 2048, 3072]) {
      for (const arm of overlapArmsFor(size).arms) {
        expect(arm.id).toBe(`overlap-${size}-${armOverlap(size, arm.overlap).effective}`);
      }
    }
  });

  /**
   * Compared on EFFECTIVE overlap, not on the requested value: two arms are the same
   * chunking when the chunker carries the same number of characters over. Since #1184 the
   * size arms request a constant 256, so at 768 the size arm *requests* a ladder value it
   * never runs (clamped to 192) — matching on the request would wrongly suppress a
   * legitimate ladder arm and, in the renderer, print a skip that did not happen.
   */
  it("never returns an arm identical to the size arm it accompanies", () => {
    for (const size of [768, 1024, 2048, 3072]) {
      const sizeArmOverlaps = CHUNK_SIZE_ARMS.filter((a) => a.chunkSize === size).map(
        (a) => armOverlap(a.chunkSize, a.overlap).effective,
      );
      for (const arm of overlapArmsFor(size).arms) {
        expect(sizeArmOverlaps, `${arm.id} duplicates a size arm`).not.toContain(
          armOverlap(size, arm.overlap).effective,
        );
      }
    }
  });

  it("gives every arm a rationale, because the artefact prints it", () => {
    for (const arm of overlapArmsFor(2048).arms) {
      expect(arm.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe("armOverlap", () => {
  it("resolves an in-range overlap unchanged", () => {
    expect(armOverlap(2048, 256)).toEqual({
      effective: 256,
      requested: 256,
      maxOverlap: 512,
      clamped: false,
      chunkSize: 2048,
    });
  });

  it("reports the clamp the chunker would apply, with both values", () => {
    expect(armOverlap(768, 256)).toEqual({
      effective: 192,
      requested: 256,
      maxOverlap: 192,
      clamped: true,
      chunkSize: 768,
    });
  });

  /** At the cap exactly, nothing is clamped — the boundary must not read as a clamp. */
  it("does not call the cap itself a clamp", () => {
    expect(armOverlap(2048, maxOverlapFor(2048)).clamped).toBe(false);
  });

  /**
   * The coupling this whole sub-issue exists to protect, pinned to the RIGHT thing.
   *
   * The assertions above pin `armOverlap` to `maxOverlapFor` — a formula. What actually
   * has to hold is that it resolves the way `chunkMarkdown` resolves, since the delivery
   * denominator divides by its answer. Those are the same function today
   * (`chunkMarkdown` calls `resolveChunkParams` at `chunker.ts:289`, and so does this),
   * so it cannot drift arithmetically — but "cannot drift" is a property of the current
   * wiring, not of the contract, and nothing failed if the wiring changed.
   */
  it("resolves exactly as resolveChunkParams does, across every cap boundary", () => {
    for (const size of [64, 100, 256, 768, 1024, 2047, 2048, 3072]) {
      for (const ov of [0, 96, 128, 192, 256, 512, 5000]) {
        const resolved = resolveChunkParams({ chunkSize: size, overlap: ov });
        const arm = armOverlap(size, ov);
        expect(arm.effective).toBe(resolved.overlap);
        expect(arm.chunkSize).toBe(resolved.chunkSize);
        expect(arm.maxOverlap).toBe(resolved.maxOverlap);
      }
    }
  });

  /**
   * Stronger than the above, because it survives a refactor of `resolveChunkParams`
   * itself: chunk a real document at a CLAMPED overlap and at the effective value this
   * function reports, and demand byte-identical chunks. If `chunkMarkdown` ever stops
   * routing through the shared resolver — an inline clamp, a second normalisation, a
   * fast path — these diverge and the delivery denominator is wrong again, which is the
   * silent failure #1183 was opened to close.
   */
  it("names the overlap chunkMarkdown actually cuts with, not the one requested", () => {
    const doc = [
      "# Guide",
      "",
      "para one ".repeat(120),
      "",
      "## Details",
      "",
      "para two ".repeat(120),
    ].join("\n");
    for (const [size, requested] of [
      [768, 512],
      [768, 256],
      [1024, 512],
    ] as const) {
      const eff = armOverlap(size, requested);
      expect(eff.clamped).toBe(true);
      const asRequested = chunkMarkdown(doc, { chunkSize: size, overlap: requested });
      const asEffective = chunkMarkdown(doc, { chunkSize: size, overlap: eff.effective });
      expect(asRequested.map((c) => c.text)).toEqual(asEffective.map((c) => c.text));
      expect(asRequested.length).toBeGreaterThan(1);
    }
  });
});

describe("describeOverlapPlan", () => {
  it("names the arms that will run at the control size", () => {
    expect(describeOverlapPlan(overlapArmsFor(2048))).toBe(
      "Overlap ladder at 2048: 0, 128, 512 (excluded by the chunker's cap: none)",
    );
  });

  /** The progress line has to show a clamped-away arm WHILE the sweep runs, not after. */
  it("names what the cap excluded, so a shortened ladder is visible during the run", () => {
    expect(describeOverlapPlan(overlapArmsFor(768))).toBe(
      "Overlap ladder at 768: 0, 128 (excluded by the chunker's cap: 256 > cap 192, 512 > cap 192)",
    );
  });

  it("says `none` rather than printing an empty list when no arm survives", () => {
    expect(describeOverlapPlan({ chunkSize: 2048, arms: [], excluded: [] })).toBe(
      "Overlap ladder at 2048: none (excluded by the chunker's cap: none)",
    );
  });
});

describe("renderOverlapValue", () => {
  it("prints a plain number when nothing is clamped", () => {
    expect(renderOverlapValue(2048, 256)).toBe("256");
  });

  it("prints the effective value AND the request when the chunker clamps", () => {
    expect(renderOverlapValue(768, 256)).toBe("192 (CLAMPED from 256, cap 192)");
  });
});

describe("ndcgByQuery", () => {
  it("keys per-query nDCG@10 by query id", () => {
    expect(ndcgByQuery([score("a", 0.5), score("b", 0)])).toEqual(
      new Map([
        ["a", 0.5],
        ["b", 0],
      ]),
    );
  });
});

describe("compareChunkArm", () => {
  const opts = { seed: 7, resamples: 400 };

  it("orients the delta so positive means the ARM beat the control", () => {
    const control = armResult(controlSpec, { q1: 0.2, q2: 0.2 });
    const arm = armResult(smallSpec, { q1: 0.8, q2: 0.8 });
    expect(compareChunkArm(control, arm, opts).all.paired.meanDelta).toBeCloseTo(0.6, 6);
  });

  it("classifies a flat result as NOT-ESTABLISHED — a null is a first-class outcome", () => {
    const scores = { q1: 0.4, q2: 0.5, q3: 0.6, q4: 0.3 };
    const control = armResult(controlSpec, scores);
    const arm = armResult(smallSpec, scores);
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.all.paired.meanDelta).toBe(0);
    expect(cmp.all.verdict).toBe("NOT-ESTABLISHED");
  });

  it("counts non-zero deltas, because sparse deltas degrade bootstrap tail coverage", () => {
    const control = armResult(controlSpec, { q1: 0.5, q2: 0.5, q3: 0.5 });
    const arm = armResult(smallSpec, { q1: 0.9, q2: 0.5, q3: 0.5 });
    expect(compareChunkArm(control, arm, opts).all.nonZeroDeltas).toBe(1);
  });

  it("reports the chunk-count multiplier against the control", () => {
    const control = armResult(controlSpec, { q1: 0.5 }, { chunkCount: 400 });
    const arm = armResult(smallSpec, { q1: 0.5 }, { chunkCount: 700 });
    expect(compareChunkArm(control, arm, opts).chunkMultiplier).toBeCloseTo(1.75, 6);
  });

  /**
   * #1159's lesson: its headline +0.053 (p=0.004) became +0.022 (p=0.125,
   * NOT-ESTABLISHED) once five flattered queries were removed. The subset must be
   * reported alongside the aggregate, not instead of it.
   */
  it("reports the arm-sensitive subset SEPARATELY from the aggregate", () => {
    const control = armResult(controlSpec, { q1: 0.2, q2: 0.5, q3: 0.5, q4: 0.5 });
    const arm = armResult(
      smallSpec,
      { q1: 0.9, q2: 0.5, q3: 0.5, q4: 0.5 },
      { sensitiveQueryIds: ["q1"] },
    );
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.all.paired.n).toBe(4);
    expect(cmp.sensitive?.paired.n).toBe(1);
    expect(cmp.sensitiveCount).toBe(1);
    // The aggregate dilutes the subset's effect fourfold — which is exactly why
    // both are printed.
    expect(cmp.all.paired.meanDelta).toBeCloseTo(0.175, 6);
    expect(cmp.sensitive?.paired.meanDelta).toBeCloseTo(0.7, 6);
  });

  it("returns a null sensitive comparison when the arm re-chunked nothing", () => {
    const control = armResult(controlSpec, { q1: 0.5 });
    const arm = armResult(smallSpec, { q1: 0.5 }, { sensitiveQueryIds: [] });
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.sensitive).toBeNull();
    expect(cmp.sensitiveCount).toBe(0);
  });

  /**
   * The other half of #1159's lesson: report the statistic on the EXCLUDED subset, not
   * only on the stratum. #1183 found it is load-bearing rather than ceremonial — on
   * the overlap arms more queries moved outside the stratum than inside it, because
   * `armSensitiveQueryIds` compares only the answer chunk's text while ranking depends
   * on the whole index.
   */
  it("reports the complement of the arm-sensitive stratum, which can carry the movers", () => {
    const control = armResult(controlSpec, { q1: 0.5, q2: 0.5, q3: 0.5 });
    const arm = armResult(
      smallSpec,
      // q1 is the only re-chunked query and it does NOT move; q2/q3 are excluded from
      // the stratum and both do.
      { q1: 0.5, q2: 0.9, q3: 0.9 },
      { sensitiveQueryIds: ["q1"] },
    );
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.sensitiveExcludedCount).toBe(2);
    expect(cmp.sensitiveExcluded?.paired.n).toBe(2);
    expect(cmp.sensitive?.nonZeroDeltas).toBe(0);
    expect(cmp.sensitiveExcluded?.nonZeroDeltas).toBe(2);
    expect(cmp.sensitiveExcluded?.paired.meanDelta).toBeCloseTo(0.4, 6);
  });

  it("returns a null excluded comparison when every query is arm-sensitive", () => {
    const control = armResult(controlSpec, { q1: 0.5 });
    const arm = armResult(smallSpec, { q1: 0.5 }, { sensitiveQueryIds: ["q1"] });
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.sensitiveExcluded).toBeNull();
    expect(cmp.sensitiveExcludedCount).toBe(0);
  });

  it("carries the arm's reindex cost and span coverage through to the comparison", () => {
    const control = armResult(controlSpec, { q1: 0.5 });
    const arm = armResult(smallSpec, { q1: 0.5 }, { reindexSeconds: 42.5, meanSpanCoverage: 0.87 });
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.reindexSeconds).toBe(42.5);
    expect(cmp.meanSpanCoverage).toBe(0.87);
  });
});

/**
 * The subset that decides what may be CLAIMED, so it is tested against the failure it
 * exists to prevent: `ranking only` keeps straddled spans and therefore still carries
 * coverage loss, which on the real `size-1024` arm is the whole of the effect.
 */
describe("compareChunkArm — the coverage-clean subset", () => {
  const opts = { seed: 5, resamples: 400 };
  const scores = { q1: 0.9, q2: 0.1, q3: 0.5, q4: 0.5 };

  /** Control covers everything; the arm straddles `q2` without dropping it. */
  const straddling = (): { control: ChunkArmResult; arm: ChunkArmResult } => ({
    control: armResult(controlSpec, { q1: 0.5, q2: 0.9, q3: 0.5, q4: 0.5 }),
    arm: armResult(smallSpec, scores, {
      spanCoverage: { q1: 1, q2: 0.42, q3: 1, q4: 1 },
    }),
  });

  it("excludes a STRADDLED span that `ranking only` keeps — the whole point of the row", () => {
    const { control, arm } = straddling();
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.uncoveredCount).toBe(0);
    // `ranking only` removes only DROPPED spans, so it keeps all four…
    expect(cmp.rankingOnly?.paired.n).toBe(4);
    // …while coverage-clean drops the straddled one.
    expect(cmp.coverageCleanCount).toBe(3);
    expect(cmp.coverageClean?.paired.n).toBe(3);
  });

  it("counts straddled spans separately from dropped ones", () => {
    const { control, arm } = straddling();
    expect(compareChunkArm(control, arm, opts).straddledCount).toBe(1);
  });

  /**
   * The load-bearing claim: on `size-1024` the arm-sensitive verdict is
   * DIRECTION-ESTABLISHED before cleaning and NOT-ESTABLISHED after, so the two rows
   * support different sentences. If cleaning could never change the delta, the row
   * would be decoration.
   */
  it("can report a different delta from `ranking only`, which is why both are printed", () => {
    const { control, arm } = straddling();
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.rankingOnly?.paired.meanDelta).not.toBeCloseTo(
      cmp.coverageClean?.paired.meanDelta ?? 0,
      6,
    );
  });

  it("intersects arm-sensitive with coverage-clean as its own row", () => {
    const control = armResult(controlSpec, scores);
    const arm = armResult(smallSpec, scores, {
      sensitiveQueryIds: ["q1", "q2"],
      spanCoverage: { q1: 1, q2: 0.42, q3: 1, q4: 1 },
    });
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.sensitiveCount).toBe(2);
    // q2 is sensitive but straddled, so only q1 survives the intersection.
    expect(cmp.sensitiveCleanCount).toBe(1);
    expect(cmp.sensitiveClean?.paired.n).toBe(1);
  });

  it("treats an exactly-covered span as clean and a hair below the floor as not", () => {
    const control = armResult(controlSpec, scores);
    const arm = armResult(smallSpec, scores, {
      spanCoverage: { q1: 1, q2: 0.9995, q3: COVERAGE_CLEAN_THRESHOLD, q4: 0.99 },
    });
    // q1 (1.0) and q2 (0.9995) clear the floor; q3 sits exactly ON it and q4 below,
    // and the predicate is strictly greater-than, so both are excluded.
    expect(compareChunkArm(control, arm, opts).coverageCleanCount).toBe(2);
  });

  it("treats a query absent from the coverage record as uncovered, not as clean", () => {
    const control = armResult(controlSpec, scores);
    const arm = armResult(smallSpec, scores, { spanCoverage: { q1: 1 } });
    // An absent measurement is not evidence of full coverage — the conservative
    // direction, since the alternative would flatter the arm silently.
    expect(compareChunkArm(control, arm, opts).coverageCleanCount).toBe(1);
  });

  it("returns null rather than an empty comparison when nothing is clean at both arms", () => {
    const control = armResult(controlSpec, scores, {
      spanCoverage: { q1: 0.5, q2: 0.5, q3: 0.5, q4: 0.5 },
    });
    const arm = armResult(smallSpec, scores);
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.coverageClean).toBeNull();
    expect(cmp.sensitiveClean).toBeNull();
    expect(cmp.coverageCleanCount).toBe(0);
  });

  it("carries realised and configured overlap through to the comparison", () => {
    const control = armResult(controlSpec, { q1: 0.5 });
    const arm = armResult(
      smallSpec,
      { q1: 0.5 },
      {
        realisedOverlapChars: 449,
        expectedOverlapChars: 111_104,
      },
    );
    const cmp = compareChunkArm(control, arm, opts);
    expect(cmp.realisedOverlapChars).toBe(449);
    expect(cmp.expectedOverlapChars).toBe(111_104);
  });
});

describe("renderOverlapDelivery", () => {
  const control = armResult(
    controlSpec,
    { q1: 0.5 },
    {
      realisedOverlapChars: 2554,
      expectedOverlapChars: 118_784,
    },
  );
  const base = {
    corpusId: "c",
    snapshotCommit: "a".repeat(40),
    queryCount: 1,
    docCount: 1,
    corpusChars: 100,
    embeddingModel: "m",
    control,
    comparisons: [],
    overlapComparisons: [],
    rerankBudget: [],
    overlapPlan: overlapArmsFor(CONTROL_CHUNK_SIZE),
    generatedAt: "2026-07-31T00:00:00.000Z",
  };

  it("refuses to let a starved overlap arm be read as a measured null", () => {
    // 2554 / 118784 = 2.2% — the pre-#1178 shipped arm, read with the inflated
    // section-transition denominator that #1178 also corrected.
    const md = renderOverlapDelivery(base);
    expect(md).toContain("UNINTERPRETABLE");
    expect(md).toContain("#1178");
    expect(md).toContain("Do not read the overlap arm as a measured null");
  });

  it("prints the delivered fraction, which is what decides the verdict", () => {
    expect(renderOverlapDelivery(base)).toContain("2.2%");
  });

  /**
   * The verdict is computed, not asserted — the whole point of #1178's change here.
   * A chunker that tiles delivers nearly all of its configured overlap, and the arm
   * becomes readable; hard-coding either verdict would make the report lie in one
   * direction or the other as soon as the chunker changed. It already changed once.
   */
  it("declares the arm READABLE once the overlap is actually delivered", () => {
    const delivered = armResult(
      controlSpec,
      { q1: 0.5 },
      { realisedOverlapChars: 12_932, expectedOverlapChars: 13_056 },
    );
    const md = renderOverlapDelivery({ ...base, control: delivered });
    expect(md).toContain("READABLE");
    expect(md).not.toContain("UNINTERPRETABLE");
    expect(md).toContain("A null here is a measured null");
    expect(md).toContain("99.1%");
  });

  /**
   * The regression this verdict exists to catch is a chunker that stops tiling, and a
   * chunker breaks per *arm* — the pre-#1178 gap widened as chunk size fell, so the
   * small arms starved while the large ones looked fine.
   *
   * A pooled `sum(realised) / sum(expected)` therefore fails in exactly the shape it
   * is meant to detect: the healthy arms outvote the broken one. These are the
   * committed 2026-07-31 numbers with the `size-768` arm zeroed — pooled delivery is
   * still 79%, which would clear the 0.5 threshold and print READABLE over an arm
   * delivering nothing at all.
   */
  it("does not let four healthy arms mask one arm delivering zero overlap", () => {
    const zeroed = armResult(
      smallSpec,
      { q1: 0.5 },
      { realisedOverlapChars: 0, expectedOverlapChars: 69_120 },
    );
    const healthy: Array<[number, number]> = [
      [29_596, 30_080],
      [36_977, 37_728],
      [7639, 7680],
    ];
    const md = renderOverlapDelivery({
      ...base,
      // 12933/13056 = 99.1%, the shipped arm.
      control: armResult(
        controlSpec,
        { q1: 0.5 },
        { realisedOverlapChars: 12_933, expectedOverlapChars: 13_056 },
      ),
      comparisons: healthy.map(([realised, expected]) =>
        compareChunkArm(
          control,
          armResult(
            smallSpec,
            { q1: 0.5 },
            {
              realisedOverlapChars: realised,
              expectedOverlapChars: expected,
            },
          ),
          { seed: 1, resamples: 200 },
        ),
      ),
      overlapComparisons: [compareChunkArm(control, zeroed, { seed: 1, resamples: 200 })],
    });
    // Pooled: (12933+29596+36977+7639+0) / (13056+30080+37728+7680+69120) = 79.0%.
    expect(md).toContain("UNINTERPRETABLE");
    expect(md).not.toContain("the overlap arm is READABLE");
    expect(md).toContain("0.0%");
  });

  /**
   * The mirror of the test above: the minimum must not be dragged below the threshold
   * by an arm that configured no overlap at all. `0 / 0` is not a delivery failure —
   * there was nothing to deliver — so those rows are excluded from the minimum rather
   * than scored as a miss, which a naive `Math.min` over all rows would do.
   */
  it("ignores a zero-overlap arm when taking the worst delivery", () => {
    const noOverlapArm = armResult(
      smallSpec,
      { q1: 0.5 },
      { realisedOverlapChars: 0, expectedOverlapChars: 0 },
    );
    const md = renderOverlapDelivery({
      ...base,
      control: armResult(
        controlSpec,
        { q1: 0.5 },
        { realisedOverlapChars: 12_932, expectedOverlapChars: 13_056 },
      ),
      overlapComparisons: [compareChunkArm(control, noOverlapArm, { seed: 1, resamples: 200 })],
    });
    expect(md).toContain("READABLE");
    expect(md).not.toContain("UNINTERPRETABLE");
  });

  /**
   * #1183. `overlapArmsFor` no longer produces a clamped arm, but `CHUNK_SIZE_ARMS` is
   * hand-written and `renderOverlapDelivery` renders whatever it is given — so a
   * clamped arm reaching the table must be labelled rather than printed as if it ran
   * at the overlap its row names.
   */
  it("marks a clamped arm CLAMPED and explains which denominator was used", () => {
    const clampedSpec: ChunkArmSpec = {
      id: "overlap-768-256",
      chunkSize: 768,
      overlap: 256,
      control: false,
      rationale: "a hand-written arm the chunker would clamp to 192",
    };
    const clamped = armResult(
      clampedSpec,
      { q1: 0.5 },
      { realisedOverlapChars: 86_400, expectedOverlapChars: 87_360 },
    );
    const md = renderOverlapDelivery({
      ...base,
      control: armResult(
        controlSpec,
        { q1: 0.5 },
        { realisedOverlapChars: 12_932, expectedOverlapChars: 13_056 },
      ),
      overlapComparisons: [compareChunkArm(control, clamped, { seed: 1, resamples: 200 })],
    });
    expect(md).toContain("768/192 (CLAMPED from 256, cap 192)");
    expect(md).toContain("did not run at the overlap its id names");
    expect(md).toContain("divides by the EFFECTIVE value");
  });

  it("omits the clamp callout when no arm is clamped", () => {
    const md = renderOverlapDelivery({
      ...base,
      control: armResult(
        controlSpec,
        { q1: 0.5 },
        { realisedOverlapChars: 12_932, expectedOverlapChars: 13_056 },
      ),
    });
    expect(md).not.toContain("CLAMPED");
  });

  it("is omitted entirely when no arm configured any overlap", () => {
    const noOverlap = armResult(
      controlSpec,
      { q1: 0.5 },
      {
        realisedOverlapChars: 0,
        expectedOverlapChars: 0,
      },
    );
    expect(renderOverlapDelivery({ ...base, control: noOverlap })).toBe("");
  });

  it("renders a row per arm, including the overlap arms", () => {
    const arm = armResult(
      smallSpec,
      { q1: 0.5 },
      {
        realisedOverlapChars: 4294,
        expectedOverlapChars: 72_288,
      },
    );
    const md = renderOverlapDelivery({
      ...base,
      comparisons: [compareChunkArm(control, arm, { seed: 1, resamples: 200 })],
    });
    expect(md).toContain("`size-768`");
    expect(md).toContain("4294");
  });
});

describe("renderChunkSweep", () => {
  const control = armResult(controlSpec, { q1: 0.4, q2: 0.6 }, { chunkCount: 400 });
  const arm = armResult(smallSpec, { q1: 0.5, q2: 0.6 }, { chunkCount: 700 });
  const report = {
    corpusId: "docretrieval-01-metis-docs",
    snapshotCommit: "a".repeat(40),
    queryCount: 48,
    docCount: 10,
    corpusChars: 380000,
    embeddingModel: "Alibaba-NLP/gte-modernbert-base",
    control,
    comparisons: [compareChunkArm(control, arm, { seed: 1, resamples: 200 })],
    overlapComparisons: [],
    rerankBudget: [],
    overlapPlan: overlapArmsFor(CONTROL_CHUNK_SIZE),
    generatedAt: "2026-07-30T00:00:00.000Z",
  };

  it("prints the pre-registered floor, so the artefact cannot be read without it", () => {
    expect(renderChunkSweep(report)).toContain(`+${MIN_IMPORTANT_NDCG_DELTA}`);
  });

  it("prints the corpus provenance", () => {
    const md = renderChunkSweep(report);
    expect(md).toContain("docretrieval-01-metis-docs");
    expect(md).toContain(report.snapshotCommit);
  });

  it("states that retrieval really ran — the distinction from rag:eval", () => {
    expect(renderChunkSweep(report)).toContain("No canned retrieval");
  });

  it("prints both the aggregate row and the arm-sensitive row for each arm", () => {
    const md = renderChunkSweep(report);
    expect(md).toContain("| all |");
    expect(md).toContain("arm-sensitive");
  });

  it("prints the chunk multiplier and reindex seconds — the cost side", () => {
    const md = renderChunkSweep(report);
    expect(md).toContain("1.75×");
    expect(md).toContain("×control");
    expect(md).toContain("reindex s");
  });

  it("spells out that a null result is a first-class outcome", () => {
    expect(renderChunkSweep(report)).toMatch(/null result is a first-class outcome/i);
  });

  it("marks an arm that re-chunked nothing rather than printing an empty comparison", () => {
    const flat = armResult(smallSpec, { q1: 0.4, q2: 0.6 }, { sensitiveQueryIds: [] });
    const md = renderChunkSweep({
      ...report,
      comparisons: [compareChunkArm(control, flat, { seed: 1, resamples: 200 })],
    });
    expect(md).toContain("NO-RE-CHUNKING");
  });

  it("uses nDCG@10 as the headline depth", () => {
    expect(DOC_EVAL_K).toBe(10);
    expect(renderChunkSweep(report)).toContain("nDCG@10");
  });
});

describe("renderChunkSweep — the two callouts that must not be silent", () => {
  const controlClean = armResult(controlSpec, { q1: 0.4, q2: 0.6 }, { chunkCount: 400 });
  const baseReport = {
    corpusId: "c",
    snapshotCommit: "a".repeat(40),
    queryCount: 2,
    docCount: 1,
    corpusChars: 100,
    embeddingModel: "m",
    control: controlClean,
    comparisons: [],
    overlapComparisons: [],
    rerankBudget: [],
    overlapPlan: overlapArmsFor(CONTROL_CHUNK_SIZE),
    generatedAt: "2026-07-30T00:00:00.000Z",
  };

  it("calls out dropped spans as a production defect, with the mechanism and the citation", () => {
    const dropping = armResult(
      smallSpec,
      { q1: 0, q2: 0.6 },
      { chunkCount: 700, uncoveredQueryIds: ["q1"] },
    );
    const md = renderChunkSweep({
      ...baseReport,
      comparisons: [compareChunkArm(controlClean, dropping, { seed: 3, resamples: 200 })],
    });
    expect(md).toContain("defect in the production chunker");
    expect(md).toContain("since #1178 it should be zero");
    expect(md).toContain("ranking only");
  });

  it("omits the dropped-span callout entirely when no arm dropped anything", () => {
    const clean = armResult(smallSpec, { q1: 0.4, q2: 0.6 }, { chunkCount: 700 });
    const md = renderChunkSweep({
      ...baseReport,
      comparisons: [compareChunkArm(controlClean, clean, { seed: 3, resamples: 200 })],
    });
    expect(md).not.toContain("defect in the production chunker");
  });

  /**
   * The case #1158's pool-20 arm hit for real, and both small arms hit in #1160's own
   * run: a bootstrap interval that excludes zero while the sign test declines to
   * reject. A reader must not have to spot that themselves.
   *
   * The comparison is CONSTRUCTED rather than produced by `compareChunkArm`, because
   * a fixture chosen to provoke a disagreement is at the mercy of the bootstrap seed —
   * an earlier version of this test guarded the assertion behind `if (!cmp.all.agree)`
   * and silently never exercised the callout at all.
   */
  it("names arms where the bootstrap interval and the sign test disagree", () => {
    const md = renderChunkSweep({ ...baseReport, comparisons: [disagreeing("size-768")] });
    expect(md).toContain("Bootstrap/sign-test disagreement");
    expect(md).toContain("`size-768`");
    expect(md).toContain("sign test governs");
  });

  it("omits the disagreement callout when both tests point the same way", () => {
    const agreeing = disagreeing("size-768");
    agreeing.all.agree = true;
    const md = renderChunkSweep({ ...baseReport, comparisons: [agreeing] });
    expect(md).not.toContain("Bootstrap/sign-test disagreement");
  });

  /**
   * #1183 measured this on real arms: the arm-sensitive stratum held 1 mover while its
   * complement held 7, so reading the verdict off the stratum would have described the
   * minority of the movement. Silence here would let the stratum keep its unearned
   * reputation as the more powerful test.
   */
  it("says so when more queries move OUTSIDE the arm-sensitive stratum than inside", () => {
    const control = armResult(controlSpec, { q1: 0.5, q2: 0.5, q3: 0.5 }, { chunkCount: 400 });
    const arm = armResult(
      smallSpec,
      { q1: 0.5, q2: 0.9, q3: 0.9 },
      { chunkCount: 700, sensitiveQueryIds: ["q1"] },
    );
    const md = renderChunkSweep({
      ...baseReport,
      control,
      comparisons: [compareChunkArm(control, arm, { seed: 3, resamples: 200 })],
    });
    expect(md).toContain("not a superset of the movement");
    expect(md).toContain("arm-sensitive EXCLUDED (2)");
    expect(md).toContain("2 outside vs 0 inside");
    // The count survives only as a severity note, never as the trigger.
    expect(md).toContain("More severe still on");
  });

  /**
   * The regression the `> 0` threshold exists for, and the one the count comparison
   * missed. On the committed run `size-1024` moves 7 queries outside the stratum and 11
   * inside, so `outside > inside` is FALSE and the old guard stayed silent — on the arm
   * whose complement carries the only established direction in the whole run, and one of
   * the two arms #1184 re-measures. A single mover outside falsifies "structurally
   * incapable of moving", so the minority case must fire just as loudly.
   */
  it("fires even when the stratum holds MORE movers than its complement", () => {
    const control = armResult(
      controlSpec,
      { q1: 0.5, q2: 0.5, q3: 0.5, q4: 0.5 },
      { chunkCount: 400 },
    );
    // q1, q2, q3 move inside the stratum; only q4 moves outside it.
    const arm = armResult(
      smallSpec,
      { q1: 0.9, q2: 0.8, q3: 0.7, q4: 0.6 },
      { chunkCount: 700, sensitiveQueryIds: ["q1", "q2", "q3"] },
    );
    const md = renderChunkSweep({
      ...baseReport,
      control,
      comparisons: [compareChunkArm(control, arm, { seed: 3, resamples: 200 })],
    });
    expect(md).toContain("not a superset of the movement");
    expect(md).toContain("1 outside vs 3 inside");
    // The severity clause must NOT claim the complement holds the majority here.
    expect(md).not.toContain("More severe still on");
  });

  /**
   * #1183's acceptance criterion is that a subset disagreement is treated as a FINDING.
   * Before this, `disagreements` compared bootstrap against sign test WITHIN a subset and
   * never across subsets, so `size-1024`'s stratum (NOT-ESTABLISHED, -0.002) and its
   * complement (DIRECTION-ESTABLISHED-MAGNITUDE-NOT, +0.065) were printed as two adjacent
   * rows and passed over. Constructed rather than measured, because a fixture chosen to
   * provoke opposite verdicts is at the mercy of the bootstrap seed.
   */
  it("reports a stratum/complement VERDICT disagreement as a finding, with both rows", () => {
    const split = disagreeing("size-1024");
    split.all.agree = true;
    split.sensitive = {
      ...split.all,
      verdict: "NOT-ESTABLISHED",
      paired: { ...split.all.paired, meanDelta: -0.002, signTestP: 1 },
    };
    split.sensitiveExcluded = {
      ...split.all,
      verdict: "DIRECTION-ESTABLISHED-MAGNITUDE-NOT",
      paired: { ...split.all.paired, meanDelta: 0.065, signTestP: 0.016 },
    };
    split.sensitiveCount = 29;
    split.sensitiveExcludedCount = 19;
    const md = renderChunkSweep({ ...baseReport, comparisons: [split] });
    expect(md).toContain("Subset verdict disagreement");
    expect(md).toContain("arm-sensitive (29) reads NOT-ESTABLISHED at -0.002 (p = 1.000)");
    expect(md).toContain(
      "arm-sensitive EXCLUDED (19) reads DIRECTION-ESTABLISHED-MAGNITUDE-NOT at +0.065 (p = 0.016)",
    );
    expect(md).toContain("opposite signs");
    expect(md).toContain("unadjusted subgroup selection");
  });

  /**
   * A verdict split does NOT require opposite signs — `size-768` splits on p-value while
   * both subsets point the same way. The callout must fire without claiming a sign
   * reversal it cannot see.
   */
  it("reports a same-sign verdict split without claiming opposite signs", () => {
    const split = disagreeing("size-768");
    split.all.agree = true;
    split.sensitive = {
      ...split.all,
      verdict: "NOT-ESTABLISHED",
      paired: { ...split.all.paired, meanDelta: 0.01, signTestP: 0.6 },
    };
    split.sensitiveExcluded = {
      ...split.all,
      verdict: "DIRECTION-ESTABLISHED-MAGNITUDE-NOT",
      paired: { ...split.all.paired, meanDelta: 0.07, signTestP: 0.02 },
    };
    const md = renderChunkSweep({ ...baseReport, comparisons: [split] });
    expect(md).toContain("Subset verdict disagreement");
    expect(md).not.toContain("opposite signs");
  });

  it("stays silent on subset verdicts when the stratum and its complement agree", () => {
    const agreed = disagreeing("size-1024");
    agreed.all.agree = true;
    agreed.sensitive = { ...agreed.all, verdict: "NOT-ESTABLISHED" };
    agreed.sensitiveExcluded = { ...agreed.all, verdict: "NOT-ESTABLISHED" };
    const md = renderChunkSweep({ ...baseReport, comparisons: [agreed] });
    expect(md).not.toContain("Subset verdict disagreement");
  });

  /**
   * A ladder value the cap forbids must be NAMED, not quietly absent. A silently
   * dropped arm is the same class of defect as a silently clamped one — the reader
   * cannot tell the ladder was not run in full (#1183).
   */
  it("names the ladder values the chunker's cap forbade at this size", () => {
    const md = renderChunkSweep({ ...baseReport, overlapPlan: overlapArmsFor(768) });
    expect(md).toContain("Not run at 768:");
    expect(md).toContain("`256` (chunker cap 192)");
    expect(md).toContain("`512` (chunker cap 192)");
    // At 768 the size arm REQUESTS the ladder's 256 and RUNS at 192, which is not a
    // ladder value — so nothing is skipped as a duplicate. Matching on the request would
    // make this report claim, two paragraphs apart, both that 256 was not run here and
    // that `size-768` already runs it.
    expect(ladderArmsAlreadyRun(768)).toEqual([]);
    expect(md).toContain("no ladder value duplicates a size arm at this size");
    expect(md).not.toContain("(`size-768`) already runs as a size arm");
  });

  it("omits the not-run callout when the cap forbade nothing", () => {
    const md = renderChunkSweep(baseReport);
    expect(md).not.toContain("Not run at");
    expect(md).toContain("256 (`size-2048`) already runs as a size arm here and is not re-run");
  });

  /**
   * The skipped value is DERIVED from the same predicate `overlapArmsFor` skips on, not
   * written as the literal "256". This epic exists to decide whether
   * `DEFAULT_RAG_CHUNK_OVERLAP` moves; the moment it does, a hardcoded sentence would
   * name a value the sweep no longer skipped — an artefact describing a run that did not
   * happen, which is the genus of defect the rest of #1183 is about.
   */
  it("derives the skipped ladder value from the size arms rather than hardcoding it", () => {
    const already = ladderArmsAlreadyRun(CONTROL_CHUNK_SIZE);
    expect(already.map((a) => a.overlap)).toEqual([256]);
    // The renderer's sentence and `overlapArmsFor`'s skip agree by construction.
    const ran = overlapArmsFor(CONTROL_CHUNK_SIZE).arms.map((a) => a.overlap);
    for (const a of already) expect(ran).not.toContain(a.overlap);
    expect(renderChunkSweep(baseReport)).toContain(`${already[0].overlap} (\`${already[0].id}\``);
  });

  /**
   * The ONLY silence the new predicate permits: nothing at all moved outside the
   * stratum, so it really is a superset of the movement on this arm.
   */
  it("omits that callout only when NO query moves outside the stratum", () => {
    const control = armResult(controlSpec, { q1: 0.5, q2: 0.5, q3: 0.5 }, { chunkCount: 400 });
    const arm = armResult(
      smallSpec,
      { q1: 0.9, q2: 0.5, q3: 0.5 },
      { chunkCount: 700, sensitiveQueryIds: ["q1"] },
    );
    const cmp = compareChunkArm(control, arm, { seed: 3, resamples: 200 });
    expect(cmp.sensitiveExcluded?.nonZeroDeltas).toBe(0);
    const md = renderChunkSweep({ ...baseReport, control, comparisons: [cmp] });
    expect(md).not.toContain("not a superset of the movement");
  });

  /**
   * The wording defect the PR #1179 review flagged: `ranking only` reads as the
   * isolating control and is not one. The artefact must say which row to read.
   */
  it("warns that `ranking only` keeps straddled spans and points at coverage-clean", () => {
    const straddling = armResult(
      smallSpec,
      { q1: 0.4, q2: 0.6 },
      { chunkCount: 700, spanCoverage: { q1: 0.4, q2: 1 } },
    );
    const md = renderChunkSweep({
      ...baseReport,
      comparisons: [compareChunkArm(controlClean, straddling, { seed: 3, resamples: 200 })],
    });
    expect(md).toContain("not the isolating control");
    expect(md).toContain("coverage-clean");
    expect(md).toContain("| coverage-clean (1) |");
  });

  it("omits the straddle warning when no arm straddled anything", () => {
    const clean = armResult(smallSpec, { q1: 0.4, q2: 0.6 }, { chunkCount: 700 });
    const md = renderChunkSweep({
      ...baseReport,
      comparisons: [compareChunkArm(controlClean, clean, { seed: 3, resamples: 200 })],
    });
    expect(md).not.toContain("not the isolating control");
  });

  it("prints the index-level confound, which no subset repairs", () => {
    const straddling = armResult(
      smallSpec,
      { q1: 0.4, q2: 0.6 },
      { chunkCount: 700, spanCoverage: { q1: 0.4, q2: 1 } },
    );
    const md = renderChunkSweep({
      ...baseReport,
      comparisons: [compareChunkArm(controlClean, straddling, { seed: 3, resamples: 200 })],
    });
    expect(md).toMatch(/MIMICS a chunk-size effect/i);
  });

  it("prints the straddled-span column beside the dropped-span one", () => {
    const md = renderChunkSweep(baseReport);
    expect(md).toContain("spans straddled");
  });

  it("renders the cross-encoder budget section when a profile is present", () => {
    const md = renderChunkSweep({
      ...baseReport,
      rerankBudget: [
        {
          chunkSize: 2048,
          chunkCount: 10,
          medianTokens: 500,
          maxTokens: 700,
          truncatedChunks: 4,
          truncatedFraction: 0.4,
          meanSurvivingFraction: 0.9,
          queryTokens: 22,
        },
      ],
    });
    expect(md).toContain("Cross-encoder input budget");
  });
});

/**
 * The sizing sections of the artefact, which had no test at all until #1184's adversarial
 * panel pointed out that deleting either one — or sizing against a stratum instead of
 * `all` — would leave the suite green.
 *
 * The `all`-only rule is not a style choice. #1183 measured the arm-sensitive stratum to be
 * an unadjusted subgroup rather than a power-preserving filter, so sizing a future corpus
 * against it would size against the wrong denominator, and on `size-1024` against the
 * subset carrying the opposite sign. `runSizingInputs`'s docstring says exactly that; these
 * tests are what make the docstring load-bearing.
 */
describe("the artefact's sizing sections", () => {
  const sizingControl = armResult(CHUNK_SIZE_ARMS[0], { q1: 0.9, q2: 0.2, q3: 0.5 });
  // Only q1 and q2 re-chunk, so the stratum is a PROPER subset of `all` and the
  // assertions below discriminate instead of passing on coincidence.
  const sizingArm = armResult(
    smallSpec,
    { q1: 0.3, q2: 0.8, q3: 0.5 },
    { chunkCount: 700, sensitiveQueryIds: ["q1", "q2"] },
  );
  const comparison = compareChunkArm(sizingControl, sizingArm, { seed: 7, resamples: 400 });
  const report = {
    corpusId: "c",
    snapshotCommit: "a".repeat(40),
    queryCount: 3,
    docCount: 1,
    corpusChars: 100,
    embeddingModel: "m",
    control: sizingControl,
    comparisons: [comparison],
    overlapComparisons: [],
    rerankBudget: [],
    overlapPlan: overlapArmsFor(CONTROL_CHUNK_SIZE),
    generatedAt: "2026-08-01T00:00:00.000Z",
  };

  it("sizes on `all`, never on a stratum whose denominator #1183 falsified", () => {
    const [row] = runSizingInputs(report);
    expect(row.subset).toBe("all");
    expect(row.n).toBe(comparison.all.paired.n);
    expect(row.meanDelta).toBe(comparison.all.paired.meanDelta);
    expect(row.ciLow).toBe(comparison.all.paired.ciLow);
    expect(row.ciHigh).toBe(comparison.all.paired.ciHigh);
    // …and the stratum really is a DIFFERENT interval here, so the assertions above
    // discriminate rather than passing because the two happen to coincide.
    expect(comparison.sensitive).not.toBeNull();
    expect(row.ciLow).not.toBe(comparison.sensitive?.paired.ciLow);
  });

  it("covers every arm of the run, size and overlap alike", () => {
    const withOverlap = { ...report, overlapComparisons: [comparison] };
    expect(runSizingInputs(withOverlap).map((r) => r.armId)).toEqual([
      comparison.armId,
      comparison.armId,
    ]);
  });

  it("prints BOTH the prior-run sizing and what this run achieved", () => {
    const md = renderChunkSweep(report);
    // The prior-run section is what discharges #1184's first acceptance criterion — state
    // the query count a decisive answer needs BEFORE spending anything on a corpus.
    expect(md).toContain("Statistical resolution — the sizing this corpus was built from");
    expect(md).toContain(`${PRIOR_RUN_QUERY_COUNT} queries on \`docretrieval-01-metis-docs\``);
    // …and the second is the honest statement of what this run could and could not
    // separate, without which a null reads as "no effect" rather than "unproven".
    expect(md).toContain("Statistical resolution — what THIS run achieved");
    expect(md).toContain(`${report.queryCount} queries actually run`);
  });
});
