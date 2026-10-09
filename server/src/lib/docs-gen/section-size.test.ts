/**
 * #741 — section and document length are bounded at topic and paragraph
 * boundaries, never mid-sentence, and the reader is told what was left out.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  DEFAULT_DOCUMENT_MAX_CHARS,
  DEFAULT_SECTION_MAX_CHARS,
  DOCUMENT_MAX_CHARS_KEY,
  MIN_SECTION_MAX_CHARS,
  SECTION_MAX_CHARS_KEY,
  batchWordBudget,
  fitSectionToBudget,
  fitSectionsToDocumentBudget,
  resolveDocumentMaxChars,
  resolveSectionMaxChars,
  sectionBudgetScale,
} from "./section-size.js";

const config = (values: Record<string, number>): ConfigService =>
  ({ getNumber: (key: string, d?: number) => values[key] ?? d }) as unknown as ConfigService;

/** A rules section: `topics` H3 topics, each with `paras` paragraphs of `words` words. */
function rulesSection(topics: number, paras = 3, words = 60): string {
  const parts = ["## Business Rules & Policies", "Rules the system enforces."];
  for (let t = 1; t <= topics; t++) {
    parts.push(`### Topic ${t}`);
    for (let p = 1; p <= paras; p++) {
      parts.push(
        `${Array.from({ length: words }, (_, i) => `word${i}`).join(" ")} [^src-${t}${p}]. Ends here.`,
      );
    }
  }
  return parts.join("\n\n");
}

describe("caps from the registry", () => {
  it("default to 60k per section and 250k per document", () => {
    expect(resolveSectionMaxChars(config({}))).toBe(DEFAULT_SECTION_MAX_CHARS);
    expect(DEFAULT_SECTION_MAX_CHARS).toBe(60_000);
    expect(resolveDocumentMaxChars(config({}))).toBe(DEFAULT_DOCUMENT_MAX_CHARS);
    expect(DEFAULT_DOCUMENT_MAX_CHARS).toBe(250_000);
  });

  it("read the configured values, never below the minimum", () => {
    expect(resolveSectionMaxChars(config({ [SECTION_MAX_CHARS_KEY]: 20_000 }))).toBe(20_000);
    expect(resolveSectionMaxChars(config({ [SECTION_MAX_CHARS_KEY]: 10 }))).toBe(
      MIN_SECTION_MAX_CHARS,
    );
    expect(resolveSectionMaxChars(config({ [SECTION_MAX_CHARS_KEY]: Number.NaN }))).toBe(
      DEFAULT_SECTION_MAX_CHARS,
    );
    expect(resolveDocumentMaxChars(config({ [DOCUMENT_MAX_CHARS_KEY]: 400_000 }))).toBe(400_000);
  });
});

describe("batch budgets", () => {
  it("scale a section's estimates only when it would exceed the cap", () => {
    expect(sectionBudgetScale(30_000, 60_000)).toBe(1);
    expect(sectionBudgetScale(1_200_000, 60_000)).toBeCloseTo(0.05);
    expect(sectionBudgetScale(0, 60_000)).toBe(1);
  });

  it("state a batch's budget in round words, never below 150", () => {
    expect(batchWordBudget(6_000)).toBe(1_000);
    expect(batchWordBudget(10)).toBe(150);
  });
});

describe("fitSectionToBudget", () => {
  it("returns a section within budget unchanged", () => {
    const md = rulesSection(2);
    expect(fitSectionToBudget(md, md.length)).toEqual({
      markdown: md,
      trimmed: false,
      omittedTopics: [],
      originalChars: md.length,
    });
  });

  it("keeps leading topics whole and names the ones it left out", () => {
    const md = rulesSection(40);
    const fit = fitSectionToBudget(md, 12_000);
    expect(fit.trimmed).toBe(true);
    expect(fit.markdown.length).toBeLessThanOrEqual(12_000);
    expect(fit.markdown.startsWith("## Business Rules & Policies\n\nRules the system")).toBe(true);
    expect(fit.omittedTopics.length).toBeGreaterThan(0);
    expect(fit.omittedTopics.at(-1)).toBe("Topic 40");
    expect(fit.markdown).toContain("**Shortened for length.**");
    expect(fit.markdown).toContain(`${fit.omittedTopics.length} further topics were left out`);
    expect(fit.markdown).toContain("; and ");
    // Every kept paragraph is whole: it still ends its last sentence.
    const body = fit.markdown.split("\n\n> **Shortened")[0];
    for (const para of body.split("\n\n").filter((p) => p.startsWith("word0"))) {
      expect(para.endsWith("Ends here.")).toBe(true);
    }
    // Never ends on a heading with nothing under it.
    expect(body.trimEnd().split("\n").at(-1)).not.toMatch(/^#/);
    // A kept topic is never also listed as omitted.
    for (const topic of fit.omittedTopics) expect(body).not.toContain(`### ${topic}\n`);
  });

  it("never splits a code fence, a math block or a table", () => {
    const fence = ["```mermaid", "graph TD", "", "A --> B", "```"].join("\n");
    const math = ["$$", "x = 1", "", "y = 2", "$$"].join("\n");
    const table = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const inline = "$$ z = 3 $$";
    const md = [
      "## Calculations",
      "Intro.",
      fence,
      math,
      inline,
      table,
      "### Later",
      "x".repeat(4_000),
    ].join("\n\n");
    const fit = fitSectionToBudget(md, 2_000);
    expect(fit.markdown).toContain(fence);
    expect(fit.markdown).toContain(math);
    expect(fit.markdown).toContain(inline);
    expect(fit.markdown).toContain(table);
    expect(fit.omittedTopics).toEqual(["Later"]);
    expect(fit.markdown).toContain("1 further topic was left out: Later.");
  });

  it("drops a fence whole rather than half of it", () => {
    const fence = ["~~~", ..."line\n".repeat(400).split("\n"), "~~~"].join("\n");
    const md = ["## Data Model", "Intro paragraph.", fence, "After."].join("\n\n");
    const fit = fitSectionToBudget(md, 1_500);
    expect(fit.markdown).toContain("Intro paragraph.");
    expect(fit.markdown).not.toContain("~~~");
    expect(fit.markdown).toContain("Its remaining detail was left out.");
  });

  it("keeps whole leading sentences when the first paragraph alone is over budget", () => {
    const sentence = "The rule applies to every feed. ";
    const md = `## Overview\n\n${sentence.repeat(200)}`;
    const fit = fitSectionToBudget(md, 2_000);
    expect(fit.markdown.startsWith("## Overview\n\nThe rule applies")).toBe(true);
    const lead = fit.markdown.split("\n\n")[1];
    expect(lead.endsWith("every feed.")).toBe(true);
    expect(fit.markdown.length).toBeLessThanOrEqual(2_000);
  });

  it.each([
    [
      "code fence",
      [
        "```ts",
        ...Array.from({ length: 200 }, (_, i) => `const a${i} = obj.read(); // step.`),
        "```",
      ],
    ],
    [
      "math block",
      ["$$", ...Array.from({ length: 200 }, (_, i) => `x_${i} = y. z_${i} = w.`), "$$"],
    ],
    [
      "table",
      [
        "| rule | note |",
        "|---|---|",
        ...Array.from({ length: 200 }, (_, i) => `| R${i}. | Applies. |`),
      ],
    ],
  ])(
    "#867 — never cuts inside a %s that is the first content and alone over budget",
    (_kind, lines) => {
      const block = lines.join("\n");
      const md = `## Overview\n\n${block}\n\n### Later\n\nMore.`;
      const fit = fitSectionToBudget(md, 2_000);
      // Cut before it: the heading, then the note — no half of the block.
      expect(fit.markdown.startsWith("## Overview\n\n> **Shortened for length.**")).toBe(true);
      expect(fit.markdown).not.toContain(lines[0]);
      expect(fit.markdown).not.toContain(lines[1]);
      expect(fit.markdown.length).toBeLessThanOrEqual(2_000);
    },
  );

  it("keeps only the heading when not even one sentence fits", () => {
    const md = `## Overview\n\n${"a".repeat(5_000)}`;
    const fit = fitSectionToBudget(md, 1_000);
    expect(fit.markdown.startsWith("## Overview\n\n> **Shortened for length.**")).toBe(true);
  });

  it("lists omitted H4 topics when no H3 was cut", () => {
    const md = [
      "## Rules",
      "### Only topic",
      "Intro.",
      ...Array.from({ length: 30 }, (_, i) => `#### Sub ${i}\n\n${"y ".repeat(200)}`),
    ].join("\n\n");
    const fit = fitSectionToBudget(md, 3_000);
    expect(fit.omittedTopics[0]).toMatch(/^Sub \d+$/);
    expect(fit.markdown).toContain("### Only topic");
  });
});

describe("fitSectionsToDocumentBudget", () => {
  it("leaves a document within budget alone", () => {
    const sections = ["## A\n\nx", "## B\n\ny"];
    expect(fitSectionsToDocumentBudget(sections, 1_000)).toEqual({
      sections,
      trimmed: 0,
      omittedTopics: [[], []],
    });
  });

  it("carries topics an earlier cap left out through a document within budget", () => {
    const fit = fitSectionsToDocumentBudget(["## A\n\nx", "## B\n\ny"], 1_000, [["Earlier"], []]);
    expect(fit.omittedTopics).toEqual([["Earlier"], []]);
  });

  // #995 — in #706 run 5 every section was held to ~38k (250k / sections) while
  // the document used only 186k of its 250k: a section whose next topic was too
  // big for its share left that share unused, and nothing else could take it.
  it("lets sections use what others leave unused (#995)", () => {
    // One section whose topics are each far bigger than any fair share, so it
    // can keep only its intro: its share is the slack the others should use.
    const coarse = [
      "## Data Model",
      "Entities the system stores.",
      `### Account\n\n${"a ".repeat(15_000)}`,
      `### Feed\n\n${"f ".repeat(15_000)}`,
    ].join("\n\n");
    const fine1 = rulesSection(80);
    const fine2 = rulesSection(80);
    const max = 60_000;
    const fit = fitSectionsToDocumentBudget([coarse, fine1, fine2], max);
    const total = fit.sections.reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(max);
    // A static third (20k) each would leave ~19k unused; the fine-grained
    // sections absorb it, to within a paragraph or two of the cap.
    expect(total).toBeGreaterThan(max - 2_000);
    expect(fit.sections[1].length).toBeGreaterThan(max / 3 + 5_000);
    expect(fit.sections[2].length).toBeGreaterThan(max / 3 + 5_000);
    // Fair between equals: neither fine section takes all the slack.
    expect(Math.abs(fit.sections[1].length - fit.sections[2].length)).toBeLessThan(2_000);
  });

  it("reports the topics each section left out, merged with an earlier cap's (#995)", () => {
    const small = "## Overview\n\nShort.";
    const earlier = fitSectionToBudget(rulesSection(60), 40_000);
    expect(earlier.trimmed).toBe(true);
    const fit = fitSectionsToDocumentBudget([small, earlier.markdown], 10_000, [
      ["Kept from before"],
      earlier.omittedTopics,
    ]);
    expect(fit.trimmed).toBe(1);
    expect(fit.omittedTopics[0]).toEqual(["Kept from before"]);
    expect(fit.omittedTopics[1][0]).toMatch(/^Topic \d+$/);
    expect(fit.omittedTopics[1]).toContain("Topic 60");
    expect(new Set(fit.omittedTopics[1]).size).toBe(fit.omittedTopics[1].length);
    // The earlier note is replaced, not kept as content beside a second one.
    expect(fit.sections[1].match(/Shortened for length/g)).toHaveLength(1);
  });

  it("never lets a closing note push a section past its budget (#995)", () => {
    // Long topic names make the note longer than the room once reserved for it.
    const parts = ["## Rules", "Intro paragraph."];
    for (let t = 0; t < 40; t++) {
      parts.push(`### ${"Long topic name ".repeat(5)}${t}`, "x ".repeat(100));
    }
    const fit = fitSectionToBudget(parts.join("\n\n"), 3_000);
    expect(fit.trimmed).toBe(true);
    expect(fit.markdown.length).toBeLessThanOrEqual(3_000);
  });

  it("shortens the longest sections first and fits the total", () => {
    const small = "## Overview\n\nShort.";
    const big1 = rulesSection(60);
    const big2 = rulesSection(30);
    const max = 20_000;
    const { sections, trimmed } = fitSectionsToDocumentBudget([small, big1, big2], max);
    expect(trimmed).toBe(2);
    expect(sections[0]).toBe(small);
    expect(sections.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(max);
    expect(sections[1]).toContain("**Shortened for length.**");
    expect(sections[2]).toContain("**Shortened for length.**");
  });
});
