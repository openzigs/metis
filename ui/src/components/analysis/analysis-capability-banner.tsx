"use client";

/**
 * Issue #733 — degraded-mode capability banner on the analysis results page.
 *
 * Renders ONLY for degraded runs (a persisted capability record with ≥1 reason).
 * Each reason maps to plain, actionable copy so a business analyst understands
 * what was NOT analyzed and how to fix it — rather than the pipeline degrading
 * silently. A fully-capable run renders nothing.
 */
import { useState } from "react";
import {
  codeInvestigationContinueLimitReached,
  codeInvestigationContinueOffered,
  isAnalysisDegraded,
  type AnalysisCapability,
  type AnalysisCodeContinuationQuote,
  type AnalysisLedgerUsage,
  type AnalysisLiveAgent,
} from "@metis/shared";
import { CAPABILITY_REASON_COPY } from "@/lib/analysis-capability-copy";
import { continuationEstimate, continuationProgressLine } from "./code-continuation";

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

/**
 * Issue #1131 — on a first cut-short run, how many requirements the pass never
 * reached and how many it reached that are inconclusive. `null` without counts.
 */
export function cutShortGapText(capability: AnalysisCapability): string | null {
  const gap = capability.codeInvestigationUnreached;
  if (!gap || (capability.codeInvestigationContinuations ?? 0) > 0) return null;
  const inconclusive = gap.inconclusive ?? 0;
  return (
    `${gap.unreached} of ${gap.total} requirements ${gap.unreached === 1 ? "was" : "were"} not reached.` +
    (inconclusive > 0
      ? inconclusive === 1
        ? " 1 more was reached but is inconclusive; a larger budget would not change it."
        : ` ${inconclusive} more were reached but are inconclusive; a larger budget would not change them.`
      : "")
  );
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
   * Issue #1001 — invoked when the operator CONFIRMS "Continue with a larger
   * budget" on the `code-investigation-cut-short` reason. Omitted ⇒ not rendered.
   */
  onContinueInvestigation?: () => void;
  /** True while a continued investigation is being started. */
  continuing?: boolean;
  /** Issue #1131 — the budget Continue would run with (the snapshot's quote). */
  continuationQuote?: AnalysisCodeContinuationQuote | null;
  /** Issue #1131 — this run's ledger spend, which the estimate is priced from. */
  ledgerUsage?: AnalysisLedgerUsage | null;
  /** Issue #1131 — a continuation running right now, shown in place of the action. */
  liveContinuation?: AnalysisLiveAgent | null;
}

const ACTION_BUTTON =
  "rounded border border-warning/40 bg-warning-muted px-2 py-1 text-xs font-medium text-warning hover:bg-warning-muted disabled:cursor-not-allowed disabled:opacity-60";

export function AnalysisCapabilityBanner({
  capability,
  onResumeRepos,
  resuming = false,
  onContinueInvestigation,
  continuing = false,
  continuationQuote,
  ledgerUsage,
  liveContinuation,
}: Props): React.ReactElement | null {
  const [confirming, setConfirming] = useState(false);
  if (!isAnalysisDegraded(capability) || !capability) return null;
  const continueOffered = codeInvestigationContinueOffered(capability);

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
          const gapNote = isCutShort ? cutShortGapText(capability) : null;
          const continueLimited = isCutShort && codeInvestigationContinueLimitReached(capability);
          // Issue #1131 — reached but not settled: counted, never continued.
          const inconclusiveGap =
            reason === "code-investigation-inconclusive"
              ? capability.codeInvestigationUnreached
              : undefined;
          const showContinue =
            isCutShort && continueOffered && !liveContinuation && Boolean(onContinueInvestigation);
          const estimate =
            showContinue && confirming
              ? continuationEstimate({
                  gap: capability.codeInvestigationUnreached,
                  quote: continuationQuote,
                  ledger: ledgerUsage,
                })
              : null;
          return (
            <li key={reason} data-testid={`capability-reason-${reason}`} className="text-warning">
              <span className="font-medium">
                {copy.title}
                {skipped}
              </span>{" "}
              {continueLimited ? null : <span className="text-warning">{copy.action}</span>}
              {inconclusiveGap ? (
                <p className="mt-1.5 font-medium text-warning" data-testid="inconclusive-count">
                  {inconclusiveGap.inconclusive ?? 0} of {inconclusiveGap.total} requirements{" "}
                  {(inconclusiveGap.inconclusive ?? 0) === 1 ? "is" : "are"} inconclusive.
                </p>
              ) : null}
              {gapNote ? (
                <p className="mt-1.5 font-medium text-warning" data-testid="cut-short-gap">
                  {gapNote}
                </p>
              ) : null}
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
                    className={ACTION_BUTTON}
                  >
                    {resuming
                      ? "Analyzing remaining repositories…"
                      : "Analyze remaining repositories"}
                  </button>
                </div>
              ) : null}
              {/* Issue #1131 — a continuation in progress, with the first run's progress line. */}
              {isCutShort && liveContinuation ? (
                <p
                  className="mt-1.5 font-medium text-warning"
                  aria-live="polite"
                  data-testid="continuation-in-progress"
                >
                  {continuationProgressLine(liveContinuation, Date.now())}
                </p>
              ) : null}
              {/* Issue #1001 — continue a code pass that ran out of budget;
              #1131 — only after the analyst has seen what it costs. */}
              {showContinue && !estimate ? (
                <div className="mt-1.5">
                  <button
                    type="button"
                    data-testid="continue-code-investigation"
                    onClick={() => setConfirming(true)}
                    disabled={continuing}
                    className={ACTION_BUTTON}
                  >
                    {continuing ? "Continuing code analysis…" : "Continue with a larger budget…"}
                  </button>
                </div>
              ) : null}
              {estimate ? (
                <div
                  role="group"
                  aria-label="Continue the code analysis"
                  data-testid="continue-confirm"
                  className="mt-1.5 space-y-1 rounded border border-warning/40 p-2 text-xs"
                >
                  <p>{estimate.scope}</p>
                  <p>{estimate.budget}</p>
                  {estimate.firstRun ? <p>{estimate.firstRun}</p> : null}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      data-testid="confirm-continue-code-investigation"
                      onClick={() => {
                        setConfirming(false);
                        onContinueInvestigation?.();
                      }}
                      disabled={continuing}
                      className={ACTION_BUTTON}
                    >
                      Start the continuation
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className={ACTION_BUTTON}
                    >
                      Not now
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
