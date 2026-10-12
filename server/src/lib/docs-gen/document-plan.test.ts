/**
 * #1070 — the topic plan: the document budget is shared among sections and
 * topics before anything is written, topics that cannot fit are dropped by
 * priority and named, and a written document that is over a cap is cut in
 * plan order — never keeping less than it would have kept without a plan.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  MIN_TOPIC_CHARS,
  SINGLE_CALL_SECTION_CHARS,
  TOPIC_PLAN_KEY,
  allocateTopicBudgets,
  decodePartRuns,
  droppedTopicLabel,
  encodePartRuns,
  fitDocumentToPlan,
  fitSectionToPlan,
  keptContentChars,
  planDocument,
  planOrderedFit,
  plannedOmissionNote,
  readTopicPlanSetting,
  splitClosingNote,
  summarizeDocumentPlan,
  topicPlanEnabled,
  waterFill,
  type PlanFitSection,
  type SectionDemand,
  type TopicCandidate,
} from "./document-plan.js";
import { mergeBatchBlocks, mergeBatchSections } from "./section-batching.js";
import { fitSectionToBudget, fitSectionsToDocumentBudget, units } from "./section-size.js";

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

/** A deterministic pseudo-random generator, so a failing case can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const topic = (id: string, priority: number, estimatedChars: number): TopicCandidate => ({
  id,
  title: `Topic ${id}`,
  priority,
  estimatedChars,
});

const enumerative = (sectionId: string, topics: TopicCandidate[]): SectionDemand => ({
  sectionId,
  label: sectionId.toUpperCase(),
  kind: "enumerative",
  topics,
});
const single = (sectionId: string): SectionDemand => ({
  sectionId,
  label: sectionId.toUpperCase(),
  kind: "single",
  topics: [],
});

describe("DOCS_GEN_TOPIC_PLAN", () => {
  const config = (value?: string): ConfigService =>
    ({ get: (key: string) => (key === TOPIC_PLAN_KEY ? value : undefined) }) as ConfigService;

  it("is off unless switched on", () => {
    expect(topicPlanEnabled(config())).toBe(false);
    expect(readTopicPlanSetting(config())).toEqual({ enabled: false });
    for (const on of ["on", "ON", " on "]) expect(topicPlanEnabled(config(on))).toBe(true);
    for (const off of ["off", "OFF", " off ", ""]) {
      expect(readTopicPlanSetting(config(off))).toEqual({ enabled: false });
    }
  });

  it("is turned on by the documented value only: anything else is off, and reported", () => {
    for (const other of ["1", "true", "yes", "enabled", "onn", "0", "false", "no"]) {
      expect(readTopicPlanSetting(config(other))).toEqual({ enabled: false, unrecognised: other });
    }
  });
});

describe("waterFill", () => {
  it("meets the small asks in full and levels the rest", () => {
    expect(waterFill([10, 100, 100], 110)).toEqual([10, 50, 50]);
    expect(waterFill([100, 10, 100], 110)).toEqual([50, 10, 50]);
  });

  it("gives every ask when there is room, and nothing from nothing", () => {
    expect(waterFill([10, 20, 30], 1_000)).toEqual([10, 20, 30]);
    expect(waterFill([10, 20], 0)).toEqual([0, 0]);
    expect(waterFill([], 50)).toEqual([]);
  });

  it("never gives more than the total or more than an ask (property)", () => {
    const next = rng(1070);
    for (let run = 0; run < 300; run++) {
      const asks = Array.from({ length: 1 + Math.floor(next() * 8) }, () =>
        Math.floor(next() * 5_000),
      );
      const total = Math.floor(next() * 12_000);
      const shares = waterFill(asks, total);
      expect(sum(shares)).toBeLessThanOrEqual(total);
      shares.forEach((share, i) => expect(share).toBeLessThanOrEqual(asks[i]));
      // Nothing is held back while an ask is unmet (whole-number rounding aside).
      if (sum(asks) >= total) expect(total - sum(shares)).toBeLessThan(asks.length);
      else expect(shares).toEqual(asks);
    }
  });
});

describe("allocateTopicBudgets", () => {
  it("gives every topic its floor and shares the rest by estimate", () => {
    const { kept, dropped } = allocateTopicBudgets(
      [topic("a", 3, 10_000), topic("b", 2, 5_000), topic("c", 1, 1_000)],
      3_000,
    );
    expect(dropped).toEqual([]);
    expect(sum(kept.map((t) => t.budgetChars))).toBe(3_000);
    for (const t of kept) expect(t.budgetChars).toBeGreaterThanOrEqual(MIN_TOPIC_CHARS);
    const [a, b, c] = kept.map((t) => t.budgetChars);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("gives a topic no more than it is estimated to need", () => {
    const { kept } = allocateTopicBudgets([topic("a", 2, 400), topic("b", 1, 90)], 10_000);
    expect(kept.map((t) => t.budgetChars)).toEqual([400, 90]);
  });

  it("drops the LOWEST-PRIORITY topics when even the floors do not fit, and names them", () => {
    // One fixture past the floor: ten topics, room for four floors.
    const topics = Array.from({ length: 10 }, (_, i) => topic(`t${i}`, i, 2_000));
    const { kept, dropped } = allocateTopicBudgets(topics, MIN_TOPIC_CHARS * 4 + 20);
    expect(kept.map((t) => t.id)).toEqual(["t9", "t8", "t7", "t6"]);
    expect(dropped.map((t) => t.id)).toEqual(["t5", "t4", "t3", "t2", "t1", "t0"]);
    expect(sum(kept.map((t) => t.budgetChars))).toBe(MIN_TOPIC_CHARS * 4 + 20);
    // Every topic is accounted for: kept with a budget, or dropped by name.
    expect(kept.length + dropped.length).toBe(topics.length);
  });

  it("#1119 — breaks a tie in priority by id, by code unit: the same on every machine", () => {
    // ICU collation would put `rules/alpha` before `rules/Zeta`.
    const tied = ["rules/alpha", "rules/Zeta", "rules/beta"].map((id) => topic(id, 5, 2_000));
    const expected = { kept: ["rules/Zeta", "rules/alpha"], dropped: ["rules/beta"] };
    for (const topics of [tied, [...tied].reverse()]) {
      const { kept, dropped } = allocateTopicBudgets(topics, MIN_TOPIC_CHARS * 2 + 10);
      expect({ kept: kept.map((t) => t.id), dropped: dropped.map((t) => t.id) }).toEqual(expected);
    }
  });

  it("drops by priority, not by size or by input order", () => {
    const big = topic("big", 1, 90_000);
    const small = topic("small", 9, 200);
    const forward = allocateTopicBudgets([big, small], MIN_TOPIC_CHARS);
    const reversed = allocateTopicBudgets([small, big], MIN_TOPIC_CHARS);
    expect(forward.kept.map((t) => t.id)).toEqual(["small"]);
    expect(forward.dropped.map((t) => t.id)).toEqual(["big"]);
    expect(reversed).toEqual(forward);
  });

  it("drops everything from a budget of nothing", () => {
    const { kept, dropped } = allocateTopicBudgets([topic("a", 1, 500)], 0);
    expect(kept).toEqual([]);
    expect(dropped.map((t) => t.id)).toEqual(["a"]);
  });

  it("keeps its invariants over random topics (property)", () => {
    const next = rng(42);
    for (let run = 0; run < 400; run++) {
      const topics = Array.from({ length: Math.floor(next() * 40) }, (_, i) =>
        topic(`t${i}`, Math.floor(next() * 10), Math.floor(next() * 4_000)),
      );
      const budget = Math.floor(next() * 20_000);
      const { kept, dropped } = allocateTopicBudgets(topics, budget);
      const total = sum(kept.map((t) => t.budgetChars));
      expect(total).toBeLessThanOrEqual(budget);
      expect(kept.length + dropped.length).toBe(topics.length);
      for (const t of kept) {
        const need = Math.max(1, t.estimatedChars);
        expect(t.budgetChars).toBeLessThanOrEqual(need);
        expect(t.budgetChars).toBeGreaterThanOrEqual(Math.min(need, MIN_TOPIC_CHARS));
      }
      // No kept topic ranks below a dropped one.
      const lowestKept = Math.min(...kept.map((t) => t.priority), Number.POSITIVE_INFINITY);
      for (const t of dropped) expect(t.priority).toBeLessThanOrEqual(lowestKept);
      // The budget is used whenever the kept topics could use it.
      if (sum(kept.map((t) => Math.max(1, t.estimatedChars))) >= budget && dropped.length === 0) {
        expect(total).toBe(budget);
      }
    }
  });
});

describe("planDocument", () => {
  it("lets a single-call section ask for more than the default, up to the section cap", () => {
    const plan = planDocument({
      sections: [{ ...single("rules"), askChars: 90_000 }, single("overview")],
      documentMaxChars: 250_000,
      sectionMaxChars: 60_000,
    });
    expect(plan.sections.map((s) => [s.demandChars, s.budgetChars])).toEqual([
      [60_000, 60_000],
      [SINGLE_CALL_SECTION_CHARS, SINGLE_CALL_SECTION_CHARS],
    ]);
  });

  const sections = (): SectionDemand[] => [
    single("overview"),
    enumerative(
      "rules",
      Array.from({ length: 30 }, (_, i) => topic(`rules/m${i}`, 30 - i, 4_000 + i * 100)),
    ),
    enumerative(
      "formulas",
      Array.from({ length: 5 }, (_, i) => topic(`formulas/m${i}`, 5 - i, 600)),
    ),
  ];

  it("gives every topic one owning section and a budget; the budgets sum to the document's", () => {
    const plan = planDocument({
      sections: sections(),
      documentMaxChars: 60_000,
      sectionMaxChars: 40_000,
      reservedChars: 2_000,
    });
    expect(plan.budgetChars).toBe(58_000);
    const topics = plan.sections.flatMap((s) => s.topics);
    // Each topic appears once, under the section that submitted it.
    expect(new Set(topics.map((t) => t.id)).size).toBe(topics.length);
    for (const s of plan.sections) {
      for (const t of s.topics) expect(t.sectionId).toBe(s.sectionId);
      expect(s.budgetChars).toBe(sum(s.topics.map((t) => t.budgetChars)));
    }
    expect(sum(topics.map((t) => t.budgetChars)) + plan.unallocatedChars).toBe(58_000);
    // Formulas asked for 3,000 and keeps it; the single section its 24,000;
    // Rules, which asked for more than is left, takes the rest.
    const by = Object.fromEntries(plan.sections.map((s) => [s.sectionId, s.budgetChars]));
    expect(by.formulas).toBe(3_000);
    expect(by.overview).toBe(SINGLE_CALL_SECTION_CHARS);
    expect(by.rules).toBe(58_000 - 3_000 - SINGLE_CALL_SECTION_CHARS);
    expect(plan.unallocatedChars).toBe(0);
  });

  it("plans a single-call section as one topic", () => {
    const plan = planDocument({
      sections: [single("overview")],
      documentMaxChars: 100_000,
      sectionMaxChars: 60_000,
    });
    expect(plan.sections[0].topics).toEqual([
      expect.objectContaining({ id: "overview", sectionId: "overview", budgetChars: 24_000 }),
    ]);
    expect(plan.unallocatedChars).toBe(76_000);
  });

  it("never plans a section past the per-section cap", () => {
    const plan = planDocument({
      sections: [enumerative("rules", [topic("rules/a", 1, 500_000)])],
      documentMaxChars: 250_000,
      sectionMaxChars: 60_000,
    });
    expect(plan.sections[0].demandChars).toBe(60_000);
    expect(plan.sections[0].budgetChars).toBe(60_000);
    expect(plan.unallocatedChars).toBe(190_000);
  });

  it("lists the topics it leaves out, by section, lowest priority last kept", () => {
    const plan = planDocument({
      sections: [
        enumerative(
          "rules",
          Array.from({ length: 50 }, (_, i) => topic(`rules/m${i}`, 50 - i, 3_000)),
        ),
      ],
      documentMaxChars: MIN_TOPIC_CHARS * 20,
      sectionMaxChars: 60_000,
    });
    const [rules] = plan.sections;
    expect(rules.topics).toHaveLength(20);
    expect(rules.dropped).toHaveLength(30);
    expect(rules.dropped[0]).toEqual(
      expect.objectContaining({ id: "rules/m20", sectionId: "rules" }),
    );
    expect(summarizeDocumentPlan(plan)).toEqual([
      {
        sectionId: "rules",
        kind: "enumerative",
        demandChars: 60_000,
        budgetChars: MIN_TOPIC_CHARS * 20,
        topics: 20,
        dropped: 30,
      },
    ]);
    expect(droppedTopicLabel(rules.dropped[0])).toBe("Topic rules/m20 (not planned)");
  });

  it("leaves a topic two sections submit with the first: one owner", () => {
    const plan = planDocument({
      sections: [
        enumerative("rules", [topic("shared", 1, 1_000)]),
        enumerative("formulas", [topic("shared", 1, 1_000), topic("own", 1, 1_000)]),
      ],
      documentMaxChars: 100_000,
      sectionMaxChars: 60_000,
    });
    expect(plan.sections[0].topics.map((t) => t.id)).toEqual(["shared"]);
    expect(plan.sections[1].topics.map((t) => t.id)).toEqual(["own"]);
  });

  it("plans nothing from a budget the reserve uses up", () => {
    const plan = planDocument({
      sections: [single("overview")],
      documentMaxChars: 1_000,
      sectionMaxChars: 60_000,
      reservedChars: 5_000,
    });
    expect(plan.budgetChars).toBe(0);
    expect(plan.sections[0].topics).toEqual([]);
    expect(plan.sections[0].dropped.map((t) => t.id)).toEqual(["overview"]);
  });
});

// ── Fitting a written document in plan order ──────────────────────────────

const PARAGRAPH = (tag: string, words = 40): string => `${tag} ${"word ".repeat(words)}`.trim();

/**
 * A section written in `parts`: each part a run of `### topics`, each topic a
 * few paragraphs. Returns the merged markdown with every unit attributed.
 */
function partsSection(
  name: string,
  parts: Array<{ topics: number; paragraphs: number; words?: number; budget: number }>,
): PlanFitSection {
  const blocks = [`## ${name}`];
  const partOf = [0];
  parts.forEach((part, p) => {
    for (let t = 0; t < part.topics; t++) {
      blocks.push("---", `### ${name} part ${p} topic ${t}`);
      partOf.push(p, p);
      for (let k = 0; k < part.paragraphs; k++) {
        blocks.push(PARAGRAPH(`${name}.${p}.${t}.${k}`, part.words));
        partOf.push(p);
      }
    }
  });
  return {
    markdown: blocks.join("\n\n"),
    budgetChars: sum(parts.map((p) => p.budget)),
    parts: { budgets: parts.map((p) => p.budget), partOf },
  };
}

/** A section written in one call. */
const plainSection = (name: string, paragraphs: number, budgetChars: number): PlanFitSection => ({
  markdown: [
    `## ${name}`,
    ...Array.from({ length: paragraphs }, (_, k) => PARAGRAPH(`${name}.${k}`)),
  ].join("\n\n"),
  budgetChars,
});

/** How many paragraphs of part `p` of section `name` are in `markdown`. */
const paragraphsOf = (markdown: string, name: string, p: number): number =>
  markdown.split("\n\n").filter((u) => u.startsWith(`${name}.${p}.`)).length;

const totalLength = (sections: readonly string[]): number => sum(sections.map((s) => s.length));
const keptOf = (sections: readonly string[]): number =>
  sum(sections.map((s) => keptContentChars(s, (m) => m.length)));

describe("fitDocumentToPlan", () => {
  it("returns a document that fits unchanged, however far its parts ran past their budgets", () => {
    // Budgets of 100 characters for parts of thousands: a budget is a target.
    const sections = [
      partsSection("Rules", [
        { topics: 3, paragraphs: 3, budget: 100 },
        { topics: 3, paragraphs: 3, budget: 100 },
      ]),
      plainSection("Overview", 4, 100),
    ];
    const fit = fitDocumentToPlan(sections, totalLength(sections.map((s) => s.markdown)));
    expect(fit.mode).toBe("whole");
    expect(fit.trimmed).toBe(0);
    expect(fit.sections).toEqual(sections.map((s) => s.markdown));
    expect(fit.parts[0]).toEqual(sections[0].parts);
    expect(fit.omittedTopics).toEqual([[], []]);
  });

  it("cuts each part at ITS tail: every part keeps its leading topic, where a tail cut loses whole parts", () => {
    const section = partsSection(
      "Rules",
      Array.from({ length: 4 }, () => ({ topics: 3, paragraphs: 3, budget: 1_000 })),
    );
    const cap = Math.floor(section.markdown.length / 2);
    const fit = fitDocumentToPlan([section], cap);
    expect(fit.mode).toBe("plan");
    const [kept] = fit.sections;
    expect(kept.length).toBeLessThanOrEqual(cap);
    for (let p = 0; p < 4; p++) expect(kept).toContain(`### Rules part ${p} topic 0`);
    // What is gone is the END of each part.
    for (let p = 0; p < 4; p++) expect(kept).not.toContain(`### Rules part ${p} topic 2`);
    // The cut without a plan keeps the first two parts and none of the last.
    const tail = fitSectionsToDocumentBudget([section.markdown], cap).sections[0];
    expect(tail).toContain("### Rules part 0 topic 2");
    expect(tail).not.toContain("### Rules part 3 topic 0");
    expect(kept).toContain("**Shortened for length.**");
    expect(fit.omittedTopics[0]).toContain("Rules part 3 topic 2");
  });

  it("fills each part in proportion to ITS budget, not equally", () => {
    // Two parts with the same text; the first was planned three times the second.
    const section = partsSection("Rules", [
      { topics: 1, paragraphs: 24, budget: 3_000 },
      { topics: 1, paragraphs: 24, budget: 1_000 },
    ]);
    const fit = fitDocumentToPlan([section], Math.floor(section.markdown.length / 2));
    expect(fit.mode).toBe("plan");
    const first = paragraphsOf(fit.sections[0], "Rules", 0);
    const second = paragraphsOf(fit.sections[0], "Rules", 1);
    expect(first + second).toBeGreaterThanOrEqual(22);
    expect(first / second).toBeGreaterThan(2.5);
    expect(first / second).toBeLessThan(3.5);
    // Budgets the other way round, the same text: the shares swap.
    const swapped = fitDocumentToPlan(
      [{ ...section, parts: { ...section.parts!, budgets: [1_000, 3_000] } }],
      Math.floor(section.markdown.length / 2),
    );
    expect(paragraphsOf(swapped.sections[0], "Rules", 1)).toBe(first);
  });

  it("gives an overrunning section the room a LATER section left unused", () => {
    // Rules was written three times its budget; the two sections after it at
    // a third of theirs. The document is over its cap by Rules' overrun alone.
    const rules = partsSection(
      "Rules",
      Array.from({ length: 3 }, () => ({ topics: 4, paragraphs: 4, budget: 1_100 })),
    );
    const later = [plainSection("Workflows", 4, 3_300), plainSection("Glossary", 4, 3_300)];
    const sections = [rules, ...later];
    const cap = 9_900;
    expect(rules.markdown.length).toBeGreaterThan(3 * rules.budgetChars);
    const fit = fitDocumentToPlan(sections, cap);
    expect(fit.mode).toBe("plan");
    expect(fit.sections.slice(1)).toEqual(later.map((s) => s.markdown));
    // Rules is held to the document cap, not to its budget: it takes all the
    // room the later sections left, to within one paragraph.
    const room = cap - totalLength(later.map((s) => s.markdown));
    expect(fit.sections[0].length).toBeGreaterThan(rules.budgetChars * 1.5);
    expect(fit.sections[0].length).toBeGreaterThan(room - 260);
    expect(totalLength(fit.sections)).toBeLessThanOrEqual(cap);
  });

  it("leaves whole the sections the cut without a plan leaves whole", () => {
    const sections = [
      plainSection("Overview", 3, 10),
      partsSection(
        "Rules",
        Array.from({ length: 3 }, () => ({ topics: 3, paragraphs: 3, budget: 5_000 })),
      ),
    ];
    const fit = fitDocumentToPlan(sections, 5_000);
    // Overview's budget is a thousandth of Rules', and it is still not cut.
    expect(fit.sections[0]).toBe(sections[0].markdown);
    expect(fit.cuts).toEqual(["whole", "plan"]);
    expect(fit.trimmed).toBe(1);
  });

  it("keeps a heading exactly when something under it is kept, whoever wrote it", () => {
    // Part 1 adds an entry under the topic part 0 opened; part 0's own entries
    // are cut before it. The heading stays for part 1's entry.
    const markdown = [
      "## Rules",
      "### Shared topic",
      PARAGRAPH("first.0", 60),
      PARAGRAPH("first.1", 60),
      PARAGRAPH("first.2", 60),
      PARAGRAPH("second.0", 20),
      "---",
      "### Only the first part's",
      PARAGRAPH("first.3", 60),
    ].join("\n\n");
    const section: PlanFitSection = {
      markdown,
      budgetChars: 2_000,
      parts: { budgets: [1_000, 1_000], partOf: [0, 0, 0, 0, 0, 1, 0, 0, 0] },
    };
    const fit = fitDocumentToPlan([section], 1_150);
    expect(fit.mode).toBe("plan");
    const [kept] = fit.sections;
    expect(kept.length).toBeLessThanOrEqual(1_150);
    expect(kept).toContain("### Shared topic");
    expect(kept).toContain("first.0");
    expect(kept).toContain("second.0");
    expect(kept).not.toContain("first.3");
    // A heading (and the rule before it) with nothing kept under it is gone, and listed.
    expect(kept).not.toContain("### Only the first part's");
    expect(kept).not.toContain("---");
    expect(fit.omittedTopics[0]).toEqual(["Only the first part's"]);
    // What was kept is attributed as it was.
    const keptUnits = units(splitClosingNote(kept).body);
    expect(fit.parts[0]!.partOf).toHaveLength(keptUnits.length);
    expect(fit.parts[0]!.partOf[keptUnits.findIndex((u) => u.text.startsWith("second.0"))]).toBe(1);
  });

  it("names the document cap, with its own value, in the note, and lists earlier omissions too", () => {
    const section = {
      ...partsSection(
        "Rules",
        Array.from({ length: 2 }, () => ({ topics: 3, paragraphs: 3, budget: 1_000 })),
      ),
      alreadyOmitted: ["billing (not planned)"],
    };
    const fit = fitDocumentToPlan([section], 3_000, (m) => m.length, 250_000);
    const note = splitClosingNote(fit.sections[0]).note!;
    expect(note).toContain(
      "The document is limited to about 250k characters (DOCS_GEN_DOCUMENT_MAX_CHARS).",
    );
    expect(note).not.toContain("DOCS_GEN_SECTION_MAX_CHARS");
    expect(fit.omittedTopics[0]).toContain("billing (not planned)");
    expect(fit.omittedTopics[0]).toContain("Rules part 1 topic 2");
    expect(fit.sections[0].match(/Shortened for length/g)).toHaveLength(1);
  });

  it("replaces a note the section already carried, and keeps it when the section stays whole", () => {
    const base = partsSection(
      "Rules",
      Array.from({ length: 2 }, () => ({ topics: 3, paragraphs: 3, budget: 1_000 })),
    );
    const noted: PlanFitSection = {
      ...base,
      markdown: `${base.markdown}\n\n${plannedOmissionNote(["billing (not planned)"], {
        setting: "DOCS_GEN_DOCUMENT_MAX_CHARS",
        maxChars: 250_000,
      })}`,
      alreadyOmitted: ["billing (not planned)"],
    };
    const whole = fitDocumentToPlan([noted], noted.markdown.length);
    expect(whole.sections[0]).toBe(noted.markdown);
    expect(whole.omittedTopics[0]).toEqual(["billing (not planned)"]);
    const cut = fitDocumentToPlan([noted], 3_000);
    expect(cut.sections[0].match(/Shortened for length/g)).toHaveLength(1);
    expect(cut.omittedTopics[0]).toContain("billing (not planned)");
    expect(cut.sections[0].length).toBeLessThanOrEqual(3_000);
  });

  it("never cuts inside a code fence or a table", () => {
    const fence = [
      "```go",
      ...Array.from({ length: 30 }, (_, i) => `line${i} := ${i}`),
      "```",
    ].join("\n");
    const table = [
      "| a | b |",
      "|---|---|",
      ...Array.from({ length: 30 }, (_, i) => `| r${i} | v |`),
    ].join("\n");
    const markdown = [
      "## Rules",
      "### One",
      PARAGRAPH("a"),
      fence,
      "---",
      "### Two",
      PARAGRAPH("b"),
      table,
    ].join("\n\n");
    const section: PlanFitSection = {
      markdown,
      budgetChars: 1_000,
      parts: { budgets: [500, 500], partOf: [0, 0, 0, 0, 1, 1, 1, 1] },
    };
    for (const cap of [1_300, 1_500, 1_700, 1_900]) {
      const [kept] = fitDocumentToPlan([section], cap).sections;
      expect(kept.length).toBeLessThanOrEqual(cap);
      expect((kept.match(/```/g) ?? []).length % 2).toBe(0);
      if (kept.includes("| a | b |")) expect(kept).toContain("| r29 | v |");
    }
  });

  it("measures as it is told to: a section that fits as rendered is whole, however long its draft (#995)", () => {
    const marker = " [facts:repo:%5B%22g%22%2Cnull%2C%22src%2Fmodule%22%5D:0]";
    const rendered: (m: string) => number = (m) => m.split(marker).join("[^1]").length;
    const section = partsSection(
      "Rules",
      Array.from({ length: 3 }, () => ({ topics: 3, paragraphs: 3, budget: 1_000 })),
    );
    const cited: PlanFitSection = {
      ...section,
      markdown: section.markdown
        .split("\n\n")
        .map((u) => (u.startsWith("Rules.") ? `${u}${marker}` : u))
        .join("\n\n"),
    };
    const cap = rendered(cited.markdown);
    expect(cited.markdown.length).toBeGreaterThan(cap * 1.15);
    expect(fitDocumentToPlan([cited], cap, rendered).mode).toBe("whole");
    // Cut to half as rendered, the kept text is half as rendered, not as drafted.
    const half = fitDocumentToPlan([cited], Math.floor(cap / 2), rendered);
    expect(half.mode).toBe("plan");
    expect(rendered(half.sections[0])).toBeLessThanOrEqual(cap / 2);
    expect(rendered(half.sections[0])).toBeGreaterThan(cap / 2 - 300);
    expect(half.keptChars).toBe(keptContentChars(half.sections[0], rendered));
  });

  it("treats a section whose parts do not match its text as one part", () => {
    const section = partsSection(
      "Rules",
      Array.from({ length: 3 }, () => ({ topics: 3, paragraphs: 3, budget: 1_000 })),
    );
    const stale: PlanFitSection = {
      ...section,
      parts: { budgets: section.parts!.budgets, partOf: section.parts!.partOf.slice(3) },
    };
    const fit = fitDocumentToPlan([stale], 3_000);
    expect(fit.sections[0].length).toBeLessThanOrEqual(3_000);
    // One part: a leading run of the section, like the cut without a plan.
    expect(fit.sections[0]).toContain("### Rules part 0 topic 0");
    expect(fit.sections[0]).not.toContain("### Rules part 2 topic 2");
    expect(fit.parts[0]).toBeUndefined();
  });

  it("stays within the cap when its note outgrows the room held for it", () => {
    // Twenty-four topics with long names, most of them cut: the note that lists
    // twelve of them is longer than the 900 characters a fit holds for a note.
    const long = (p: number, t: number): string =>
      `Reconciliation of settlement batches against the ledger, part ${p} topic ${t}`;
    const blocks = ["## Rules"];
    const partOf = [0];
    for (let p = 0; p < 4; p++) {
      for (let t = 0; t < 6; t++) {
        blocks.push(`### ${long(p, t)}`, PARAGRAPH(`r.${p}.${t}`, 30));
        partOf.push(p, p);
      }
    }
    const section: PlanFitSection = {
      markdown: blocks.join("\n\n"),
      budgetChars: 4_000,
      parts: { budgets: [1_000, 1_000, 1_000, 1_000], partOf },
    };
    const cap = 2_600;
    const fit = fitDocumentToPlan([section], cap);
    const note = splitClosingNote(fit.sections[0]).note!;
    expect(note.length).toBeGreaterThan(900);
    expect(fit.sections[0].length).toBeLessThanOrEqual(cap);
    // And it is still the plan's cut: every part leads with its first topic.
    expect(fit.mode).toBe("plan");
    for (let p = 0; p < 4; p++) expect(fit.sections[0]).toContain(`### ${long(p, 0)}`);
  });

  it("does not take a longer note for more kept: the content is what is compared", () => {
    // Twelve small topics with long names (planned almost nothing), then one
    // large topic (planned everything). The cut without a plan keeps the small
    // topics and part of the large one, and lists nothing. The plan-ordered
    // cut keeps the large topic and lists the small ones: as long a section,
    // most of a thousand characters of it the list.
    const blocks = ["## Rules"];
    const partOf = [0];
    for (let t = 0; t < 12; t++) {
      blocks.push(
        `### Reconciliation of settlement batches against the general ledger, case ${t}`,
        PARAGRAPH(`small.${t}`, 12),
      );
      partOf.push(0, 0);
    }
    blocks.push("### The large topic");
    partOf.push(1);
    for (let k = 0; k < 40; k++) {
      blocks.push(PARAGRAPH(`large.${k}`, 20));
      partOf.push(1);
    }
    const section: PlanFitSection = {
      markdown: blocks.join("\n\n"),
      budgetChars: 10_000,
      parts: { budgets: [1, 9_999], partOf },
    };
    const cap = 4_500;
    const tail = fitSectionsToDocumentBudget([section.markdown], cap);
    const plan = planOrderedFit([section], cap, (m) => m.length, {
      setting: "DOCS_GEN_DOCUMENT_MAX_CHARS",
      maxChars: cap,
    });
    // The plan-ordered cut is as long as the other, and holds less.
    expect(plan.sections[0].length).toBeGreaterThanOrEqual(tail.sections[0].length - 29);
    expect(keptOf(plan.sections)).toBeLessThan(keptOf(tail.sections));
    const fit = fitDocumentToPlan([section], cap);
    expect(fit.mode).toBe("tail");
    expect(fit.keptChars).toBe(keptOf(tail.sections));
  });

  it("uses the cut without a plan when that keeps more of the text", () => {
    // One paragraph larger than everything else, in the lower-budget part: the
    // plan-ordered fill stops short of it, the tail cut happens to fit it.
    const found = findTailCase();
    expect(found).not.toBeNull();
    const { sections, cap } = found!;
    const fit = fitDocumentToPlan(sections, cap);
    const tail = fitSectionsToDocumentBudget(
      sections.map((s) => s.markdown),
      cap,
    );
    expect(fit.mode).toBe("tail");
    expect(fit.keptChars).toBe(keptOf(tail.sections));
    const plan = planOrderedFit(sections, cap, (m) => m.length, {
      setting: "DOCS_GEN_DOCUMENT_MAX_CHARS",
      maxChars: cap,
    });
    expect(keptOf(plan.sections)).toBeLessThan(fit.keptChars);
    // The note still names the one limit, and the kept parts are attributed.
    expect(fit.sections.join("\n")).not.toContain("DOCS_GEN_SECTION_MAX_CHARS");
    fit.sections.forEach((kept, i) => {
      if (!fit.parts[i]) return;
      expect(fit.parts[i]!.partOf).toHaveLength(units(splitClosingNote(kept).body).length);
    });
  });

  it("never keeps less than the cut without a plan, and never passes the cap (property)", () => {
    const modes = { whole: 0, plan: 0, tail: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const { sections, cap } = randomDocument(seed);
      const fit = fitDocumentToPlan(sections, cap);
      const tail = fitSectionsToDocumentBudget(
        sections.map((s) => s.markdown),
        cap,
        sections.map((s) => s.alreadyOmitted ?? []),
      );
      modes[fit.mode] += 1;
      const label = `seed ${seed}`;
      // The invariant: at least as much content as the cut without a plan.
      expect(keptOf(fit.sections), label).toBeGreaterThanOrEqual(keptOf(tail.sections));
      expect(fit.keptChars, label).toBe(keptOf(fit.sections));
      // ... and at least as full a document. (A note here names one setting
      // where the note without a plan names two: 29 characters a note.)
      expect(totalLength(fit.sections), label).toBeGreaterThanOrEqual(
        totalLength(tail.sections) - 29 * tail.trimmed,
      );
      // The cap is the limit (the cut without a plan can overrun a very small one).
      if (totalLength(tail.sections) <= cap) {
        expect(totalLength(fit.sections), label).toBeLessThanOrEqual(cap);
      }
      expect(totalLength(fit.sections), label).toBeLessThanOrEqual(
        Math.max(cap, totalLength(tail.sections)),
      );
      // Nothing is cut from a document that fits.
      if (totalLength(sections.map((s) => s.markdown)) <= cap) {
        expect(fit.sections, label).toEqual(sections.map((s) => s.markdown));
      }
      // Every section is still there, opening with its own heading, and each
      // part kept only a leading run of what it wrote.
      fit.sections.forEach((kept, i) => {
        expect(kept.startsWith(`## Section ${i}`), label).toBe(true);
        // (A tail cut may keep the leading sentences of a paragraph instead.)
        if (fit.cuts[i] === "tail") return;
        const original = sections[i].markdown.split("\n\n");
        const body = splitClosingNote(kept).body.split("\n\n");
        let at = 0;
        for (const unit of body) {
          at = original.indexOf(unit, at) + 1;
          expect(at, `${label}: kept text in its original order`).toBeGreaterThan(0);
        }
        if (fit.cuts[i] !== "plan") return;
        for (const part of new Set(sections[i].parts?.partOf ?? [])) {
          const written = original.filter(
            (u, k) => sections[i].parts!.partOf[k] === part && /^p\d/.test(u),
          );
          const keptOfPart = body.filter((u) => written.includes(u));
          expect(keptOfPart, `${label}: part ${part} keeps a leading run`).toEqual(
            written.slice(0, keptOfPart.length),
          );
        }
      });
    }
    // The plan's own cut is the usual one; the fallback is the exception.
    expect(modes.plan).toBeGreaterThan(modes.tail * 8);
    expect(modes.whole).toBeGreaterThan(0);
    expect(modes.tail).toBeGreaterThan(0);
  });

  describe("#1119 — the per-section figures a floor would be decided from", () => {
    const measure = (markdown: string): number => markdown.length;
    const unplanned = (sections: readonly PlanFitSection[], cap: number) =>
      fitSectionsToDocumentBudget(
        sections.map((s) => s.markdown),
        cap,
        sections.map((s) => s.alreadyOmitted ?? []),
      );

    it("reports what each section kept, under the plan-ordered cut and under the cut without a plan", () => {
      let keptLessInOneSection = 0;
      let cutDocuments = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const { sections, cap } = randomDocument(seed);
        const fit = fitDocumentToPlan(sections, cap);
        const tail = unplanned(sections, cap);
        const plan = planOrderedFit(
          sections,
          cap,
          measure,
          { setting: "DOCS_GEN_DOCUMENT_MAX_CHARS", maxChars: cap },
          sections.map((s, i) => tail.sections[i] === s.markdown),
        );
        const label = `seed ${seed}`;
        const fits = totalLength(sections.map((s) => s.markdown)) <= cap;
        expect(fit.kept, label).toHaveLength(sections.length);
        expect(sum(fit.kept.map((k) => k.chars)), label).toBe(fit.keptChars);
        fit.kept.forEach((kept, i) => {
          // As returned, and under each of the two cuts, measured alike.
          expect(kept.chars, label).toBe(keptContentChars(fit.sections[i], measure));
          expect(kept.unplannedChars, label).toBe(keptContentChars(tail.sections[i], measure));
          if (fits) {
            expect(kept, label).toEqual({
              chars: kept.chars,
              planChars: kept.chars,
              unplannedChars: kept.chars,
            });
            return;
          }
          if (totalLength(tail.sections) <= cap) {
            expect(kept.planChars, label).toBe(keptContentChars(plan.sections[i], measure));
          }
          if (fit.cuts[i] === "plan") expect(kept.planChars, label).toBe(kept.chars);
          if (fit.cuts[i] === "tail") expect(kept.unplannedChars, label).toBe(kept.chars);
          if (kept.chars < kept.unplannedChars) keptLessInOneSection += 1;
        });
        if (fits) continue;
        cutDocuments += 1;
        // The guarantee is on the document, when the other cut is within the cap.
        // (Measured with its notes reworded, which can only shorten them.)
        if (totalLength(tail.sections) <= cap) expect(fit.unplannedWithinCap, label).toBe(true);
        if (fit.unplannedWithinCap) {
          expect(sum(fit.kept.map((k) => k.chars)), label).toBeGreaterThanOrEqual(
            sum(fit.kept.map((k) => k.unplannedChars)),
          );
        }
      }
      expect(cutDocuments).toBeGreaterThan(100);
      // ... and NOT on a section: there is no per-section floor. This is what
      // the figures are logged for.
      expect(keptLessInOneSection).toBeGreaterThan(0);
    });

    it("says so when the cut without a plan is itself over a very small cap: the plan's cut is then the shorter", () => {
      let overruns = 0;
      let shorter = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const { sections } = randomDocument(seed);
        // Far below what the generator uses: a few hundred characters a section.
        const cap = 350 * sections.length;
        const tail = unplanned(sections, cap);
        const fit = fitDocumentToPlan(sections, cap);
        const label = `seed ${seed}`;
        const fits = totalLength(sections.map((s) => s.markdown)) <= cap;
        if (fits || totalLength(tail.sections) <= cap) {
          expect(fit.unplannedWithinCap, label).toBe(true);
        }
        if (fit.unplannedWithinCap) continue;
        expect(totalLength(tail.sections), label).toBeGreaterThan(cap);
        overruns += 1;
        if (fit.mode !== "plan") continue;
        // The plan-ordered cut stands with no comparison: within the cap ...
        expect(totalLength(fit.sections), label).toBeLessThanOrEqual(cap);
        // ... and so it can keep LESS than the cut that is over it.
        if (sum(fit.kept.map((k) => k.chars)) < sum(fit.kept.map((k) => k.unplannedChars))) {
          shorter += 1;
        }
      }
      expect(overruns).toBeGreaterThan(0);
      expect(shorter).toBeGreaterThan(0);
    });

    it("reports the same three figures for a section held to the section cap", () => {
      let cuts = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const section = randomDocument(seed).sections[0];
        const cap = Math.max(2_000, Math.floor(section.markdown.length * 0.6));
        const fit = fitSectionToPlan(section, cap);
        const tail = fitSectionToBudget(section.markdown, cap, section.alreadyOmitted ?? []);
        const [kept] = fit.kept;
        expect(fit.kept).toHaveLength(1);
        expect(fit.unplannedWithinCap).toBe(true);
        expect(kept.chars, `seed ${seed}`).toBe(fit.keptChars);
        expect(kept.unplannedChars, `seed ${seed}`).toBe(keptContentChars(tail.markdown, measure));
        expect(kept.chars, `seed ${seed}`).toBeGreaterThanOrEqual(kept.unplannedChars);
        if (fit.mode === "plan") expect(kept.planChars).toBe(kept.chars);
        if (fit.mode === "whole") expect(kept.planChars).toBe(kept.chars);
        else cuts += 1;
      }
      expect(cuts).toBeGreaterThan(20);
    });

    it("counts headings and rules as kept: in paragraphs alone the plan's cut can keep less", () => {
      // The precision the module comment states. A plan cut keeps more topics,
      // each with its rule and heading.
      const paragraphs = (section: string): number =>
        sum(
          units(splitClosingNote(section).body)
            .filter((u) => u.depth === 0 && u.text.trim() !== "---")
            .map((u) => u.text.length),
        );
      let less = 0;
      let worst = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const { sections, cap } = randomDocument(seed);
        const fit = fitDocumentToPlan(sections, cap);
        if (fit.mode !== "plan") continue;
        const tail = unplanned(sections, cap);
        // Kept text, headings and rules included: never less.
        expect(keptOf(fit.sections), `seed ${seed}`).toBeGreaterThanOrEqual(keptOf(tail.sections));
        const gap = sum(tail.sections.map(paragraphs)) - sum(fit.sections.map(paragraphs));
        if (gap > 0) less += 1;
        worst = Math.max(worst, gap);
      }
      expect(less).toBeGreaterThan(0);
      // Small: a few headings' worth.
      expect(worst).toBeLessThan(600);
    });
  });

  it("is linear in the size of the document", () => {
    expectLinearTime(
      "fitDocumentToPlan",
      (size) => {
        const topics = Math.max(1, Math.floor(size / 8 / 1_300));
        const sections = Array.from({ length: 2 }, (_, s) =>
          partsSection(
            `S${s}`,
            Array.from({ length: 4 }, () => ({ topics, paragraphs: 6, budget: 1_000 })),
          ),
        );
        const cap = Math.floor(totalLength(sections.map((x) => x.markdown)) / 2);
        return () => fitDocumentToPlan(sections, cap);
      },
      400_000,
    );
  });
});

/** A generated document: sections in one part or several, of uneven paragraphs. */
function randomDocument(seed: number): { sections: PlanFitSection[]; cap: number } {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const count = int(1, 7);
  const sections: PlanFitSection[] = Array.from({ length: count }, (_, s) => {
    const partCount = r() < 0.4 ? 1 : int(2, 8);
    const blocks = [`## Section ${s}`];
    const partOf = [0];
    for (let p = 0; p < partCount; p++) {
      const topics = int(1, 6);
      for (let t = 0; t < topics; t++) {
        if (r() < 0.5) {
          blocks.push("---");
          partOf.push(p);
        }
        blocks.push(`### Topic ${s}.${p}.${t}`);
        partOf.push(p);
        const paragraphs = int(1, 6);
        for (let k = 0; k < paragraphs; k++) {
          // One paragraph in ten is far larger than the rest.
          blocks.push(PARAGRAPH(`p${s}.${p}.${t}.${k}`, int(5, r() < 0.1 ? 900 : 120)));
          partOf.push(p);
        }
      }
    }
    const budgets = Array.from({ length: partCount }, () => int(200, 6_000));
    return {
      markdown: blocks.join("\n\n"),
      budgetChars: sum(budgets),
      ...(partCount > 1 ? { parts: { budgets, partOf } } : {}),
      alreadyOmitted: r() < 0.2 ? [`left out earlier ${s}`] : [],
    };
  });
  const total = totalLength(sections.map((s) => s.markdown));
  return { sections, cap: Math.max(2_000 * count, Math.floor(total * (0.2 + r() * 0.9))) };
}

/** The first generated document whose plan-ordered cut keeps less than the tail cut. */
function findTailCase(): { sections: PlanFitSection[]; cap: number } | null {
  for (let seed = 1; seed <= 400; seed++) {
    const document = randomDocument(seed);
    if (fitDocumentToPlan(document.sections, document.cap).mode === "tail") return document;
  }
  return null;
}

describe("fitSectionToPlan", () => {
  it("returns a section within the section cap unchanged", () => {
    const section = partsSection("Rules", [
      { topics: 2, paragraphs: 2, budget: 10 },
      { topics: 2, paragraphs: 2, budget: 10 },
    ]);
    const fit = fitSectionToPlan(section, section.markdown.length);
    expect(fit.mode).toBe("whole");
    expect(fit.sections[0]).toBe(section.markdown);
    expect(fit.parts[0]).toEqual(section.parts);
  });

  it("holds the section, its note included, to the cap, cutting each part's tail", () => {
    const section = partsSection(
      "Rules",
      Array.from({ length: 4 }, () => ({ topics: 3, paragraphs: 3, budget: 1_000 })),
    );
    const cap = 5_000;
    const fit = fitSectionToPlan(section, cap);
    expect(fit.mode).toBe("plan");
    expect(fit.sections[0].length).toBeLessThanOrEqual(cap);
    expect(fit.sections[0].length).toBeGreaterThan(cap - 300);
    for (let p = 0; p < 4; p++) expect(fit.sections[0]).toContain(`### Rules part ${p} topic 0`);
    expect(splitClosingNote(fit.sections[0]).note).toContain(
      "This section is limited to about 5k characters (DOCS_GEN_SECTION_MAX_CHARS).",
    );
  });

  it("does not cut a section whose parts merged to less than the cap (the reviewer's case)", () => {
    // Two replies of 1,402 and 1,384 characters sharing an intro and one topic
    // merge to 1,994: under a 2,044 cap. Fitting the PARTS before the merge
    // cut both and dropped a topic.
    const sized = (text: string, chars: number): string =>
      `${text} ${"more detail follows here ".repeat(40)}`.slice(0, chars - 1) + ".";
    const intro = sized("Rules govern how a request is accepted", 300);
    const shared = sized("- The request is checked against the configured policy", 460);
    const reply = (topic: string, chars: number): string =>
      [
        "## Rules",
        intro,
        "### Entries",
        shared,
        `### ${topic}`,
        sized(`- ${topic} only`, chars),
      ].join("\n\n");
    const a = reply("Alpha", 604);
    const b = reply("Beta", 587);
    expect([a.length, b.length]).toEqual([1_402, 1_384]);
    const blocks = mergeBatchBlocks([a, b], "Rules");
    const merged = blocks.map((block) => block.text).join("\n\n");
    expect(merged).toBe(mergeBatchSections([a, b], "Rules"));
    // 2,016 here (the review's own two parts merged to 1,994): under the cap.
    expect(merged.length).toBe(2_016);
    const fit = fitSectionToPlan(
      {
        markdown: merged,
        budgetChars: 1_000,
        parts: {
          budgets: [500, 500],
          partOf: blocks.flatMap((block) => units(block.text).map(() => block.reply)),
        },
      },
      2_044,
    );
    expect(fit.trimmed).toBe(0);
    expect(fit.sections[0]).toBe(merged);
    expect(fit.omittedTopics[0]).toEqual([]);
    // Each block is attributed to the reply that wrote it; what both wrote, to the first.
    expect(blocks.find((block) => block.text.startsWith("### Beta"))!.reply).toBe(1);
    expect(blocks.find((block) => block.text.startsWith("### Entries"))!.reply).toBe(0);
    expect(blocks.filter((block) => block.text.startsWith("- The request"))).toHaveLength(1);
  });

  it("never keeps less than the section cap without a plan keeps (property)", () => {
    let planCuts = 0;
    let cuts = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { sections } = randomDocument(seed);
      const section = sections[0];
      const r = rng(seed * 7919);
      const cap = Math.max(2_000, Math.floor(section.markdown.length * (0.3 + r() * 0.8)));
      const fit = fitSectionToPlan(section, cap);
      const tail = fitSectionToBudget(section.markdown, cap, section.alreadyOmitted ?? []);
      expect(keptOf(fit.sections), `seed ${seed}`).toBeGreaterThanOrEqual(keptOf([tail.markdown]));
      expect(fit.sections[0].length, `seed ${seed}`).toBeLessThanOrEqual(
        Math.max(cap, tail.markdown.length),
      );
      if (!tail.trimmed) expect(fit.sections[0]).toBe(section.markdown);
      if (fit.mode !== "whole") cuts += 1;
      if (fit.mode === "plan") planCuts += 1;
    }
    expect(planCuts).toBeGreaterThan(cuts * 0.9);
  });
});

describe("the parts of a stored section", () => {
  it("round-trips as runs", () => {
    const partOf = [0, 0, 0, 1, 1, 0, 2, 2, 2, 2];
    expect(encodePartRuns(partOf)).toEqual([
      [0, 3],
      [1, 2],
      [0, 1],
      [2, 4],
    ]);
    expect(decodePartRuns(encodePartRuns(partOf))).toEqual(partOf);
    expect(encodePartRuns([])).toEqual([]);
    expect(decodePartRuns([[1, 0]])).toEqual([]);
  });
});
