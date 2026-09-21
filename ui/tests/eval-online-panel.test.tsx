/**
 * Issue #1321 — Online Eval panel tests.
 *
 * The load-bearing assertion is the honesty marking: while the judge is the
 * lexical stub the panel must say so, because these scores are otherwise
 * indistinguishable from a real quality metric (#1317).
 *
 * The marking must come from each WINDOW's own `judgeMeaningful`, not from
 * `/status`. `/status` describes the judge configured right now; it says nothing
 * about the judge that produced a row rendered from history. Gating on
 * `/status` alone fails in both directions and both are tested here: rows render
 * uncaveated while `/status` is loading or 403s, and every historical stub
 * window silently joins the "real" trend the moment #1317 lands.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/eval-api", () => ({
  onlineEvalApi: {
    listWindows: vi.fn(),
    getStatus: vi.fn(),
  },
}));

import { onlineEvalApi, type OnlineEvalStatus, type OnlineEvalWindowSummary } from "@/lib/eval-api";
import { OnlineEvalPanel } from "@/components/eval/online-eval-panel";
import { OnlineTrendChart } from "@/components/eval/online-trend-chart";

const m = onlineEvalApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function mkWindow(
  windowId: string,
  faithfulness: number | null,
  over: Partial<OnlineEvalWindowSummary> = {},
): OnlineEvalWindowSummary {
  return {
    windowId,
    schemaVersion: 1,
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: `2026-08-1${windowId.slice(-1)}T00:00:00.000Z`,
    judge: "StubRagasJudge",
    judgeMeaningful: false,
    sampleCount: 20,
    meanScores: {
      context_precision: 1,
      context_recall: 1,
      faithfulness,
      answer_relevancy: 0.7,
    },
    scored: {
      context_precision: 20,
      context_recall: 20,
      faithfulness: faithfulness === null ? 0 : 20,
      answer_relevancy: 20,
    },
    unverifiable: {
      context_precision: 0,
      context_recall: 0,
      faithfulness: faithfulness === null ? 20 : 0,
      answer_relevancy: 0,
    },
    trendedMetrics: ["faithfulness", "answer_relevancy"],
    drift: {
      metric: "faithfulness",
      previous: null,
      delta: null,
      thresholdPct: 0.05,
      alert: false,
      reason: "NO_PREVIOUS_WINDOW",
    },
    budget: { monthBucket: "2026-08", tokensUsed: 4000, tokensCap: 250_000, calls: 20 },
    driftAlert: false,
    ...over,
  };
}

function mkStatus(over: Partial<OnlineEvalStatus> = {}): OnlineEvalStatus {
  return {
    enabled: true,
    sampleRate: 0.01,
    windowSize: 20,
    driftAlertsEnabled: false,
    judge: "StubRagasJudge",
    judgeMeaningful: false,
    pendingSamples: 3,
    budget: { monthBucket: "2026-08", tokensUsed: 4000, tokensCap: 250_000, calls: 20 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.listWindows.mockResolvedValue({ windows: [] });
  m.getStatus.mockResolvedValue(mkStatus());
});

describe("OnlineEvalPanel", () => {
  it("warns that stub-judge scores are not a quality signal", async () => {
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    const warning = await screen.findByTestId("online-stub-judge-warning");
    expect(warning.textContent).toContain("not a quality signal");
    expect(warning.textContent).toContain("StubRagasJudge");
    expect(warning.textContent).toContain("#1317");
  });

  it("drops the warning once a real judge is configured", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ judge: "ModelRagasJudge", judgeMeaningful: true }));
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    await screen.findByTestId("online-status-card");
    expect(screen.queryByTestId("online-stub-judge-warning")).toBeNull();
  });

  it("renders the sampler status: rate, alerting, budget and buffer depth", async () => {
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    expect((await screen.findByTestId("online-enabled")).textContent).toContain("1.0%");
    expect(screen.getByTestId("online-alerts-enabled").textContent).toBe("Off");
    expect(screen.getByTestId("online-budget").textContent).toContain("4,000");
    expect(screen.getByTestId("online-pending").textContent).toContain("3 / 20");
  });

  it("says sampling is off when the kill switch is engaged", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ enabled: false }));
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    expect((await screen.findByTestId("online-enabled")).textContent).toBe("Off");
  });

  it("shows the empty state when no window has completed", async () => {
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("online-windows-empty")).toBeTruthy();
  });

  it("lists completed windows with their scores and drift state", async () => {
    m.listWindows.mockResolvedValue({
      windows: [
        mkWindow("w1", 0.9),
        mkWindow("w2", 0.4, {
          driftAlert: true,
          drift: {
            metric: "faithfulness",
            previous: 0.9,
            delta: -0.5,
            thresholdPct: 0.05,
            alert: true,
            reason: "DRIFT",
          },
        }),
      ],
    });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    const table = await screen.findByTestId("online-windows-table");
    expect(table.textContent).toContain("90.0%");
    expect(table.textContent).toContain("40.0%");
    expect(screen.getByTestId("online-drift-w2")).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    m.listWindows.mockRejectedValue(new Error("boom"));
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("online-windows-error")).toBeTruthy());
  });

  it("marks each stub-judge row from the WINDOW, not from /status", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ judge: "ModelRagasJudge", judgeMeaningful: true }));
    m.listWindows.mockResolvedValue({
      windows: [
        mkWindow("w2", 0.88, { judge: "ModelRagasJudge", judgeMeaningful: true }),
        mkWindow("w1", 0.9),
      ],
    });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    await screen.findByTestId("online-windows-table");

    // The historical stub window is marked even though the CURRENT judge is real.
    expect(screen.getByTestId("online-window-stub-w1")).toBeTruthy();
    expect(screen.queryByTestId("online-window-stub-w2")).toBeNull();
    expect(screen.getByTestId("online-window-w1").getAttribute("data-judge-meaningful")).toBe(
      "false",
    );
    expect(screen.getByTestId("online-window-w2").getAttribute("data-judge-meaningful")).toBe(
      "true",
    );
    // …and the banner still fires, scoped to "some of these".
    const warning = screen.getByTestId("online-stub-judge-warning");
    expect(warning.textContent).toContain("Some of these scores are not a quality signal");
  });

  it("still caveats the rows when /status is unavailable", async () => {
    // A 403 or a network failure on /status must not silently un-caveat the
    // stub-derived numbers rendered below it.
    m.getStatus.mockRejectedValue(new Error("403"));
    m.listWindows.mockResolvedValue({ windows: [mkWindow("w1", 0.9), mkWindow("w2", 0.8)] });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    await screen.findByTestId("online-windows-table");

    expect(screen.queryByTestId("online-status-card")).toBeNull();
    expect(screen.getByTestId("online-stub-judge-warning")).toBeTruthy();
    expect(screen.getByTestId("online-window-stub-w1")).toBeTruthy();
    expect(screen.getByTestId("online-window-stub-w2")).toBeTruthy();
  });

  it("notes how many trend points came from a stub judge", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ judge: "ModelRagasJudge", judgeMeaningful: true }));
    m.listWindows.mockResolvedValue({
      windows: [
        mkWindow("w2", 0.88, { judge: "ModelRagasJudge", judgeMeaningful: true }),
        mkWindow("w1", 0.9),
      ],
    });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    const note = await screen.findByTestId("online-trend-stub-note");
    expect(note.textContent).toContain("1 of 2");
  });

  // ── #1329 — UNVERIFIABLE IS NOT ZERO ──────────────────────────────────────
  //
  // `null * 100` is `0` in JavaScript, so every arithmetic route from an
  // unscored metric to a rendered figure paints it as a confident 0.0%. These
  // pin the two places a reader would see it.

  it("renders an unverifiable faithfulness as n/a, never as 0.0%", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ judge: "ModelRagasJudge", judgeMeaningful: true }));
    m.listWindows.mockResolvedValue({
      windows: [mkWindow("w1", null, { judge: "ModelRagasJudge", judgeMeaningful: true })],
    });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    const cell = await screen.findByTestId("online-window-faithfulness-w1");
    expect(cell.textContent).toBe("n/a");
    expect(cell.textContent).not.toContain("0.0%");
  });

  it("notes the windows left out of the trend because nothing was measurable", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ judge: "ModelRagasJudge", judgeMeaningful: true }));
    m.listWindows.mockResolvedValue({
      windows: [
        mkWindow("w2", null, { judge: "ModelRagasJudge", judgeMeaningful: true }),
        mkWindow("w1", 0.9, { judge: "ModelRagasJudge", judgeMeaningful: true }),
      ],
    });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    const note = await screen.findByTestId("online-trend-unverifiable-note");
    expect(note.textContent).toContain("1 of 2");
  });

  it("drops every caveat once both /status and all windows are real", async () => {
    m.getStatus.mockResolvedValue(mkStatus({ judge: "ModelRagasJudge", judgeMeaningful: true }));
    m.listWindows.mockResolvedValue({
      windows: [
        mkWindow("w1", 0.9, { judge: "ModelRagasJudge", judgeMeaningful: true }),
        mkWindow("w2", 0.88, { judge: "ModelRagasJudge", judgeMeaningful: true }),
      ],
    });
    render(<OnlineEvalPanel />, { wrapper: makeWrapper() });
    await screen.findByTestId("online-windows-table");
    expect(screen.queryByTestId("online-stub-judge-warning")).toBeNull();
    expect(screen.queryByTestId("online-window-stub-w1")).toBeNull();
    expect(screen.queryByTestId("online-trend-stub-note")).toBeNull();
  });
});

describe("OnlineTrendChart", () => {
  it("needs two windows before it draws a trend", () => {
    render(<OnlineTrendChart windows={[mkWindow("w1", 0.9)]} />);
    expect(screen.getByTestId("online-trend-empty")).toBeTruthy();
  });

  it("plots one point per window and flags drift ones", () => {
    render(
      <OnlineTrendChart
        windows={[mkWindow("w1", 0.9), mkWindow("w2", 0.4, { driftAlert: true })]}
      />,
    );
    expect(screen.getByTestId("online-trend-chart")).toBeTruthy();
    expect(screen.getByTestId("online-point-w1").getAttribute("data-drift-alert")).toBe("false");
    expect(screen.getByTestId("online-point-w2").getAttribute("data-drift-alert")).toBe("true");
  });

  it("draws a stub-judge point as a hollow square, not a point on the real line", () => {
    render(
      <OnlineTrendChart
        windows={[
          mkWindow("w1", 0.9),
          mkWindow("w2", 0.88, { judge: "ModelRagasJudge", judgeMeaningful: true }),
        ]}
      />,
    );
    const stub = screen.getByTestId("online-point-w1");
    const real = screen.getByTestId("online-point-w2");
    expect(stub.getAttribute("data-judge-meaningful")).toBe("false");
    expect(real.getAttribute("data-judge-meaningful")).toBe("true");
    // Shape, not just colour — the marker is distinguishable without colour.
    expect(stub.tagName.toLowerCase()).toBe("rect");
    expect(real.tagName.toLowerCase()).toBe("circle");
    expect(stub.querySelector("title")?.textContent).toContain("not a quality signal");
  });

  it("breaks the line at the judge cutover instead of drawing one continuous trend", () => {
    render(
      <OnlineTrendChart
        windows={[
          mkWindow("w1", 0.9),
          mkWindow("w2", 0.88, { judge: "ModelRagasJudge", judgeMeaningful: true }),
        ]}
      />,
    );
    const stubSeg = screen.getByTestId("online-trend-segment-0");
    const realSeg = screen.getByTestId("online-trend-segment-1");
    expect(stubSeg.getAttribute("data-judge-meaningful")).toBe("false");
    expect(stubSeg.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(realSeg.getAttribute("data-judge-meaningful")).toBe("true");
    expect(realSeg.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("draws one solid segment when every window shares a judge", () => {
    render(<OnlineTrendChart windows={[mkWindow("w1", 0.9), mkWindow("w2", 0.4)]} />);
    expect(screen.getByTestId("online-trend-segment-0")).toBeTruthy();
    expect(screen.queryByTestId("online-trend-segment-1")).toBeNull();
  });

  it("does not plot an unverifiable window — it is not a point at zero (#1329)", () => {
    render(
      <OnlineTrendChart
        windows={[mkWindow("w1", 0.9), mkWindow("w2", 0.8), mkWindow("w3", null)]}
      />,
    );
    expect(screen.getByTestId("online-point-w1")).toBeTruthy();
    expect(screen.getByTestId("online-point-w2")).toBeTruthy();
    expect(screen.queryByTestId("online-point-w3")).toBeNull();
  });

  it("refuses to draw a trend when fewer than two windows were measurable", () => {
    render(<OnlineTrendChart windows={[mkWindow("w1", 0.9), mkWindow("w2", null)]} />);
    expect(screen.queryByTestId("online-trend-chart")).toBeNull();
    expect(screen.getByTestId("online-trend-empty").textContent).toContain("unverifiable");
  });
});
