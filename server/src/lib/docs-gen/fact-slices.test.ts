/**
 * #154 / #155 — the pure contracts behind topic-sliced Phase-1 facts and the
 * persisted mined-rule inventory. No DB, no model.
 */
import { describe, expect, it } from "vitest";
import {
  FACT_SLICES,
  countFactBullets,
  dedupeRulesAgainstMined,
  parsePersistedMinedRules,
  renderMinedRuleInventory,
  sliceModuleFacts,
  toPersistedMinedRules,
  type PersistedMinedRule,
} from "./fact-slices.js";

const FULL = `PURPOSE
Handles payments.

ENTITIES
- \`Payment\` — amount, currency

RULES
- Amount must be positive
- Currency must be ISO-4217

WORKFLOWS
1. Authorise
2. Capture

FORMULAS
- fee = amount * 0.029

INTEGRATIONS
- Stripe — charges

KEY_APIS
- \`charge(amount)\` — takes a payment

STATUS_TRANSITIONS
- \`pending\` → \`captured\` — on capture

NOTES
- Retries are idempotent`;

describe("sliceModuleFacts (#154)", () => {
  it("routes each Phase-1 heading to its topic slice", () => {
    const s = sliceModuleFacts(FULL);
    expect(s.summary).toBe("PURPOSE\nHandles payments.");
    expect(s.entities).toContain("`Payment`");
    expect(s.rules).toContain("Amount must be positive");
    expect(s.workflows).toContain("1. Authorise");
    expect(s.formulas).toContain("fee = amount * 0.029");
    expect(s.integrations).toContain("Stripe");
    expect(s.capabilities).toContain("charge(amount)");
    expect(s.notes).toContain("Retries are idempotent");
  });

  it("keeps each topic out of the slices it does not belong to", () => {
    const s = sliceModuleFacts(FULL);
    expect(s.rules).not.toContain("Stripe");
    expect(s.rules).not.toContain("fee =");
    expect(s.integrations).not.toContain("Amount must be positive");
    expect(s.summary).not.toContain("Retries are idempotent");
  });

  it("sends STATUS_TRANSITIONS to both rules and workflows, DATA_LINEAGE to workflows and entities", () => {
    const s = sliceModuleFacts(`${FULL}\n\nDATA_LINEAGE\n- reads raw.orders`);
    expect(s.rules).toContain("`pending` → `captured`");
    expect(s.workflows).toContain("`pending` → `captured`");
    expect(s.workflows).toContain("reads raw.orders");
    expect(s.entities).toContain("reads raw.orders");
    expect(s.rules).not.toContain("reads raw.orders");
  });

  it("falls back to the WHOLE text in summary when no heading is recognised", () => {
    const text =
      "Here are some facts about the module:\n- it validates amounts\n- it charges cards";
    const s = sliceModuleFacts(text);
    expect(s.summary).toBe(text);
    for (const slice of FACT_SLICES) if (slice !== "summary") expect(s[slice]).toBe("");
  });

  it("keeps preamble text before the first heading in summary", () => {
    const s = sliceModuleFacts("Okay, here are the facts.\n\nRULES\n- x must be set");
    expect(s.summary).toBe("Okay, here are the facts.");
    expect(s.rules).toBe("RULES\n- x must be set");
  });

  it("tolerates decorated headings from small local models", () => {
    const s = sliceModuleFacts("## PURPOSE\nA.\n\n**RULES**\n- r1\n\nKEY APIS:\n- api1");
    expect(s.summary).toContain("A.");
    expect(s.rules).toBe("RULES\n- r1");
    expect(s.capabilities).toBe("KEY_APIS\n- api1");
  });

  it("concatenates a repeated heading instead of keeping only the last block", () => {
    const s = sliceModuleFacts("WORKFLOWS\n(none)\n\nRULES\n- r\n\nWORKFLOWS\n- mined step 1");
    expect(s.workflows).toBe("WORKFLOWS\n- mined step 1");
    const two = sliceModuleFacts("WORKFLOWS\n- a\n\nRULES\n- r\n\nWORKFLOWS\n- b");
    expect(two.workflows).toBe("WORKFLOWS\n- a\n\nWORKFLOWS\n- b");
  });

  it("drops empty and '(none)' blocks so they do not burn section budget", () => {
    const s = sliceModuleFacts(
      "PURPOSE\nx\n\nRULES\n(none extracted in offline mode)\n\nFORMULAS\nnone\n\nNOTES\n",
    );
    expect(s.rules).toBe("");
    expect(s.formulas).toBe("");
    expect(s.notes).toBe("");
  });

  it("keeps a repeated bullet once (a model stuck in a repetition loop)", () => {
    const looped = `RULES\n${Array.from({ length: 50 }, () => "- same rule").join("\n")}\n- other rule`;
    const s = sliceModuleFacts(looped);
    expect(s.rules).toBe("RULES\n- same rule\n- other rule");
  });

  it("does not drop a bullet from workflows just because rules already has it", () => {
    const s = sliceModuleFacts("RULES\n- a → b\n\nWORKFLOWS\n- a → b");
    expect(s.rules).toBe("RULES\n- a → b");
    expect(s.workflows).toBe("WORKFLOWS\n- a → b");
  });

  it("keeps a shared heading's bullet in the slice that has not seen it yet", () => {
    // STATUS_TRANSITIONS feeds rules AND workflows; rules already has the bullet.
    const s = sliceModuleFacts("RULES\n- a → b\n\nSTATUS_TRANSITIONS\n- a → b");
    expect(s.rules).toBe("RULES\n- a → b\n\nSTATUS_TRANSITIONS\n- a → b");
    expect(s.workflows).toBe("STATUS_TRANSITIONS\n- a → b");
  });
});

describe("countFactBullets", () => {
  it("counts dash, star, bullet and numbered items only", () => {
    expect(countFactBullets("RULES\n- a\n* b\n• c\n1. d\nprose line")).toBe(4);
  });
});

const rule = (over: Partial<PersistedMinedRule> = {}): PersistedMinedRule => ({
  language: "ts",
  kind: "guard",
  expression: "if (amount <= 0) throw new Error('bad')",
  summary: "Rejects non-positive amounts",
  file: "src/pay.ts",
  line: 12,
  context: "pay",
  ...over,
});

describe("toPersistedMinedRules / parsePersistedMinedRules (#155)", () => {
  it("normalises a miner's rule into the language-neutral shape and round-trips it", () => {
    const persisted = toPersistedMinedRules("go", [
      {
        kind: "guard",
        expression: "if x < 0",
        summary: "neg",
        filePath: "a.go",
        line: 3,
        context: null,
      },
    ]);
    expect(persisted).toEqual([
      {
        language: "go",
        kind: "guard",
        expression: "if x < 0",
        summary: "neg",
        file: "a.go",
        line: 3,
        context: null,
      },
    ]);
    expect(parsePersistedMinedRules(JSON.stringify(persisted))).toEqual(persisted);
  });

  it("rejects a legacy Java-only row (miner shape, no language) so the caller re-mines", () => {
    const legacy = [{ kind: "throw", expression: "x", summary: "y", filePath: "A.java", line: 1 }];
    expect(parsePersistedMinedRules(JSON.stringify(legacy))).toBeNull();
  });

  it("rejects malformed JSON, non-arrays, unknown languages and empty input", () => {
    expect(parsePersistedMinedRules("{not json")).toBeNull();
    expect(parsePersistedMinedRules('{"a":1}')).toBeNull();
    expect(
      parsePersistedMinedRules(JSON.stringify([rule({ language: "cobol" as never })])),
    ).toBeNull();
    expect(parsePersistedMinedRules("")).toBeNull();
    expect(parsePersistedMinedRules(undefined)).toBeNull();
  });

  it("accepts an empty inventory as a valid (not legacy) row", () => {
    expect(parsePersistedMinedRules("[]")).toEqual([]);
  });
});

describe("dedupeRulesAgainstMined (#155)", () => {
  it("removes an LLM bullet that quotes a mined expression", () => {
    const slice = "RULES\n- Guard: `if (amount <= 0) throw new Error('bad')` rejects\n- Keep me";
    expect(dedupeRulesAgainstMined(slice, [rule()])).toBe("RULES\n- Keep me");
  });

  it("matches across whitespace and case differences", () => {
    const slice = "RULES\n- IF (AMOUNT <=   0) THROW new error('bad') is enforced";
    expect(dedupeRulesAgainstMined(slice, [rule()])).toBe("RULES");
  });

  it("removes an LLM bullet that names the mined rule's file:line", () => {
    const slice = "RULES\n- Amounts must be positive (src/pay.ts:12)\n- Other";
    expect(dedupeRulesAgainstMined(slice, [rule()])).toBe("RULES\n- Other");
  });

  it("does not treat a short, generic expression as a duplicate", () => {
    const slice = "RULES\n- Retry while x > 0 holds";
    expect(dedupeRulesAgainstMined(slice, [rule({ expression: "x > 0", line: 99 })])).toBe(slice);
  });

  it("never removes headings or prose, and is a no-op without mined rules", () => {
    const slice = "RULES\nif (amount <= 0) throw new Error('bad') appears in prose";
    expect(dedupeRulesAgainstMined(slice, [rule()])).toBe(slice);
    expect(dedupeRulesAgainstMined("RULES\n- a", [])).toBe("RULES\n- a");
  });
});

describe("renderMinedRuleInventory (#155)", () => {
  it("renders every rule with its language, kind, expression and file:line", () => {
    const out = renderMinedRuleInventory([
      rule(),
      rule({
        language: "sql",
        kind: "check",
        expression: "CHECK (qty > 0)",
        file: "db/a.sql",
        line: 4,
      }),
    ]);
    expect(out.split("\n")[0]).toMatch(/^MINED_RULES .*2 rule/);
    expect(out).toContain("[ts guard] `if (amount <= 0) throw new Error('bad')`");
    expect(out).toContain("(src/pay.ts:12)");
    expect(out).toContain("[sql check] `CHECK (qty > 0)`");
    expect(out).toContain("(db/a.sql:4)");
  });

  it("states how many rules did not fit the budget instead of dropping them silently", () => {
    const many = Array.from({ length: 50 }, (_, i) => rule({ line: i + 1 }));
    const out = renderMinedRuleInventory(many, 600);
    expect(out.length).toBeLessThan(700);
    const shown = out.split("\n").filter((l) => l.includes("(src/pay.ts:")).length;
    expect(out).toContain(`(${50 - shown} more mined rule(s) omitted to fit the budget)`);
  });

  it("is empty when there is nothing mined", () => {
    expect(renderMinedRuleInventory([])).toBe("");
  });
});
