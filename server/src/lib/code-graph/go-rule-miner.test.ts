/**
 * Unit tests for the Go rule miner (#274).
 *
 * Prove the deterministic miner surfaces Go business logic: guard clauses
 * (`if x { return err }`), validation conditions, switch business branches,
 * sentinel / errors.New / fmt.Errorf failure conditions, and const thresholds —
 * while NOT over-capturing ordinary control flow.
 */
import { describe, expect, it } from "vitest";
import { mineGoRules, renderMinedGoRules, type MinedGoRule } from "./go-rule-miner.js";

const FILE = "internal/billing/charge.go";

function kinds(rules: MinedGoRule[]): Set<string> {
  return new Set(rules.map((r) => r.kind));
}
function byKind(rules: MinedGoRule[], k: MinedGoRule["kind"]): MinedGoRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("mineGoRules", () => {
  it("mines an inline guard clause that returns an error", () => {
    const rules = mineGoRules(`if amount <= 0 { return ErrInvalidAmount }`, FILE, 1, "Charge");
    const g = byKind(rules, "guard");
    expect(g).toHaveLength(1);
    expect(g[0].summary).toMatch(/amount <= 0/);
    expect(g[0].line).toBe(1);
    expect(g[0].context).toBe("Charge");
  });

  it("mines a multi-line guard whose body returns an error", () => {
    const src = [`if err := validate(req); err != nil {`, `    return err`, `}`].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    expect(byKind(rules, "guard").length).toBeGreaterThanOrEqual(1);
  });

  it("mines errors.New / fmt.Errorf failure conditions", () => {
    const src = [
      `return errors.New("user not found")`,
      `return fmt.Errorf("invalid status %q", s)`,
    ].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    const e = byKind(rules, "error");
    expect(e).toHaveLength(2);
    expect(e[0].summary).toContain("user not found");
    expect(e[1].summary).toMatch(/invalid status/);
  });

  it("mines switch business branches", () => {
    const src = [
      `switch status {`,
      `case "active":`,
      `    return true`,
      `case "suspended":`,
      `    return false`,
      `}`,
    ].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    const sw = byKind(rules, "switch-case");
    expect(sw).toHaveLength(1);
    expect(sw[0].summary).toMatch(/status/);
    expect(sw[0].summary).toMatch(/active/);
  });

  it("mines const thresholds", () => {
    const src = [`const MaxRetries = 5`, `const minBalance = 100.0`].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    const c = byKind(rules, "const");
    expect(c).toHaveLength(2);
    expect(c[0].summary).toContain("MaxRetries");
    expect(c[0].summary).toContain("5");
  });

  it("mines grouped `const ( ... )` blocks (#278)", () => {
    const src = [
      `const (`,
      `    MaxRetries = 5`,
      `    MinBalance = 100.0`,
      `    DefaultRegion = "us-east-1"`,
      `)`,
    ].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    const c = byKind(rules, "const");
    expect(c.length).toBeGreaterThanOrEqual(3);
    expect(c.some((r) => r.summary.includes("MaxRetries") && r.summary.includes("5"))).toBe(true);
    expect(c.some((r) => r.summary.includes("MinBalance"))).toBe(true);
    expect(c.some((r) => r.summary.includes("DefaultRegion"))).toBe(true);
    // Line numbers point at the individual const lines, not the `const (` line.
    expect(c.find((r) => r.summary.includes("MaxRetries"))?.line).toBe(2);
    expect(c.find((r) => r.summary.includes("DefaultRegion"))?.line).toBe(4);
  });

  it("handles typed and iota entries inside a grouped const block (#278)", () => {
    const src = [
      `const (`,
      `    StatusActive Status = "active"`,
      `    StatusClosed Status = "closed"`,
      `)`,
    ].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    const c = byKind(rules, "const");
    expect(c.some((r) => r.summary.includes("StatusActive"))).toBe(true);
    expect(c.some((r) => r.summary.includes("StatusClosed"))).toBe(true);
  });

  it("mines a threshold guard even when the body is not an error return", () => {
    const rules = mineGoRules(`if score >= 0.8 {`, FILE, 1);
    expect(byKind(rules, "guard").some((r) => r.expression.includes("score >= 0.8"))).toBe(true);
  });

  it("does NOT over-capture an ordinary if with a plain body", () => {
    const src = [`if ok {`, `    log.Println("done")`, `}`].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    expect(byKind(rules, "guard")).toHaveLength(0);
  });

  it("ignores plain assignments, comments, and blanks", () => {
    const src = [`// add totals`, ``, `total := a + b`, `x := foo()`].join("\n");
    expect(mineGoRules(src, FILE, 1)).toHaveLength(0);
  });

  it("reports accurate line numbers offset from baseLine", () => {
    const src = [`x := 1`, `return errors.New("boom")`].join("\n");
    const rules = mineGoRules(src, FILE, 100);
    expect(byKind(rules, "error")[0].line).toBe(101);
  });

  it("truncates a runaway expression", () => {
    const long = `if ${"a == 1 && ".repeat(80)}b == 2 { return err }`;
    const rules = mineGoRules(long, FILE, 1);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].expression.length).toBeLessThanOrEqual(200);
  });

  it("handles a realistic handler slice end to end", () => {
    const src = [
      `const MaxItems = 100`,
      `func (s *Service) Add(req Req) error {`,
      `    if req.Qty <= 0 {`,
      `        return ErrInvalidQty`,
      `    }`,
      `    if len(req.Items) > MaxItems {`,
      `        return fmt.Errorf("too many items: %d", len(req.Items))`,
      `    }`,
      `    switch req.Kind {`,
      `    case "fast":`,
      `        return s.fast(req)`,
      `    case "slow":`,
      `        return s.slow(req)`,
      `    }`,
      `    return nil`,
      `}`,
    ].join("\n");
    const rules = mineGoRules(src, FILE, 1, "Service.Add");
    const ks = kinds(rules);
    expect(ks).toContain("const");
    expect(ks).toContain("guard");
    expect(ks).toContain("error");
    expect(ks).toContain("switch-case");
  });
});

describe("renderMinedGoRules", () => {
  it("returns empty string for no rules", () => {
    expect(renderMinedGoRules([])).toBe("");
  });

  it("groups rules under labelled headings", () => {
    const src = [
      `const Max = 5`,
      `if x <= 0 { return ErrBad }`,
      `return errors.New("nope")`,
      `switch s {`,
      `case "a":`,
      `}`,
    ].join("\n");
    const rules = mineGoRules(src, FILE, 1);
    const out = renderMinedGoRules(rules);
    expect(out).toMatch(/Constants|Guards|Errors|State/);
  });

  it("honours the maxChars budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `return errors.New("e${i}")`).join("\n");
    const rules = mineGoRules(many, FILE, 1);
    const out = renderMinedGoRules(rules, 500);
    expect(out.length).toBeLessThan(700);
    expect(out).toMatch(/truncated for prompt budget/);
  });
});
