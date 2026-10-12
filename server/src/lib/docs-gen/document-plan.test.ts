/**
 * #1070 — the topic plan: the document budget is shared among sections and
 * topics before anything is written, topics that cannot fit are dropped by
 * priority and named, and written parts are held to their own budgets.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  MIN_TOPIC_CHARS,
  SINGLE_CALL_SECTION_CHARS,
  TOPIC_PLAN_KEY,
  allocateTopicBudgets,
  droppedTopicLabel,
  fitPartsToBudgets,
  planDocument,
  sectionCeilingChars,
  summarizeDocumentPlan,
  topicPlanEnabled,
  waterFill,
  type SectionDemand,
  type TopicCandidate,
} from "./document-plan.js";

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

  it("is on unless switched off", () => {
    expect(topicPlanEnabled(config())).toBe(true);
    expect(topicPlanEnabled(config("on"))).toBe(true);
    for (const off of ["off", "OFF", "0", "false", "no", " off "]) {
      expect(topicPlanEnabled(config(off))).toBe(false);
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

describe("sectionCeilingChars", () => {
  const plan = planDocument({
    sections: [
      single("overview"),
      enumerative("rules", [topic("rules/a", 1, 90_000)]),
      enumerative("formulas", [topic("formulas/a", 1, 90_000)]),
    ],
    documentMaxChars: 104_000,
    sectionMaxChars: 60_000,
  });
  // overview 24,000; rules and formulas 40,000 each; nothing unallocated.

  it("is the budget while the document has nothing to spare", () => {
    expect(plan.unallocatedChars).toBe(0);
    expect(sectionCeilingChars(plan, "rules", new Map(), 60_000)).toBe(40_000);
  });

  it("adds a share of what the sections already written left unused", () => {
    // Overview used 14,000 of 24,000: 10,000 to spare, two sections to come.
    const written = new Map([["overview", 14_000]]);
    expect(sectionCeilingChars(plan, "rules", written, 60_000)).toBe(45_000);
    // Rules then used all of its ceiling: Formulas still has its own 5,000.
    written.set("rules", 45_000);
    expect(sectionCeilingChars(plan, "formulas", written, 60_000)).toBe(45_000);
  });

  it("takes room away when an earlier section overran, but never below half the budget", () => {
    expect(sectionCeilingChars(plan, "rules", new Map([["overview", 34_000]]), 60_000)).toBe(
      35_000,
    );
    expect(sectionCeilingChars(plan, "rules", new Map([["overview", 400_000]]), 60_000)).toBe(
      20_000,
    );
  });

  it("shares budget no section asked for, up to the per-section cap", () => {
    const roomy = planDocument({
      sections: [enumerative("rules", [topic("rules/a", 1, 10_000)]), single("overview")],
      documentMaxChars: 250_000,
      sectionMaxChars: 60_000,
    });
    expect(roomy.unallocatedChars).toBe(216_000);
    expect(sectionCeilingChars(roomy, "rules", new Map(), 60_000)).toBe(60_000);
    expect(sectionCeilingChars(roomy, "rules", new Map(), 12_000)).toBe(12_000);
  });

  it("is the section cap for a section the plan does not know", () => {
    expect(sectionCeilingChars(plan, "appendix", new Map(), 60_000)).toBe(60_000);
  });

  it("never lets the sections together pass the document budget (property)", () => {
    const next = rng(7);
    for (let run = 0; run < 200; run++) {
      const demands = Array.from({ length: 2 + Math.floor(next() * 5) }, (_, i) =>
        enumerative(`s${i}`, [topic(`s${i}/a`, 1, 1_000 + Math.floor(next() * 80_000))]),
      );
      const p = planDocument({
        sections: demands,
        documentMaxChars: 20_000 + Math.floor(next() * 200_000),
        sectionMaxChars: 60_000,
      });
      const written = new Map<string, number>();
      for (const s of p.sections) {
        const ceiling = sectionCeilingChars(p, s.sectionId, written, 60_000);
        // Each section writes anything up to its ceiling.
        written.set(s.sectionId, Math.floor(next() * (ceiling + 1)));
      }
      expect(sum([...written.values()])).toBeLessThanOrEqual(p.budgetChars);
    }
  });
});

/** One written part: an H2, then `topics` H3 topics of `paras` paragraphs each. */
function part(name: string, topics: number, paras = 2, chars = 200): string {
  const out = ["## Business Rules & Policies"];
  for (let t = 1; t <= topics; t++) {
    out.push(`### ${name} topic ${t}`);
    for (let p = 1; p <= paras; p++) {
      out.push(`${name}.${t}.${p} ${"policy text ".repeat(Math.ceil(chars / 12))}`.slice(0, chars));
    }
  }
  return out.join("\n\n");
}

describe("fitPartsToBudgets", () => {
  it("returns parts that already fit unchanged, whatever each one's budget", () => {
    const parts = [part("A", 2), part("B", 6)];
    const fit = fitPartsToBudgets(parts, [10, 10], 1_000_000);
    expect(fit.parts).toEqual(parts);
    expect(fit.trimmed).toBe(0);
    expect(fit.omittedTopics).toEqual([[], []]);
  });

  it("cuts the part that overran at ITS tail and keeps the others whole", () => {
    const a = part("A", 3); // within its budget
    const b = part("B", 12); // far over
    const c = part("C", 3);
    const total = a.length + c.length + 1_600;
    const fit = fitPartsToBudgets([a, b, c], [1_500, 1_500, 1_500], total);
    expect(fit.parts[0]).toBe(a);
    expect(fit.parts[2]).toBe(c);
    expect(fit.trimmed).toBe(1);
    // B keeps its leading topics, whole, and names the ones it lost.
    expect(b.startsWith(fit.parts[1])).toBe(true);
    expect(fit.parts[1]).toContain("### B topic 1");
    expect(fit.parts[1]).not.toContain("### B topic 12");
    expect(fit.omittedTopics[1]).toContain("B topic 12");
    expect(fit.omittedTopics[0]).toEqual([]);
    for (const lost of fit.omittedTopics[1]) expect(fit.parts[1]).not.toContain(`### ${lost}\n`);
    expect(sum(fit.parts.map((p) => p.length))).toBeLessThanOrEqual(total);
    // No part writes a note of its own: the section writes one.
    expect(fit.parts.join("\n")).not.toContain("Shortened for length");
  });

  it("shares the room in proportion to the budgets when several parts overran", () => {
    const a = part("A", 20);
    const b = part("B", 20);
    const fit = fitPartsToBudgets([a, b], [3_000, 1_000], 4_000);
    expect(fit.trimmed).toBe(2);
    expect(fit.parts[0].length).toBeGreaterThan(fit.parts[1].length * 2);
    expect(sum(fit.parts.map((p) => p.length))).toBeLessThanOrEqual(4_000);
  });

  it("hands the room a cut leaves unused to the parts still shortened", () => {
    // B's allowance ends just short of its next topic; without the hand-back
    // the room A's coarse cut left would be wasted.
    const a = `## H\n\n### A big\n\n${"x".repeat(2_400)}\n\n### A tail\n\n${"y".repeat(2_400)}`;
    const b = part("B", 10, 1, 300);
    const total = 4_000;
    const fit = fitPartsToBudgets([a, b], [2_000, 2_000], total);
    const used = sum(fit.parts.map((p) => p.length));
    expect(used).toBeLessThanOrEqual(total);
    // A can keep nothing whole (its first topic alone is 2,400), so B takes the room.
    expect(fit.parts[1].length).toBeGreaterThan(2_000);
  });

  it("empties a part that cannot keep even its first paragraph, and lists its topics", () => {
    const table = `## H\n\n### Limits\n\n| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(200)}`;
    const other = part("B", 2);
    const fit = fitPartsToBudgets([table, other], [100, 5_000], other.length + 300);
    expect(fit.parts[0]).toBe("");
    expect(fit.omittedTopics[0]).toEqual(["Limits"]);
    expect(fit.parts[1]).toBe(other);
  });

  it("never cuts inside a code fence or a table", () => {
    const fenced = [
      "## H",
      "### Kept",
      "short",
      "### Fenced",
      "```go",
      ...Array.from({ length: 40 }, (_, i) => `line ${i}`),
      "",
      "still inside the fence",
      "```",
    ].join("\n\n");
    const fit = fitPartsToBudgets([fenced, part("B", 1)], [400, 400], 500);
    expect(fit.parts[0]).not.toContain("```");
    expect(fit.omittedTopics[0]).toEqual(["Fenced"]);
  });

  it("keeps CRLF text byte for byte in what it keeps", () => {
    const crlf = part("A", 8).replace(/\n/g, "\r\n");
    const fit = fitPartsToBudgets([crlf, part("B", 1)], [600, 600], 1_300);
    expect(fit.trimmed).toBe(1);
    expect(fit.parts[0].length).toBeGreaterThan(0);
    // What survives is the original's own characters, in order.
    let at = 0;
    for (const line of fit.parts[0].split("\n")) {
      const found = crlf.indexOf(line, at);
      expect(found).toBeGreaterThanOrEqual(0);
      at = found + line.length;
    }
  });

  it("fits the total and keeps only a leading run of each part (property)", () => {
    const next = rng(2026);
    for (let run = 0; run < 150; run++) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, i) =>
        part(`P${i}`, 1 + Math.floor(next() * 9), 1 + Math.floor(next() * 3), 60 + next() * 400),
      );
      const budgets = parts.map(() => 200 + Math.floor(next() * 3_000));
      const total = 300 + Math.floor(next() * sum(parts.map((p) => p.length)));
      const fit = fitPartsToBudgets(parts, budgets, total);
      expect(sum(fit.parts.map((p) => p.length))).toBeLessThanOrEqual(total);
      fit.parts.forEach((kept, i) => {
        expect(parts[i].startsWith(kept)).toBe(true);
        if (kept !== parts[i]) expect(fit.omittedTopics[i].length + kept.length).toBeGreaterThan(0);
      });
      expect(fit.trimmed).toBe(fit.parts.filter((kept, i) => kept !== parts[i]).length);
    }
  });

  it("is linear in the size of the parts", () => {
    expectLinearTime("fitPartsToBudgets", (size) => {
      const parts = Array.from({ length: 8 }, (_, i) => part(`P${i}`, Math.ceil(size / 8 / 450)));
      return () =>
        fitPartsToBudgets(
          parts,
          parts.map(() => 1_000),
          Math.floor(size / 3),
        );
    });
  });
});
