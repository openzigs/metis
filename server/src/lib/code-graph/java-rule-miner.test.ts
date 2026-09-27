/**
 * Unit tests for the Java rule miner — single-line baseline and the
 * multi-line statements #170 added.
 */
import { describe, expect, it } from "vitest";
import { mineJavaRules, renderMinedRules } from "./java-rule-miner.js";

const FILE = "src/main/java/com/acme/Pricing.java";

describe("mineJavaRules — single-line rules", () => {
  it("mines annotations, preconditions, throws, switches and null guards", () => {
    const src = [
      "@NotNull @Size(min = 1, max = 20) private String code;",
      'Preconditions.checkArgument(qty > 0, "qty must be positive");',
      'if (qty > 1000) throw new IllegalStateException("too many");',
      "switch (status) {",
      "  case OPEN: break;",
      "  case CLOSED: break;",
      "}",
      "if (code == null) {",
      '  throw new IllegalArgumentException("code is required");',
      "}",
    ].join("\n");
    const rules = mineJavaRules(src, FILE, 1);
    expect(rules.map((r) => [r.kind, r.line])).toEqual([
      ["annotation-validation", 1],
      ["annotation-validation", 1],
      ["precondition", 2],
      ["precondition", 2],
      ["throw", 3],
      ["switch-case", 4],
      ["null-guard", 8],
      ["throw", 9],
    ]);
    expect(renderMinedRules(rules)).toContain("State Machines (switch/case)");
  });
});

describe("mineJavaRules — statements that span lines (#170)", () => {
  it("mines a precondition whose arguments are on the following lines", () => {
    const src = [
      "Preconditions.checkArgument(",
      "    qty <= 500,",
      '    "qty must be at most 500");',
    ].join("\n");
    const rules = mineJavaRules(src, FILE, 7);
    expect(rules[0]).toMatchObject({
      kind: "precondition",
      line: 7,
      summary: 'Guava precondition: qty <= 500, "qty must be at most 500"',
    });
  });

  it("reads a thrown exception's message from the next line", () => {
    const src = [
      "throw new UnsupportedOperationException(",
      '    "pricing is not supported");',
    ].join("\n");
    expect(mineJavaRules(src, FILE, 1)).toEqual([
      expect.objectContaining({
        kind: "throw",
        line: 1,
        summary: "Throws UnsupportedOperationException: pricing is not supported",
      }),
    ]);
  });

  it("mines a null guard whose condition spans lines", () => {
    const src = ["if (", "    currency == null", ") {", "  return;", "}"].join("\n");
    expect(mineJavaRules(src, FILE, 1)).toEqual([
      expect.objectContaining({
        kind: "null-guard",
        line: 1,
        summary: "Null guard on `currency` with early exit",
      }),
    ]);
  });

  it("reads a validation annotation's arguments across lines", () => {
    const src = [
      "@Pattern(",
      '    regexp = "^[A-Z]{3}$",',
      '    message = "code must be three letters")',
      "private String currency;",
    ].join("\n");
    expect(mineJavaRules(src, FILE, 1)[0]).toMatchObject({
      line: 1,
      summary: 'Regex constraint: regexp = "^[A-Z]{3}$", message = "code must be three letters"',
    });
  });

  it("attributes a construct that starts on a continuation line to that line, once", () => {
    const src = [
      "return combine(",
      '    Objects.requireNonNull(a, "a"),',
      '    Objects.requireNonNull(b, "b"));',
    ].join("\n");
    const nullGuards = mineJavaRules(src, FILE, 1).filter((r) =>
      r.summary.startsWith("Null guard"),
    );
    expect(nullGuards.map((r) => r.line)).toEqual([2, 3]);
  });

  it("stays linear on adversarial multi-line input (ReDoS)", () => {
    const inputs = [
      Array.from({ length: 2_000 }, () => "Preconditions.checkArgument(").join("\n"),
      Array.from({ length: 2_000 }, () => "@Size(").join("\n"),
      `throw new XException(\n${" ".repeat(4000)}\n"m");`,
    ];
    const start = performance.now();
    for (const src of inputs) mineJavaRules(src, FILE, 1);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
