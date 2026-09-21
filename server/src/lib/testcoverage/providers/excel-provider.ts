import type { NormalisedTestCase } from "@metis/shared";

import { assertMappingOrThrow, matchColumns } from "../normaliser.js";
import { rowsToCases } from "./csv-provider.js";
import type { ImportProvider, ImportProviderContext, ImportProviderResult } from "./types.js";

export const excelProvider: ImportProvider = {
  source: "excel",
  parse(input, ctx) {
    if (typeof input === "string") {
      throw new TypeError("excelProvider requires a Buffer input");
    }
    return parseExcel(input, ctx);
  },
};

async function parseExcel(
  buffer: Buffer,
  ctx: ImportProviderContext,
): Promise<ImportProviderResult> {
  const moduleName = "exceljs";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS = (await import(moduleName)) as any;
  const workbook: import("exceljs").Workbook = new ExcelJS.Workbook();
  // exceljs's type accepts Uint8Array at runtime but its declaration insists
  // on `Buffer` — cast to satisfy the narrower DefinitelyTyped surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return { cases: [], confidence: 0, notes: ["empty workbook"] };
  }
  const rows: Record<string, string>[] = [];
  let headers: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = (row.values as (string | number | null | undefined)[]).slice(1);
    if (rowNumber === 1) {
      headers = cells.map((c) => String(c ?? "").trim());
      return;
    }
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      const cell = cells[idx];
      record[h] = cell == null ? "" : String(cell);
    });
    rows.push(record);
  });
  if (headers.length === 0 || rows.length === 0) {
    return { cases: [], confidence: 0, notes: ["empty workbook"] };
  }
  const match = matchColumns(headers);
  const mapping = assertMappingOrThrow(match, ctx.columnOverrides);
  const cases: NormalisedTestCase[] = rowsToCases(rows, mapping).map((tc) => ({
    ...tc,
    source: "excel",
  }));
  return { cases, confidence: match.confidence, notes: [] };
}
