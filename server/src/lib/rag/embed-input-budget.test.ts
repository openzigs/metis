/**
 * Issue #201 — the byte bound that stands in for a token bound on non-ASCII text.
 */
import { describe, expect, it } from "vitest";
import {
  EMBED_INPUT_MAX_BYTES,
  EMBED_SEQUENCE_SPECIAL_TOKENS,
  MAX_EMBED_SEQUENCE_TOKENS,
  exceedsEmbedInputBudget,
  splitToByteBudget,
  utf8ByteLength,
} from "./embed-input-budget.js";
import { MAX_EMBED_SEQUENCE_TOKENS as FROM_EMBEDDER } from "./embedder.js";

const bytes = utf8ByteLength;

describe("embed input budget (#201)", () => {
  it("leaves room for the special tokens inside the model's sequence cap", () => {
    expect(EMBED_INPUT_MAX_BYTES + EMBED_SEQUENCE_SPECIAL_TOKENS).toBe(MAX_EMBED_SEQUENCE_TOKENS);
    // The embedder re-exports the same cap its tokenizer is lowered to.
    expect(FROM_EMBEDDER).toBe(MAX_EMBED_SEQUENCE_TOKENS);
  });

  it("measures UTF-8 bytes, not UTF-16 code units", () => {
    expect(bytes("abc")).toBe(3);
    expect(bytes("検")).toBe(3);
    expect(bytes("😀")).toBe(4);
    expect("😀".length).toBe(2);
  });

  it("flags only non-ASCII text over the byte budget", () => {
    // 2,048 ASCII characters: exempt — the character window already bounds it.
    expect(exceedsEmbedInputBudget("a".repeat(MAX_EMBED_SEQUENCE_TOKENS))).toBe(false);
    expect(exceedsEmbedInputBudget("a".repeat(10_000))).toBe(false);
    // 700 CJK characters = 2,100 bytes: over.
    expect(exceedsEmbedInputBudget("検".repeat(700))).toBe(true);
    // 682 CJK characters = 2,046 bytes: exactly at the budget, allowed.
    expect(bytes("検".repeat(682))).toBe(EMBED_INPUT_MAX_BYTES);
    expect(exceedsEmbedInputBudget("検".repeat(682))).toBe(false);
    // One non-ASCII character is enough to make a long chunk subject to the bound.
    expect(exceedsEmbedInputBudget(`${"a".repeat(2046)}é`)).toBe(true);
  });

  it("splits at line breaks first, losing nothing", () => {
    const line = `${"検".repeat(300)}\n`; // 901 bytes
    const text = line.repeat(5);
    const pieces = splitToByteBudget(text);
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((p) => bytes(p) <= EMBED_INPUT_MAX_BYTES)).toBe(true);
    // Two whole lines per piece (1,802 bytes); a third would exceed 2,046.
    expect(pieces.map((p) => p.split("\n").length - 1)).toEqual([2, 2, 1]);
  });

  it("cuts one over-long line at code points, never inside a surrogate pair", () => {
    const text = "😀".repeat(1000); // 4,000 bytes, no newline
    const pieces = splitToByteBudget(text, 10);
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((p) => bytes(p) <= 10)).toBe(true);
    expect(pieces.every((p) => !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(pieces[0]).toBe("😀😀");
  });

  it("returns short text whole and mixes line and code-point cuts in order", () => {
    expect(splitToByteBudget("short")).toEqual(["short"]);
    const text = `ab\n${"検".repeat(5)}\ncd`;
    const pieces = splitToByteBudget(text, 7);
    expect(pieces.join("")).toBe(text);
    expect(pieces).toEqual(["ab\n", "検検", "検検", "検\ncd"]);
  });

  it("refuses a budget that cannot hold one code point", () => {
    expect(() => splitToByteBudget("検検", 3)).toThrow(RangeError);
  });
});
