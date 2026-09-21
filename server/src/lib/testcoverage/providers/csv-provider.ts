import Papa from "papaparse";
import type { NormalisedTestCase } from "@metis/shared";

import {
  assertMappingOrThrow,
  finaliseCase,
  matchColumns,
  normaliseSteps,
  normaliseTags,
} from "../normaliser.js";
import type {
  CanonicalColumn,
  ImportProvider,
  ImportProviderContext,
  ImportProviderResult,
} from "./types.js";

export const csvProvider: ImportProvider = {
  source: "csv",
  parse(input, ctx) {
    return parseCsv(input, ctx);
  },
};

function parseCsv(input: Buffer | string, ctx: ImportProviderContext): ImportProviderResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const result = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const notes: string[] = [];
  if (result.errors.length > 0) {
    notes.push(...result.errors.slice(0, 3).map((e) => `parse: ${e.message}`));
  }
  const headers = (result.meta.fields ?? []).map((h) => h.trim());
  if (headers.length === 0 || result.data.length === 0) {
    return { cases: [], confidence: 0, notes: [...notes, "empty CSV"] };
  }
  const match = matchColumns(headers);
  const mapping = assertMappingOrThrow(match, ctx.columnOverrides);
  const cases = rowsToCases(result.data, mapping);
  return { cases, confidence: match.confidence, notes };
}

export function rowsToCases(
  rows: ReadonlyArray<Record<string, string | undefined>>,
  mapping: Readonly<Record<string, CanonicalColumn | null>>,
): NormalisedTestCase[] {
  const inverse: Partial<Record<CanonicalColumn, string>> = {};
  for (const [header, canonical] of Object.entries(mapping)) {
    if (canonical) inverse[canonical] = header;
  }
  const out: NormalisedTestCase[] = [];
  for (const row of rows) {
    const pick = (c: CanonicalColumn): string | undefined => {
      const header = inverse[c];
      if (!header) return undefined;
      const v = row[header];
      if (v == null) return undefined;
      const trimmed = String(v).trim();
      return trimmed.length === 0 ? undefined : trimmed;
    };
    const tc = finaliseCase(
      {
        externalId: pick("externalId"),
        title: pick("title"),
        preconditions: pick("preconditions"),
        steps: normaliseSteps(pick("steps")),
        expected: pick("expected"),
        priority: pick("priority") ?? null,
        tags: normaliseTags(pick("tags")),
      },
      "csv",
    );
    if (tc) out.push(tc);
  }
  return out;
}
