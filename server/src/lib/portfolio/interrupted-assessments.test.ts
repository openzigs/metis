/**
 * #1657 — the interrupted portfolio assessment sweep, with the store as a
 * double. The sweep's conditional update over a real database is in
 * `tests/portfolio-assessment-routes-1625.sqlite.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ failInterruptedPortfolioAssessments: vi.fn() }));
vi.mock("./assessment-store.js", () => store);
const events = vi.hoisted(() => ({ failed: vi.fn() }));
vi.mock("../socket/job-events.js", () => ({
  jobEvents: events,
  genericFailureMessage: (kind: string) => `generic ${kind} failure`,
}));

const {
  PORTFOLIO_ASSESSMENT_HEARTBEAT_MS,
  PORTFOLIO_ASSESSMENT_STALE_MS,
  startPortfolioAssessmentSweeper,
  sweepInterruptedPortfolioAssessments,
} = await import("./interrupted-assessments.js");

beforeEach(() => {
  vi.useFakeTimers();
  store.failInterruptedPortfolioAssessments.mockReset();
  store.failInterruptedPortfolioAssessments.mockResolvedValue([]);
  events.failed.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("sweepInterruptedPortfolioAssessments", () => {
  it("fails the rows unchanged for the stale window, which outlasts many missed beats", async () => {
    store.failInterruptedPortfolioAssessments.mockResolvedValue(["pa-1", "pa-2", "pa-3"]);
    expect(await sweepInterruptedPortfolioAssessments(1_000_000_000)).toBe(3);
    expect(store.failInterruptedPortfolioAssessments).toHaveBeenCalledWith(
      new Date(1_000_000_000 - PORTFOLIO_ASSESSMENT_STALE_MS),
    );
    expect(PORTFOLIO_ASSESSMENT_STALE_MS).toBeGreaterThanOrEqual(
      5 * PORTFOLIO_ASSESSMENT_HEARTBEAT_MS,
    );
  });

  it("tells each failed run's subscribers it failed, with the generic message (#1668)", async () => {
    store.failInterruptedPortfolioAssessments.mockResolvedValue(["pa-1", "pa-2"]);
    await sweepInterruptedPortfolioAssessments();
    expect(events.failed.mock.calls).toEqual([
      ["portfolio-assessment", "pa-1", null, "generic portfolio-assessment failure"],
      ["portfolio-assessment", "pa-2", null, "generic portfolio-assessment failure"],
    ]);
    events.failed.mockReset();
    store.failInterruptedPortfolioAssessments.mockResolvedValue([]);
    expect(await sweepInterruptedPortfolioAssessments()).toBe(0);
    expect(events.failed).not.toHaveBeenCalled();
  });
});

describe("startPortfolioAssessmentSweeper", () => {
  it("sweeps now and then every interval until stopped, and survives a failed sweep", async () => {
    store.failInterruptedPortfolioAssessments.mockRejectedValueOnce(new Error("db down"));
    const stop = startPortfolioAssessmentSweeper(1_000);
    expect(store.failInterruptedPortfolioAssessments).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.failInterruptedPortfolioAssessments).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.failInterruptedPortfolioAssessments).toHaveBeenCalledTimes(3);
  });
});
