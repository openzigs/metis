import { describe, it, expect } from "vitest";
import { extractFirstJson } from "./json-extract.js";

describe("extractFirstJson", () => {
  it("parses clean JSON objects and arrays (fast path)", () => {
    expect(extractFirstJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractFirstJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("strips a ```json fence (the historical happy path)", () => {
    expect(extractFirstJson('```json\n{"verdicts":[]}\n```')).toEqual({ verdicts: [] });
    expect(extractFirstJson('```\n{"claims":[]}\n```')).toEqual({ claims: [] });
  });

  it("recovers JSON preceded by prose (the unparseable-batch fix)", () => {
    expect(extractFirstJson('Here are the verdicts:\n{"verdicts":[{"claim":"x"}]}')).toEqual({
      verdicts: [{ claim: "x" }],
    });
  });

  it("recovers JSON followed by a trailing sign-off", () => {
    expect(extractFirstJson('{"claims":[]}\n\nLet me know if you need anything else.')).toEqual({
      claims: [],
    });
  });

  it("recovers prose-wrapped, fenced JSON (prefix + ```json + suffix)", () => {
    const raw =
      'Sure! Here you go:\n```json\n{"verdicts":[{"claim":"a","supported":true}]}\n```\nDone.';
    expect(extractFirstJson(raw)).toEqual({ verdicts: [{ claim: "a", supported: true }] });
  });

  it("is string-aware: braces inside string values do not break the span", () => {
    const raw = '{"claim":"mitigate when offer > cost { trigger }","supported":false}';
    expect(extractFirstJson(raw)).toEqual({
      claim: "mitigate when offer > cost { trigger }",
      supported: false,
    });
  });

  it("ignores a stray closing brace in trailing prose", () => {
    expect(extractFirstJson('{"a":1} (note: ranges use [a,b} notation)')).toEqual({ a: 1 });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractFirstJson('prefix {"claim":"he said \\"hi\\"","ok":true} suffix')).toEqual({
      claim: 'he said "hi"',
      ok: true,
    });
  });

  it("extracts a nested object correctly", () => {
    expect(extractFirstJson('x {"a":{"b":[1,{"c":2}]}} y')).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it("returns null when there is no JSON at all", () => {
    expect(extractFirstJson("not json at all")).toBeNull();
    expect(extractFirstJson("")).toBeNull();
    expect(extractFirstJson("   \n  ")).toBeNull();
  });

  it("returns null for truncated/unbalanced JSON (no matching close)", () => {
    expect(extractFirstJson('{"verdicts":[{"claim":"x",')).toBeNull();
  });

  it("returns null for non-string input (defensive)", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(extractFirstJson(null)).toBeNull();
    // @ts-expect-error — exercising the runtime guard
    expect(extractFirstJson(42)).toBeNull();
  });
});
