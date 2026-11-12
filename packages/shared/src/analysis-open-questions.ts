/**
 * #2348 — the number of open clarifying questions on an analysis run: the
 * count the run's Questions tab shows (`analysisTabCounts` in
 * `ui/src/components/analysis/analysis-views.ts`) and the count Home's
 * "Waiting on your answers" lists (`server/src/lib/my-work/my-work-service.ts`).
 * One function, so the two can never disagree.
 *
 * Reads the run's `metadata` object. A clarify round rewrites
 * `structuredRequirements.totalAmbiguities` to what is still unaddressed, so
 * the count falls as the analyst answers, with or without a dialog row.
 *
 * `undefined` = the run has no count to show: clarification was not asked
 * for, or structured extraction failed (#1081: "0" would read as "nothing to
 * clarify" when the step never ran).
 */
export function openQuestionCount(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const meta = metadata as {
    enhancement?: { enableClarification?: unknown } | null;
    structuredExtractionFailure?: unknown;
    structuredRequirements?: { totalAmbiguities?: unknown } | null;
  };
  if (meta.enhancement?.enableClarification !== true) return undefined;
  if (meta.structuredExtractionFailure) return undefined;
  const total = meta.structuredRequirements?.totalAmbiguities;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}
