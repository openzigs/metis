/**
 * Issue #2571 — the progress line an analyst sees while METIS reads the code:
 * it follows each poll's counts, counts the time up on the server's clock (a
 * browser clock an hour off still reads "1 min 10 s"), and adds the explore
 * note only in explore mode.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisLiveAgent } from "@metis/shared";
import { LiveAgentProgress } from "./live-agent-progress";
import { EXPLORE_PROGRESS_NOTE, serverClockOffsetMs } from "./analysis-views";

const SERVER_START = "2026-11-16T10:00:00.000Z";
/** The browser's clock runs an hour ahead of the server's. */
const SKEW_MS = 3_600_000;

const live = (over: Partial<AnalysisLiveAgent> = {}): AnalysisLiveAgent => ({
  agentKey: "code",
  startedAt: SERVER_START,
  toolCalls: 23,
  filesRead: 14,
  searches: 9,
  mode: "explore",
  rerun: false,
  phase: "investigating",
  ...over,
});

describe("LiveAgentProgress (#2571)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The server read the snapshot 70 s after the pass started; the browser,
    // an hour ahead, received it at that moment on its own clock.
    vi.setSystemTime(Date.parse(SERVER_START) + 70_000 + SKEW_MS);
  });
  afterEach(() => vi.useRealTimers());

  const offset = () =>
    serverClockOffsetMs(new Date(Date.parse(SERVER_START) + 70_000).toISOString(), Date.now());

  it("reads the counts and the server-clock time, follows a second poll, and counts up", () => {
    const { rerender } = render(
      <LiveAgentProgress live={live()} clockOffsetMs={offset()} testId="p" />,
    );
    expect(screen.getByTestId("p")).toHaveTextContent(
      "Reading the code: 14 files read, 9 searches, 1 min 10 s so far.",
    );
    expect(screen.getByTestId("p-note")).toHaveTextContent(EXPLORE_PROGRESS_NOTE);

    // The next poll: one more file read.
    rerender(
      <LiveAgentProgress live={live({ filesRead: 15 })} clockOffsetMs={offset()} testId="p" />,
    );
    expect(screen.getByTestId("p")).toHaveTextContent("15 files read, 9 searches");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId("p")).toHaveTextContent("1 min 15 s so far.");
  });

  it("fast mode: the same counts, no note", () => {
    render(<LiveAgentProgress live={live({ mode: "fast" })} clockOffsetMs={offset()} testId="p" />);
    expect(screen.getByTestId("p")).toHaveTextContent("14 files read, 9 searches");
    expect(screen.queryByTestId("p-note")).toBeNull();
  });

  it("another agent keeps the #766 line, on the server's clock too", () => {
    render(
      <LiveAgentProgress
        live={live({ agentKey: "database", rerun: true, toolCalls: 0 })}
        clockOffsetMs={offset()}
        testId="p"
      />,
    );
    expect(screen.getByTestId("p")).toHaveTextContent("Re-running · 1m 10s");
  });

  it("keeps the ticking time out of the live region: it holds only what a poll changes", () => {
    render(<LiveAgentProgress live={live()} clockOffsetMs={offset()} testId="p" />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/^Reading the code: 14 files read, 9 searches$/);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // The time moved on; the live region's text did not.
    expect(screen.getByTestId("p")).toHaveTextContent("1 min 15 s so far.");
    expect(screen.getByRole("status")).toHaveTextContent(
      /^Reading the code: 14 files read, 9 searches$/,
    );
    expect(screen.getByTestId("p-elapsed")).not.toHaveAttribute("role");
  });

  it("the #766 line's live region holds the steps, not the time", () => {
    render(
      <LiveAgentProgress
        live={live({ agentKey: "database", rerun: true, toolCalls: 3 })}
        clockOffsetMs={offset()}
        testId="p"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^Re-running · 3 steps so far$/);
    expect(screen.getByTestId("p")).toHaveTextContent("Re-running · 3 steps so far · 1m 10s");
  });

  it("with announce={false} there is no live region, so a second copy is not announced", () => {
    render(
      <>
        <LiveAgentProgress
          live={live()}
          clockOffsetMs={offset()}
          testId="header"
          announce={false}
        />
        <LiveAgentProgress live={live()} clockOffsetMs={offset()} testId="card" />
      </>,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("header")).toHaveTextContent("Reading the code: 14 files read");
  });

  it("stops its one-second timer on unmount", () => {
    const { unmount } = render(
      <LiveAgentProgress live={live()} clockOffsetMs={offset()} testId="p" />,
    );
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says none of agent, token, turn or tool call", () => {
    const { container } = render(
      <LiveAgentProgress live={live()} clockOffsetMs={offset()} testId="p" />,
    );
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["agent", "token", "turn", "tool call"]) expect(text).not.toContain(word);
  });
});
