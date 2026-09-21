/**
 * Epic #770 / Issue #775 — RFC 4180 CSV serialization tests.
 */
import { describe, expect, it } from "vitest";
import { toCsvField, toCsv } from "./csv.js";

describe("toCsvField", () => {
  it("leaves simple values unquoted", () => {
    expect(toCsvField("hello")).toBe("hello");
    expect(toCsvField(42)).toBe("42");
  });

  it("renders null/undefined as an empty field", () => {
    expect(toCsvField(null)).toBe("");
    expect(toCsvField(undefined)).toBe("");
  });

  it("quotes fields containing a comma", () => {
    expect(toCsvField("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles embedded double-quotes", () => {
    expect(toCsvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it("quotes fields containing newlines or carriage returns", () => {
    expect(toCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(toCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("neutralizes spreadsheet formula injection on risky leading characters", () => {
    // Leading =, +, -, @ are prefixed with a single quote so spreadsheets
    // render them as inert text instead of evaluating a formula.
    expect(toCsvField('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(toCsvField("+1+2")).toBe("'+1+2");
    expect(toCsvField("-5")).toBe("'-5");
    expect(toCsvField("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
  });

  it("does not alter safe leading characters", () => {
    expect(toCsvField("hello")).toBe("hello");
    expect(toCsvField("2026-06-09T00:00:00.000Z")).toBe("2026-06-09T00:00:00.000Z");
    expect(toCsvField('{"title":["a","b"]}')).toBe('"{""title"":[""a"",""b""]}"');
  });
});

describe("toCsv", () => {
  it("joins fields with commas and records with CRLF", () => {
    const csv = toCsv([
      ["version", "title"],
      ["1", "Hello"],
      ["2", "World"],
    ]);
    expect(csv).toBe("version,title\r\n1,Hello\r\n2,World");
  });

  it("quotes cells that need quoting within a row", () => {
    const csv = toCsv([["a", 'b,"c"']]);
    expect(csv).toBe('a,"b,""c"""');
  });
});
