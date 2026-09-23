/**
 * #157 — the pure parts of batched section synthesis: the output estimate, the
 * batch planner, the bounded re-split rule, the deterministic merge of batch
 * replies, and the pooled faithfulness score.
 *
 * The merge fixtures follow the shape real sections have (onyourleft's Rules and
 * Calculations sections: an intro, `---` separators, H3 topics, H4 subtopics,
 * numbered rules with nested Condition/Action bullets, GFM tables, `$$` blocks,
 * and "**Variables:**" lists) plus large and unclosed code fences, which the
 * synthetic bullet fixtures of earlier batching work never contained (#165).
 */
import { describe, expect, it } from "vitest";
import type { FaithfulnessResult } from "./grounding/citation-validator.js";
import {
  aggregateFaithfulness,
  batchOutputBudgetChars,
  entryKey,
  estimateModuleOutputChars,
  mergeBatchSections,
  MIN_SPLIT_BUDGET_FRACTION,
  planBatches,
  shouldResplit,
  splitBatch,
  topicKey,
  type BatchCandidate,
} from "./section-batching.js";

const cand = (item: string, inputChars: number, outputChars: number): BatchCandidate<string> => ({
  item,
  inputChars,
  outputChars,
});
const names = (batches: BatchCandidate<string>[][]): string[][] =>
  batches.map((b) => b.map((c) => c.item));

describe("batchOutputBudgetChars / estimateModuleOutputChars", () => {
  it("plans a batch to fill 60% of the cap at 3.5 chars per token", () => {
    expect(batchOutputBudgetChars(16_384)).toBe(Math.floor(16_384 * 3.5 * 0.6));
    expect(batchOutputBudgetChars(0)).toBe(1);
  });

  it("grows with the topic facts and with each rendered mined rule", () => {
    const base = estimateModuleOutputChars({ topicChars: 0, minedRules: 0 });
    expect(base).toBe(300);
    expect(estimateModuleOutputChars({ topicChars: 1_000, minedRules: 0 })).toBe(300 + 1_250);
    expect(estimateModuleOutputChars({ topicChars: 0, minedRules: 4 })).toBe(300 + 1_200);
  });
});

describe("planBatches", () => {
  it("closes a batch when the ESTIMATED OUTPUT would pass the budget, even with input to spare", () => {
    const batches = planBatches([cand("a", 10, 400), cand("b", 10, 400), cand("c", 10, 400)], {
      inputCap: 1_000_000,
      outputBudget: 1_000,
    });
    expect(names(batches)).toEqual([["a", "b"], ["c"]]);
  });

  it("closes a batch when the INPUT would pass the facts cap, even with output to spare", () => {
    const batches = planBatches([cand("a", 600, 1), cand("b", 600, 1), cand("c", 300, 1)], {
      inputCap: 1_000,
      outputBudget: 1_000_000,
    });
    expect(names(batches)).toEqual([["a"], ["b", "c"]]);
  });

  it("puts every module in exactly one batch, in the given order", () => {
    const cands = Array.from({ length: 143 }, (_, i) =>
      cand(`m${i}`, 500 + (i % 7) * 900, 800 + (i % 5) * 700),
    );
    const batches = planBatches(cands, { inputCap: 20_000, outputBudget: 10_000 });
    expect(batches.flat().map((c) => c.item)).toEqual(cands.map((c) => c.item));
    for (const b of batches) {
      expect(b.reduce((n, c) => n + c.outputChars, 0)).toBeLessThanOrEqual(10_000);
      expect(b.reduce((n, c) => n + c.inputChars, 0)).toBeLessThanOrEqual(20_000);
    }
  });

  it("gives a module that is over a limit on its own a batch to itself rather than dropping it", () => {
    const batches = planBatches(
      [cand("small", 1, 100), cand("huge", 1, 5_000), cand("tail", 1, 100)],
      {
        inputCap: 1_000,
        outputBudget: 1_000,
      },
    );
    expect(names(batches)).toEqual([["small"], ["huge"], ["tail"]]);
  });

  it("returns no batches for no modules", () => {
    expect(planBatches([], { inputCap: 1, outputBudget: 1 })).toEqual([]);
  });
});

describe("splitBatch", () => {
  it("splits where the estimated output is most balanced, keeping order", () => {
    const halves = splitBatch([
      cand("a", 1, 900),
      cand("b", 1, 100),
      cand("c", 1, 100),
      cand("d", 1, 700),
    ]);
    expect(halves!.map((h) => h.map((c) => c.item))).toEqual([["a"], ["b", "c", "d"]]);
  });

  it("splits evenly sized modules in half", () => {
    const halves = splitBatch([cand("a", 1, 1), cand("b", 1, 1), cand("c", 1, 1), cand("d", 1, 1)]);
    expect(halves!.map((h) => h.length)).toEqual([2, 2]);
  });

  it("cannot split a single module", () => {
    expect(splitBatch([cand("a", 1, 1)])).toBeNull();
  });
});

describe("shouldResplit — bounded so an always-at-cap model cannot loop (#165)", () => {
  const budget = 10_000;
  const big = [cand("a", 1, 4_000), cand("b", 1, 4_000)];

  it("splits a cut-off multi-module batch while the section budget lasts", () => {
    expect(shouldResplit(big, true, 1, budget)).toBe(true);
  });

  it("does not split a batch that was not cut off", () => {
    expect(shouldResplit(big, false, 1, budget)).toBe(false);
  });

  it("does not split once the section's re-split budget is spent", () => {
    expect(shouldResplit(big, true, 0, budget)).toBe(false);
  });

  it("does not split a single module", () => {
    expect(shouldResplit([cand("a", 1, 9_000)], true, 5, budget)).toBe(false);
  });

  it("does not split a batch too small for its size to explain the cut-off", () => {
    const threshold = MIN_SPLIT_BUDGET_FRACTION * budget;
    const small = [cand("a", 1, threshold / 2 - 1), cand("b", 1, threshold / 2)];
    expect(shouldResplit(small, true, 5, budget)).toBe(false);
    const atThreshold = [cand("a", 1, threshold / 2), cand("b", 1, threshold / 2)];
    expect(shouldResplit(atThreshold, true, 5, budget)).toBe(true);
  });
});

describe("entryKey / topicKey", () => {
  it("treats renumbering, emphasis, case and spacing as the same rule", () => {
    expect(entryKey("3. **Amount  Check**: amount > 0.")).toBe(
      entryKey("1. amount check: Amount > 0"),
    );
  });

  it("ignores renumbering on EVERY line, so a renumbered step list still matches", () => {
    const steps =
      "**Steps & Decisions:**\n\n1. Load the plan.\n2. Validate it.\n   - reject when empty";
    expect(
      entryKey(steps.replace("1. Load", "7. Load").replace("2. Validate", "8. Validate")),
    ).toBe(entryKey(steps));
  });

  it("treats '&' and punctuation in a heading as the same topic", () => {
    expect(topicKey("Pricing & Cost Rules")).toBe(topicKey("pricing and cost rules:"));
  });
});

// ---------------------------------------------------------------------------
// Merge — real section shapes
// ---------------------------------------------------------------------------

const RULE_A = `1. **Device ID Validation**
   - **Condition**: A device id is empty or blank (whitespace-only).
   - **Action/Consequence**: A \`SensorError('invalid-device-id')\` is thrown.
   - **Exceptions/Edge Cases**: None.`;

const RULE_B = `2. **Transport Availability Check**
   - **Condition**: \`availability.kind\` is not \`'available'\`.
   - **Action/Consequence**: A \`SensorError\` is thrown.
   - **Exceptions/Edge Cases**: None.`;

const RULE_C = `1. **Refund Window**
   - **Condition**: The refund is requested more than 30 days after purchase.
   - **Action/Consequence**: The refund is rejected with \`REFUND_WINDOW_CLOSED\`.
   - **Exceptions/Edge Cases**: Administrators may override.`;

const BATCH_1 = `## Business Rules & Policies

This section catalogs every business rule enforced in the system.

---

### Validation Rules

#### Sensor Device Validation

${RULE_A}

${RULE_B}

| Field | Condition | Error Code |
|---|---|---|
| Device ID | Empty or blank | \`'invalid-device-id'\` |
| Transport ID | Empty or blank | \`'invalid-device-id'\` |

---

### Eligibility & Qualification Rules

- **Trial eligibility**: accounts younger than 14 days qualify for a trial.`;

const BATCH_2 = `## Business Rules & Policies

### Pricing, Cost & Financial Rules

${RULE_C}

### Validation rules

#### Sensor device validation

${RULE_A.replace(/^1\./, "4.")}

| Field | Condition | Error Code |
|---|---|---|
| Device ID | Empty or blank | \`'invalid-device-id'\` |
| Session | Not connected | \`'not-connected'\` |`;

describe("mergeBatchSections — real section shape", () => {
  const merged = mergeBatchSections([BATCH_1, BATCH_2], "Business Rules & Policies");

  it("emits one H2, from the first reply", () => {
    expect(merged.match(/^## /gm)).toHaveLength(1);
    expect(merged.startsWith("## Business Rules & Policies\n")).toBe(true);
  });

  it("merges topics and subtopics with the same heading, in order of first appearance", () => {
    const h3 = [...merged.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(h3).toEqual([
      "Validation Rules",
      "Eligibility & Qualification Rules",
      "Pricing, Cost & Financial Rules",
    ]);
    expect(merged.match(/^#### /gm)).toHaveLength(1);
  });

  it("keeps each rule once — a renumbered repeat from a later batch is dropped", () => {
    expect(merged.split("Device ID Validation")).toHaveLength(2);
    expect(merged).toContain("Transport Availability Check");
    expect(merged).toContain("Refund Window");
    expect(merged).toContain("Trial eligibility");
  });

  it("keeps a rule's nested Condition/Action bullets with the rule", () => {
    const at = merged.indexOf("Refund Window");
    expect(merged.slice(at, at + 400)).toContain("REFUND_WINDOW_CLOSED");
  });

  it("drops repeated table rows under the same header but keeps the header and new rows", () => {
    const tables = merged.split("\n").filter((l) => l.startsWith("| Field |"));
    expect(tables).toHaveLength(2);
    expect(merged.split("| Device ID | Empty or blank |")).toHaveLength(2);
    expect(merged).toContain("| Session | Not connected |");
    const second = merged.lastIndexOf("| Field |");
    expect(merged.slice(second).split("\n")[1]).toBe("|---|---|---|");
  });

  it("separates topics with one thematic break each", () => {
    expect(merged.match(/^---$/gm)).toHaveLength(3);
  });

  it("is deterministic", () => {
    expect(mergeBatchSections([BATCH_1, BATCH_2], "Business Rules & Policies")).toBe(merged);
  });

  it("puts a later batch's rules under the earlier topic, in batch order", () => {
    const validation = merged.slice(
      merged.indexOf("### Validation Rules"),
      merged.indexOf("### Eligibility"),
    );
    expect(validation.indexOf("Transport Availability Check")).toBeLessThan(
      validation.indexOf("| Session | Not connected |"),
    );
  });
});

describe("mergeBatchSections — what must NOT be deduplicated", () => {
  it("keeps a repeat the model wrote inside ONE reply", () => {
    const reply = `## R\n\n### T\n\n- the same rule written twice by the model\n\n- the same rule written twice by the model`;
    expect(mergeBatchSections([reply], "R").split("the same rule written twice")).toHaveLength(3);
  });

  it("never takes a labelled list apart — two formulas' identical 'Edge cases' bullets both stay", () => {
    const f1 = `## Calculations & Formulas

### Route Planning Calculations

#### Next Waypoint Calculation

$$
\\text{next} = \\text{last} + 4
$$

**Variables:**
- \`last\` — the last waypoint.

**Edge cases:**

- None.`;
    const f2 = `## Calculations & Formulas

### Route Planning Calculations

#### Nudge Calculation

$$
\\text{new} = \\text{old} + \\text{north}
$$

**Variables:**
- \`north\` — the northward offset.

**Edge cases:**

- None.`;
    const merged = mergeBatchSections([f1, f2], "Calculations & Formulas");
    expect(merged.match(/- None\./g)).toHaveLength(2);
    expect(merged).toContain("#### Next Waypoint Calculation");
    expect(merged).toContain("#### Nudge Calculation");
    expect(merged).toContain("\\text{new} = \\text{old} + \\text{north}");
  });

  it("keeps a later batch's labelled list whole even when its label and a line repeat", () => {
    const rate = "- `rate` — the discount rate applied to the order subtotal before tax.";
    const a = `## C\n\n### Pricing\n\n#### Discount\n\n**Variables:**\n\n${rate}`;
    const b = `## C\n\n### Pricing\n\n#### Discount\n\n**Variables:**\n\n${rate}\n- \`cap\` — the most a discount may take off.`;
    const merged = mergeBatchSections([a, b], "C");
    // Taken apart, the repeated label and line would be dropped and "cap"
    // would be left dangling under the first batch's list.
    expect(merged).toContain(`**Variables:**\n\n${rate}\n- \`cap\``);
    expect(merged.match(/\*\*Variables:\*\*/g)).toHaveLength(2);
  });

  it("keeps a short entry that repeats under a DIFFERENT subtopic", () => {
    const a = `## R\n\n### T\n\n#### One\n\nNone.`;
    const b = `## R\n\n### T\n\n#### Two\n\nNone.`;
    expect(mergeBatchSections([a, b], "R").match(/^None\.$/gm)).toHaveLength(2);
  });

  it("drops a substantive entry repeated under a different topic by a later batch", () => {
    const rule = "- **Session timeout**: an idle session expires after 30 minutes of inactivity.";
    const a = `## R\n\n### Security Rules\n\n${rule}`;
    const b = `## R\n\n### Timing Rules\n\n${rule}\n\n- **Grace**: a 5 minute warning precedes expiry.`;
    const merged = mergeBatchSections([a, b], "R");
    expect(merged.split("Session timeout")).toHaveLength(2);
    expect(merged).toContain("### Timing Rules");
    expect(merged).toContain("Grace");
  });
});

describe("mergeBatchSections — fences", () => {
  it("does not read a heading inside a fence as a topic", () => {
    const reply =
      "## R\n\n### Real Topic\n\n```python\n## not a heading\n### nor this\n```\n\n- item";
    // A fenced "### nor this" read as a topic would come out as its own H3
    // with a "---" before it and the fence broken in two.
    expect(mergeBatchSections([reply], "R")).toBe(
      "## R\n\n### Real Topic\n\n```python\n## not a heading\n### nor this\n```\n\n- item",
    );
  });

  it("closes an unclosed fence at the end of its own reply so it cannot swallow the next batch", () => {
    const a = "## R\n\n### A\n\n```mermaid\nflowchart TD\n  X --> Y";
    const b = "## R\n\n### B\n\n- rule from batch two";
    const merged = mergeBatchSections([a, b], "R");
    const fences = merged.split("\n").filter((l) => l.startsWith("```"));
    expect(fences).toEqual(["```mermaid", "```"]);
    expect(merged.indexOf("```", merged.indexOf("X --> Y"))).toBeLessThan(merged.indexOf("### B"));
    expect(merged).toMatch(/^### B$/m);
  });

  it("keeps a 20,000-char fence whole and intact", () => {
    const code = Array.from({ length: 800 }, (_, i) => `line ${i} = compute(${i}) # ### x`).join(
      "\n",
    );
    expect(code.length).toBeGreaterThan(20_000);
    const reply = `## R\n\n### Code\n\n\`\`\`sas\n${code}\n\`\`\`\n\n- after`;
    const merged = mergeBatchSections([reply, reply], "R");
    expect(merged).toContain(`\`\`\`sas\n${code}\n\`\`\``);
    expect(merged.split("line 799 = compute")).toHaveLength(2);
  });

  it("keeps a fence nested in a list item with the item", () => {
    const reply =
      "## R\n\n### T\n\n1. **Rule**\n   ```js\nif (x) {}\n   ```\n   - detail\n\n2. **Other**";
    const merged = mergeBatchSections([reply], "R");
    expect(merged).toContain("1. **Rule**\n   ```js\nif (x) {}\n   ```\n   - detail");
    expect(merged).toContain("2. **Other**");
  });
});

describe("mergeBatchSections — edges", () => {
  it("falls back to the group's heading when no reply has an H2", () => {
    expect(
      mergeBatchSections(["### T\n\n- a"], "Key Workflows").startsWith("## Key Workflows"),
    ).toBe(true);
  });

  it("treats a second H2 in one reply as a topic", () => {
    const merged = mergeBatchSections(["## R\n\n- a\n\n## Extra\n\n- b"], "R");
    expect(merged).toContain("### Extra");
    expect(merged.match(/^## /gm)).toHaveLength(1);
  });

  it("drops a topic whose every entry was a duplicate", () => {
    const a = "## R\n\n### T\n\n- a long enough rule that it is matched section wide ok";
    const b = "## R\n\n### U\n\n- a long enough rule that it is matched section wide ok";
    const merged = mergeBatchSections([a, b], "R");
    expect(merged).not.toContain("### U");
  });

  it("keeps an empty heading the model wrote with no content", () => {
    expect(mergeBatchSections(["## R\n\n### Empty\n\n#### Sub"], "R")).toContain(
      "### Empty\n\n#### Sub",
    );
  });

  it("returns only the heading for no replies", () => {
    expect(mergeBatchSections([], "R")).toBe("## R");
  });

  it("keeps a header-only table", () => {
    expect(mergeBatchSections(["## R\n\n| A | B |"], "R")).toContain("| A | B |");
  });

  it("keeps tight lists after a plain paragraph attached, and a loose one separate", () => {
    const a = "## R\n\n### T\n\nIntro sentence.\n- tight one\n\n- loose one";
    const b = "## R\n\n### T\n\n- loose one";
    const merged = mergeBatchSections([a, b], "R");
    expect(merged).toContain("Intro sentence.\n- tight one");
    expect(merged.match(/- loose one/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Faithfulness
// ---------------------------------------------------------------------------

const res = (over: Partial<FaithfulnessResult>): FaithfulnessResult => ({
  section: "s",
  totalClaims: 0,
  supportedClaims: 0,
  faithfulness: 1,
  verified: true,
  unsupportedClaims: [],
  supportedAttributions: [],
  ...over,
});

describe("aggregateFaithfulness", () => {
  it("pools claims across batches rather than averaging ratios", () => {
    const agg = aggregateFaithfulness("Rules", [
      res({
        totalClaims: 2,
        supportedClaims: 0,
        faithfulness: 0,
        unsupportedClaims: [{ claim: "x" }],
      }),
      res({ totalClaims: 198, supportedClaims: 198 }),
    ])!;
    expect(agg.totalClaims).toBe(200);
    expect(agg.supportedClaims).toBe(198);
    expect(agg.faithfulness).toBeCloseTo(0.99);
    expect(agg.verified).toBe(true);
    expect(agg.unsupportedClaims).toEqual([{ claim: "x" }]);
    expect(agg.section).toBe("Rules");
  });

  it("leaves unverified batches out of the score", () => {
    const agg = aggregateFaithfulness("Rules", [
      res({ totalClaims: 10, supportedClaims: 5, faithfulness: 0.5 }),
      res({ totalClaims: 90, supportedClaims: 90, verified: false }),
    ])!;
    expect(agg.faithfulness).toBe(0.5);
    expect(agg.totalClaims).toBe(10);
  });

  it("is unverified when no batch was verified", () => {
    const agg = aggregateFaithfulness("Rules", [res({ verified: false })])!;
    expect(agg.verified).toBe(false);
    expect(agg.faithfulness).toBe(1);
  });

  it("carries an unparseable or cut-off reply from any batch", () => {
    const verdicts = aggregateFaithfulness("s", [res({}), res({ unparseable: "verdicts" })])!;
    expect(verdicts.unparseable).toBe("verdicts");
    expect(verdicts.truncated).toBeUndefined();
    const claims = aggregateFaithfulness("s", [
      res({ unparseable: "verdicts" }),
      res({ unparseable: "claims", truncated: true, verified: false }),
    ])!;
    expect(claims.unparseable).toBe("claims");
    expect(claims.truncated).toBe(true);
  });

  it("returns null for no results", () => {
    expect(aggregateFaithfulness("s", [])).toBeNull();
  });
});
