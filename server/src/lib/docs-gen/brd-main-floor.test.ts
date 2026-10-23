/**
 * #1427 — the reader layout's main part asked for at least its 40k floor.
 *
 * Replays the two DeepSeek (`deepseek-flash`) reader-BRD runs of the Miniflux
 * walkthrough offline, from the rendered length of each main section as stored
 * (dev database, read-only): 2026-10-22 (`cmvjbjldd000gqk9kr1bc5ah4`, 48,880
 * characters of main part) and 2026-10-23 (`cmvkwly7c008axc9kc0esbzy3`,
 * 35,996). Both runs' main sections were told the same length, their target
 * divided by DeepSeek's 1.5; what differed is how far the model wrote past
 * it. The replay assumes a run writes each section at the same ratio to the
 * words it is asked, and moves only the ask. Pure: no model, no database.
 */
import { describe, expect, it } from "vitest";
import {
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_MAX_OVERRUN,
  BRD_MAIN_MIN_CHARS,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_TARGET_CHARS,
  mainFitCap,
  mainSectionOverrun,
} from "./brd-layout.js";
import { DEFAULT_LENGTH_OVERRUN_RULES } from "./length-calibration.js";
import { batchWordBudget } from "./section-size.js";

/** Rendered characters of each main section (from its `##` heading to the next section's). */
const RUNS: Record<string, Record<string, number>> = {
  // Executive Summary 1,661 + Scope 3,268 + Business Domain Overview 2,428.
  "2026-10-22": {
    overview: 7_357,
    capabilities: 11_145,
    "key-rules": 10_292,
    requirements: 19_875,
  },
  // Executive Summary 1,548 + Scope 2,981 + Business Domain Overview 1,855.
  "2026-10-23": { overview: 6_384, capabilities: 8_288, "key-rules": 10_065, requirements: 11_046 },
};

const DEEPSEEK = DEFAULT_LENGTH_OVERRUN_RULES.find((r) => r.pattern === "deepseek")!.factor;
const asked = (id: string, overrun: number): number =>
  batchWordBudget(BRD_MAIN_SECTION_TARGETS[id] / overrun);

/** The main part a run would have written at another ask, fitted to the default body's cap. */
function replay(run: Record<string, number>, overrun: number): { written: number; kept: number } {
  const written = Object.entries(run).reduce(
    (n, [id, chars]) => n + Math.round((chars * asked(id, overrun)) / asked(id, DEEPSEEK)),
    0,
  );
  return { written, kept: Math.min(written, mainFitCap(250_000)) };
}

describe("the main sections' overrun correction", () => {
  it("is the model's factor, at most the main part's target over its floor", () => {
    expect(BRD_MAIN_MAX_OVERRUN).toBe(BRD_MAIN_TARGET_CHARS / BRD_MAIN_MIN_CHARS);
    expect(mainSectionOverrun(DEEPSEEK)).toBe(BRD_MAIN_MAX_OVERRUN);
    expect(mainSectionOverrun(1.1)).toBe(1.1);
    expect(mainSectionOverrun(1)).toBe(1);
    expect(mainSectionOverrun(0.8)).toBe(0.8);
  });

  it("asks a model that keeps to its length for the floor, and lands DeepSeek's overrun on the top", () => {
    const words = (overrun: number) =>
      Object.keys(BRD_MAIN_SECTION_TARGETS).reduce((n, id) => n + asked(id, overrun), 0);
    // 6 characters a word (`CHARS_PER_WORD`); each note is rounded to 50 words.
    const rounding = Object.keys(BRD_MAIN_SECTION_TARGETS).length * 25 * 6;
    expect(words(mainSectionOverrun(DEEPSEEK)) * 6).toBeGreaterThanOrEqual(
      BRD_MAIN_MIN_CHARS - rounding,
    );
    expect(words(mainSectionOverrun(DEEPSEEK)) * 6 * DEEPSEEK).toBeLessThanOrEqual(
      BRD_MAIN_MAX_CHARS + rounding,
    );
    // Before #1427: 32k asked, 8k under the floor.
    expect(words(DEEPSEEK) * 6).toBeLessThan(BRD_MAIN_MIN_CHARS - 7_000);
  });
});

describe("the measured DeepSeek runs, replayed at the main sections' ask", () => {
  it("reproduces the measured main parts at the ask they were given", () => {
    expect(replay(RUNS["2026-10-22"], DEEPSEEK).written).toBe(48_669);
    expect(replay(RUNS["2026-10-23"], DEEPSEEK).written).toBe(35_783);
    // The 2026-10-23 main part is the one under the floor (#1427).
    expect(replay(RUNS["2026-10-23"], DEEPSEEK).kept).toBeLessThan(BRD_MAIN_MIN_CHARS);
  });

  it.each(Object.keys(RUNS))("lands the %s run inside 40–60k at the new ask", (run) => {
    const { kept } = replay(RUNS[run], mainSectionOverrun(DEEPSEEK));
    expect(kept).toBeGreaterThanOrEqual(BRD_MAIN_MIN_CHARS);
    expect(kept).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
  });

  it("would have run the 2026-10-22 run only just under the fit's cap: the high side is cut at assembly", () => {
    const { written, kept } = replay(RUNS["2026-10-22"], mainSectionOverrun(DEEPSEEK));
    expect(written).toBeGreaterThan(55_000);
    expect(kept).toBe(Math.min(written, BRD_MAIN_MAX_CHARS));
  });
});
