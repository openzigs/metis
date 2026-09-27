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

describe("mineTsRules — conditions that span lines (#170)", () => {
  it("mines the issue's multi-line guard whole, anchored at the `if` line", () => {
    const src = [
      "function ftp(athlete: Athlete) {",
      "  if (",
      "    athlete.thresholdPower === undefined ||",
      "    athlete.thresholdPower <= 0",
      '  ) throw new RangeError("threshold power must be positive");',
      "}",
    ].join("\n");
    const rules = mineTsRules(src, FILE, 10);
    const guard = rules.find((r) => r.kind === "guard")!;
    expect(guard.line).toBe(11);
    expect(guard.summary).toBe(
      "Rejects when athlete.thresholdPower === undefined || athlete.thresholdPower <= 0",
    );
    // The throw on the closing line is still its own rule, as before.
    expect(rules.find((r) => r.kind === "throw")?.line).toBe(14);
  });

  it("reads a K&R block guard whose condition continues on the next line", () => {
    const src = [
      'if (tier === "gold" &&',
      "    total > 1000) {",
      "  return total * 0.8;",
      "}",
    ].join("\n");
    const [guard] = mineTsRules(src, FILE, 1).filter((r) => r.kind === "guard");
    expect(guard).toMatchObject({
      line: 1,
      summary: 'Rejects/exits when tier === "gold" && total > 1000',
    });
  });

  it("reads a threshold ternary whose branches are on later lines", () => {
    const src = ["const shipping = total > 250", "  ? 0", "  : 12;"].join("\n");
    const [guard] = mineTsRules(src, FILE, 1).filter((r) => r.kind === "guard");
    expect(guard).toMatchObject({ line: 1, summary: "Branches on threshold total > 250" });
  });

  it("reads a ternary that starts on the line after the assignment", () => {
    const src = ["const band =", '  total >= 10000 ? "enterprise" : "retail";'].join("\n");
    const [guard] = mineTsRules(src, FILE, 1).filter((r) => r.kind === "guard");
    expect(guard).toMatchObject({ line: 1, summary: "Branches on threshold total >= 10000" });
  });

  it("does not read JSX or a call's arguments as a ternary", () => {
    const src = [
      'const el = (<p className="x">',
      "  {items.length === 1 ? 'one' : 'many'}",
      "</p>);",
    ].join("\n");
    // Line 2 is mined on its own as before; nothing is attributed to line 1.
    expect(mineTsRules(src, FILE, 1).filter((r) => r.line === 1)).toEqual([]);
  });

  it("reads a zod chain continued on `.method()` lines, but not an object's fields", () => {
    const src = [
      "const S = z.object({",
      "  name: z",
      "    .string()",
      "    .min(2)",
      "    .max(80),",
      "  email: z.string().email(),",
      "});",
    ].join("\n");
    const rules = mineTsRules(src, FILE, 1).filter((r) => r.kind === "schema-constraint");
    expect(rules.map((r) => [r.line, r.summary])).toEqual([
      [2, "Field `name` schema constraints: min, max"],
      [6, "Field `email` schema constraints: email"],
    ]);
  });

  it("reads a thrown error's message from the next line", () => {
    const src = ["throw new ValidationError(", '  "total must be finite",', ");"].join("\n");
    expect(mineTsRules(src, FILE, 1)[0]).toMatchObject({
      kind: "throw",
      line: 1,
      summary: "Throws ValidationError: total must be finite",
    });
  });

  it("keeps a single-line guard containing a regex literal (`\\/\\/` is not a comment)", () => {
    const src = [
      'if (typeof url !== "string" || !/^https?:\\/\\//i.test(url)) {',
      "  return null;",
      "}",
      "const x = 1;",
    ].join("\n");
    expect(mineTsRules(src, FILE, 1).find((r) => r.kind === "guard")?.summary).toBe(
      'Rejects/exits when typeof url !== "string" || !/^https?:\\/\\//i.test(url)',
    );
  });

  it("stays linear on adversarial multi-line input (ReDoS)", () => {
    const n = 4000;
    const inputs = [
      // An unclosed condition on every line: each join is bounded.
      Array.from({ length: 20_000 }, () => "if (a &&").join("\n"),
      // A `=` run then whitespace after the line's only `?`: the old ternary
      // regex `/=\s*(.+?)\s*\?/` was cubic here (2 s at 2,000 characters).
      `x ? y : 1 > 2 ${"=".repeat(n / 2)}${" ".repeat(n / 2)}z`,
      `const x = ${"=a".repeat(n / 4)}${" ".repeat(n / 2)}\n  ? 1\n  : 2;`,
      `const s = z\n${"  .min(1)\n".repeat(20)}`,
      `throw new E(\n${" ".repeat(n)}\n"m")`,
    ];
    const start = performance.now();
    for (const src of inputs) mineTsRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("mineTsRules — typed multi-line ternary (#170)", () => {
  it("reads a ternary on a typed declaration", () => {
    const src = ["const fee: number = total > 100", "  ? 0", "  : 5;"].join("\n");
    expect(mineTsRules(src, FILE, 1)[0]).toMatchObject({
      kind: "guard",
      line: 1,
      summary: "Branches on threshold total > 100",
    });
  });

  it("stays linear on a long typed-declaration head with no `=` (ReDoS)", () => {
    const start = performance.now();
    mineTsRules(`const x: ${" ".repeat(100_000)}T`, FILE, 1);
    mineTsRules(`const x${" ".repeat(100_000)}T`, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
