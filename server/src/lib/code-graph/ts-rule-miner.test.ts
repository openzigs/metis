/**
 * Unit tests for the TypeScript/JavaScript rule miner (#274).
 *
 * Prove the deterministic miner surfaces TS business logic: if/ternary guards,
 * thrown-error conditions, zod schema constraints, enum/union constraints, and
 * numeric/string constants — while NOT over-capturing ordinary control flow.
 */
import { describe, expect, it } from "vitest";
import { mineTsRules, renderMinedTsRules, type MinedTsRule } from "./ts-rule-miner.js";

const FILE = "src/services/order.ts";

function kinds(rules: MinedTsRule[]): Set<string> {
  return new Set(rules.map((r) => r.kind));
}
function byKind(rules: MinedTsRule[], k: MinedTsRule["kind"]): MinedTsRule[] {
  return rules.filter((r) => r.kind === k);
}

describe("mineTsRules", () => {
  it("mines an if guard that throws", () => {
    const src = [
      `if (amount <= 0) {`,
      `  throw new ValidationError("amount must be positive");`,
      `}`,
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1, "OrderService.charge");
    const g = byKind(rules, "guard");
    expect(g.length).toBeGreaterThanOrEqual(1);
    expect(g[0].summary).toMatch(/amount <= 0/);
    expect(g[0].context).toBe("OrderService.charge");
  });

  it("mines thrown-error conditions", () => {
    const src = [
      `throw new NotFoundError("user not found");`,
      `throw new Error(\`bad status \${s}\`);`,
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1);
    const t = byKind(rules, "throw");
    expect(t).toHaveLength(2);
    expect(t[0].summary).toContain("NotFoundError");
    expect(t[0].summary).toContain("user not found");
  });

  it("mines zod schema constraints", () => {
    const src = [
      `const Schema = z.object({`,
      `  email: z.string().email(),`,
      `  age: z.number().gte(18).lte(120),`,
      `  name: z.string().min(1).max(255),`,
      `  code: z.string().regex(/^[A-Z]{3}$/),`,
      `  role: z.enum(["admin", "user"]),`,
      `});`,
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1);
    const z = byKind(rules, "schema-constraint");
    expect(z.length).toBeGreaterThanOrEqual(5);
    expect(z.some((r) => r.summary.includes("email"))).toBe(true);
    expect(z.some((r) => r.summary.includes("gte"))).toBe(true);
    expect(z.some((r) => r.summary.includes("regex"))).toBe(true);
    expect(z.some((r) => r.summary.includes("enum"))).toBe(true);
  });

  it("mines numeric/string constants", () => {
    const src = [`const MAX_RETRIES = 5;`, `const STATUS = "active";`].join("\n");
    const rules = mineTsRules(src, FILE, 1);
    const c = byKind(rules, "const");
    expect(c).toHaveLength(2);
    expect(c[0].summary).toContain("MAX_RETRIES");
    expect(c[0].summary).toContain("5");
  });

  it("mines a threshold ternary", () => {
    const rules = mineTsRules(`const tier = score >= 0.8 ? "gold" : "std";`, FILE, 1);
    expect(byKind(rules, "guard").some((r) => r.expression.includes("score >= 0.8"))).toBe(true);
  });

  it("mines enum/union type constraints", () => {
    const rules = mineTsRules(`type Status = "open" | "closed" | "archived";`, FILE, 1);
    const u = byKind(rules, "union");
    expect(u).toHaveLength(1);
    expect(u[0].summary).toContain("open");
  });

  it("mines a single-value literal-narrowed type as a constraint (#278)", () => {
    // A single string-literal type expresses a real constraint (the only
    // allowed value) and should be captured.
    const rules = mineTsRules(`type Mode = "strict";`, FILE, 1);
    const u = byKind(rules, "union");
    expect(u).toHaveLength(1);
    expect(u[0].summary).toContain("Mode");
    expect(u[0].summary).toContain("strict");
  });

  it("mines a narrow two-member literal union as a constraint (#278)", () => {
    const rules = mineTsRules(`export type Toggle = "on" | "off";`, FILE, 1);
    const u = byKind(rules, "union");
    expect(u).toHaveLength(1);
    expect(u[0].summary).toContain("Toggle");
    expect(u[0].summary).toContain("on");
    expect(u[0].summary).toContain("off");
  });

  it("does NOT mine a trivial/structural type alias as a union constraint (#278)", () => {
    // Aliases to primitives or object/function types carry no value-domain
    // constraint and must not flood the inventory.
    const src = [
      `type Id = string;`,
      `type Handler = (req: Request) => void;`,
      `type Config = { a: number; b: string };`,
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1);
    expect(byKind(rules, "union")).toHaveLength(0);
  });

  it("does NOT over-capture an ordinary if with a plain body", () => {
    const src = [`if (verbose) {`, `  console.log("hi");`, `}`].join("\n");
    const rules = mineTsRules(src, FILE, 1);
    expect(byKind(rules, "guard")).toHaveLength(0);
  });

  it("ignores plain assignments, comments, and blanks", () => {
    const src = [`// total`, ``, `const total = a + b;`, `let x = foo();`].join("\n");
    expect(mineTsRules(src, FILE, 1)).toHaveLength(0);
  });

  it("reports accurate line numbers offset from baseLine", () => {
    const src = [`const x = 1;`, `throw new Error("boom");`].join("\n");
    const rules = mineTsRules(src, FILE, 100);
    expect(byKind(rules, "throw")[0].line).toBe(101);
  });

  it("truncates a runaway expression", () => {
    const long = `if (${"a === 1 && ".repeat(80)}b === 2) {\n  throw new Error("x");\n}`;
    const rules = mineTsRules(long, FILE, 1);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].expression.length).toBeLessThanOrEqual(200);
  });

  it("handles a realistic service slice end to end", () => {
    const src = [
      `const MAX_ITEMS = 100;`,
      `type Kind = "fast" | "slow";`,
      `const ReqSchema = z.object({ qty: z.number().positive() });`,
      `function add(req: Req) {`,
      `  if (req.qty <= 0) {`,
      `    throw new ValidationError("qty must be positive");`,
      `  }`,
      `  return req;`,
      `}`,
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1, "add");
    const ks = kinds(rules);
    expect(ks).toContain("const");
    expect(ks).toContain("union");
    expect(ks).toContain("schema-constraint");
    expect(ks).toContain("guard");
    expect(ks).toContain("throw");
  });
});

describe("renderMinedTsRules", () => {
  it("returns empty string for no rules", () => {
    expect(renderMinedTsRules([])).toBe("");
  });

  it("groups rules under labelled headings", () => {
    const src = [
      `const MAX = 5;`,
      `type S = "a" | "b";`,
      `const Z = z.string().min(1);`,
      `if (x <= 0) { throw new Error("bad"); }`,
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1);
    const out = renderMinedTsRules(rules);
    expect(out).toMatch(/Constants|Union|Schema|Guards|Throws/);
  });

  it("honours the maxChars budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `throw new Error("e${i}");`).join("\n");
    const rules = mineTsRules(many, FILE, 1);
    const out = renderMinedTsRules(rules, 500);
    expect(out.length).toBeLessThan(700);
    expect(out).toMatch(/truncated for prompt budget/);
  });
});
