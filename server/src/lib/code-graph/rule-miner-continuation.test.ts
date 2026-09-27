/**
 * Unit tests for the logical-line joiner the rule miners share (#170).
 */
import { describe, expect, it } from "vitest";
import {
  joinLogicalLine,
  MAX_CONTINUATION_LINES,
  MAX_LOGICAL_CHARS,
  opensBracket,
  operatorContinues,
} from "./rule-miner-continuation.js";

const lines = (src: string) => src.split("\n");

describe("joinLogicalLine", () => {
  it("joins a parenthesised condition up to its closing bracket", () => {
    const src = lines(
      `if (\n  a === undefined ||\n  a <= 0\n) throw new RangeError("x");\nnext();`,
    );
    expect(joinLogicalLine(src, 0, { comment: "//" })).toEqual({
      text: 'if ( a === undefined || a <= 0 ) throw new RangeError("x");',
      end: 3,
    });
  });

  it("returns null when the construct is complete on its own line", () => {
    expect(joinLogicalLine(lines(`if (a > 0) {\n  b();\n}`), 0, { comment: "//" })).toBeNull();
  });

  it("does not let a block-opening brace keep the join going, but counts a lambda inside the condition", () => {
    const src = lines(`if (xs.any {\n  it > 0\n}) {\n  return\n}`);
    expect(joinLogicalLine(src, 0, { comment: "//" })).toEqual({
      text: "if (xs.any { it > 0 }) {",
      end: 2,
    });
  });

  it("ignores brackets and comment markers inside strings, escapes and comments", () => {
    const src = lines(`check(a == "(" &&  // a ( in a comment\n  /\\/\\(/.test(b))\nafter()`);
    expect(joinLogicalLine(src, 0, { comment: "//" })).toEqual({
      text: 'check(a == "(" && /\\/\\(/.test(b))',
      end: 1,
    });
  });

  it("follows a Python backslash continuation and strips `#` comments", () => {
    const src = lines(`if a and \\\n        b > 1:  # tail (\n    raise X()`);
    expect(joinLogicalLine(src, 0, { comment: "#", backslash: true })).toEqual({
      text: "if a and b > 1:",
      end: 1,
    });
  });

  it("follows an operator continuation at depth 0", () => {
    const src = lines(`const fee = total > 100\n  ? 0\n  : 5;\nconst next = 1;`);
    expect(joinLogicalLine(src, 0, { comment: "//", continues: operatorContinues })).toEqual({
      text: "const fee = total > 100 ? 0 : 5;",
      end: 2,
    });
  });

  it("joins until a terminator is seen, and fails when it never is", () => {
    const hasSemi = (t: string) => t.includes(";");
    const src = lines(`if a > 1\n  and b < 2 then x = 1;\ny = 2;`);
    expect(joinLogicalLine(src, 0, { until: hasSemi })).toEqual({
      text: "if a > 1 and b < 2 then x = 1;",
      end: 1,
    });
    expect(joinLogicalLine(lines(`if a > 1\n  and b < 2`), 0, { until: hasSemi })).toBeNull();
  });

  it("gives up on a bracket that never closes within the look-ahead bound", () => {
    const src = [`if (`, ...Array.from({ length: MAX_CONTINUATION_LINES + 5 }, () => "a &&"), `b)`];
    expect(joinLogicalLine(src, 0, { comment: "//" })).toBeNull();
    // ...but the same construct inside the bound joins.
    const short = [
      `if (`,
      ...Array.from({ length: MAX_CONTINUATION_LINES - 2 }, () => "a &&"),
      `b)`,
    ];
    expect(joinLogicalLine(short, 0, { comment: "//" })?.end).toBe(MAX_CONTINUATION_LINES - 1);
  });

  it("returns what it has when only an operator continuation reaches the bound", () => {
    const src = Array.from({ length: MAX_CONTINUATION_LINES + 3 }, () => "a &&");
    expect(joinLogicalLine(src, 0, { continues: operatorContinues })?.end).toBe(
      MAX_CONTINUATION_LINES - 1,
    );
  });

  it("refuses a logical line longer than the character cap", () => {
    const long = "x".repeat(MAX_LOGICAL_CHARS);
    expect(joinLogicalLine([`if (`, long, `)`], 0)).toBeNull();
    expect(joinLogicalLine([`if (${long}`, `)`], 0)).toBeNull();
  });

  it("returns null for a start index past the end", () => {
    expect(joinLogicalLine(["a"], 3)).toBeNull();
  });

  it("is linear: joining from every line reads each line a bounded number of times", () => {
    // Counts line reads instead of timing them: a wall-clock budget here went
    // red under the monorepo test fan-out on a loaded machine with the code
    // unchanged (#1379 shape), and a read count is exact on any machine.
    // An unbounded look-ahead reads O(N) lines per start, O(N²) in total.
    const n = 5_000;
    const src = Array.from({ length: n }, (_, k) => (k % 2 ? "((((((((((" : "if (a &&"));
    let reads = 0;
    const counted = new Proxy(src, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    for (let i = 0; i < n; i++) joinLogicalLine(counted, i, { comment: "//" });
    // Each start scans at most MAX_CONTINUATION_LINES lines and peeks the next
    // one for an operator continuation: two reads per consumed line, plus one.
    // The bound is only a bound while the constant itself stays small.
    expect(MAX_CONTINUATION_LINES).toBeLessThanOrEqual(32);
    expect(reads).toBeLessThanOrEqual(n * (2 * MAX_CONTINUATION_LINES + 1));
  });
});

describe("opensBracket / operatorContinues", () => {
  it("reports an unclosed bracket only", () => {
    expect(opensBracket("if (a &&")).toBe(true);
    expect(opensBracket("if (a) {")).toBe(false);
    expect(opensBracket('x = "("')).toBe(false);
    expect(opensBracket("-- (", "--")).toBe(false);
    expect(opensBracket(`(${"x".repeat(MAX_LOGICAL_CHARS)}`)).toBe(false);
  });

  it("recognises leading and trailing operators", () => {
    expect(operatorContinues("a &&", "b")).toBe(true);
    expect(operatorContinues("x = a", "? b")).toBe(true);
    expect(operatorContinues("a", "|| b")).toBe(true);
    expect(operatorContinues("a;", "b()")).toBe(false);
    expect(operatorContinues("a", "// comment")).toBe(false);
  });
});
