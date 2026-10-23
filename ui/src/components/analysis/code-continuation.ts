/**
 * Issue #1131 — what the analysis page says about "Continue with a larger
 * budget": before it starts (what it re-runs, its token budget, and a cost
 * estimate from this run's own figures) and while it runs.
 *
 * In #706 run 8 Continue re-ran the whole pass, cost more than the run it
 * continued, and showed nothing for 23 minutes. It now re-investigates only
 * the requirements the code pass never reached, and the page says so first.
 */
import type {
  AnalysisCodeContinuationQuote,
  AnalysisLedgerUsage,
  AnalysisLiveAgent,
  CodeInvestigationGap,
} from "@metis/shared";
import { formatTokens } from "@/lib/run-tokens";
import { liveAgentLine } from "./analysis-views";

/** Unrounded USD to four places, as the run header shows it. */
function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export interface ContinuationEstimate {
  /** What the continuation re-runs, and what it keeps. */
  scope: string;
  /** Its token budget and, when the run is priced, an estimated cost. */
  budget: string;
  /** This run's own tokens and cost so far, to compare with; `null` when unknown. */
  firstRun: string | null;
}

/**
 * The text of the confirmation step. The estimate prices the continuation's
 * code-pass token budget at this run's average price per token so far (its
 * ledger cost over its ledger tokens); rebuilding the requirements is extra.
 */
export function continuationEstimate(input: {
  gap?: CodeInvestigationGap;
  quote?: AnalysisCodeContinuationQuote | null;
  ledger?: AnalysisLedgerUsage | null;
}): ContinuationEstimate {
  const { gap, quote, ledger } = input;
  const what = gap
    ? `only the ${gap.unreached} of ${gap.total} requirements the code analysis did not reach`
    : "the requirements the code analysis did not reach";
  const inconclusive = gap?.inconclusive ?? 0;
  const scope =
    `Re-investigates ${what}, keeping the findings it already made, then rebuilds the requirements from all findings.` +
    (inconclusive > 0
      ? ` The ${inconclusive} inconclusive requirements are not re-run: a larger budget would not settle them.`
      : "");

  const counted = ledger && ledger.totalTokens > 0 ? ledger : null;
  let budget: string;
  if (!quote) {
    budget = "It runs with a larger token and turn budget than the first pass.";
  } else {
    budget = `The code pass may use up to ${formatTokens(quote.tokenBudget)} tokens (${quote.budgetMultiplier}× the configured budget)`;
    if (counted && counted.costUsd !== null) {
      const estimate = (quote.tokenBudget * counted.costUsd) / counted.totalTokens;
      budget += `: about ${usd(estimate)} at this run's average price, plus rebuilding the requirements.`;
    } else if (counted) {
      budget += "; no price is set for this run's model, so there is no cost estimate.";
    } else {
      budget += ".";
    }
  }

  const firstRun = counted
    ? `This run so far: ${formatTokens(counted.totalTokens)} tokens${
        counted.costUsd !== null ? `, ${usd(counted.costUsd)}` : ""
      }.`
    : null;
  return { scope, budget, firstRun };
}

/** The line the banner shows while a continuation runs. */
export function continuationProgressLine(live: AnalysisLiveAgent, now: number): string {
  const scope = live.continuation
    ? `re-investigating ${live.continuation.requirements} of ${live.continuation.total} requirements`
    : "re-investigating the requirements the code analysis did not reach";
  return `Rerun in progress: ${scope}. ${liveAgentLine(live, now)}`;
}
