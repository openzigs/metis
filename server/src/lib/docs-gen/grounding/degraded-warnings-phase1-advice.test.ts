/**
 * #191 (M1) — every Phase-1 warning's one-line summary gives advice that
 * matches its cause. The Phase-1 warnings added by #188 shared a kind and a
 * section label with other causes, so `summarizeWarnings` told an operator to
 * raise DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS for skipped long lines, to re-ingest
 * the project for a permission error, and counted a module's failed fact
 * extraction as a failed SECTION. Each case below is checked through the real
 * `summarizeWarnings` and `deriveDocStatus`.
 */
import { describe, expect, it } from "vitest";
import {
  deriveDocStatus,
  factsTruncatedWarning,
  FORMULA_EXTRACTION_SECTION,
  formulaLinesSkippedWarning,
  PHASE1_FACTS_SECTION,
  phase1ChunksFailedWarning,
  phase1FactsTruncatedWarning,
  sectionFailedWarning,
  sourceUnavailableWarning,
  SQL_FILES_SECTION,
  sqlFilesSkippedWarning,
  sqlScanIncompleteWarning,
  summarizeWarnings,
  type DocWarning,
} from "./degraded-warnings.js";

/** Advice that belongs to one cause each; no other cause may print it. */
const ADVICE = {
  outputCap: "raise DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS",
  reingest: "re-ingest",
  factsCap: "_FACTS_CHAR_CAP",
  sectionFailed: "section(s) failed to generate",
  formula: "formula pre-extraction skipped",
  sqlFiles: "SQL file(s) or director",
  sqlScan: "SQL-only-directory scan",
  phase1Failed: "fact extraction failed for all or part of",
} as const;
type Advice = keyof typeof ADVICE;

const CASES: Array<{
  name: string;
  warning: DocWarning;
  advice: Advice;
  prefix: "Needs review" | "Degraded output";
}> = [
  {
    name: "Phase-1 output truncation",
    warning: phase1FactsTruncatedWarning(["m"]),
    advice: "outputCap",
    prefix: "Needs review",
  },
  {
    name: "per-section facts cap",
    warning: factsTruncatedWarning("Business Rules", 2, 3, 1000, "bedrock"),
    advice: "factsCap",
    prefix: "Needs review",
  },
  {
    name: "source unavailable",
    warning: sourceUnavailableWarning(1, 2),
    advice: "reingest",
    prefix: "Degraded output",
  },
  {
    name: "failed section",
    warning: sectionFailedWarning("Overview", "timed out"),
    advice: "sectionFailed",
    prefix: "Needs review",
  },
  {
    name: "skipped long-line formula extraction",
    warning: formulaLinesSkippedWarning([{ module: "vendor/bundle", lines: 2 }], 10_000),
    advice: "formula",
    prefix: "Needs review",
  },
  {
    name: "unreadable .sql files",
    warning: sqlFilesSkippedWarning(["db/locked.sql"]),
    advice: "sqlFiles",
    prefix: "Degraded output",
  },
  {
    name: "unlistable module directory",
    warning: sqlFilesSkippedWarning([], ["db"]),
    advice: "sqlFiles",
    prefix: "Degraded output",
  },
  {
    name: "SQL scan stopped at its bound",
    warning: sqlScanIncompleteWarning("repo", {
      visited: 100_000,
      truncated: true,
      unreadable: [],
    }),
    advice: "sqlScan",
    prefix: "Degraded output",
  },
  {
    name: "SQL scan with unreadable directories",
    warning: sqlScanIncompleteWarning("repo", { visited: 9, truncated: false, unreadable: ["x"] }),
    advice: "sqlScan",
    prefix: "Degraded output",
  },
  {
    name: "failed Phase-1 chunks",
    warning: phase1ChunksFailedWarning(["m"]),
    advice: "phase1Failed",
    prefix: "Needs review",
  },
];

describe("#191 — each Phase-1 warning's summary advice matches its cause", () => {
  for (const c of CASES) {
    it(`${c.name}: its own advice, and no other cause's`, () => {
      const summary = summarizeWarnings([c.warning]);
      expect(summary.startsWith(`${c.prefix} — `)).toBe(true);
      expect(summary).toContain(ADVICE[c.advice]);
      for (const [other, text] of Object.entries(ADVICE)) {
        if (other !== c.advice) expect(summary).not.toContain(text);
      }
      // Every warning is reported: none is silently a clean `ready`.
      expect(deriveDocStatus([c.warning])).toBe("degraded");
    });
  }

  it("gives every cause its own line when they all occur together", () => {
    const summary = summarizeWarnings(CASES.map((c) => c.warning));
    for (const text of Object.values(ADVICE)) {
      expect(summary.split(text).length - 1).toBe(1);
    }
  });

  it("uses one constant per section label, never a repeated literal", () => {
    expect(phase1FactsTruncatedWarning(["m"]).section).toBe(PHASE1_FACTS_SECTION);
    expect(phase1ChunksFailedWarning(["m"]).section).toBe(PHASE1_FACTS_SECTION);
    expect(sqlFilesSkippedWarning(["a.sql"]).section).toBe(SQL_FILES_SECTION);
    expect(formulaLinesSkippedWarning([{ module: "m", lines: 1 }], 10).section).toBe(
      FORMULA_EXTRACTION_SECTION,
    );
    expect(
      new Set([PHASE1_FACTS_SECTION, SQL_FILES_SECTION, FORMULA_EXTRACTION_SECTION]).size,
    ).toBe(3);
  });

  it("names the directories that could not be listed, and why their rules are missing", () => {
    const w = sqlFilesSkippedWarning(["db/a.sql"], ["reports", "etl"]);
    expect(w.message).toContain("db/a.sql");
    expect(w.message).toContain("2 module director");
    expect(w.message).toContain("reports, etl");
    expect(sqlFilesSkippedWarning([], ["x"]).message).not.toContain("0 SQL file");
  });

  it("counts the modules whose facts failed, not sections", () => {
    const summary = summarizeWarnings([phase1ChunksFailedWarning(["a", "b"])]);
    expect(summary).toContain(
      "fact extraction failed for all or part of some modules — regenerate to retry only the failed parts",
    );
    expect(summary).not.toContain("section(s) failed");
    const both = summarizeWarnings([
      phase1ChunksFailedWarning(["a"]),
      sectionFailedWarning("Overview", "x"),
    ]);
    expect(both).toContain("1 section(s) failed to generate");
  });
});
