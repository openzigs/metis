/**
 * Gherkin .feature exporter (Epic #856, issue #877).
 *
 * Converts an array of `ExportableSuggestion` into one or more
 * `.feature` files (one per feature tag, or a single bundle when no
 * feature tag is present). Returns either:
 *   - a single `{ filename, text }` when a single feature is produced
 *   - a zip blob when multiple features are produced
 *
 * Each suggestion becomes one `Scenario:` with `Given/When/Then` steps
 * generated from `gwt`. Steps without explicit `expected` text use a
 * single `Then` derived from `gwt.then`. Tags on the suggestion (other
 * than the `feature:*` selector) are written as `@scenario-tags`.
 *
 * The output is guaranteed to round-trip through the gherkin importer
 * (`parseFeature`) — see `gherkin-exporter.test.ts`.
 */
import JSZip from "jszip";

import type { ExportableSuggestion } from "./types.js";

export interface GherkinExportSingle {
  readonly kind: "feature";
  readonly filename: string;
  readonly text: string;
}

export interface GherkinExportZip {
  readonly kind: "zip";
  readonly filename: string;
  readonly data: Buffer;
  readonly files: ReadonlyArray<{ filename: string; text: string }>;
}

export type GherkinExportResult = GherkinExportSingle | GherkinExportZip;

const FEATURE_TAG_PREFIX = "feature:";

export async function exportSuggestionsToGherkin(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  opts: { defaultFeatureName?: string } = {},
): Promise<GherkinExportResult> {
  const defaultName = opts.defaultFeatureName ?? "Generated Test Suite";
  const groups = groupByFeature(suggestions, defaultName);

  const files = [...groups.entries()].map(([feature, items]) => ({
    filename: `${slugify(feature)}.feature`,
    text: renderFeature(feature, items),
  }));

  if (files.length === 0) {
    return { kind: "feature", filename: `${slugify(defaultName)}.feature`, text: "" };
  }
  if (files.length === 1) {
    return { kind: "feature", filename: files[0].filename, text: files[0].text };
  }

  const zip = new JSZip();
  for (const f of files) zip.file(f.filename, f.text);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  return { kind: "zip", filename: "features.zip", data, files };
}

function groupByFeature(
  suggestions: ReadonlyArray<ExportableSuggestion>,
  defaultFeature: string,
): Map<string, ExportableSuggestion[]> {
  const out = new Map<string, ExportableSuggestion[]>();
  for (const s of suggestions) {
    const featureTag = (s.tags ?? []).find((t) => t.startsWith(FEATURE_TAG_PREFIX));
    const feature = featureTag ? featureTag.slice(FEATURE_TAG_PREFIX.length) : defaultFeature;
    const list = out.get(feature) ?? [];
    list.push(s);
    out.set(feature, list);
  }
  return out;
}

function renderFeature(name: string, items: ReadonlyArray<ExportableSuggestion>): string {
  const lines: string[] = [];
  lines.push(`Feature: ${escapeOneLine(name)}`);
  for (const s of items) {
    lines.push("");
    const scenarioTags = (s.tags ?? [])
      .filter((t) => !t.startsWith(FEATURE_TAG_PREFIX))
      .map((t) => `@${t}`);
    if (scenarioTags.length) lines.push(`  ${scenarioTags.join(" ")}`);
    lines.push(`  Scenario: ${escapeOneLine(s.title)}`);
    const givens = collectLines(s.gwt.given);
    const whens = collectLines(s.gwt.when);
    const thens = collectLines(s.gwt.then);
    appendBucket(lines, "Given", givens);
    appendBucket(lines, "When", whens);
    appendBucket(lines, "Then", thens);
  }
  lines.push("");
  return lines.join("\n");
}

function appendBucket(lines: string[], keyword: string, items: string[]): void {
  if (!items.length) return;
  lines.push(`    ${keyword} ${items[0]}`);
  for (let i = 1; i < items.length; i += 1) {
    lines.push(`    And ${items[i]}`);
  }
}

function collectLines(text: string | ReadonlyArray<string> | undefined): string[] {
  if (!text) return [];
  const list = Array.isArray(text) ? text : [text as string];
  return list
    .flatMap((line) => line.split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeOneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "feature";
}
