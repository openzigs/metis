/**
 * #1277 — DeepSeek caches a prompt automatically, but only a PREFIX that
 * matches from token 0. docs-gen section prompts therefore put what every
 * section of a document (and every batch of a section) sends byte for byte
 * first, and what one section or batch alone sends last. The content of the
 * prompt is unchanged; only its order is.
 */
import { describe, expect, it } from "vitest";
import {
  buildSectionPrompts,
  docsGenTuning,
  sectionGroupsFor,
  type SectionGroup,
} from "./holistic-synthesizer.js";

const META = {
  name: "Fixture",
  totalFiles: 143,
  totalSymbols: 5_000,
  language: "typescript",
} as never;
const TITLE = "Fixture BRD";
const FLOW = "orders -> billing -> ledger\nDATASET raw.orders -> work.billed";
const tuning = docsGenTuning("anthropic", "deepseek-flash");
const groups = sectionGroupsFor("business-requirements");
const byId = (id: string) => groups.find((g) => g.id === id)!;

const promptFor = (
  group: SectionGroup,
  part: { facts: string; formulas: string; grounding?: string; note?: string },
) =>
  buildSectionPrompts(
    group,
    META,
    TITLE,
    "business-requirements",
    part.facts,
    part.formulas,
    tuning,
    part.grounding ?? "",
    FLOW,
    part.note ?? "",
  );

/** The two prompts as the one token stream a prefix cache sees. */
const stream = (p: { systemMessage: string; userMessage: string }) =>
  `${p.systemMessage}\u0000${p.userMessage}`;

const commonPrefixLength = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

describe("docs-gen section prompts lead with the byte-stable shared context (#1277)", () => {
  it("every section's system prompt is byte-identical up to that section's own text", () => {
    const heads = groups.map((g) => {
      const { systemMessage } = promptFor(g, { facts: "f", formulas: "x" });
      return systemMessage.slice(0, systemMessage.indexOf(g.instructions));
    });
    const shared = heads.reduce((a, b) => a.slice(0, commonPrefixLength(a, b)));
    // The shared head is the whole writer brief, not a few characters of it.
    expect(shared.length).toBeGreaterThan(4_000);
    expect(shared).toContain("CRITICAL MANDATE");
    for (const g of groups) expect(shared).not.toContain(g.instructions);
  });

  it("puts the code-derived grounding discipline BEFORE the section's instructions", () => {
    // Shared by every code-derived section, so it belongs in the shared lead.
    const rules = promptFor(byId("rules"), { facts: "f", formulas: "x" }).systemMessage;
    const workflows = promptFor(byId("workflows"), { facts: "f", formulas: "x" }).systemMessage;
    const discipline = rules.indexOf("GROUNDING DISCIPLINE");
    expect(discipline).toBeGreaterThan(0);
    expect(discipline).toBeLessThan(rules.indexOf(byId("rules").instructions));
    // ...and two code-derived sections share it: their prefix runs through it.
    expect(commonPrefixLength(rules, workflows)).toBeGreaterThan(
      discipline + "GROUNDING DISCIPLINE".length + 1_000,
    );
  });

  it("the batches of one section share the system prompt and the document context, flow included", () => {
    const rules = byId("rules");
    const a = promptFor(rules, {
      facts: "### MODULE: orders\nfacts A",
      formulas: "total = a + b",
      grounding: "=== GROUNDING A ===",
      note: "Part 1 of 2",
    });
    const b = promptFor(rules, {
      facts: "### MODULE: billing\nfacts B",
      formulas: "fee = c * d",
      grounding: "=== GROUNDING B ===",
      note: "Part 2 of 2",
    });
    expect(b.systemMessage).toBe(a.systemMessage);
    const shared = stream(a).slice(0, commonPrefixLength(stream(a), stream(b)));
    // Document-level context first: the project, the title and the flow graph.
    expect(shared).toContain(`Project: **Fixture**`);
    expect(shared).toContain(FLOW);
    expect(shared).toContain("=== END FLOW ===");
    expect(shared).toContain(`Section group: **${rules.label}**`);
    // Per-batch content last.
    for (const own of ["facts A", "total = a + b", "GROUNDING A", "Part 1 of 2"]) {
      expect(shared).not.toContain(own);
      expect(a.userMessage).toContain(own);
    }
  });

  it("the user turn of two different sections is byte-identical up to the section label", () => {
    const user = (id: string) =>
      promptFor(byId(id), { facts: `${id} facts`, formulas: "x" }).userMessage;
    const overview = user("overview");
    const rules = user("rules");
    const lead = overview.slice(0, overview.indexOf("Section group: **"));
    expect(rules.startsWith(lead)).toBe(true);
    expect(lead).toContain(FLOW);
  });

  it("keeps every block of the prompt exactly once — only the order changed", () => {
    const rules = byId("rules");
    const { systemMessage, userMessage } = promptFor(rules, {
      facts: "FACTS-BLOCK",
      formulas: "FORMULAS-BLOCK",
      grounding: "GROUNDING-BLOCK",
      note: "NOTE-BLOCK",
    });
    const all = `${systemMessage}\n${userMessage}`;
    const once = (s: string) => all.split(s).length - 1;
    for (const block of [
      "GROUNDING DISCIPLINE",
      rules.instructions,
      "SECTION GROUP TO PRODUCE:",
      "FACTS-BLOCK",
      "FORMULAS-BLOCK",
      "GROUNDING-BLOCK",
      "NOTE-BLOCK",
      "=== END-TO-END FLOW",
      FLOW,
      `Section group: **${rules.label}**`,
      "Write the markdown for the",
    ]) {
      expect(once(block)).toBe(1);
    }
  });
});
