"use client";

/**
 * Issue #733 — degraded-mode capability banner on the analysis results page.
 *
 * Renders ONLY for degraded runs (a persisted capability record with ≥1 reason).
 * Each reason maps to plain, actionable copy so a business analyst understands
 * what was NOT analyzed and how to fix it — rather than the pipeline degrading
 * silently. A fully-capable run renders nothing.
 */
import {
  codeInvestigationContinueLimitReached,
  isAnalysisDegraded,
  type AnalysisCapability,
} from "@metis/shared";
import { CAPABILITY_REASON_COPY } from "@/lib/analysis-capability-copy";

/**
 * Issue #1062 — why "Continue with a larger budget" is no longer offered. Every
 * continuation reruns at the same enlarged budget, so another would spend the
 * same tokens to stop in the same place.
 */
export const CONTINUE_LIMIT_REASON =
  "Continue is not offered again: the code analysis has already been re-run at the largest budget a continuation can use. Ask an administrator to raise ANALYSIS_AGENT_TOKEN_BUDGET and start a new analysis, or analyse fewer requirements per run.";

/**
 * Issue #1062 — the sentence shown when a "Continue with a larger budget" rerun
 * ran out of budget as well, with the gap it left when the pass reported one.
 * `null` when no continuation has run.
 */
export function rerunAlsoCutShortText(capability: AnalysisCapability): string | null {
  if ((capability.codeInvestigationContinuations ?? 0) < 1) return null;
  const gap = capability.codeInvestigationUnreached;
  if (!gap) return "The rerun was also cut short.";
  return `The rerun was also cut short: ${gap.unreached} of ${gap.total} requirements unreached.`;
}

interface Props {
  capability: AnalysisCapability | null;
  /**
   * Issue #741 — invoked when the operator clicks "Analyze remaining
   * repositories" on the `repos-skipped-budget` reason. When omitted the action
   * is not rendered (e.g. read-only viewers without `analysis.run`).
   */
  onResumeRepos?: () => void;
  /** True while a resume is in flight — disables the action + shows progress. */
  resuming?: boolean;
  /**
   * Issue #1001 — invoked when the operator clicks "Continue with a larger
   * budget" on the `code-investigation-cut-short` reason. Omitted ⇒ not rendered.
   */
  onContinueInvestigation?: () => void;
  /** True while a continued investigation is being started. */
  continuing?: boolean;
}

export function AnalysisCapabilityBanner({
  capability,
  onResumeRepos,
  resuming = false,
  onContinueInvestigation,
  continuing = false,
}: Props): React.ReactElement | null {
  if (!isAnalysisDegraded(capability) || !capability) return null;

  return (
    <div
      role="status"
      data-testid="analysis-capability-banner"
      className="rounded border border-warning/40 bg-warning-muted p-3 text-sm"
    >
      <div className="mb-2 flex items-center gap-2 font-medium text-warning">
        <svg
          className="h-4 w-4 shrink-0"
          fill="currentColor"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path
            d="M8 1.5 15 14H1L8 1.5Zm0 4.5v3.5m0 2v.5"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
        </svg>
        Some analysis capabilities were limited for this run
      </div>
      <ul className="space-y-2">
        {capability.reasons.map((reason) => {
          const copy = CAPABILITY_REASON_COPY[reason];
          const isSkippedRepos =
            reason === "repos-skipped-budget" && capability.skippedRepos.length > 0;
          const skipped = isSkippedRepos
            ? ` (${capability.skippedRepos.map((r) => r.label).join(", ")})`
            : "";
          // Issue #1062 — a Continue rerun that was cut short too says so, and
          // Continue is not offered past its limit (the reason is shown instead).
          const isCutShort = reason === "code-investigation-cut-short";
          const rerunNote = isCutShort ? rerunAlsoCutShortText(capability) : null;
          const continueLimited = isCutShort && codeInvestigationContinueLimitReached(capability);
          return (
            <li key={reason} data-testid={`capability-reason-${reason}`} className="text-warning">
              <span className="font-medium">
                {copy.title}
                {skipped}
              </span>{" "}
              {continueLimited ? null : <span className="text-warning">{copy.action}</span>}
              {rerunNote ? (
                <p className="mt-1.5 font-medium text-warning" data-testid="rerun-also-cut-short">
                  {rerunNote}
                </p>
              ) : null}
              {continueLimited ? (
                <p className="mt-1 text-warning" data-testid="continue-limit-reason">
                  {CONTINUE_LIMIT_REASON}
                </p>
              ) : null}
              {/* Issue #741 — offer a one-click resume of the skipped repos. */}
              {isSkippedRepos && onResumeRepos ? (
                <div className="mt-1.5">
                  <button
                    type="button"
                    data-testid="resume-skipped-repos"
                    onClick={onResumeRepos}
                    disabled={resuming}
                    className="rounded border border-warning/40 bg-warning-muted px-2 py-1 text-xs font-medium text-warning hover:bg-warning-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {resuming
                      ? "Analyzing remaining repositories…"
                      : "Analyze remaining repositories"}
                  </button>
                </div>
              ) : null}
              {/* Issue #1001 — continue a code pass that ran out of budget. */}
              {isCutShort && !continueLimited && onContinueInvestigation ? (
                <div className="mt-1.5">
                  <button
                    type="button"
                    data-testid="continue-code-investigation"
                    onClick={onContinueInvestigation}
                    disabled={continuing}
                    className="rounded border border-warning/40 bg-warning-muted px-2 py-1 text-xs font-medium text-warning hover:bg-warning-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {continuing ? "Continuing code analysis…" : "Continue with a larger budget"}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
