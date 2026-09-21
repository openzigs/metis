/**
 * Epic #194 (C.5) — Eval leaderboard page tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";

vi.mock("@/lib/eval-api", () => ({
  evalApi: {
    listLeaderboard: vi.fn(),
    getRun: vi.fn(),
    triggerRun: vi.fn(),
  },
}));

import { evalApi } from "@/lib/eval-api";
import EvalLeaderboardPage from "@/app/(authed)/eval/leaderboard/page";

const m = evalApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  for (const k of Object.keys(m)) m[k]!.mockReset();
  m.listLeaderboard!.mockResolvedValue({
    runs: [
      {
        id: "r1",
        benchmark: "swe-bench-pro",
        model: "gpt-5",
        score: 0.7,
        totalTasks: 10,
        passedTasks: 7,
        meanTokens: 100,
        meanCostCents: 50,
        meanLatencyMs: 200,
        startedAt: "2026-04-25T10:00:00Z",
        completedAt: "2026-04-25T11:00:00Z",
        status: "completed",
      },
      {
        id: "r2",
        benchmark: "swe-bench-pro",
        model: "gpt-5",
        score: 0.5,
        totalTasks: 10,
        passedTasks: 5,
        meanTokens: 100,
        meanCostCents: 50,
        meanLatencyMs: 200,
        startedAt: "2026-04-24T10:00:00Z",
        completedAt: "2026-04-24T11:00:00Z",
        status: "completed",
      },
    ],
  });
});

describe("EvalLeaderboardPage", () => {
  it("renders the leaderboard with rows + trend cards", async () => {
    render(<EvalLeaderboardPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => expect(screen.getByTestId("leaderboard-row-r1")).toBeInTheDocument());
    expect(screen.getByTestId("trend-swe-bench-pro")).toBeInTheDocument();
    expect(screen.getByTestId("trend-tau-bench")).toBeInTheDocument();
  });

  it("hides the trigger buttons for non-admins", async () => {
    const viewer = { ...TEST_USER, role: "reader" as const };
    render(<EvalLeaderboardPage />, { wrapper: makeWrapper({ initialUser: viewer }) });
    await waitFor(() => expect(screen.getByTestId("leaderboard-row-r1")).toBeInTheDocument());
    expect(screen.queryByTestId("trigger-swe-bench-pro")).toBeNull();
  });

  it("shows the disabled message when the trigger returns disabled", async () => {
    m.triggerRun!.mockResolvedValueOnce({
      benchRunId: null,
      status: "disabled",
      reason: "EVAL_NIGHTLY_ENABLED is not 'true'",
    });
    render(<EvalLeaderboardPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => expect(screen.getByTestId("trigger-swe-bench-pro")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("trigger-swe-bench-pro"));
    await waitFor(() => expect(screen.getByTestId("trigger-feedback")).toBeInTheDocument());
    expect(screen.getByTestId("trigger-feedback")).toHaveTextContent(/EVAL_NIGHTLY_ENABLED/);
  });

  it("re-fetches when the bench filter changes", async () => {
    render(<EvalLeaderboardPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => expect(screen.getByTestId("bench-filter")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("bench-filter"), { target: { value: "tau-bench" } });
    await waitFor(() => expect(m.listLeaderboard).toHaveBeenCalledTimes(2));
    const lastCall = m.listLeaderboard!.mock.calls.at(-1)?.[0];
    expect(lastCall.bench).toBe("tau-bench");
  });

  it("renders an error state on fetch failure", async () => {
    m.listLeaderboard!.mockRejectedValueOnce(new Error("boom"));
    render(<EvalLeaderboardPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await waitFor(() => expect(screen.getByTestId("leaderboard-error")).toBeInTheDocument());
  });
});
