/**
 * Clarifying-question CSV round-trip (Business Analyst export/import).
 *
 * A BA exports the current round's clarifying questions to a CSV, fills the
 * `answer` column offline, and re-uploads it. METIS parses the answers and
 * applies them through the EXISTING clarification submit path (matching by
 * `questionId`). This module is a pure (no-I/O) serializer/parser so it is
 * fully unit-testable.
 *
 * Security: every exported cell is run through the injection-safe RFC-4180
 * helpers in ../requirements/csv.ts (`toCsvField` → `neutralizeFormula`), so a
 * user-controlled requirement title / question text that begins with `=`, `+`,
 * `-`, `@`, TAB, or CR is neutralized (prefixed with a single quote) and never
 * evaluated as a spreadsheet formula. On import the parser enforces row + cell
 * bounds to cap memory and reject obviously malformed documents.
 */
import Papa from "papaparse";
import { toCsvField } from "../requirements/csv.js";

/** One exported row — one clarifying question, with a blank `answer` to fill. */
export interface ClarifyExportRow {
  questionId: string;
  requirement: string;
  ambiguityField: string;
  question: string;
  /** Suggested (grounded) answer, empty when the question is open. */
  suggestedAnswer: string;
  /** Blank on export; the BA fills this offline. */
  answer: string;
}

/** Exact, ordered CSV column header. The import parser keys off these names. */
const COLUMNS = [
  "questionId",
  "requirement",
  "ambiguityField",
  "question",
  "suggestedAnswer",
  "answer",
] as const;

/** Typed error for any import-side validation failure (bad headers, bounds). */
export class ClarifyCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClarifyCsvError";
  }
}

/**
 * Serialize export rows to an RFC-4180, injection-safe CSV document.
 * Cell serialization is delegated to `toCsvField` so escaping is shared with
 * the existing requirements CSV export — never re-implemented here.
 */
export function serializeClarifyCsv(rows: ClarifyExportRow[]): string {
  const lines: string[] = [COLUMNS.map((c) => toCsvField(c)).join(",")];
  for (const r of rows) {
    lines.push(
      [
        toCsvField(r.questionId),
        toCsvField(r.requirement),
        toCsvField(r.ambiguityField),
        toCsvField(r.question),
        toCsvField(r.suggestedAnswer),
        toCsvField(r.answer),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}

/** Passthrough JSON view of the export rows (for `format=json`). */
export function serializeClarifyJson(rows: ClarifyExportRow[]): ClarifyExportRow[] {
  return rows;
}

export interface ParseClarifyOptions {
  /** Maximum number of data rows accepted (DoS guard). */
  maxRows: number;
  /** Maximum characters allowed in any single cell (DoS guard). */
  maxCellChars: number;
}

export interface ParsedClarifyRow {
  questionId: string;
  answer: string;
}

/**
 * Parse an uploaded CSV into `{ questionId, answer }` pairs, returning only
 * rows whose `answer` is non-empty after trimming. Throws {@link ClarifyCsvError}
 * on missing required columns, unparseable input, or a bounds violation.
 */
export function parseClarifyCsv(
  text: string,
  { maxRows, maxCellChars }: ParseClarifyOptions,
): { rows: ParsedClarifyRow[] } {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });

  // Header check: PapaParse exposes the parsed header order in meta.fields.
  const fields = result.meta.fields ?? [];
  if (!fields.includes("questionId") || !fields.includes("answer")) {
    throw new ClarifyCsvError(
      "CSV must include a 'questionId' and an 'answer' column. " +
        "Export the questions from METIS to get a correctly formatted template.",
    );
  }

  const data = result.data;
  if (data.length > maxRows) {
    throw new ClarifyCsvError(`CSV exceeds the maximum of ${maxRows} rows.`);
  }

  const rows: ParsedClarifyRow[] = [];
  for (const record of data) {
    // Cell-size bound across every column guards against pathological input.
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value.length > maxCellChars) {
        throw new ClarifyCsvError(`A CSV cell exceeds the maximum of ${maxCellChars} characters.`);
      }
    }
    const questionId = (record.questionId ?? "").trim();
    const answer = (record.answer ?? "").trim();
    if (!questionId) continue; // structurally empty row — ignore.
    if (!answer) continue; // unanswered question — skip on import.
    rows.push({ questionId, answer });
  }

  return { rows };
}
