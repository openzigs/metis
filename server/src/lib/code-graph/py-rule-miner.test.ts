/**
 * Unit tests for the Python rule miner (#274).
 *
 * Prove the deterministic miner surfaces the categories of Python business
 * logic the LLM tends to gloss over: if/elif guards & validations,
 * raise/assert conditions, comparison/threshold constants, pydantic
 * Field()/validator constraints, and early returns — while NOT over-capturing
 * ordinary control flow.
 */
import { describe, expect, it } from "vitest";
import { minePyRules, renderMinedPyRules, type MinedPyRule } from "./py-rule-miner.js";

const FILE = "app/services/pricing.py";

function kinds(rules: MinedPyRule[]): Set<string> {
  return new Set(rules.map((r) => r.kind));
}
function byKind(rules: MinedPyRule[], k: MinedPyRule["kind"]): MinedPyRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("minePyRules", () => {
  it("mines an if guard that raises", () => {
    const src = [`if amount <= 0:`, `    raise ValueError("amount must be positive")`].join("\n");
    const rules = minePyRules(src, FILE, 1, "pricing.compute");
    const g = byKind(rules, "guard");
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g[0].summary).toMatch(/amount <= 0/);
    expect(g[0].line).toBe(1);
    expect(g[0].context).toBe("pricing.compute");
  });

  it("mines elif validation conditions", () => {
    const src = [
      `if tier == "gold":`,
      `    rate = 0.1`,
      `elif balance < 100:`,
      `    raise ValueError("insufficient balance")`,
    ].join("\n");
    const rules = minePyRules(src, FILE, 1);
    const conds = byKind(rules, "guard");
    expect(conds.some((r) => r.expression.includes("balance < 100"))).toBe(true);
  });

  it("mines raise with its condition/message", () => {
    const rules = minePyRules(`raise PermissionError("user not allowed")`, FILE, 5);
    const r = byKind(rules, "raise");
    expect(r).toHaveLength(1);
    expect(r[0].summary).toMatch(/PermissionError/);
    expect(r[0].summary).toContain("user not allowed");
    expect(r[0].line).toBe(5);
  });

  it("mines assert statements with their condition", () => {
    const rules = minePyRules(`assert qty > 0, "qty must be positive"`, FILE, 3);
    const a = byKind(rules, "assert");
    expect(a).toHaveLength(1);
    expect(a[0].summary).toMatch(/qty > 0/);
  });

  it("mines pydantic Field constraints (gt/le/max_length/regex)", () => {
    const src = [
      `age: int = Field(..., gt=0, le=120)`,
      `name: str = Field(..., max_length=255, min_length=1)`,
      `code: str = Field(..., pattern=r"^[A-Z]{3}$")`,
    ].join("\n");
    const rules = minePyRules(src, FILE, 1);
    const f = byKind(rules, "field-constraint");
    expect(f.length).toBe(3);
    expect(f[0].summary).toContain("gt=0");
    expect(f[0].summary).toContain("le=120");
    expect(f[1].summary).toContain("max_length=255");
    expect(f[2].summary).toMatch(/pattern/);
  });

  it("mines multi-line pydantic Field constraints (#278)", () => {
    const src = [
      `score: int = Field(`,
      `    ...,`,
      `    gt=0,`,
      `    le=100,`,
      `    description="normalized score",`,
      `)`,
    ].join("\n");
    const rules = minePyRules(src, FILE, 1);
    const f = byKind(rules, "field-constraint");
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f[0].summary).toContain("score");
    expect(f[0].summary).toContain("gt=0");
    expect(f[0].summary).toContain("le=100");
    // The rule is anchored at the field's opening line.
    expect(f[0].line).toBe(1);
  });

  it("does NOT treat a multi-line Field without constraints as a constraint (#278)", () => {
    const src = [
      `label: str = Field(`,
      `    default="x",`,
      `    description="just a label",`,
      `)`,
    ].join("\n");
    const rules = minePyRules(src, FILE, 1);
    expect(byKind(rules, "field-constraint")).toHaveLength(0);
  });

  it("mines validator decorators", () => {
    const src = [`@field_validator("email")`, `def check_email(cls, v):`].join("\n");
    const rules = minePyRules(src, FILE, 1);
    const d = byKind(rules, "validator");
    expect(d).toHaveLength(1);
    expect(d[0].summary).toMatch(/field_validator/);
    expect(d[0].summary).toContain("email");
  });

  it("mines comparison/threshold constants in guards", () => {
    const rules = minePyRules(`if score >= 0.8:\n    flag = True`, FILE, 1);
    const g = byKind(rules, "guard");
    expect(g.some((r) => r.expression.includes("score >= 0.8"))).toBe(true);
  });

  it("mines early returns guarded by a condition", () => {
    const src = [`if not user.active:`, `    return None`].join("\n");
    const rules = minePyRules(src, FILE, 1);
    // Either captured as a guard (the if condition with early return) — must be present.
    expect(rules.some((r) => r.expression.includes("not user.active"))).toBe(true);
    expect(kinds(rules)).toContain("early-return");
  });

  it("does NOT over-capture ordinary if statements without a rule-bearing body", () => {
    const src = [`if verbose:`, `    print("hello")`, `    log.info("done")`].join("\n");
    const rules = minePyRules(src, FILE, 1);
    // A plain logging branch is not a business rule — should not be flagged
    // as a guard (no raise/return/assert in its short body).
    expect(byKind(rules, "guard")).toHaveLength(0);
    expect(byKind(rules, "early-return")).toHaveLength(0);
  });

  it("ignores plain assignments, comments, and blanks", () => {
    const src = [`# compute total`, ``, `total = a + b`, `x = foo()`].join("\n");
    expect(minePyRules(src, FILE, 1)).toHaveLength(0);
  });

  it("reports accurate line numbers offset from baseLine", () => {
    const src = [`x = 1`, `raise RuntimeError("boom")`].join("\n");
    const rules = minePyRules(src, FILE, 100);
    const r = byKind(rules, "raise");
    expect(r[0].line).toBe(101);
  });

  it("truncates a runaway expression to keep the prompt budget bounded", () => {
    const long = `if ${"a == 1 and ".repeat(80)}b == 2:\n    raise ValueError("x")`;
    const rules = minePyRules(long, FILE, 1);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].expression.length).toBeLessThanOrEqual(200);
  });

  it("handles a realistic validator slice end to end", () => {
    const src = [
      `class Order(BaseModel):`,
      `    qty: int = Field(..., gt=0, le=1000)`,
      `    coupon: str = Field(default="", max_length=16)`,
      ``,
      `    @field_validator("qty")`,
      `    def check_qty(cls, v):`,
      `        if v % 5 != 0:`,
      `            raise ValueError("qty must be a multiple of 5")`,
      `        return v`,
    ].join("\n");
    const rules = minePyRules(src, FILE, 1, "Order");
    const ks = kinds(rules);
    expect(ks).toContain("field-constraint");
    expect(ks).toContain("validator");
    expect(ks).toContain("guard");
    expect(ks).toContain("raise");
  });
});

describe("renderMinedPyRules", () => {
  it("returns empty string for no rules", () => {
    expect(renderMinedPyRules([])).toBe("");
  });

  it("groups rules under labelled headings", () => {
    const src = [
      `age: int = Field(..., gt=0)`,
      `@validator("x")`,
      `if y < 0:`,
      `    raise ValueError("neg")`,
      `assert z > 0`,
    ].join("\n");
    const rules = minePyRules(src, FILE, 1);
    const out = renderMinedPyRules(rules);
    expect(out).toContain("Field constraints");
    expect(out).toContain("Validator decorators");
    expect(out).toMatch(/Guards|Raises|Assertions/);
  });

  it("honours the maxChars budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `raise ValueError("e${i}")`).join("\n");
    const rules = minePyRules(many, FILE, 1);
    const out = renderMinedPyRules(rules, 500);
    expect(out.length).toBeLessThan(700);
    expect(out).toMatch(/truncated for prompt budget/);
  });
});
