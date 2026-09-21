import type { NormalisedTestCase } from "@metis/shared";

import { finaliseCase, normaliseTags } from "../normaliser.js";
import type { ImportProvider, ImportProviderResult } from "./types.js";

/**
 * Gherkin .feature parser (Epic #856, issue #877).
 *
 * Supports the subset of the official grammar we care about:
 *   - `Feature:` with optional preceding `@feature-tag` lines
 *   - `Background:` — its `Given/And/But` steps are prepended to every
 *     scenario in the same feature
 *   - `Scenario:` — emits one `TestCaseDoc`
 *   - `Scenario Outline:` + `Examples:` — emits one `TestCaseDoc` per
 *     example row, with `<placeholder>` substitution
 *   - `Given/When/Then/And/But` step keywords
 *   - `@scenario-tag` annotations (merged with feature-level tags)
 *   - `#` line comments
 *
 * Each scenario becomes one normalised test case where:
 *   - `title` = scenario name (with example values appended for outlines)
 *   - `preconditions` = concatenated `Given` lines (background first)
 *   - `steps` = `When` lines (action only)
 *   - `expected` = concatenated `Then` lines
 *   - `tags` = feature-level @tags ∪ scenario-level @tags
 */
export const gherkinProvider: ImportProvider = {
  source: "gherkin",
  parse(input, _ctx) {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseFeature(text);
  },
};

interface ScenarioDraft {
  title: string;
  tags: string[];
  isOutline: boolean;
  given: string[];
  when: string[];
  then: string[];
  examples: { headers: string[]; rows: string[][] };
}

export function parseFeature(text: string): ImportProviderResult {
  const lines = text.split(/\r?\n/);
  const cases: NormalisedTestCase[] = [];

  let featureTags: string[] = [];
  let pendingTags: string[] = [];
  let inBackground = false;
  let background: { given: string[] } = { given: [] };
  let current: ScenarioDraft | null = null;
  let bucket: "given" | "when" | "then" | null = null;
  let inExamples = false;
  let examplesHeaderSeen = false;

  const emitCurrent = (): void => {
    if (!current) return;
    if (current.isOutline && current.examples.rows.length > 0) {
      for (const row of current.examples.rows) {
        const subs = makeRowSubstitutions(current.examples.headers, row);
        const titleSuffix = current.examples.headers.length
          ? ` [${current.examples.headers.map((h) => `${h}=${subs[h] ?? ""}`).join(", ")}]`
          : "";
        const tc = finaliseCase(
          {
            title: applySubs(current.title, subs) + titleSuffix,
            preconditions: joinNonEmpty(
              background.given.concat(current.given).map((l) => applySubs(l, subs)),
            ),
            steps: current.when.map((line) => ({ action: applySubs(line, subs) })),
            expected: joinNonEmpty(current.then.map((line) => applySubs(line, subs))),
            tags: normaliseTags(current.tags.join(",")),
          },
          "gherkin",
        );
        if (tc) cases.push(tc);
      }
    } else {
      const tc = finaliseCase(
        {
          title: current.title,
          preconditions: joinNonEmpty(background.given.concat(current.given)),
          steps: current.when.map((line) => ({ action: line })),
          expected: joinNonEmpty(current.then),
          tags: normaliseTags(current.tags.join(",")),
        },
        "gherkin",
      );
      if (tc) cases.push(tc);
    }
    current = null;
    bucket = null;
    inExamples = false;
    examplesHeaderSeen = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;

    if (line.startsWith("@")) {
      pendingTags.push(
        ...line
          .split(/\s+/)
          .filter((t) => t.startsWith("@"))
          .map((t) => t.slice(1)),
      );
      continue;
    }

    if (/^Feature\s*:/i.test(line)) {
      emitCurrent();
      featureTags = pendingTags.slice();
      pendingTags = [];
      background = { given: [] };
      inBackground = false;
      continue;
    }

    if (/^Background\s*:/i.test(line)) {
      emitCurrent();
      pendingTags = [];
      inBackground = true;
      background = { given: [] };
      bucket = "given";
      continue;
    }

    const scenarioMatch = line.match(/^Scenario(\s+Outline)?\s*:(.*)$/i);
    if (scenarioMatch) {
      emitCurrent();
      inBackground = false;
      const title = scenarioMatch[2].trim() || "Scenario";
      current = {
        title,
        tags: [...featureTags, ...pendingTags],
        isOutline: Boolean(scenarioMatch[1]),
        given: [],
        when: [],
        then: [],
        examples: { headers: [], rows: [] },
      };
      pendingTags = [];
      bucket = null;
      inExamples = false;
      examplesHeaderSeen = false;
      continue;
    }

    if (/^Examples\s*:/i.test(line)) {
      if (current?.isOutline) {
        inExamples = true;
        examplesHeaderSeen = false;
      }
      continue;
    }

    if (inExamples && current?.isOutline) {
      const row = parseTableRow(line);
      if (!row) continue;
      if (!examplesHeaderSeen) {
        current.examples.headers = row;
        examplesHeaderSeen = true;
      } else {
        current.examples.rows.push(row);
      }
      continue;
    }

    const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
    if (!stepMatch) continue;

    const keyword = stepMatch[1].toLowerCase();
    const body = stepMatch[2].trim();

    if (inBackground) {
      background.given.push(body);
      continue;
    }
    if (!current) continue;

    if (keyword === "given") {
      bucket = "given";
      current.given.push(body);
    } else if (keyword === "when") {
      bucket = "when";
      current.when.push(body);
    } else if (keyword === "then") {
      bucket = "then";
      current.then.push(body);
    } else if (bucket) {
      current[bucket].push(body);
    }
  }
  emitCurrent();
  return { cases, confidence: cases.length > 0 ? 1 : 0, notes: [] };
}

function parseTableRow(line: string): string[] | null {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  return line
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

function makeRowSubstitutions(headers: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i += 1) {
    out[headers[i]] = row[i] ?? "";
  }
  return out;
}

function applySubs(text: string, subs: Record<string, string>): string {
  return text.replace(/<([^>]+)>/g, (_, key: string) => subs[key.trim()] ?? `<${key}>`);
}

function joinNonEmpty(parts: string[]): string | undefined {
  const filtered = parts.filter((p) => p && p.trim().length > 0);
  return filtered.length ? filtered.join("\n") : undefined;
}
