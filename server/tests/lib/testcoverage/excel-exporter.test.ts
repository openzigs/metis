/**
 * Excel exporter tests — Epic #856 / issue #866.
 *
 * Reloads the produced workbook and asserts the four sheets, header styles,
 * colour fills for matrix cells, and low-confidence row highlighting.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import {
  exportCoverageReportToExcel,
  type CoverageReport,
} from "../../../src/lib/testcoverage/index.js";

const sampleReport: CoverageReport = {
  runId: "run-1",
  projectName: "Sample",
  generatedAt: "2025-01-01T00:00:00.000Z",
  requirements: [
    { requirementId: "R1", title: "Covered req", status: "covered", bestScore: 0.95 },
    { requirementId: "R2", title: "Partial req", status: "partial", bestScore: 0.6 },
    { requirementId: "R3", title: "Uncovered req", status: "uncovered", bestScore: 0.1 },
  ],
  testCases: [
    { id: "TC1", title: "Login" },
    { id: "TC2", title: "Logout" },
  ],
  matrix: [
    { requirementId: "R1", testCaseId: "TC1", score: 0.95, status: "covered" },
    { requirementId: "R2", testCaseId: "TC1", score: 0.6, status: "partial" },
    { requirementId: "R3", testCaseId: "TC2", score: 0.1, status: "uncovered" },
  ],
  gaps: [
    { requirementId: "R3", title: "Uncovered req", severity: "high", reason: "no candidates" },
  ],
  suggestions: [
    {
      id: "S1",
      title: "Suggested high-confidence test",
      gwt: { given: ["a user"], when: ["they click submit"], then: ["a confirmation appears"] },
      steps: [],
      priority: "medium",
      mappedRequirementIds: ["R3"],
      faithfulness: 0.92,
      lowConfidence: false,
    },
    {
      id: "S2",
      title: "Low-confidence suggestion",
      gwt: { given: ["unclear precondition"], when: ["unclear action"], then: ["unclear result"] },
      steps: [],
      mappedRequirementIds: ["R2"],
      faithfulness: 0.35,
      lowConfidence: true,
    },
  ],
};

async function loadExported(report: CoverageReport): Promise<ExcelJS.Workbook> {
  const { data, filename } = await exportCoverageReportToExcel(report);
  expect(filename).toBe("coverage-report-run-1.xlsx");
  expect(Buffer.isBuffer(data)).toBe(true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  return wb;
}

describe("exportCoverageReportToExcel", () => {
  it("produces four named sheets", async () => {
    const wb = await loadExported(sampleReport);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Coverage Report",
      "Matrix",
      "Gaps",
      "Suggestions",
    ]);
  });

  it("populates the coverage-report metric sheet with all counts", async () => {
    const wb = await loadExported(sampleReport);
    const ws = wb.getWorksheet("Coverage Report")!;
    const cells = (rowNum: number) => [
      ws.getRow(rowNum).getCell(1).text,
      ws.getRow(rowNum).getCell(2).text,
    ];
    expect(cells(2)).toEqual(["Project", "Sample"]);
    expect(cells(5)).toEqual(["Requirements (total)", "3"]);
    expect(cells(6)).toEqual(["Requirements covered", "1"]);
    expect(cells(7)).toEqual(["Requirements partial", "1"]);
    expect(cells(8)).toEqual(["Requirements uncovered", "1"]);
    expect(cells(9)).toEqual(["Suggestions (low confidence)", "1"]);
  });

  it("colours matrix cells green/amber/red according to score", async () => {
    const wb = await loadExported(sampleReport);
    const ws = wb.getWorksheet("Matrix")!;
    // header row + R1, R2, R3 in that order
    const r1tc1 = ws.getRow(2).getCell(2);
    const r2tc1 = ws.getRow(3).getCell(2);
    const r3tc2 = ws.getRow(4).getCell(3);
    expect((r1tc1.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FF22C55E");
    expect((r2tc1.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFF59E0B");
    expect((r3tc2.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFEF4444");
  });

  it("highlights low-confidence suggestion rows", async () => {
    const wb = await loadExported(sampleReport);
    const ws = wb.getWorksheet("Suggestions")!;
    const row2 = ws.getRow(2); // S1 — high confidence
    const row3 = ws.getRow(3); // S2 — low confidence
    expect((row3.getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb).toBe("FFFEF3C7");
    // High-confidence row has no fill override (only header has the grey)
    expect((row2.getCell(1).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb).not.toBe(
      "FFFEF3C7",
    );
    expect(row3.getCell(8).text).toBe("YES");
  });

  it("freezes header rows and sets autoFilter on every sheet", async () => {
    const wb = await loadExported(sampleReport);
    for (const ws of wb.worksheets) {
      expect(ws.views?.[0]?.state).toBe("frozen");
      expect(ws.autoFilter).toBeDefined();
    }
  });
});
