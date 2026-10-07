/**
 * #778 — a section whose relevant facts exceed `factsCharCap` read only the
 * top-ranked handful of modules in full and dropped the rest to a name-only
 * catalog: Miniflux's architecture doc wrote every section from 3–14 of 103
 * modules (34–71% faithfulness).
 *
 * The fix spends the SAME budget differently instead of raising it: the
 * highest-ranked modules keep their full entry, and every module that does not
 * fit is read as a condensed digest (its slice headings and leading bullets),
 * sized so the whole selection still fits the cap. A module is omitted only
 * when even a minimal digest no longer fits.
 */
import { describe, expect, it } from "vitest";
import {
  buildRelevantFactsBlob,
  buildSectionFactsSources,
  sectionGroupsFor,
  selectRelevantFacts,
  summarizeFactsBudget,
  type ModuleFacts,
} from "./holistic-synthesizer.js";

const CAP = 150_000;
const group = sectionGroupsFor("architecture").find((g) => g.id === "components-and-data")!;

/** A module whose components-and-data entry is about `size` characters. */
function moduleFacts(i: number, size: number): ModuleFacts {
  const bullets = (tag: string, n: number) =>
    Array.from({ length: n }, (_, k) => `- ${tag} ${k} of module${i}: ${"detail ".repeat(8)}`).join(
      "\n",
    );
  const per = Math.max(1, Math.floor(size / 4 / 70));
  return {
    modulePath: `internal/module${i}`,
    moduleName: `module${i}`,
    classCount: 1,
    // Descending method counts give a stable, known relevance order.
    methodCount: 1000 - i,
    facts: [
      `PURPOSE\nModule ${i} handles part ${i} of the system.`,
      `ENTITIES\n${bullets("entity", per)}`,
      `KEY_APIS\n${bullets("api", per)}`,
      `INTEGRATIONS\n${bullets("integration", per)}`,
    ].join("\n\n"),
    formulas: [],
    topClasses: [`Class${i}`],
  };
}

/** Miniflux's shape: 103 modules, roughly 10× the cap in total. */
const miniflux = Array.from({ length: 103 }, (_, i) => moduleFacts(i, 14_000));

describe("facts digests for modules past the cap (#778)", () => {
  it("reads every one of 103 modules within the same 150k cap", () => {
    const blob = buildRelevantFactsBlob(miniflux, group, "architecture", CAP);
    for (let i = 0; i < 103; i++) expect(blob).toContain(`### MODULE: module${i}\n`);
    expect(blob).not.toContain("ADDITIONAL MODULES");
    // Same budget as before: the module entries never exceed the cap.
    const { included, entryOf } = selectRelevantFacts(miniflux, group, "architecture", CAP);
    const total = included.reduce((sum, f) => sum + entryOf(f).length, 0);
    expect(total).toBeLessThanOrEqual(CAP);
  });

  it("keeps the top-ranked modules in full and condenses the rest", () => {
    const { included, entryOf, condensed } = selectRelevantFacts(
      miniflux,
      group,
      "architecture",
      CAP,
    );
    const top = entryOf(included[0]);
    expect(top).toContain("entity");
    expect(top).not.toContain("condensed");
    expect(condensed.size).toBeGreaterThan(80);
    const digest = entryOf(miniflux[102]);
    expect(condensed.has(miniflux[102])).toBe(true);
    expect(digest).toContain("condensed");
    // A digest samples every slice the section reads, not only the first.
    expect(digest).toContain("- entity 0 of module102");
    expect(digest).toContain("- api 0 of module102");
    expect(digest).toContain("- integration 0 of module102");
  });

  it("reports condensed modules separately from omitted ones", () => {
    const budget = summarizeFactsBudget(miniflux, group, "architecture", CAP);
    expect(budget.omittedModules).toBe(0);
    expect(budget.exceeded).toBe(false);
    expect(budget.condensedModules).toBeGreaterThan(80);
    expect(budget.includedModules).toBe(103);
  });

  it("makes every digest citable with exactly the text the model read", () => {
    const blob = buildRelevantFactsBlob(miniflux, group, "architecture", CAP);
    const sources = buildSectionFactsSources(miniflux, group, "architecture", CAP);
    expect(sources).toHaveLength(103);
    for (const s of sources) expect(blob).toContain(s.text);
    expect(sources.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThanOrEqual(CAP);
  });

  it("leaves a selection that already fits unchanged — no digest", () => {
    const small = Array.from({ length: 5 }, (_, i) => moduleFacts(i, 2_000));
    const { included, condensed, omitted } = selectRelevantFacts(small, group, "architecture", CAP);
    expect(included).toHaveLength(5);
    expect(condensed.size).toBe(0);
    expect(omitted).toHaveLength(0);
  });

  it("still omits — and reports — modules when even a minimal digest cannot fit", () => {
    const tightCap = 4_000;
    const budget = summarizeFactsBudget(miniflux, group, "architecture", tightCap);
    expect(budget.exceeded).toBe(true);
    expect(budget.omittedModules).toBeGreaterThan(0);
    expect(budget.includedModules + budget.omittedModules).toBe(103);
    const blob = buildRelevantFactsBlob(miniflux, group, "architecture", tightCap);
    expect(blob).toContain(`ADDITIONAL MODULES`);
    const { included, entryOf } = selectRelevantFacts(miniflux, group, "architecture", tightCap);
    expect(included.reduce((sum, f) => sum + entryOf(f).length, 0)).toBeLessThanOrEqual(tightCap);
  });

  it("truncates a digest's single over-long line at a word boundary rather than dropping it", () => {
    const long: ModuleFacts = {
      ...moduleFacts(500, 100),
      facts: `PURPOSE\n${"word ".repeat(5_000)}`,
      methodCount: 0,
    };
    const many = [...miniflux, long];
    const { entryOf, condensed } = selectRelevantFacts(many, group, "architecture", CAP);
    expect(condensed.has(long)).toBe(true);
    const digest = entryOf(long);
    expect(digest).toContain("word word");
    expect(digest).toMatch(/word…/);
  });
});
