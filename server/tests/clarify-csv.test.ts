/**
 * Unit tests for the clarify-csv round-trip serializer/parser.
 *
 * The Business Analyst CSV export/import feature reuses the injection-safe RFC
 * 4180 helpers from ../src/lib/requirements/csv.ts. These tests pin the exact
 * header contract, per-question row mapping, injection neutralization, RFC-4180
 * quoting, round-trip recovery of questionId + answer, blank-row skipping, and
 * the validation bounds (maxRows / maxCellChars) + error signalling.
 */
import { describe, it, expect } from "vitest";
import {
  serializeClarifyCsv,
  serializeClarifyJson,
  parseClarifyCsv,
  ClarifyCsvError,
  type ClarifyExportRow,
} from "../src/lib/analysis/clarify-csv.js";

const HEADER = "questionId,requirement,ambiguityField,question,suggestedAnswer,answer";

function row(overrides: Partial<ClarifyExportRow> = {}): ClarifyExportRow {
  return {
    questionId: "q-1",
    requirement: "Audit logging",
    ambiguityField: "retention",
    question: "How long should logs be retained?",
    suggestedAnswer: "",
    answer: "",
    ...overrides,
  };
}

describe("serializeClarifyCsv", () => {
  it("emits the exact header row", () => {
    const csv = serializeClarifyCsv([row()]);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(HEADER);
  });

  it("emits one row per question with questionId, requirement, suggestedAnswer mapped", () => {
    const csv = serializeClarifyCsv([
      row({ questionId: "q-a", requirement: "Req A", suggestedAnswer: "7 years" }),
      row({ questionId: "q-b", requirement: "Req B", suggestedAnswer: "" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3); // header + 2
    expect(lines[1]!.startsWith("q-a,Req A,retention,")).toBe(true);
    expect(lines[1]!.endsWith(",7 years,")).toBe(true); // suggestedAnswer set, answer blank
    expect(lines[2]!.startsWith("q-b,Req B,retention,")).toBe(true);
    expect(lines[2]!.endsWith(",,")).toBe(true); // suggestedAnswer + answer both blank
  });

  it("neutralizes spreadsheet formula injection on leading = + - @ TAB CR", () => {
    for (const trigger of ["=cmd", "+cmd", "-cmd", "@cmd", "\tcmd", "\rcmd"]) {
      const csv = serializeClarifyCsv([row({ requirement: trigger })]);
      const dataLine = csv.split("\r\n")[0] === HEADER ? csv.slice(HEADER.length + 2) : csv;
      // Neutralized: a single quote is prefixed so spreadsheets render it inert.
      expect(dataLine).toContain(`'${trigger}`);
      // The raw trigger must never appear at the start of an unquoted cell.
      expect(dataLine.startsWith("q-1,=")).toBe(false);
      expect(dataLine.startsWith("q-1,+")).toBe(false);
      expect(dataLine.startsWith("q-1,@")).toBe(false);
    }
  });

  it("RFC-4180 quotes cells containing comma, quote, or newline", () => {
    const csv = serializeClarifyCsv([row({ question: 'has, comma and "quote"' })]);
    const dataLine = csv.split("\r\n")[1]!;
    expect(dataLine).toContain('"has, comma and ""quote"""');
  });
});

describe("serializeClarifyJson", () => {
  it("passes rows through unchanged", () => {
    const rows = [row({ questionId: "q-x", answer: "kept" })];
    expect(serializeClarifyJson(rows)).toEqual(rows);
  });
});

describe("parseClarifyCsv", () => {
  const bounds = { maxRows: 5000, maxCellChars: 10000 };

  it("round-trips: parse recovers questionId + answer from a serialized + filled doc", () => {
    const csv = serializeClarifyCsv([
      row({ questionId: "q-a", answer: "30 days" }),
      row({ questionId: "q-b", answer: "indefinitely" }),
    ]);
    const { rows } = parseClarifyCsv(csv, bounds);
    expect(rows).toEqual([
      { questionId: "q-a", answer: "30 days" },
      { questionId: "q-b", answer: "indefinitely" },
    ]);
  });

  it("recovers values that required RFC-4180 quoting", () => {
    const csv = serializeClarifyCsv([
      row({ questionId: "q-a", answer: 'keep, with "quotes"\nand newline' }),
    ]);
    const { rows } = parseClarifyCsv(csv, bounds);
    expect(rows).toEqual([{ questionId: "q-a", answer: 'keep, with "quotes"\nand newline' }]);
  });

  it("skips rows whose answer is blank or whitespace-only", () => {
    const csv = serializeClarifyCsv([
      row({ questionId: "q-a", answer: "" }),
      row({ questionId: "q-b", answer: "   " }),
      row({ questionId: "q-c", answer: "real" }),
    ]);
    const { rows } = parseClarifyCsv(csv, bounds);
    expect(rows).toEqual([{ questionId: "q-c", answer: "real" }]);
  });

  it("trims surrounding whitespace from recovered answers", () => {
    const csv = `${HEADER}\r\nq-a,Req,field,Q,, padded \r\n`;
    const { rows } = parseClarifyCsv(csv, bounds);
    expect(rows).toEqual([{ questionId: "q-a", answer: "padded" }]);
  });

  it("throws ClarifyCsvError when the questionId column is missing", () => {
    const csv = "requirement,ambiguityField,question,suggestedAnswer,answer\r\na,b,c,d,e";
    expect(() => parseClarifyCsv(csv, bounds)).toThrow(ClarifyCsvError);
  });

  it("throws ClarifyCsvError when the answer column is missing", () => {
    const csv = "questionId,requirement,ambiguityField,question,suggestedAnswer\r\na,b,c,d,e";
    expect(() => parseClarifyCsv(csv, bounds)).toThrow(ClarifyCsvError);
  });

  it("throws ClarifyCsvError on garbage / non-CSV input", () => {
    expect(() => parseClarifyCsv("\u0000 not a csv at all", bounds)).toThrow(ClarifyCsvError);
  });

  it("enforces the maxRows bound", () => {
    const many = Array.from({ length: 11 }, (_, i) => row({ questionId: `q-${i}`, answer: "x" }));
    const csv = serializeClarifyCsv(many);
    expect(() => parseClarifyCsv(csv, { maxRows: 10, maxCellChars: 10000 })).toThrow(
      ClarifyCsvError,
    );
  });

  it("enforces the maxCellChars bound", () => {
    const csv = serializeClarifyCsv([row({ questionId: "q-a", answer: "x".repeat(50) })]);
    expect(() => parseClarifyCsv(csv, { maxRows: 5000, maxCellChars: 10 })).toThrow(
      ClarifyCsvError,
    );
  });

  it("ignores fully empty trailing lines (skipEmptyLines)", () => {
    const csv = `${HEADER}\r\nq-a,Req,field,Q,,answered\r\n\r\n`;
    const { rows } = parseClarifyCsv(csv, bounds);
    expect(rows).toEqual([{ questionId: "q-a", answer: "answered" }]);
  });
});
