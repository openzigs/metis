/**
 * Excel coverage-report exporter (Epic #856, issue #866).
 *
 * Produces a four-sheet workbook:
 *
 *   1. Coverage Report — high-level summary (covered/partial/uncovered counts,
 *      confidence flag column for any test case with faithfulness < 0.6).
 *   2. Matrix — requirement × test-case grid; cells coloured green
 *      (covered ≥ 0.8), amber (partial 0.5–0.79), red (uncovered < 0.5).
 *   3. Gaps — one row per uncovered or partial requirement with severity.
 *   4. Suggestions — generated test cases with Given/When/Then and the
 *      LOW-CONFIDENCE flag.
 *
 * Sheet 1 has frozen header row + auto-filter. The header style is bold.
 * Cell colour fills use plain ARGB hex (no theme dependency) so the file
 * renders identically in Excel, Numbers, and LibreOffice.
 */
import ExcelJS from "exceljs";

import type { CoverageReport } from "./types.js";
import { gwtBucketToText } from "./types.js";

const GREEN = "FF22C55E";
const AMBER = "FFF59E0B";
const RED = "FFEF4444";
const HEADER_FILL = "FFE5E7EB";
const LOW_CONFIDENCE_FILL = "FFFEF3C7";

export interface ExcelExportResult {
  readonly filename: string;
  readonly data: Buffer;
}

export async function exportCoverageReportToExcel(
  report: CoverageReport,
  opts: { filename?: string } = {},
): Promise<ExcelExportResult> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Metis";
  wb.created = new Date(report.generatedAt);

  buildCoverageSheet(wb, report);
  buildMatrixSheet(wb, report);
  buildGapsSheet(wb, report);
  buildSuggestionsSheet(wb, report);

  const buffer = await wb.xlsx.writeBuffer();
  return {
    filename: opts.filename ?? `coverage-report-${report.runId}.xlsx`,
    data: Buffer.from(buffer),
  };
}

function buildCoverageSheet(wb: ExcelJS.Workbook, report: CoverageReport): void {
  const ws = wb.addWorksheet("Coverage Report");
  const total = report.requirements.length;
  const covered = report.requirements.filter((r) => r.status === "covered").length;
  const partial = report.requirements.filter((r) => r.status === "partial").length;
  const uncovered = report.requirements.filter((r) => r.status === "uncovered").length;
  const lowConfidence = report.suggestions.filter((s) => s.lowConfidence).length;

  ws.columns = [
    { header: "Metric", key: "metric", width: 40 },
    { header: "Value", key: "value", width: 20 },
  ];
  styleHeaderRow(ws, 1);
  ws.addRow({ metric: "Project", value: report.projectName });
  ws.addRow({ metric: "Run ID", value: report.runId });
  ws.addRow({ metric: "Generated At", value: report.generatedAt });
  ws.addRow({ metric: "Requirements (total)", value: total });
  ws.addRow({ metric: "Requirements covered", value: covered });
  ws.addRow({ metric: "Requirements partial", value: partial });
  ws.addRow({ metric: "Requirements uncovered", value: uncovered });
  ws.addRow({ metric: "Suggestions (low confidence)", value: lowConfidence });

  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } };
}

function buildMatrixSheet(wb: ExcelJS.Workbook, report: CoverageReport): void {
  const ws = wb.addWorksheet("Matrix");
  const tcIds = report.testCases.map((t) => t.id);
  const columns: Partial<ExcelJS.Column>[] = [
    { header: "Requirement", key: "req", width: 32 },
    ...tcIds.map((id) => ({ header: id, key: id, width: 16 })),
  ];
  ws.columns = columns;
  styleHeaderRow(ws, 1);

  const matrixIndex = new Map<string, number>();
  for (const cell of report.matrix) {
    matrixIndex.set(`${cell.requirementId}::${cell.testCaseId}`, cell.score);
  }

  for (const req of report.requirements) {
    const rowData: Record<string, string | number> = { req: req.title };
    for (const tcId of tcIds) rowData[tcId] = "";
    const row = ws.addRow(rowData);
    for (let colIdx = 0; colIdx < tcIds.length; colIdx += 1) {
      const tcId = tcIds[colIdx];
      const score = matrixIndex.get(`${req.requirementId}::${tcId}`);
      if (score === undefined) continue;
      const cell = row.getCell(colIdx + 2);
      cell.value = Number(score.toFixed(2));
      cell.fill = solidFill(scoreColor(score));
      cell.alignment = { horizontal: "center" };
    }
  }
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  if (tcIds.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: tcIds.length + 1 } };
  }
}

function buildGapsSheet(wb: ExcelJS.Workbook, report: CoverageReport): void {
  const ws = wb.addWorksheet("Gaps");
  ws.columns = [
    { header: "Requirement ID", key: "id", width: 24 },
    { header: "Title", key: "title", width: 48 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Reason", key: "reason", width: 48 },
  ];
  styleHeaderRow(ws, 1);
  for (const gap of report.gaps) {
    ws.addRow({
      id: gap.requirementId,
      title: gap.title,
      severity: gap.severity,
      reason: gap.reason ?? "",
    });
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 4 } };
}

function buildSuggestionsSheet(wb: ExcelJS.Workbook, report: CoverageReport): void {
  const ws = wb.addWorksheet("Suggestions");
  ws.columns = [
    { header: "ID", key: "id", width: 36 },
    { header: "Title", key: "title", width: 48 },
    { header: "Priority", key: "priority", width: 10 },
    { header: "Given", key: "given", width: 40 },
    { header: "When", key: "when", width: 40 },
    { header: "Then", key: "then", width: 40 },
    { header: "Confidence", key: "confidence", width: 14 },
    { header: "Low Confidence", key: "low", width: 16 },
    { header: "Requirements", key: "reqs", width: 40 },
  ];
  styleHeaderRow(ws, 1);
  for (const s of report.suggestions) {
    const row = ws.addRow({
      id: s.id,
      title: s.title,
      priority: s.priority ?? "",
      given: gwtBucketToText(s.gwt.given),
      when: gwtBucketToText(s.gwt.when),
      then: gwtBucketToText(s.gwt.then),
      confidence: Number(s.faithfulness.toFixed(2)),
      low: s.lowConfidence ? "YES" : "",
      reqs: s.mappedRequirementIds.join(", "),
    });
    if (s.lowConfidence) {
      for (let i = 1; i <= 9; i += 1) {
        row.getCell(i).fill = solidFill(LOW_CONFIDENCE_FILL);
      }
    }
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };
}

function styleHeaderRow(ws: ExcelJS.Worksheet, rowNumber: number): void {
  const row = ws.getRow(rowNumber);
  row.font = { bold: true };
  row.fill = solidFill(HEADER_FILL);
  row.commit();
}

function solidFill(argb: string): ExcelJS.FillPattern {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function scoreColor(score: number): string {
  if (score >= 0.8) return GREEN;
  if (score >= 0.5) return AMBER;
  return RED;
}
