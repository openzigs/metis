import type { NormalisedTestCase } from "@metis/shared";

import { finaliseCase, normaliseSteps } from "../normaliser.js";
import type { ImportProvider, ImportProviderResult } from "./types.js";

export const markdownProvider: ImportProvider = {
  source: "markdown",
  parse(input, _ctx) {
    const text = typeof input === "string" ? input : input.toString("utf8");
    return parseMarkdown(text);
  },
};

/**
 * Heuristic Markdown parser:
 *   - Each `## ` heading starts a new test case (`title`).
 *   - Lines under `**Preconditions:**` / `Preconditions:` populate that field.
 *   - Lines under `**Steps:**` / `Steps:` are passed to `normaliseSteps`.
 *   - Lines under `**Expected:**` / `Expected:` populate `expected`.
 *   - `**Tags:**` accepts comma-separated tags.
 */
export function parseMarkdown(md: string): ImportProviderResult {
  const cases: NormalisedTestCase[] = [];
  const blocks = md.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const [headerLine, ...rest] = block.split(/\r?\n/);
    const title = (headerLine ?? "").trim();
    if (!title) continue;
    const sections = splitSections(rest.join("\n"));
    const tc = finaliseCase(
      {
        title,
        preconditions: sections.preconditions,
        steps: normaliseSteps(sections.steps),
        expected: sections.expected,
        tags: sections.tags
          ? sections.tags
              .split(/[,;|]/)
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        priority: sections.priority ?? null,
      },
      "markdown",
    );
    if (tc) cases.push(tc);
  }
  return { cases, confidence: cases.length > 0 ? 1 : 0, notes: [] };
}

function splitSections(body: string): {
  preconditions?: string;
  steps?: string;
  expected?: string;
  tags?: string;
  priority?: string;
} {
  const sectionRe =
    /^\s*\*?\*?\s*(preconditions?|steps?|expected(?:\s*results?)?|tags?|priority)\s*:?\*?\*?\s*$/i;
  const out: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(sectionRe);
    if (m) {
      const key = m[1]
        .toLowerCase()
        .replace(/s$/, "")
        .replace(/\s+results?$/, "");
      current = normaliseSection(key);
      out[current] ??= [];
      continue;
    }
    if (current) out[current].push(line);
  }
  return {
    preconditions: joinSection(out["preconditions"]),
    steps: joinSection(out["steps"]),
    expected: joinSection(out["expected"]),
    tags: joinSection(out["tags"]),
    priority: joinSection(out["priority"]),
  };
}

function normaliseSection(s: string): string {
  switch (s) {
    case "precondition":
      return "preconditions";
    case "step":
      return "steps";
    case "tag":
      return "tags";
    default:
      return s;
  }
}

function joinSection(lines: string[] | undefined): string | undefined {
  if (!lines) return undefined;
  const trimmed = lines.join("\n").trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
