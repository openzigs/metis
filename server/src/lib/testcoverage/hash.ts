import { createHash } from "node:crypto";

import type { NormalisedTestCase } from "@metis/shared";

/**
 * Deterministic, sorted-key JSON for a normalised test case. Used as the
 * input to `sha256` so semantically-equal cases produce the same hash even
 * when the source field order differs.
 */
export function canonicaliseCase(tc: NormalisedTestCase): string {
  return JSON.stringify(
    {
      externalId: tc.externalId ?? null,
      title: tc.title,
      preconditions: tc.preconditions ?? null,
      steps: tc.steps.map((s) => ({
        action: s.action,
        expected: s.expected ?? null,
      })),
      expected: tc.expected ?? null,
      priority: tc.priority,
      tags: [...tc.tags].sort(),
      source: tc.source,
    },
    null,
    0,
  );
}

export function hashCase(tc: NormalisedTestCase): string {
  return createHash("sha256").update(canonicaliseCase(tc)).digest("hex");
}

/**
 * Deterministic content hash for a coverage run, derived from the sorted set
 * of input hashes. Two runs over the same imports produce the same hash and
 * can therefore be deduplicated.
 */
export function hashRunInput(testCaseHashes: readonly string[]): string {
  const sorted = [...testCaseHashes].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}
