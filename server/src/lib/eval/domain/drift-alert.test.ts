/**
 * Epic #803 (Epic 09) — drift alert dispatcher unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvalRunResult, OnlineEvalWindowSummary } from "@metis/shared";
import {
  buildDriftMessage,
  buildOnlineDriftMessage,
  dispatchDriftAlert,
  dispatchOnlineDriftAlert,
} from "./drift-alert.js";

function makeRun(
  alert: boolean,
  driftOver: Partial<DomainEvalRunResult["drift"]> = {},
): DomainEvalRunResult {
  return {
    runId: "2026-02-01T00-00-00-000Z",
    schemaVersion: 1,
    model: "offline-stub",
    startedAt: "2026-02-01T00:00:00.000Z",
    completedAt: "2026-02-01T00:00:00.000Z",
    itemCount: 20,
    corpusPrecision: 0.85,
    corpusRecall: 0.85,
    corpusF1: 0.85,
    meanRougeL: 0.8,
    totalTokens: 100,
    totalCostCents: 0,
    commit: "abc123",
    calibration: [],
    drift: {
      previousF1: 0.95,
      deltaF1: -0.1,
      thresholdPct: 0.05,
      alert,
      reason: alert ? "F1 dropped 10.0% > 5%" : "WITHIN_THRESHOLD",
      baselineRunId: "2026-01-25T00-00-00-000Z",
      baselineAgeDays: 7,
      staleBaseline: false,
      ...driftOver,
    },
    items: [],
  };
}

const fakeResponse = (status: number): Response =>
  ({ status, headers: { get: () => null } }) as unknown as Response;

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.EVAL_ALERT_WEBHOOK_URL;
  delete process.env.EVAL_ALERT_WEBHOOK_URL;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.EVAL_ALERT_WEBHOOK_URL;
  else process.env.EVAL_ALERT_WEBHOOK_URL = savedEnv;
  vi.restoreAllMocks();
});

describe("buildDriftMessage", () => {
  it("formats a Slack-style drift message", () => {
    const msg = buildDriftMessage(makeRun(true));
    expect(msg).toContain("Domain Eval drift detected");
    expect(msg).toContain("10.0%");
    expect(msg).toContain("95.0%");
    expect(msg).toContain("85.0%");
    expect(msg).toContain("abc123");
  });
  it("tolerates a null previous F1", () => {
    const run = makeRun(true);
    run.drift.previousF1 = null;
    run.drift.deltaF1 = null;
    expect(buildDriftMessage(run)).toContain("n/a");
  });

  // Issue #1333 — a drift verdict measured against five-week-old history is not
  // a week-over-week verdict, and the page has to say so or the reader will
  // draw the wrong conclusion from the number.
  it("does not add a staleness caveat when the baseline is a week old", () => {
    expect(buildDriftMessage(makeRun(true))).not.toContain("STALE BASELINE");
  });

  it("appends the staleness caveat when the baseline is older than the window", () => {
    const msg = buildDriftMessage(
      makeRun(true, {
        staleBaseline: true,
        baselineAgeDays: 39,
        baselineRunId: "2026-07-21T03-00-00-000Z",
      }),
    );
    expect(msg).toContain("STALE BASELINE");
    expect(msg).toContain("39 days old");
    expect(msg).toContain("2026-07-21T03-00-00-000Z");
  });

  it("carries the caveat into the dispatched payload, not just the log line", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await dispatchDriftAlert(
      makeRun(true, {
        staleBaseline: true,
        baselineAgeDays: 39,
        baselineRunId: "2026-07-21T03-00-00-000Z",
      }),
      {
        webhookUrl: "http://127.0.0.1:65535/webhook",
        allowLoopback: true,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          calls.push(JSON.parse(String(init.body)));
          return fakeResponse(200);
        }) as unknown as typeof fetch,
      },
    );
    expect(calls).toHaveLength(1);
    expect(String(calls[0].text)).toContain("STALE BASELINE");
    expect(calls[0].staleBaseline).toBe(true);
    expect(calls[0].baselineAgeDays).toBe(39);
  });
});

describe("dispatchDriftAlert", () => {
  it("is a no-op when there is no drift", async () => {
    const out = await dispatchDriftAlert(makeRun(false), {
      webhookUrl: "http://127.0.0.1:65535/x",
    });
    expect(out).toEqual({ dispatched: false, reason: "NO_DRIFT" });
  });

  it("is a no-op when no webhook is configured", async () => {
    const out = await dispatchDriftAlert(makeRun(true));
    expect(out.dispatched).toBe(false);
    expect(out.reason).toBe("WEBHOOK_NOT_CONFIGURED");
  });

  it("POSTs the alert through safeFetch on drift", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200));
    const out = await dispatchDriftAlert(makeRun(true), {
      webhookUrl: "http://127.0.0.1:65535/webhook",
      allowLoopback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.dispatched).toBe(true);
    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("Domain Eval drift detected");
  });

  it("uses the EVAL_ALERT_WEBHOOK_URL env var when no override is given", async () => {
    process.env.EVAL_ALERT_WEBHOOK_URL = "http://127.0.0.1:65535/env-hook";
    const fetchImpl = vi.fn(async () => fakeResponse(204));
    const out = await dispatchDriftAlert(makeRun(true), {
      allowLoopback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.dispatched).toBe(true);
    expect(out.status).toBe(204);
  });

  it("reports a non-2xx response without throwing", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500));
    const out = await dispatchDriftAlert(makeRun(true), {
      webhookUrl: "http://127.0.0.1:65535/webhook",
      allowLoopback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.dispatched).toBe(false);
    expect(out.reason).toBe("HTTP_500");
  });

  it("captures transport errors into the outcome", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const out = await dispatchDriftAlert(makeRun(true), {
      webhookUrl: "http://127.0.0.1:65535/webhook",
      allowLoopback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.dispatched).toBe(false);
    expect(out.reason).toContain("ERROR:");
  });
});

// ── Online eval (#1321), and the UNVERIFIABLE case (#1329) ──────────────────

function makeOnlineWindow(over: Partial<OnlineEvalWindowSummary> = {}): OnlineEvalWindowSummary {
  return {
    windowId: "online-2026-08-15T00-00-00-000Z",
    schemaVersion: 1,
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T01:00:00.000Z",
    judge: "ModelRagasJudge",
    judgeMeaningful: true,
    sampleCount: 20,
    meanScores: {
      context_precision: null,
      context_recall: null,
      faithfulness: 0.6,
      answer_relevancy: 0.7,
    },
    scored: { context_precision: 0, context_recall: 0, faithfulness: 20, answer_relevancy: 20 },
    unverifiable: {
      context_precision: 20,
      context_recall: 20,
      faithfulness: 0,
      answer_relevancy: 0,
    },
    trendedMetrics: ["faithfulness", "answer_relevancy"],
    drift: {
      metric: "faithfulness",
      previous: 0.9,
      delta: -0.3,
      thresholdPct: 0.05,
      alert: true,
      reason: "DRIFT",
    },
    budget: { monthBucket: "2026-08", tokensUsed: 4000, tokensCap: 250_000, calls: 20 },
    driftAlert: true,
    ...over,
  };
}

describe("buildOnlineDriftMessage", () => {
  it("formats the window-over-window drop", () => {
    const msg = buildOnlineDriftMessage(makeOnlineWindow());
    expect(msg).toContain("Online eval drift detected");
    expect(msg).toContain("90.0%");
    expect(msg).toContain("60.0%");
    expect(msg).toContain("ModelRagasJudge");
  });

  // #1329 — the scorer already refuses to alert on an unverifiable metric, but
  // this builder is exported and `null * 100` is 0, so an unmeasured metric
  // would render as a confident "0.0%" in the operator's alert channel.
  it("renders an UNVERIFIABLE current metric as n/a, not as 0.0%", () => {
    const msg = buildOnlineDriftMessage(
      makeOnlineWindow({
        meanScores: {
          context_precision: null,
          context_recall: null,
          faithfulness: null,
          answer_relevancy: null,
        },
      }),
    );
    expect(msg).toContain("n/a");
    expect(msg).not.toContain("0.0%,");
  });
});

describe("dispatchOnlineDriftAlert", () => {
  it("does not send when the window carries no drift", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200));
    const out = await dispatchOnlineDriftAlert(
      makeOnlineWindow({
        driftAlert: false,
        drift: { ...makeOnlineWindow().drift, alert: false, reason: "WITHIN_THRESHOLD" },
      }),
      {
        webhookUrl: "http://127.0.0.1:65535/webhook",
        allowLoopback: true,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(out).toEqual({ dispatched: false, reason: "NO_DRIFT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the window through the shared SSRF-guarded transport", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200));
    const out = await dispatchOnlineDriftAlert(makeOnlineWindow(), {
      webhookUrl: "http://127.0.0.1:65535/webhook",
      allowLoopback: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.dispatched).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.windowId).toBe("online-2026-08-15T00-00-00-000Z");
    expect(body.metric).toBe("faithfulness");
    expect(body.current).toBeCloseTo(0.6);
  });
});
