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
  BRD_MAIN_FLOOR_MARGIN,
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_MAX_OVERRUN,
  BRD_MAIN_MIN_CHARS,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_SUMMARY_SECTIONS,
  BRD_MAIN_TARGET_CHARS,
  fitReaderDocument,
  mainFitCap,
  mainSectionOverrun,
} from "./brd-layout.js";
import { splitClosingNote } from "./document-plan.js";
import { DEFAULT_LENGTH_OVERRUN_RULES } from "./length-calibration.js";
import { batchWordBudget, CHARS_PER_WORD } from "./section-size.js";

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

const MAIN_IDS = Object.keys(BRD_MAIN_SECTION_TARGETS);
const DEEPSEEK = DEFAULT_LENGTH_OVERRUN_RULES.find((r) => r.pattern === "deepseek")!.factor;
/** The words a main section's length note asks for, as `lengthLimitNote` computes them. */
const asked = (id: string, overrun: number): number =>
  batchWordBudget(BRD_MAIN_SECTION_TARGETS[id] / overrun);
/** The characters the main sections' notes ask for together, after each note's rounding. */
const askedChars = (overrun: number): number =>
  MAIN_IDS.reduce((n, id) => n + asked(id, overrun) * CHARS_PER_WORD, 0);

/** Each section of a run, rescaled from the ask it was given to another. */
const rescaled = (run: Record<string, number>, overrun: number): Record<string, number> =>
  Object.fromEntries(
    Object.entries(run).map(([id, chars]) => [
      id,
      Math.round((chars * asked(id, overrun)) / asked(id, DEEPSEEK)),
    ]),
  );
const total = (sizes: Record<string, number>): number =>
  Object.values(sizes).reduce((n, chars) => n + chars, 0);

/** A main section of about `chars` characters: H3 topics of paragraphs, as a model writes it. */
function writtenSection(id: string, chars: number): string {
  const paragraph = `The ${id} policy applies to every request the capability receives. `
    .repeat(4)
    .trim();
  const blocks = [`## ${id}`];
  let length = blocks[0].length;
  for (let t = 1; length < chars; t++) {
    const topic = `### ${id} topic ${t}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    blocks.push(topic);
    length += topic.length + 2;
  }
  return blocks.join("\n\n");
}

/** A main part with its sections at `sizes`, through the real reader-layout fit. */
function fitMain(sizes: Record<string, number>) {
  const sections = MAIN_IDS.map((id) => ({
    markdown: writtenSection(id, sizes[id]),
    budgetChars: BRD_MAIN_SECTION_TARGETS[id],
  }));
  const fit = fitReaderDocument(
    sections,
    MAIN_IDS.map(() => true),
    250_000,
    (markdown) => markdown.length,
    250_000,
    MAIN_IDS.map((id) => BRD_MAIN_SUMMARY_SECTIONS.has(id)),
  );
  return { sections, fit };
}

describe("the main sections' overrun correction", () => {
  it("is the model's factor, at most the main part's target over 5% above its floor", () => {
    expect(BRD_MAIN_FLOOR_MARGIN).toBe(1.05);
    expect(BRD_MAIN_MAX_OVERRUN).toBeCloseTo(BRD_MAIN_TARGET_CHARS / 42_000, 10);
    expect(mainSectionOverrun(DEEPSEEK)).toBe(BRD_MAIN_MAX_OVERRUN);
    expect(mainSectionOverrun(1.1)).toBe(1.1);
    expect(mainSectionOverrun(1)).toBe(1);
    expect(mainSectionOverrun(0.8)).toBe(0.8);
  });

  it("asks a model that keeps to its length for at least the floor, after each note's rounding", () => {
    expect(MAIN_IDS.map((id) => asked(id, mainSectionOverrun(DEEPSEEK)))).toEqual([
      1_150, 1_750, 1_750, 2_350,
    ]);
    expect(askedChars(mainSectionOverrun(DEEPSEEK))).toBe(42_000);
    expect(askedChars(mainSectionOverrun(DEEPSEEK))).toBeGreaterThanOrEqual(BRD_MAIN_MIN_CHARS);
    // Before #1427: 32,400 asked, 7,600 under the floor.
    expect(askedChars(DEEPSEEK)).toBe(32_400);
  });
});

describe("the measured DeepSeek runs, replayed at the main sections' ask", () => {
  it("reproduces the measured main parts at the ask they were given", () => {
    expect(total(rescaled(RUNS["2026-10-22"], DEEPSEEK))).toBe(48_669);
    expect(total(rescaled(RUNS["2026-10-23"], DEEPSEEK))).toBe(35_783);
    // The 2026-10-23 main part is the one under the floor (#1427).
    expect(total(rescaled(RUNS["2026-10-23"], DEEPSEEK))).toBeLessThan(BRD_MAIN_MIN_CHARS);
  });

  it("lands the 2026-10-23 run inside 40–60k at the new ask, under the fit's cap", () => {
    const sizes = rescaled(RUNS["2026-10-23"], mainSectionOverrun(DEEPSEEK));
    expect(total(sizes)).toBe(46_369);
    expect(total(sizes)).toBeGreaterThanOrEqual(BRD_MAIN_MIN_CHARS);
    expect(total(sizes)).toBeLessThan(mainFitCap(250_000));
  });

  it("writes the 2026-10-22 run past 60k at the new ask, and the real fit trims it to the cap", () => {
    const sizes = rescaled(RUNS["2026-10-22"], mainSectionOverrun(DEEPSEEK));
    expect(total(sizes)).toBe(63_137);
    const { fit } = fitMain(sizes);
    expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    expect(fit.mainChars).toBeGreaterThanOrEqual(BRD_MAIN_MAX_CHARS - 2_000);
  });
});

describe("a main part written at DeepSeek's highest measured overrun (1.64×) of its ask", () => {
  const ask = mainSectionOverrun(DEEPSEEK);
  const sizes = Object.fromEntries(
    MAIN_IDS.map((id) => [id, Math.round(asked(id, ask) * CHARS_PER_WORD * 1.64)]),
  );
  const { sections, fit } = fitMain(sizes);

  it("is written well past the cap, and fitted inside 40–60k", () => {
    expect(sections.reduce((n, s) => n + s.markdown.length, 0)).toBeGreaterThan(68_000);
    expect(fit.mainChars).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    expect(fit.mainChars).toBeGreaterThanOrEqual(BRD_MAIN_MIN_CHARS);
  });

  it("cuts the summary sections, whose detail is in the appendix, and keeps the others whole", () => {
    MAIN_IDS.forEach((id, i) => {
      const summary = BRD_MAIN_SUMMARY_SECTIONS.has(id);
      expect({ id, cut: fit.cuts[i] !== "whole" }).toEqual({ id, cut: summary });
      if (!summary) expect(fit.sections[i]).toBe(sections[i].markdown);
    });
  });

  it("cuts at a block boundary, says so in a closing note, and lists the topics it left out", () => {
    MAIN_IDS.forEach((id, i) => {
      if (!BRD_MAIN_SUMMARY_SECTIONS.has(id)) return;
      const { body, note } = splitClosingNote(fit.sections[i]);
      expect(note).not.toBeNull();
      // What is kept is the section as written, up to the end of a block.
      expect(body.length).toBeLessThan(sections[i].markdown.length);
      expect(sections[i].markdown.startsWith(body)).toBe(true);
      expect(sections[i].markdown.slice(body.length, body.length + 2)).toBe("\n\n");
      expect(fit.omittedTopics[i].length).toBeGreaterThan(0);
      for (const topic of fit.omittedTopics[i]) {
        expect(topic.startsWith(`${id} topic `)).toBe(true);
      }
    });
  });
});
