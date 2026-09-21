import { describe, expect, it } from "vitest";
import { MIN_IMPORTANT_DELTA } from "../embed-retrieval/rerank-sweep.js";
import { queriesNeededForHalfWidth, Z_95 } from "../embed-retrieval/stats.js";
import {
  asMeanWithCi,
  corpusGoNoGo,
  halfWidthOf,
  impliedSd,
  PRACTICAL_QUERY_CEILING,
  PRIOR_RUN_QUERY_COUNT,
  PRIOR_RUN_SIZING,
  renderCorpusSizing,
  sizeArm,
  SIZING_TARGETS,
  type SizingInput,
} from "./power-sizing.js";

const input = (over: Partial<SizingInput> = {}): SizingInput => ({
  armId: "size-1024",
  subset: "all",
  n: 48,
  meanDelta: 0.02,
  ciLow: -0.05,
  ciHigh: 0.1,
  ...over,
});

describe("impliedSd", () => {
  /**
   * The inversion is the whole basis of this module: if `hw = z·sd/√n` then
   * `sd = hw·√n/z`, exactly. Asserted as a ROUND TRIP through the shared function
   * rather than against a hand-computed constant, so a change to `Z_95` cannot leave
   * this test passing against a stale number.
   */
  it("round-trips a half-width back through queriesNeededForHalfWidth", () => {
    const stats = asMeanWithCi(input({ n: 48, ciLow: -0.05, ciHigh: 0.1 }));
    const target = stats.halfWidth;
    expect(queriesNeededForHalfWidth(stats, target)).toBe(48);
  });

  it("reduces to n·(hw/target)² — the identity the artefact quotes", () => {
    const stats = asMeanWithCi(input({ n: 48, ciLow: -0.05408, ciHigh: 0.0995 }));
    const target = 0.04;
    expect(queriesNeededForHalfWidth(stats, target)).toBe(
      Math.ceil(stats.n * (stats.halfWidth / target) ** 2),
    );
  });

  it("recovers the sd from the interval", () => {
    expect(impliedSd(0.0768, 48)).toBeCloseTo((0.0768 * Math.sqrt(48)) / Z_95, 12);
  });

  /** `null`, not 0 — a caller must not read "no information" as "no spread". */
  it("returns null where the inversion carries no information", () => {
    expect(impliedSd(0.05, 1)).toBeNull();
    expect(impliedSd(0, 48)).toBeNull();
    expect(impliedSd(Number.NaN, 48)).toBeNull();
  });
});

describe("halfWidthOf", () => {
  it("halves the interval width", () => {
    expect(halfWidthOf(-0.05, 0.1)).toBeCloseTo(0.075, 12);
  });
});

describe("asMeanWithCi", () => {
  it("carries the interval through unchanged and derives only the spread", () => {
    const stats = asMeanWithCi(input());
    expect(stats.mean).toBe(0.02);
    expect(stats.ciLow).toBe(-0.05);
    expect(stats.ciHigh).toBe(0.1);
    expect(stats.n).toBe(48);
    expect(stats.halfWidth).toBeCloseTo(0.075, 12);
    expect(stats.sd).toBeCloseTo(impliedSd(0.075, 48) ?? 0, 12);
  });

  /** A degenerate interval must not present as a zero-spread sample worth sizing. */
  it("passes sd 0 through so the shared sizing function declines to size it", () => {
    const stats = asMeanWithCi(input({ ciLow: 0.02, ciHigh: 0.02 }));
    expect(stats.sd).toBe(0);
    expect(queriesNeededForHalfWidth(stats, 0.04)).toBeNull();
  });
});

describe("sizeArm", () => {
  it("sizes against every target, in order", () => {
    const row = sizeArm(input());
    expect(row.needed).toHaveLength(SIZING_TARGETS.length);
    // A tighter target always costs more queries.
    const counts = row.needed.map((n) => n ?? 0);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });

  it("emits null rather than a number for an unsizeable arm", () => {
    expect(sizeArm(input({ ciLow: 0.02, ciHigh: 0.02 })).needed).toEqual(
      SIZING_TARGETS.map(() => null),
    );
  });
});

/**
 * #1184's first acceptance criterion, discharged in code: the query count a decisive
 * answer needs is COMPUTED from the committed #1183 intervals, never asserted beside
 * them. These expectations therefore pin the arithmetic, not a copied conclusion.
 */
/**
 * The provenance claim itself, checked against the artefact rather than trusted.
 *
 * `PRIOR_RUN_SIZING`'s docstring says its numbers are copied from a named committed JSON
 * file. The first version of it was hand-transcribed and every one of the eighteen values
 * was wrong at ~5e-5 — harmless for the ±0.04 counts, wrong by one query in a published
 * ±0.02 cell, and invisible to every test in the suite, because the rest of this file
 * asserts arithmetic OVER the constants and so cannot see a wrong input. Two of #1184's
 * three adversarial lenses found it independently.
 *
 * So the comparison is field by field against the file the docstring names. `toBe`, not
 * `toBeCloseTo`: "copied" is an exact claim, and a tolerance here would readmit exactly
 * the error this exists to catch.
 */
describe("PRIOR_RUN_SIZING is genuinely copied from the artefact it names", () => {
  // #1382 moved this out of `eval-results/`, which is now untracked nightly output.
  // It is a fixture: a test reads it on every run. See ../provenance/README.md.
  const ARTEFACT =
    "server/src/lib/eval/provenance/doc-retrieval-chunk-sweep-2026-07-31T20-37-55-374Z.json";

  it("matches the committed #1183 run's `all` intervals exactly, arm for arm", async () => {
    const { promises: fs } = await import("node:fs");
    const path = (await import("node:path")).default;
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const report = JSON.parse(await fs.readFile(path.join(repoRoot, ARTEFACT), "utf8")) as {
      comparisons: { armId: string; all: { paired: Record<string, number> } }[];
      overlapComparisons: { armId: string; all: { paired: Record<string, number> } }[];
    };
    const byArm = new Map(
      [...report.comparisons, ...report.overlapComparisons].map((c) => [c.armId, c.all.paired]),
    );
    // Every arm of the artefact is represented, and nothing else is.
    expect([...PRIOR_RUN_SIZING].map((i) => i.armId).sort()).toEqual([...byArm.keys()].sort());
    for (const row of PRIOR_RUN_SIZING) {
      const paired = byArm.get(row.armId);
      expect(paired, row.armId).toBeDefined();
      expect(row.subset, row.armId).toBe("all");
      expect(row.n, row.armId).toBe(paired?.n);
      expect(row.meanDelta, row.armId).toBe(paired?.meanDelta);
      expect(row.ciLow, row.armId).toBe(paired?.ciLow);
      expect(row.ciHigh, row.armId).toBe(paired?.ciHigh);
    }
  });

  it("agrees with the query count it declares those intervals were measured on", () => {
    for (const row of PRIOR_RUN_SIZING) expect(row.n, row.armId).toBe(PRIOR_RUN_QUERY_COUNT);
  });
});

describe("the sizing taken from the committed #1183 run", () => {
  const rows = PRIOR_RUN_SIZING.map((i) => sizeArm(i));
  const atFloor = (armId: string): number | null =>
    rows.find((r) => r.armId === armId)?.needed[SIZING_TARGETS.indexOf(MIN_IMPORTANT_DELTA)] ??
    null;

  it("puts every SIZE arm above the 48 queries that were available", () => {
    for (const armId of ["size-1024", "size-768", "size-3072"]) {
      expect(atFloor(armId), armId).toBeGreaterThan(PRIOR_RUN_QUERY_COUNT);
    }
  });

  /**
   * The contrast that decides the issue. The overlap arms resolved their own floor on
   * 48 queries — #1183 could say "null AT the floor" and mean it — while the size arms
   * carry half-widths WIDER than the floor itself, so their nulls were unresolved
   * rather than measured. That asymmetry is the entire argument for expanding the
   * corpus, and it is arithmetic, not judgement.
   */
  it("puts every OVERLAP arm at or below them, which is why #1183's null was readable", () => {
    for (const armId of ["overlap-2048-0", "overlap-2048-128", "overlap-2048-512"]) {
      expect(atFloor(armId), armId).toBeLessThanOrEqual(PRIOR_RUN_QUERY_COUNT);
    }
  });

  it("returns a GO at the pre-registered ceiling, bound by the widest arm", () => {
    const decision = corpusGoNoGo(rows);
    expect(decision.go).toBe(true);
    expect(decision.target).toBe(MIN_IMPORTANT_DELTA);
    expect(decision.ceiling).toBe(PRACTICAL_QUERY_CEILING);
    expect(decision.bindingArmId).toBe("size-768");
    expect(decision.queriesNeeded).toBe(atFloor("size-768"));
    // The binding arm is the WORST, not the mean of the arms.
    for (const row of rows) {
      expect(row.needed[0] ?? 0).toBeLessThanOrEqual(decision.queriesNeeded ?? 0);
    }
  });

  /**
   * The honest half of the answer: the corpus this issue can afford resolves the
   * DECISION floor and does not resolve ±0.02. Reporting only the GO would let a
   * reader hear "settled" where the run can only say "unproven below the floor".
   */
  it("records ±0.02 as out of reach at that ceiling", () => {
    const decision = corpusGoNoGo(rows);
    expect(decision.outOfReach.map((o) => o.target)).toContain(0.02);
    for (const o of decision.outOfReach) expect(o.queriesNeeded).toBeGreaterThan(decision.ceiling);
  });
});

describe("corpusGoNoGo", () => {
  const wide = sizeArm(input({ armId: "wide", ciLow: -0.3, ciHigh: 0.3 }));
  const narrow = sizeArm(input({ armId: "narrow", ciLow: -0.01, ciHigh: 0.01 }));

  it("says NO-GO when the binding arm exceeds the ceiling", () => {
    const decision = corpusGoNoGo([narrow, wide], { ceiling: 100 });
    expect(decision.go).toBe(false);
    expect(decision.bindingArmId).toBe("wide");
  });

  it("says GO when even the binding arm fits", () => {
    expect(corpusGoNoGo([narrow, wide], { ceiling: 100_000 }).go).toBe(true);
  });

  /** An arm that cannot be sized is skipped, never treated as costing nothing. */
  it("ignores unsizeable arms rather than letting them read as free", () => {
    const flat = sizeArm(input({ armId: "flat", ciLow: 0, ciHigh: 0 }));
    const decision = corpusGoNoGo([flat, narrow], { ceiling: 100_000 });
    expect(decision.bindingArmId).toBe("narrow");
  });

  it("reports no decision at all when nothing can be sized", () => {
    const flat = sizeArm(input({ armId: "flat", ciLow: 0, ciHigh: 0 }));
    const decision = corpusGoNoGo([flat]);
    expect(decision.queriesNeeded).toBeNull();
    expect(decision.bindingArmId).toBeNull();
    expect(decision.go).toBe(false);
  });

  it("declines to decide against a target it was not sized for", () => {
    const decision = corpusGoNoGo([narrow], { target: 0.017 });
    expect(decision.queriesNeeded).toBeNull();
    expect(decision.go).toBe(false);
  });
});

describe("renderCorpusSizing", () => {
  const render = (rows: readonly SizingInput[], ceiling?: number): string =>
    renderCorpusSizing(rows, {
      heading: "Sizing",
      preamble: "why",
      currentQueryCount: 48,
      ceiling,
    });

  it("prints one row per arm with the measured half-width beside the estimate", () => {
    const md = render(PRIOR_RUN_SIZING);
    for (const row of PRIOR_RUN_SIZING) expect(md).toContain(`\`${row.armId}\``);
    expect(md).toContain("measured ±hw");
    expect(md).toContain("implied sd");
  });

  it("states the verdict as GO with the binding arm and the multiplier", () => {
    const md = render(PRIOR_RUN_SIZING);
    expect(md).toContain("**GO**");
    expect(md).toContain("`size-768`");
    expect(md).toMatch(/\d+\.\dx|\d+\.\d×/);
  });

  it("states NO-GO when the ceiling is below the binding arm", () => {
    expect(render(PRIOR_RUN_SIZING, 10)).toContain("**NO-GO**");
  });

  /** "Unproven below the floor" is not "no effect", and the artefact must say so. */
  it("names the targets that stay out of reach and what they would cost", () => {
    const md = render(PRIOR_RUN_SIZING, 200);
    expect(md).toContain("Out of reach at that ceiling");
    expect(md).toContain("unproven below the floor");
  });

  it("omits the out-of-reach clause when every target fits", () => {
    const md = render(PRIOR_RUN_SIZING, 100_000);
    expect(md).not.toContain("Out of reach at that ceiling");
  });

  it("says so plainly when nothing can be sized", () => {
    const md = render([{ armId: "flat", subset: "all", n: 48, meanDelta: 0, ciLow: 0, ciHigh: 0 }]);
    expect(md).toContain("No arm carries a usable spread");
    expect(md).toContain("| — |");
  });
});
