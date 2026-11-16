/**
 * Issue #2571 — the Continue banner shows the same "Reading the code: …" line
 * as the code card while a continuation reads the code, on the server's clock:
 * a browser clock an hour ahead still reads "1 min 10 s".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  deriveCapabilityReasons,
  type AnalysisCapability,
  type AnalysisLiveAgent,
} from "@metis/shared";
import { AnalysisCapabilityBanner } from "./analysis-capability-banner";
import { continuationProgressLine } from "./code-continuation";

const SERVER_START = "2026-11-16T10:00:00.000Z";
const SKEW_MS = 3_600_000;

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
  codeInvestigationUnreached: { unreached: 3, inconclusive: 0, total: 19 },
};
const cutShort: AnalysisCapability = { ...base, reasons: deriveCapabilityReasons(base) };

const live = (over: Partial<AnalysisLiveAgent> = {}): AnalysisLiveAgent => ({
  agentKey: "code",
  startedAt: SERVER_START,
  toolCalls: 12,
  filesRead: 14,
  searches: 9,
  rerun: true,
  phase: "investigating",
  continuation: { requirements: 3, total: 19 },
  ...over,
});

describe("#2571 the Continue banner's progress line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(SERVER_START) + 70_000 + SKEW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it("reads the code-reading counts on the server's clock, not 'N steps so far'", () => {
    render(
      <AnalysisCapabilityBanner
        capability={cutShort}
        onContinueInvestigation={() => {}}
        liveContinuation={live()}
        clockOffsetMs={-SKEW_MS}
      />,
    );
    const progress = screen.getByTestId("continuation-in-progress");
    expect(progress).toHaveTextContent(
      "Rerun in progress: re-investigating 3 of 19 requirements. Reading the code: 14 files read, 9 searches, 1 min 10 s so far.",
    );
    expect(progress).not.toHaveTextContent("steps so far");
  });

  it("keeps the #766 line for an entry from a server without the counts, and a re-summary", () => {
    const now = Date.parse(SERVER_START) + 70_000;
    const old = live();
    delete (old as Partial<AnalysisLiveAgent>).filesRead;
    expect(continuationProgressLine(old, now)).toBe(
      "Rerun in progress: re-investigating 3 of 19 requirements. Re-running · 12 steps so far · 1m 10s",
    );
    expect(continuationProgressLine(live({ phase: "synthesizing" }), now)).toContain(
      "updating the run summary with the new findings",
    );
  });
});
