/**
 * Epic #803 (Epic 09) — Domain Eval panel tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/eval-api", () => ({
  domainEvalApi: {
    listRuns: vi.fn(),
    getRun: vi.fn(),
  },
}));

import { domainEvalApi, type DomainEvalRunSummary, type DomainEvalRunDetail } from "@/lib/eval-api";
import { DomainEvalPanel } from "@/components/eval/domain-eval-panel";

const m = domainEvalApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function mkSummary(
  runId: string,
  f1: number,
  driftAlert = false,
  driftOver: Partial<DomainEvalRunSummary["drift"]> = {},
): DomainEvalRunSummary {
  return {
    runId,
    schemaVersion: 1,
    model: "offline-stub",
    startedAt: `2026-05-0${runId.slice(-1)}T00:00:00Z`,
    completedAt: `2026-05-0${runId.slice(-1)}T00:10:00Z`,
    itemCount: 20,
    corpusPrecision: f1,
    corpusRecall: f1,
    corpusF1: f1,
    meanRougeL: 0.8,
    totalTokens: 1000,
    totalCostCents: 0,
    commit: "abc123",
    drift: {
      previousF1: driftAlert ? f1 + 0.1 : null,
      deltaF1: driftAlert ? -0.1 : null,
      thresholdPct: 0.05,
      alert: driftAlert,
      reason: driftAlert ? "F1 dropped" : "NO_BASELINE",
      baselineRunId: null,
      baselineAgeDays: null,
      staleBaseline: false,
      ...driftOver,
    },
    driftAlert,
  };
}

const detail: DomainEvalRunDetail = {
  ...mkSummary("run2", 0.7, true),
  calibration: [
    {
      bucket: "0.9-1.0",
      lowerBound: 0.9,
      upperBound: 1,
      count: 5,
      meanConfidence: 0.92,
      accuracy: 0.8,
    },
    { bucket: "0.0-0.1", lowerBound: 0, upperBound: 0.1, count: 0, meanConfidence: 0, accuracy: 0 },
  ],
  items: [
    {
      itemId: "prd-01",
      docType: "prd",
      title: "Auth portal",
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 0.66,
      recall: 1,
      f1: 0.8,
      meanRougeL: 0.75,
      matches: [
        { expectedId: "R1", predictedId: "P1", titleSimilarity: 0.9, rougeL: 0.8, confidence: 0.9 },
      ],
      expected: [
        {
          id: "R1",
          type: "feature",
          title: "Email login",
          description: "Log in via email",
          priority: "high",
        },
      ],
      predicted: [
        {
          id: "P1",
          type: "feature",
          title: "Email sign-in",
          description: "Sign in via email",
          priority: "high",
          confidence: 0.9,
        },
      ],
    },
  ],
};

beforeEach(() => {
  for (const k of Object.keys(m)) m[k]!.mockReset();
  m.listRuns!.mockResolvedValue({ runs: [mkSummary("run2", 0.7, true), mkSummary("run1", 0.9)] });
  m.getRun!.mockResolvedValue(detail);
});

describe("DomainEvalPanel", () => {
  it("renders the trend chart and a run table with a drift badge", async () => {
    render(<DomainEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("domain-runs-table")).toBeInTheDocument());
    expect(screen.getByTestId("domain-run-row-run2")).toBeInTheDocument();
    expect(screen.getByTestId("domain-drift-badge-run2")).toBeInTheDocument();
    expect(screen.getByTestId("domain-trend-card")).toBeInTheDocument();
  });

  // Issue #1333 — the stale-baseline caveat has to be WIRED INTO the table, not
  // merely renderable in isolation. Between 2026-07-21 and the fix, the nightly
  // committed nothing and every run compared against the same 2026-07-21
  // envelope; a row that reads a bare "OK" would present that as stability.
  it("states the history gap on a run whose baseline is stale", async () => {
    m.listRuns!.mockResolvedValue({
      runs: [
        mkSummary("run2", 0.7, false, {
          staleBaseline: true,
          baselineAgeDays: 39,
          baselineRunId: "2026-07-21T03-00-00-000Z",
        }),
        mkSummary("run1", 0.9),
      ],
    });
    render(<DomainEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("domain-runs-table")).toBeInTheDocument());
    expect(screen.getByTestId("domain-drift-stale-run2")).toHaveTextContent("Stale baseline (39d)");
    // The healthy row alongside it stays uncluttered.
    expect(screen.queryByTestId("domain-drift-stale-run1")).toBeNull();
  });

  it("shows the empty state when there are no runs", async () => {
    m.listRuns!.mockResolvedValueOnce({ runs: [] });
    render(<DomainEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("domain-runs-empty")).toBeInTheDocument());
  });

  it("loads run detail with calibration and per-item diffs on inspect", async () => {
    render(<DomainEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("domain-run-inspect-run2")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("domain-run-inspect-run2"));
    await waitFor(() => expect(screen.getByTestId("domain-run-detail-run2")).toBeInTheDocument());
    expect(m.getRun).toHaveBeenCalledWith("run2");
    // Non-empty calibration bins are shown; empty ones filtered out.
    await waitFor(() =>
      expect(screen.getByTestId("domain-calibration-bin-0.9-1.0")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("domain-calibration-bin-0.0-0.1")).not.toBeInTheDocument();
    // Expand the item to reveal the field diff.
    fireEvent.click(screen.getByTestId("domain-item-toggle-prd-01"));
    expect(screen.getByTestId("domain-field-diff-prd-01")).toBeInTheDocument();
  });

  it("refetches with a new window when the days filter changes", async () => {
    const user = userEvent.setup();
    render(<DomainEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("domain-runs-table")).toBeInTheDocument());
    await user.click(screen.getByTestId("domain-days-filter"));
    await user.click(await screen.findByRole("option", { name: "30 days" }));
    await waitFor(() => expect(m.listRuns).toHaveBeenCalledWith({ days: 30 }));
  });

  it("surfaces an error state when the list query fails", async () => {
    m.listRuns!.mockRejectedValueOnce(new Error("boom"));
    render(<DomainEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("domain-runs-error")).toBeInTheDocument());
  });
});
