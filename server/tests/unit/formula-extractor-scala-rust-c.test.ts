/**
 * Issue #161 — formula extraction for Scala, Rust, C and C++: constants and
 * arithmetic assignments. Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { extractFormulas } from "../../src/lib/code-graph/formula-extractor.js";

const pick = (src: string, lang: Parameters<typeof extractFormulas>[2]) =>
  extractFormulas(src, "f", lang).map((f) => [f.kind, f.name, f.expression, f.startLine]);

describe("extractFormulas — Scala", () => {
  it("reads capitalised literal vals as constants and arithmetic vals as calculations", () => {
    const src = [
      "object Pricing {",
      "  final val VatRate: Double = 0.2",
      "  val MaxItems = 50",
      "  val lower = 3",
      "  def total(net: Double) = {",
      "    val gross: Double = net * (1 + VatRate) - discount",
      '    val label = "a + b + c + d"',
      "    gross",
      "  }",
      "}",
    ].join("\n");
    expect(pick(src, "scala")).toEqual([
      ["constant", "VatRate", "0.2", 2],
      ["constant", "MaxItems", "50", 3],
      ["arithmetic", "gross", "net * (1 + VatRate) - discount", 6],
    ]);
  });
});

describe("extractFormulas — Rust", () => {
  it("reads const/static literals and let calculations, not comparisons", () => {
    const src = [
      "pub const MAX_ITEMS: usize = 50;",
      "static FEE: f64 = 2.5;",
      "fn total(net: f64) -> f64 {",
      "    let gross: f64 = net * (1.0 + VAT_RATE) - discount;",
      "    let ok = gross >= MIN_TOTAL && gross <= MAX_TOTAL;",
      "    total += gross * 2;",
      "    gross",
      "}",
    ].join("\n");
    expect(pick(src, "rs")).toEqual([
      ["constant", "MAX_ITEMS", "50", 1],
      ["constant", "FEE", "2.5", 2],
      ["arithmetic", "gross", "net * (1.0 + VAT_RATE) - discount", 4],
    ]);
  });
});

describe("extractFormulas — C / C++", () => {
  it("reads #define and const literals and calculations; skips compound and comparison operators", () => {
    const src = [
      "#define MAX_ITEMS 50",
      "#define LIMIT (MAX_ITEMS * UNIT_PRICE + 10)",
      "#define SQUARE(x) ((x) * (x))",
      "static const double VAT_RATE = 0.2;",
      "double gross = net * (1.0 + VAT_RATE) - discount; // with VAT",
      "total += gross * 2;",
      "if (gross == limit * 2 + offset) { }",
      "int arr[COUNT] = {1, 2, 3};",
    ].join("\n");
    const expected = [
      ["constant", "MAX_ITEMS", "50", 1],
      ["arithmetic", "LIMIT", "(MAX_ITEMS * UNIT_PRICE + 10)", 2],
      ["constant", "VAT_RATE", "0.2", 4],
      ["arithmetic", "gross", "net * (1.0 + VAT_RATE) - discount", 5],
    ];
    expect(pick(src, "c")).toEqual(expected);
    expect(pick(src, "cpp")).toEqual(expected);
  });

  it("stays linear on long lines without a plain `=`", () => {
    const n = 50_000;
    const inputs = [
      `${"==".repeat(n)}`,
      `x${" ".repeat(n)}= 1`,
      `#define A${" ".repeat(n)}`,
      `${"a".repeat(n)}]=1`,
    ];
    const start = performance.now();
    for (const src of inputs)
      for (const lang of ["scala", "rs", "c", "cpp"] as const) extractFormulas(src, "f", lang);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
