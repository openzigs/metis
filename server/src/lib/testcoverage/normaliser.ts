import {
  type NormalisedTestCase,
  NormalisedTestCaseSchema,
  type Priority,
  type TestCaseSource,
} from "@metis/shared";

import { redactString } from "../connectors/pii-redactor.js";
import {
  CANONICAL_COLUMNS,
  COLUMN_ALIASES,
  type CanonicalColumn,
  ColumnMappingRequiredError,
  MIN_COLUMN_MAPPING_CONFIDENCE,
} from "./providers/types.js";

const PRIORITY_NORMALISE: Record<string, Priority> = {
  low: "low",
  l: "low",
  p4: "low",
  trivial: "low",
  medium: "medium",
  med: "medium",
  m: "medium",
  p3: "medium",
  normal: "medium",
  high: "high",
  h: "high",
  p2: "high",
  major: "high",
  critical: "critical",
  c: "critical",
  p1: "critical",
  blocker: "critical",
};

/** Maps any free-form priority string to a canonical Priority. */
export function normalisePriority(input: string | null | undefined): Priority {
  if (!input) return "medium";
  const key = input.trim().toLowerCase();
  return PRIORITY_NORMALISE[key] ?? "medium";
}

/** Split a free-form tags string on common separators. */
export function normaliseTags(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .split(/[,;|\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Convert a multi-line "step" cell into structured `{action, expected}` rows.
 * Recognised formats:
 *   - one line per step ("1. Do X" / "- Do X")
 *   - "Action → Expected" or "Action -> Expected"
 *   - "Action :: Expected"
 */
export function normaliseSteps(
  raw: string | null | undefined,
): { action: string; expected?: string }[] {
  if (!raw) return [];
  const lines = raw
    .split(/\r?\n+/)
    .map((l) => l.replace(/^[\s>•·\-*]*\d+[.)]?\s*/, "").trim())
    .map((l) => l.replace(/^[-*•·>]\s+/, "").trim())
    .filter((l) => l.length > 0);
  return lines.map((line) => {
    const m = line.match(/^(.*?)\s*(?:→|->|::|=>)\s*(.+)$/) ?? null;
    if (m) {
      return { action: m[1].trim(), expected: m[2].trim() };
    }
    return { action: line };
  });
}

// ---- Column matching ------------------------------------------------------

/**
 * Damerau-Levenshtein-lite (classic Levenshtein) distance. We don't need
 * transpositions for header matching and keeping it simple avoids a
 * runtime dependency.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

export interface ColumnMatch {
  mapping: Record<string, CanonicalColumn | null>;
  confidence: number;
}

/**
 * Match free-form header names to canonical columns. Returns the proposed
 * mapping and the average confidence across the headers it claimed (an
 * `unmapped` header contributes 0).
 */
export function matchColumns(headers: readonly string[]): ColumnMatch {
  const mapping: Record<string, CanonicalColumn | null> = {};
  const claimed = new Set<CanonicalColumn>();
  const scores: number[] = [];
  for (const raw of headers) {
    const header = raw.trim().toLowerCase();
    let bestCanonical: CanonicalColumn | null = null;
    let bestScore = 0;
    for (const canonical of CANONICAL_COLUMNS) {
      if (claimed.has(canonical)) continue;
      const aliases = [canonical, ...COLUMN_ALIASES[canonical]];
      for (const alias of aliases) {
        const score = similarity(header, alias.toLowerCase());
        if (score > bestScore) {
          bestScore = score;
          bestCanonical = canonical;
        }
      }
    }
    if (bestCanonical && bestScore >= 0.7) {
      mapping[raw] = bestCanonical;
      claimed.add(bestCanonical);
      scores.push(bestScore);
    } else {
      mapping[raw] = null;
    }
  }
  const titleMapped = Object.values(mapping).includes("title");
  const confidence = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  // Title is mandatory — if we couldn't map it we cap confidence.
  const effective = titleMapped ? confidence : Math.min(confidence, 0.4);
  return { mapping, confidence: effective };
}

/**
 * Convenience helper: throws `ColumnMappingRequiredError` if confidence is
 * below threshold and no explicit override map was supplied.
 */
export function assertMappingOrThrow(
  match: ColumnMatch,
  overrides?: Readonly<Record<string, CanonicalColumn>>,
): Record<string, CanonicalColumn | null> {
  if (overrides && Object.keys(overrides).length > 0) {
    const merged: Record<string, CanonicalColumn | null> = { ...match.mapping };
    for (const [k, v] of Object.entries(overrides)) merged[k] = v;
    return merged;
  }
  if (match.confidence < MIN_COLUMN_MAPPING_CONFIDENCE) {
    throw new ColumnMappingRequiredError(match.mapping, match.confidence);
  }
  return match.mapping;
}

/**
 * Wrap a partial test-case in `redactString` for every free-form text field
 * and validate the result through the shared zod schema. Returns null when
 * the case is missing the mandatory title (so callers can drop empty rows).
 */
export function finaliseCase(
  partial: {
    externalId?: string;
    title?: string;
    preconditions?: string;
    steps?: { action: string; expected?: string }[];
    expected?: string;
    priority?: string | null;
    tags?: string[];
  },
  source: TestCaseSource,
): NormalisedTestCase | null {
  const title = partial.title?.trim();
  if (!title) return null;
  const redacted = {
    externalId: partial.externalId?.trim() || undefined,
    title: redactString(title),
    preconditions: partial.preconditions ? redactString(partial.preconditions) : undefined,
    steps: (partial.steps ?? []).map((s) => ({
      action: redactString(s.action),
      expected: s.expected ? redactString(s.expected) : undefined,
    })),
    expected: partial.expected ? redactString(partial.expected) : undefined,
    priority: normalisePriority(partial.priority ?? null),
    tags: (partial.tags ?? []).map((t) => redactString(t)),
    source,
  };
  return NormalisedTestCaseSchema.parse(redacted);
}
