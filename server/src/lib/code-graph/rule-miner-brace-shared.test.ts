/**
 * Issue #161 — the scanning helpers shared by the Scala, Rust and C/C++ miners.
 */
import { describe, expect, it } from "vitest";
import {
  BODY_LOOKAHEAD,
  blockBody,
  braceDelta,
  comparesToConstant,
  constantLabel,
  firstTopLevelBrace,
  isLiteralValue,
  splitParen,
  splitTopLevel,
  trailingIdentifier,
} from "./rule-miner-brace-shared.js";

describe("blockBody", () => {
  it("returns the top-level statements of a braced, Allman or unbraced body", () => {
    expect(blockBody(["if (a) {", "  log(x);", "  return f(", "    y);", "}"], 0)).toEqual([
      "log(x);",
      "return f(",
    ]);
    expect(blockBody(["if (a)", "{", "  return 1;", "}"], 0)).toEqual(["return 1;"]);
    expect(blockBody(["if (a)", "  // why", "  return 1;", "next();"], 0)).toEqual(["return 1;"]);
  });

  it("ignores braces and parentheses inside string and char literals", () => {
    expect(blockBody(["if (a) {", "  f(\"}\", '(');", "  return 1;", "}"], 0)).toEqual([
      "f(\"}\", '(');",
      "return 1;",
    ]);
  });

  it("reads at most BODY_LOOKAHEAD lines past the header (the linear bound)", () => {
    const lines = ["if (a) {", ...Array.from({ length: 5 * BODY_LOOKAHEAD }, () => "  x();")];
    let reads = 0;
    const counted = new Proxy(lines, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    blockBody(counted, 0);
    expect(BODY_LOOKAHEAD).toBeLessThanOrEqual(100);
    expect(reads).toBeLessThanOrEqual(BODY_LOOKAHEAD + 1);
  });
});

describe("splitParen / splitTopLevel / firstTopLevelBrace", () => {
  it("splits a head at its matching parenthesis, skipping literals", () => {
    expect(splitParen("if (a(\")\") && c == ')') { x", 4)).toEqual({
      cond: "a(\")\") && c == ')'",
      rest: "{ x",
    });
    expect(splitParen("if (a && (b", 4)).toBeNull();
  });

  it("treats a Rust lifetime quote as a plain character", () => {
    expect(splitParen("f(x: &'a str) {", 2)).toEqual({ cond: "x: &'a str", rest: "{" });
  });

  it("splits on a separator only outside brackets and strings", () => {
    expect(splitTopLevel('a(b, c), "d, e", [f, g]', ",")).toEqual(["a(b, c)", '"d, e"', "[f, g]"]);
    expect(splitTopLevel("A | B(x | y) | C", "|")).toEqual(["A", "B(x | y)", "C"]);
  });

  it("finds the block brace outside brackets", () => {
    const t = "if xs.iter().any(|x| { x > 0 }) {";
    expect(firstTopLevelBrace(t, 3)).toBe(t.length - 1);
    expect(firstTopLevelBrace("if a", 3)).toBe(-1);
  });
});

describe("braceDelta", () => {
  it("counts braces outside strings, char literals and a trailing comment", () => {
    expect(braceDelta('x => { println!("{}", "}"); } // }')).toBe(0);
    expect(braceDelta("switch (c) { case '{':")).toBe(1);
    expect(braceDelta("}")).toBe(-1);
  });
});

describe("literals, labels and comparisons", () => {
  it("recognises literal constant values", () => {
    for (const v of [
      "50",
      "-1",
      "0.2f64",
      "1_000",
      "(50)",
      '"EUR"',
      "'x'",
      "true",
      "0x1F",
      "10'000",
    ]) {
      expect(isLiteralValue(v)).toBe(true);
    }
    for (const v of ["compute()", "A + 1", "Duration::from_secs(3)", ""]) {
      expect(isLiteralValue(v)).toBe(false);
    }
  });

  it("keeps constant dispatch labels and drops bindings, wildcards and Option/Result", () => {
    expect(constantLabel("Status::Open")).toBe("Status::Open");
    expect(constantLabel("Event::Paid { amount }")).toBe("Event::Paid");
    expect(constantLabel("Paid(x)")).toBe("Paid");
    expect(constantLabel("OPEN")).toBe("OPEN");
    expect(constantLabel("0..=9")).toBe("0..=9");
    expect(constantLabel('"cancelled"')).toBe('"cancelled"');
    for (const l of ["_", "x", "Some(x)", "None", "Ok(v)", "Err(e)", "e: IOException"]) {
      expect(constantLabel(l)).toBeNull();
    }
  });

  it("detects comparisons against literals and named constants only", () => {
    expect(comparesToConstant("total > 100")).toBe(true);
    expect(comparesToConstant("s == Status::Open")).toBe(true);
    expect(comparesToConstant("n < kLimit")).toBe(true);
    expect(comparesToConstant("a > b")).toBe(false);
  });

  it("reads the identifier that ends a declaration", () => {
    expect(trailingIdentifier("static const double RATE ")).toBe("RATE");
    expect(trailingIdentifier("x[3]")).toBe("");
    expect(trailingIdentifier("9lives")).toBe("");
  });
});
