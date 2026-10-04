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
    expect(fitSectionsToDocumentBudget(sections, 1_000)).toEqual({ sections, trimmed: 0 });
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
