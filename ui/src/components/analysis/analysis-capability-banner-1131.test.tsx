/**
 * Issue #1131 — "Continue with a larger budget" in #706 run 8: it cost more
 * than the run it continued, showed nothing while it ran, and was offered for
 * requirements the agent had already reached (inconclusive, not unreached).
 *
 * Pinned here: the banner quotes what Continue re-runs and an estimate before
 * it starts (a confirmation step), shows a rerun in progress, names
 * inconclusive requirements without offering Continue, and says nothing on a
 * run whose every requirement is grounded.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  deriveCapabilityReasons,
  type AnalysisCapability,
  type AnalysisLiveAgent,
} from "@metis/shared";
import { AnalysisCapabilityBanner } from "./analysis-capability-banner";
import { continuationEstimate, continuationProgressLine } from "./code-continuation";

function capability(overrides: Partial<AnalysisCapability> = {}): AnalysisCapability {
  const base = {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    agentMode: "agentic" as const,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: [] as AnalysisCapability["skippedRepos"],
    codeInvestigationCutShort: true,
    ...overrides,
  };
  return { ...base, reasons: deriveCapabilityReasons(base) };
}

const cutShort = capability({
  codeInvestigationUnreached: { unreached: 3, inconclusive: 2, total: 19 },
});
const QUOTE = { tokenBudget: 200_000, budgetMultiplier: 2 };
// Wave B, Phase 7: $0.1084 for the first run.
const LEDGER = { totalTokens: 400_000, costUsd: 0.1084, unpricedTokens: 0 };

describe("#1131 Continue asks for confirmation with what it re-runs and an estimate", () => {
  it("does not start on the first click: it shows the scope and the estimate", () => {
    const onContinue = vi.fn();
    render(
      <AnalysisCapabilityBanner
        capability={cutShort}
        onContinueInvestigation={onContinue}
        continuationQuote={QUOTE}
        ledgerUsage={LEDGER}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue with a larger budget…" }));
    expect(onContinue).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: "Continue the code analysis" });
    expect(confirm).toHaveTextContent(
      "only the 3 of 19 requirements the code analysis did not reach",
    );
    expect(confirm).toHaveTextContent("2 inconclusive requirements are not re-run");
    expect(confirm).toHaveTextContent("budgeted at 200.0k tokens (2× the configured budget)");
    // A budget, not a cap: the recovery calls and the rebuild are named.
    expect(confirm).toHaveTextContent(
      "The final answer retry and evidence salvage can add a little, and rebuilding the requirements is extra.",
    );
    // 200k tokens at this run's $0.1084 / 400k.
    expect(confirm).toHaveTextContent("about $0.0542");
    expect(confirm).toHaveTextContent("This run so far: 400.0k tokens, $0.1084.");
  });

  it("starts only on confirm, and Not now closes it without starting", () => {
    const onContinue = vi.fn();
    render(
      <AnalysisCapabilityBanner
        capability={cutShort}
        onContinueInvestigation={onContinue}
        continuationQuote={QUOTE}
        ledgerUsage={LEDGER}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue with a larger budget…" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Continue the code analysis" })).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue with a larger budget…" }));
    fireEvent.click(screen.getByRole("button", { name: "Start the continuation" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("says plainly when the run's model has no price", () => {
    render(
      <AnalysisCapabilityBanner
        capability={cutShort}
        onContinueInvestigation={() => {}}
        continuationQuote={QUOTE}
        ledgerUsage={{ totalTokens: 400_000, costUsd: null, unpricedTokens: 400_000 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue with a larger budget…" }));
    expect(screen.getByRole("group", { name: "Continue the code analysis" })).toHaveTextContent(
      "no price is set for this run's model, so there is no cost estimate",
    );
  });
});

describe("#1131 a rerun in progress shows on the banner", () => {
  const live: AnalysisLiveAgent = {
    agentKey: "code",
    startedAt: new Date(Date.now() - 64_000).toISOString(),
    toolCalls: 12,
    rerun: true,
    phase: "investigating",
    continuation: { requirements: 3, total: 19 },
  };

  it("shows what it re-investigates and its progress, with no Continue button", () => {
    render(
      <AnalysisCapabilityBanner
        capability={cutShort}
        onContinueInvestigation={() => {}}
        liveContinuation={live}
      />,
    );
    const progress = screen.getByTestId("continuation-in-progress");
    expect(progress).toHaveTextContent("Rerun in progress: re-investigating 3 of 19 requirements");
    expect(progress).toHaveTextContent("12 steps so far");
    expect(screen.queryByRole("button", { name: /Continue with a larger budget/ })).toBeNull();
  });

  it("says when it has moved on to rebuilding the requirements", () => {
    expect(continuationProgressLine({ ...live, phase: "synthesizing" }, Date.now())).toContain(
      "updating the run summary with the new findings",
    );
  });
});

describe("#1131 inconclusive is not unreached", () => {
  it("names an inconclusive-only run as inconclusive, with no Continue", () => {
    render(
      <AnalysisCapabilityBanner
        capability={capability({
          codeInvestigationUnreached: { unreached: 0, inconclusive: 3, total: 19 },
        })}
        onContinueInvestigation={() => {}}
        continuationQuote={QUOTE}
      />,
    );
    const reason = screen.getByTestId("capability-reason-code-investigation-inconclusive");
    expect(reason).toHaveTextContent("3 of 19 requirements are inconclusive");
    expect(reason).toHaveTextContent(/a larger budget would not change/i);
    expect(screen.queryByTestId("capability-reason-code-investigation-cut-short")).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue with a larger budget/ })).toBeNull();
  });

  it("shows no banner when every requirement has a grounded verdict", () => {
    const { container } = render(
      <AnalysisCapabilityBanner
        capability={capability({
          codeInvestigationUnreached: { unreached: 0, inconclusive: 0, total: 5 },
        })}
        onContinueInvestigation={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("counts unreached and inconclusive apart on a first cut-short run", () => {
    render(<AnalysisCapabilityBanner capability={cutShort} />);
    expect(screen.getByTestId("cut-short-gap")).toHaveTextContent(
      "3 of 19 requirements were not reached. 2 more were reached but are inconclusive; a larger budget would not change them.",
    );
  });
});

describe("continuationEstimate (#1131)", () => {
  it("describes a run with no counts and no quote without inventing numbers", () => {
    const out = continuationEstimate({});
    expect(out.scope).toMatch(/^Re-investigates the requirements the code analysis did not reach/);
    expect(out.budget).toBe("It runs with a larger token and turn budget than the first pass.");
    expect(out.firstRun).toBeNull();
  });

  it("gives no cost when the ledger holds no tokens", () => {
    const out = continuationEstimate({
      quote: QUOTE,
      ledger: { totalTokens: 0, costUsd: null, unpricedTokens: 0 },
    });
    expect(out.budget).not.toContain("$");
    expect(out.firstRun).toBeNull();
  });
});

describe("#1131 singular copy (review of #1451)", () => {
  it("says one requirement in the singular", () => {
    const out = continuationEstimate({ gap: { unreached: 1, inconclusive: 1, total: 19 } });
    expect(out.scope).toContain("only the 1 of 19 requirements the code analysis did not reach");
    expect(out.scope).toContain(
      "The 1 inconclusive requirement is not re-run: a larger budget would not settle it.",
    );
    render(
      <AnalysisCapabilityBanner
        capability={capability({
          codeInvestigationUnreached: { unreached: 1, inconclusive: 1, total: 19 },
        })}
      />,
    );
    expect(screen.getByTestId("cut-short-gap")).toHaveTextContent(
      "1 of 19 requirements was not reached. 1 more was reached but is inconclusive; a larger budget would not change it.",
    );
  });

  it("names one inconclusive requirement in the singular", () => {
    render(
      <AnalysisCapabilityBanner
        capability={capability({
          codeInvestigationUnreached: { unreached: 0, inconclusive: 1, total: 19 },
        })}
      />,
    );
    expect(screen.getByTestId("inconclusive-count")).toHaveTextContent(
      "1 of 19 requirements is inconclusive.",
    );
  });
});
