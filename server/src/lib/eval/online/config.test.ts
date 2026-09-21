/**
 * Issue #1321 — online-eval configuration resolution.
 *
 * The defaults matter more than the parsing here: the feature must ship OFF,
 * with a conservative sample rate, and with drift alerting gated separately
 * so it cannot fire against `StubRagasJudge` scores (#1317).
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultOnlineResultsDir, resolveOnlineEvalConfig } from "./config.js";
import type { OnlineEvalConfigReader } from "./config.js";

function reader(values: Record<string, string> = {}): OnlineEvalConfigReader {
  return {
    get: (k) => values[k],
    getBool: (k, d = false) => {
      const raw = values[k];
      if (raw == null) return d;
      return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
    },
    getNumber: (k, d = 0) => {
      const raw = values[k];
      if (raw == null) return d;
      const n = Number(raw);
      return Number.isFinite(n) ? n : d;
    },
  };
}

describe("resolveOnlineEvalConfig defaults", () => {
  it("ships OFF with a 1% sample rate and drift alerting separately OFF", () => {
    const cfg = resolveOnlineEvalConfig(reader());
    expect(cfg.enabled).toBe(false);
    expect(cfg.sampleRate).toBe(0.01);
    expect(cfg.driftAlertsEnabled).toBe(false);
    expect(cfg.monthlyTokenBudget).toBe(250_000);
    expect(cfg.windowSize).toBe(20);
  });

  it("writes under eval-results/online, not the domain-eval directory", () => {
    const cfg = resolveOnlineEvalConfig(reader());
    expect(cfg.resultsDir).toBe(defaultOnlineResultsDir());
    expect(cfg.resultsDir.endsWith(path.join("eval-results", "online"))).toBe(true);
  });

  it("enabling the feature does NOT enable drift alerting", () => {
    const cfg = resolveOnlineEvalConfig(reader({ ONLINE_EVAL_ENABLED: "true" }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.driftAlertsEnabled).toBe(false);
  });
});

describe("resolveOnlineEvalConfig overrides", () => {
  it("reads every knob from configuration", () => {
    const cfg = resolveOnlineEvalConfig(
      reader({
        ONLINE_EVAL_ENABLED: "1",
        ONLINE_EVAL_SAMPLE_RATE: "0.25",
        ONLINE_EVAL_MONTHLY_TOKEN_BUDGET: "1000",
        ONLINE_EVAL_TOKENS_PER_SCORE: "900",
        ONLINE_EVAL_WINDOW_SIZE: "5",
        ONLINE_EVAL_DRIFT_THRESHOLD_PCT: "0.2",
        ONLINE_EVAL_DRIFT_ALERTS_ENABLED: "yes",
        ONLINE_EVAL_MAX_CHARS: "77",
        ONLINE_EVAL_RESULTS_DIR: "/tmp/online-eval",
      }),
    );
    expect(cfg).toEqual({
      enabled: true,
      sampleRate: 0.25,
      monthlyTokenBudget: 1000,
      tokensPerScore: 900,
      windowSize: 5,
      driftThresholdPct: 0.2,
      driftAlertsEnabled: true,
      maxChars: 77,
      resultsDir: path.resolve("/tmp/online-eval"),
    });
  });

  it("clamps a nonsensical sample rate into [0,1]", () => {
    expect(resolveOnlineEvalConfig(reader({ ONLINE_EVAL_SAMPLE_RATE: "9" })).sampleRate).toBe(1);
    expect(resolveOnlineEvalConfig(reader({ ONLINE_EVAL_SAMPLE_RATE: "-3" })).sampleRate).toBe(0);
    expect(resolveOnlineEvalConfig(reader({ ONLINE_EVAL_SAMPLE_RATE: "junk" })).sampleRate).toBe(
      0.01,
    );
  });

  it("keeps a zero budget as zero — the budget fails closed, it does not mean unlimited", () => {
    expect(
      resolveOnlineEvalConfig(reader({ ONLINE_EVAL_MONTHLY_TOKEN_BUDGET: "0" })).monthlyTokenBudget,
    ).toBe(0);
  });

  it("floors window size and per-score tokens at 1", () => {
    const cfg = resolveOnlineEvalConfig(
      reader({ ONLINE_EVAL_WINDOW_SIZE: "0", ONLINE_EVAL_TOKENS_PER_SCORE: "0" }),
    );
    expect(cfg.windowSize).toBe(1);
    expect(cfg.tokensPerScore).toBe(1);
  });
});
