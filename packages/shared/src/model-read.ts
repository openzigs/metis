/**
 * Issue #1081 (epic #1313, "no silent wrong output") — a model step whose
 * answer METIS could not read.
 *
 * Before #1081 sixteen model-JSON callers caught a parse failure and returned
 * the value a legitimately empty answer returns: no completeness gaps, no
 * contradictions, no NFRs. The analyst saw "No cross-document contradictions or
 * completeness gaps detected" for a check that never produced an answer.
 *
 * The analysis-side steps now record the failure on
 * `Analysis.metadata.unreadAnalysisSteps` (additive, no migration), and the UI
 * words it with {@link describeUnreadAnalysisStep}. The wording lives here so the
 * server log, the API and every panel say the same thing.
 */

/**
 * Why a model step produced nothing usable. Mirrors the server's
 * `NoVerdictReason` (`structured-verdict.ts`); duplicated here because the
 * shared package cannot import the server.
 */
export const MODEL_READ_FAILURE_REASONS = [
  /** The reply contained no JSON object, after one re-prompt. */
  "unparseable",
  /** The reply was JSON but not the expected shape, after one re-prompt. */
  "schema-invalid",
  /** The model returned nothing, twice. */
  "empty-response",
  /** The provider call itself failed (transport, upstream error, quota). */
  "provider-error",
] as const;
export type ModelReadFailureReason = (typeof MODEL_READ_FAILURE_REASONS)[number];

/** The analysis steps that record an unread answer. */
export const UNREAD_ANALYSIS_STEPS = [
  "nfr-elicitation",
  "assumption-risk-elicitation",
  "completeness-check",
  "contradiction-check",
  "cross-doc-detection",
] as const;
export type UnreadAnalysisStepKey = (typeof UNREAD_ANALYSIS_STEPS)[number];

/** One step whose answer (or some of whose answers) could not be read. */
export interface UnreadAnalysisStep {
  step: UnreadAnalysisStepKey;
  /** The reason of the first unread call; enough to choose the wording. */
  reason: ModelReadFailureReason;
  /** Model calls of this step whose answer could not be read. */
  failedCalls: number;
  /** Model calls this step made in total (>= failedCalls). */
  totalCalls: number;
}

/** Persisted to `Analysis.metadata.unreadAnalysisSteps`; absent on a clean run. */
export interface UnreadAnalysisSteps {
  steps: UnreadAnalysisStep[];
  /** ISO timestamp of the pass that recorded it. */
  at: string;
}

const CAUSE: Record<ModelReadFailureReason, string> = {
  unparseable: "the model's reply was not in the expected format",
  "schema-invalid": "the model's reply was not in the expected format",
  "empty-response": "the model returned an empty reply",
  "provider-error": "the model call failed",
};

/**
 * The sentence an analyst needs: which step, why, and what its empty-looking
 * output does NOT mean.
 */
export function describeUnreadAnalysisStep(s: UnreadAnalysisStep): string {
  const cause = CAUSE[s.reason];
  switch (s.step) {
    case "nfr-elicitation":
      return (
        `METIS could not list the non-functional requirements and acceptance criteria ` +
        `(${cause}), so the completeness check ran without them.`
      );
    case "assumption-risk-elicitation":
      return (
        `METIS could not list the assumptions and risks (${cause}), so the completeness ` +
        `check ran without them.`
      );
    case "completeness-check":
      return (
        `The completeness check could not be read (${cause}). Missing non-functional ` +
        `requirements, acceptance criteria, assumptions and risks were not checked — no gaps ` +
        `listed here does not mean none are missing.`
      );
    case "contradiction-check": {
      const scope =
        s.totalCalls > 1
          ? `${s.failedCalls} of ${s.totalCalls} contradiction checks`
          : "the contradiction check";
      return (
        `METIS could not read ${scope} (${cause}), so contradictions in those documents may ` +
        `be missing from this list.`
      );
    }
    case "cross-doc-detection":
      // The whole pass stopped; its cause may not be the model, so none is named.
      return (
        "The cross-document checks did not finish. No contradictions or completeness gaps " +
        "listed here does not mean there are none."
      );
  }
}

/**
 * Narrow an untrusted metadata value to {@link UnreadAnalysisSteps}. Entries
 * that do not name a known step are dropped, so an older or hand-edited blob
 * can never make the UI render `undefined`.
 */
export function readUnreadAnalysisSteps(value: unknown): UnreadAnalysisSteps | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { steps?: unknown; at?: unknown };
  if (!Array.isArray(raw.steps)) return null;
  const steps = raw.steps.filter(
    (s): s is UnreadAnalysisStep =>
      !!s &&
      typeof s === "object" &&
      (UNREAD_ANALYSIS_STEPS as readonly string[]).includes((s as UnreadAnalysisStep).step) &&
      (MODEL_READ_FAILURE_REASONS as readonly string[]).includes(
        (s as UnreadAnalysisStep).reason,
      ) &&
      typeof (s as UnreadAnalysisStep).failedCalls === "number" &&
      typeof (s as UnreadAnalysisStep).totalCalls === "number",
  );
  if (steps.length === 0) return null;
  return { steps, at: typeof raw.at === "string" ? raw.at : "" };
}
