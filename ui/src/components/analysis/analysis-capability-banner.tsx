"use client";

/**
 * Issue #733 — degraded-mode capability banner on the analysis results page.
 *
 * Renders ONLY for degraded runs (a persisted capability record with ≥1 reason).
 * Each reason maps to plain, actionable copy so a business analyst understands
 * what was NOT analyzed and how to fix it — rather than the pipeline degrading
 * silently. A fully-capable run renders nothing.
 */
import { isAnalysisDegraded, type AnalysisCapability } from "@metis/shared";
import { CAPABILITY_REASON_COPY } from "@/lib/analysis-capability-copy";

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
}

export function AnalysisCapabilityBanner({
  capability,
  onResumeRepos,
  resuming = false,
}: Props): React.ReactElement | null {
  if (!isAnalysisDegraded(capability) || !capability) return null;

  return (
    <div
      role="status"
      data-testid="analysis-capability-banner"
      className="rounded border border-amber-700/50 bg-amber-950/20 p-3 text-sm"
    >
      <div className="mb-2 flex items-center gap-2 font-medium text-amber-300">
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
          return (
            <li
              key={reason}
              data-testid={`capability-reason-${reason}`}
              className="text-amber-100/90"
            >
              <span className="font-medium">
                {copy.title}
                {skipped}
              </span>{" "}
              <span className="text-amber-200/70">{copy.action}</span>
              {/* Issue #741 — offer a one-click resume of the skipped repos. */}
              {isSkippedRepos && onResumeRepos ? (
                <div className="mt-1.5">
                  <button
                    type="button"
                    data-testid="resume-skipped-repos"
                    onClick={onResumeRepos}
                    disabled={resuming}
                    className="rounded border border-amber-600/60 bg-amber-900/40 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-900/60 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {resuming
                      ? "Analyzing remaining repositories…"
                      : "Analyze remaining repositories"}
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
