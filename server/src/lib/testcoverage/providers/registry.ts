import type { TestCaseSource } from "@metis/shared";

import { csvProvider } from "./csv-provider.js";
import { docxProvider } from "./docx-provider.js";
import { excelProvider } from "./excel-provider.js";
import { gherkinProvider } from "./gherkin-provider.js";
import { markdownProvider } from "./markdown-provider.js";
import type { ImportProvider } from "./types.js";

const REGISTRY: Partial<Record<TestCaseSource, ImportProvider>> = {
  csv: csvProvider,
  excel: excelProvider,
  docx: docxProvider,
  markdown: markdownProvider,
  gherkin: gherkinProvider,
};

export function resolveProvider(source: TestCaseSource): ImportProvider {
  const provider = REGISTRY[source];
  if (!provider) {
    throw new Error(`No importer registered for source "${source}".`);
  }
  return provider;
}

/**
 * Pick a provider from a filename / mimetype pair. Returns null when the
 * file looks like one we don't import (e.g. PDF).
 */
export function detectProviderForUpload(filename: string, mimeType: string): ImportProvider | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv") || mimeType === "text/csv") return csvProvider;
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || mimeType.includes("spreadsheetml"))
    return excelProvider;
  if (lower.endsWith(".docx") || mimeType.includes("wordprocessingml")) return docxProvider;
  if (lower.endsWith(".feature")) return gherkinProvider;
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || mimeType === "text/markdown")
    return markdownProvider;
  return null;
}
