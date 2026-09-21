/**
 * Issue #1321 — the online eval scorer.
 *
 * These tests are written against the acceptance criteria one for one:
 *   • kill switch + configurable sampling rate, conservative default
 *   • fully out-of-band: no work in the caller's tick, failures never escape
 *   • a separate token budget enforced BEFORE the judge call
 *   • PII redaction on everything that reaches the judge, and nothing but
 *     digests on disk
 *   • windowed aggregation + drift, with alerting that cannot fire on stub
 *     judge output — including the BASELINE it is compared against, which is
 *     the half a "current row only" honesty gate misses
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnlineEvalWindowSummary, RagasJudgement, RagasScores } from "@metis/shared";
import { averageScores, StubRagasJudge, type RagasFixture } from "../../rag/ragas.js";
import { OnlineEvalBudget } from "./budget.js";
import type { OnlineEvalConfig } from "./config.js";
import type { LiveRunCandidate } from "./redact.js";
import { loadAllWindows, readPending } from "./store.js";
import {
  aggregateScores,
  computeDrift,
  describeJudge,
  estimateJudgeTokens,
  getOnlineEvalScorer,
  MAX_INFLIGHT_SCORES,
  OnlineEvalScorer,
  selectBaselineWindow,
  __setOnlineEvalScorer,
  type OnlineJudge,
} from "./scorer.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "online-scorer-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  __setOnlineEvalScorer(null);
});

const FLAT: RagasScores = {
  context_precision: 1,
  context_recall: 1,
  faithfulness: 0.9,
  answer_relevancy: 0.8,
};

function cfg(over: Partial<OnlineEvalConfig> = {}): OnlineEvalConfig {
  return {
    enabled: true,
    sampleRate: 1,
    monthlyTokenBudget: 1_000_000,
    tokensPerScore: 1000,
    windowSize: 2,
    driftThresholdPct: 0.05,
    driftAlertsEnabled: false,
    maxChars: 4000,
    resultsDir: dir,
    ...over,
  };
}

/** A judge whose NAME starts with `Stub`, so the scorer treats it as lexical. */
class StubJudge implements OnlineJudge {
  constructor(private readonly faithfulness = 0.95) {}
  scoreFixture(): RagasScores {
    return { ...FLAT, faithfulness: this.faithfulness };
  }
}

/** A judge that is not called `Stub*`, so the scorer treats it as real. */
class FakeModelJudge implements OnlineJudge {
  calls: RagasFixture[] = [];
  constructor(private readonly scores: RagasJudgement | (() => RagasJudgement) = FLAT) {}
  scoreFixture(f: RagasFixture): RagasJudgement {
    this.calls.push(f);
    return typeof this.scores === "function" ? this.scores() : this.scores;
  }
}

/**
 * #1329 — a judge that cannot decide anything, i.e. every metric UNVERIFIABLE.
 * This is what a model-judge outage, a refusal, or an unparseable response
 * looks like from the scorer's side after #1317.
 */
const ALL_NULL: RagasJudgement = {
  context_precision: null,
  context_recall: null,
  faithfulness: null,
  answer_relevancy: null,
};

const candidate = (over: Partial<LiveRunCandidate> = {}): LiveRunCandidate => ({
  surface: "chat",
  question: "how do refunds work?",
  answer: "refunds take five days",
  contexts: ["policy: refunds take five days"],
  ...over,
});

function makeScorer(
  over: Partial<OnlineEvalConfig> = {},
  deps: Partial<ConstructorParameters<typeof OnlineEvalScorer>[0]> = {},
) {
  const config = cfg(over);
  const judge = (deps.judge as FakeModelJudge) ?? new FakeModelJudge();
  const scorer = new OnlineEvalScorer({
    config: () => config,
    judge,
    random: () => 0,
    now: () => new Date("2026-08-15T00:00:00.000Z"),
    // Run deferred work inline so tests do not race the event loop, except
    // where the test is specifically about deferral.
    defer: (fn) => fn(),
    ...deps,
  });
  return { scorer, judge, config };
}

// ── Kill switch + sampling ──────────────────────────────────────────────────

describe("kill switch and sampling", () => {
  it("does nothing at all when disabled", async () => {
    const { scorer, judge } = makeScorer({ enabled: false });
    const out = await scorer.score(candidate());
    expect(out).toEqual({ scored: false, reason: "DISABLED" });
    expect(judge.calls).toHaveLength(0);
    expect(await readPending(dir)).toEqual([]);
  });

  it("skips a run that loses the sampling draw", async () => {
    const { scorer, judge } = makeScorer({ sampleRate: 0.1 }, { random: () => 0.5 });
    expect((await scorer.score(candidate())).reason).toBe("NOT_SAMPLED");
    expect(judge.calls).toHaveLength(0);
  });

  it("scores a run that wins the sampling draw", async () => {
    const { scorer, judge } = makeScorer({ sampleRate: 0.1 }, { random: () => 0.05 });
    expect((await scorer.score(candidate())).scored).toBe(true);
    expect(judge.calls).toHaveLength(1);
  });

  it("never samples at rate 0", async () => {
    const { scorer, judge } = makeScorer({ sampleRate: 0 }, { random: () => 0 });
    expect((await scorer.score(candidate())).reason).toBe("NOT_SAMPLED");
    expect(judge.calls).toHaveLength(0);
  });

  it("skips a candidate with no question or no answer", async () => {
    const { scorer, judge } = makeScorer();
    expect((await scorer.score(candidate({ question: "   " }))).reason).toBe("EMPTY_CANDIDATE");
    expect((await scorer.score(candidate({ answer: "" }))).reason).toBe("EMPTY_CANDIDATE");
    expect(judge.calls).toHaveLength(0);
  });
});

// ── Out-of-band ─────────────────────────────────────────────────────────────

describe("read-only observer: no latency, no escaping failures", () => {
  it("does no work in the caller's tick", async () => {
    let configReads = 0;
    const config = cfg();
    const judge = new FakeModelJudge();
    const scorer = new OnlineEvalScorer({
      config: () => {
        configReads += 1;
        return config;
      },
      judge,
      random: () => 0,
      // Real deferral — this test is about it.
    });

    scorer.observe(candidate());
    // Nothing has run yet: not the config read, not the judge.
    expect(configReads).toBe(0);
    expect(judge.calls).toHaveLength(0);

    await scorer.drain();
    expect(configReads).toBeGreaterThan(0);
    expect(judge.calls).toHaveLength(1);
  });

  it("observe() returns void and the caller finishes before scoring starts", async () => {
    const order: string[] = [];
    const judge: OnlineJudge = {
      scoreFixture: () => {
        order.push("judge");
        return FLAT;
      },
    };
    const config = cfg();
    const scorer = new OnlineEvalScorer({ config: () => config, judge, random: () => 0 });

    const returned = scorer.observe(candidate());
    order.push("caller-returned");
    expect(returned).toBeUndefined();

    await scorer.drain();
    expect(order).toEqual(["caller-returned", "judge"]);
  });

  it("a throwing judge never escapes observe(), and the next sample still works", async () => {
    let attempt = 0;
    const judge: OnlineJudge = {
      scoreFixture: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("judge exploded");
        return FLAT;
      },
    };
    const config = cfg();
    const scorer = new OnlineEvalScorer({
      config: () => config,
      judge,
      random: () => 0,
      defer: (fn) => fn(),
    });

    expect(() => scorer.observe(candidate())).not.toThrow();
    await scorer.drain();
    expect((await scorer.score(candidate())).scored).toBe(true);
  });

  it("a judge failure refunds the reservation instead of burning budget", async () => {
    const budget = new OnlineEvalBudget({ dir, cap: () => 10_000 });
    const judge: OnlineJudge = {
      scoreFixture: () => {
        throw new Error("nope");
      },
    };
    const config = cfg();
    const scorer = new OnlineEvalScorer({
      config: () => config,
      judge,
      budget,
      random: () => 0,
      defer: (fn) => fn(),
    });
    expect((await scorer.score(candidate())).reason).toBe("JUDGE_ERROR");
    const after = await budget.status();
    expect(after.tokensUsed).toBe(0);
    // The `calls` counter reports COMPLETED judge calls, not reservations —
    // otherwise the operator's status drifts upward with every judge failure.
    expect(after.calls).toBe(0);
  });

  it("a store failure is swallowed, not thrown at the caller", async () => {
    // Point the results dir at a path that cannot be created (a file).
    const filePath = path.join(dir, "not-a-dir");
    await fs.writeFile(filePath, "x", "utf8");
    const { scorer } = makeScorer({ resultsDir: filePath });
    const out = await scorer.score(candidate());
    expect(out.scored).toBe(false);
    expect(out.reason).toBe("STORE_ERROR");
  });
});

// ── Budget ──────────────────────────────────────────────────────────────────

describe("separate token budget, enforced before the call", () => {
  it("does not call the judge when the monthly budget is spent", async () => {
    const budget = new OnlineEvalBudget({ dir, cap: () => 1000 });
    await budget.reserve(1000); // exhaust it
    const { scorer, judge } = makeScorer({}, { budget });
    const out = await scorer.score(candidate());
    expect(out.reason).toBe("MONTHLY_BUDGET_EXCEEDED");
    expect(judge.calls).toHaveLength(0);
  });

  it("does not call the judge when no online budget is configured", async () => {
    const { scorer, judge } = makeScorer({ monthlyTokenBudget: 0 });
    expect((await scorer.score(candidate())).reason).toBe("NO_BUDGET_CONFIGURED");
    expect(judge.calls).toHaveLength(0);
  });

  it("charges the online ledger, never the analysis cap", async () => {
    const budget = new OnlineEvalBudget({ dir, cap: () => 10_000 });
    const { scorer } = makeScorer({}, { budget });
    await scorer.score(candidate());
    const state = await budget.status();
    expect(state.tokensUsed).toBeGreaterThan(0);
    // The ledger lives in the online results dir — an entirely separate store
    // from `Analysis.totalTokens`, which backs ANALYSIS_MONTHLY_TOKEN_CAP.
    expect(await fs.readFile(path.join(dir, "budget.json"), "utf8")).toContain("tokensUsed");
  });

  it("estimates the settled cost from the redacted payload size", () => {
    expect(estimateJudgeTokens(0)).toBe(200);
    expect(estimateJudgeTokens(400)).toBe(300);
  });
});

// ── Privacy ─────────────────────────────────────────────────────────────────

describe("privacy", () => {
  const dirty = candidate({
    question: "email alice@example.com for the refund",
    answer: "we sent it to alice@example.com",
    contexts: ["contact: alice@example.com, ssn 123-45-6789"],
  });

  it("the judge only ever sees redacted text", async () => {
    const { scorer, judge } = makeScorer();
    await scorer.score(dirty);
    const fixture = judge.calls[0];
    const seen = [
      fixture.question,
      fixture.generatedAnswer ?? "",
      ...(fixture.retrievedChunks ?? []),
    ].join("\n");
    expect(seen).not.toContain("alice@example.com");
    expect(seen).not.toContain("123-45-6789");
    expect(seen).toContain("[REDACTED:email]");
  });

  it("records the redaction count so operators can see the pass ran", async () => {
    const { scorer } = makeScorer();
    const out = await scorer.score(dirty);
    expect(out.sample?.redactionHits).toBe(4);
  });

  it("writes digests, never content, into eval-results", async () => {
    const { scorer } = makeScorer({ windowSize: 1 });
    await scorer.score(dirty);
    const raw = await fs.readFile(
      path.join(dir, (await fs.readdir(dir)).filter((n) => n.startsWith("online-"))[0]),
      "utf8",
    );
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("refund");
    expect(raw).not.toContain("123-45-6789");
    expect(raw).toMatch(/"questionHash": "[a-f0-9]{64}"/);
  });

  it("hashes the REDACTED text, so the digest cannot confirm a guessed raw value", async () => {
    const { scorer } = makeScorer();
    const out = await scorer.score(dirty);
    const { digest } = await import("./redact.js");
    expect(out.sample?.questionHash).not.toBe(digest(dirty.question));
    expect(out.sample?.questionHash).toBe(digest("email [REDACTED:email] for the refund"));
  });
});

// ── Windows, aggregation and drift ──────────────────────────────────────────

describe("windowed aggregation", () => {
  it("buffers samples and flushes a window envelope when it is full", async () => {
    const { scorer } = makeScorer({ windowSize: 3 });
    await scorer.score(candidate());
    await scorer.score(candidate());
    expect(await readPending(dir)).toHaveLength(2);
    expect(await loadAllWindows(dir)).toHaveLength(0);

    const out = await scorer.score(candidate());
    expect(out.window?.sampleCount).toBe(3);
    // Read back through the store, not the object we just built.
    const windows = await loadAllWindows(dir);
    expect(windows).toHaveLength(1);
    expect(windows[0].meanScores.faithfulness).toBeCloseTo(0.9);
    expect(await readPending(dir)).toEqual([]);
  });

  it("averages the metrics across the window", async () => {
    let n = 0;
    const judge = new FakeModelJudge(() => ({ ...FLAT, faithfulness: n++ === 0 ? 1 : 0.5 }));
    const { scorer } = makeScorer({ windowSize: 2 }, { judge });
    await scorer.score(candidate());
    await scorer.score(candidate());
    expect((await loadAllWindows(dir))[0].meanScores.faithfulness).toBeCloseTo(0.75);
  });

  it("only trends the reference-free metrics — live traffic has no ground truth", async () => {
    const { scorer } = makeScorer({ windowSize: 1 });
    const out = await scorer.score(candidate());
    expect(out.window?.trendedMetrics).toEqual(["faithfulness", "answer_relevancy"]);
    // No ground truth is fabricated for the judge.
    expect(out.window?.drift.metric).toBe("faithfulness");
  });

  it("survives a restart with a half-full window", async () => {
    const first = makeScorer({ windowSize: 2 }).scorer;
    await first.score(candidate());
    // A brand-new scorer over the same directory (the restart).
    const second = makeScorer({ windowSize: 2 }).scorer;
    const out = await second.score(candidate());
    expect(out.window?.sampleCount).toBe(2);
  });
});

describe("drift", () => {
  it("flags a drop beyond the threshold against the previous window", () => {
    const d = computeDrift({
      current: 0.6,
      previous: 0.8,
      thresholdPct: 0.05,
      judgeMeaningful: true,
    });
    expect(d).toMatchObject({ alert: true, reason: "DRIFT" });
    expect(d.delta).toBeCloseTo(-0.2);
  });

  it("does not flag a drop inside the threshold", () => {
    expect(
      computeDrift({ current: 0.78, previous: 0.8, thresholdPct: 0.05, judgeMeaningful: true })
        .alert,
    ).toBe(false);
  });

  it("has nothing to compare on the first window", () => {
    expect(
      computeDrift({ current: 0.6, previous: null, thresholdPct: 0.05, judgeMeaningful: true }),
    ).toMatchObject({ alert: false, reason: "NO_PREVIOUS_WINDOW", delta: null });
  });

  it("SUPPRESSES a real drop when the judge is the lexical stub (#1317)", () => {
    const d = computeDrift({
      current: 0.2,
      previous: 0.9,
      thresholdPct: 0.05,
      judgeMeaningful: false,
    });
    expect(d.delta).toBeCloseTo(-0.7);
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("SUPPRESSED_STUB_JUDGE");
  });

  it("compares against the most recent window on disk", async () => {
    let n = 0;
    const judge = new FakeModelJudge(() => ({ ...FLAT, faithfulness: n++ === 0 ? 0.9 : 0.2 }));
    const { scorer } = makeScorer({ windowSize: 1 }, { judge });
    await scorer.score(candidate());
    const second = await scorer.score(candidate());
    expect(second.window?.drift.previous).toBeCloseTo(0.9);
    expect(second.window?.drift.alert).toBe(true);
  });
});

// ── Drift baseline: the row a window is COMPARED AGAINST (#1321 review B1) ──
//
// `judgeMeaningful` gates the row being written. That is only half the gate: a
// window scored by a real judge must not inherit a lexical-stub baseline, or
// the very first real window pages at the #1317 cutover. These tests exercise
// the comparison, not the write.

describe("drift baseline selection", () => {
  const win = (over: Record<string, unknown>) =>
    ({
      windowId: "w",
      schemaVersion: 1,
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:00.000Z",
      judge: "FakeModelJudge",
      judgeMeaningful: true,
      sampleCount: 1,
      meanScores: FLAT,
      trendedMetrics: ["faithfulness", "answer_relevancy"],
      drift: {
        metric: "faithfulness",
        previous: null,
        delta: null,
        thresholdPct: 0.05,
        alert: false,
        reason: "NO_PREVIOUS_WINDOW",
      },
      budget: { monthBucket: "2026-08", tokensUsed: 0, tokensCap: 10, calls: 0 },
      samples: [],
      ...over,
    }) as Parameters<typeof selectBaselineWindow>[0][number];

  it("picks the most recent window from the SAME judge", () => {
    const windows = [
      win({ windowId: "w3", judge: "StubRagasJudge", judgeMeaningful: false }),
      win({ windowId: "w2", judge: "ModelRagasJudge" }),
      win({ windowId: "w1", judge: "ModelRagasJudge" }),
    ];
    expect(selectBaselineWindow(windows, "ModelRagasJudge")?.windowId).toBe("w2");
    expect(selectBaselineWindow(windows, "StubRagasJudge")?.windowId).toBe("w3");
  });

  it("returns null rather than a different judge's window", () => {
    const windows = [win({ windowId: "w1", judge: "StubRagasJudge", judgeMeaningful: false })];
    expect(selectBaselineWindow(windows, "ModelRagasJudge")).toBeNull();
  });

  it("distinguishes 'no history' from 'no comparable history'", () => {
    expect(
      computeDrift({ current: 0.6, previous: null, thresholdPct: 0.05, judgeMeaningful: true })
        .reason,
    ).toBe("NO_PREVIOUS_WINDOW");
    expect(
      computeDrift({
        current: 0.6,
        previous: null,
        thresholdPct: 0.05,
        judgeMeaningful: true,
        incomparableHistory: true,
      }).reason,
    ).toBe("NO_COMPARABLE_BASELINE");
  });

  it("does NOT diff a real-judge window against a stub baseline, and does not alert", async () => {
    // Exactly the #1317 cutover: a stub window at 0.95 already on disk, then the
    // first real-judge window at 0.60 with alerting fully enabled.
    const stub = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      { judge: new StubJudge(0.95) },
    );
    await stub.scorer.score(candidate());
    expect((await loadAllWindows(dir))[0].judge).toBe("StubJudge");

    const dispatched: OnlineEvalWindowSummary[] = [];
    const real = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      {
        judge: new FakeModelJudge({ ...FLAT, faithfulness: 0.6 }),
        dispatchAlert: async (w) => {
          dispatched.push(w);
          return { dispatched: true, status: 200 };
        },
      },
    );
    const out = await real.scorer.score(candidate());

    expect(out.window?.judge).toBe("FakeModelJudge");
    expect(out.window?.drift.previous).toBeNull();
    expect(out.window?.drift.reason).toBe("NO_COMPARABLE_BASELINE");
    expect(out.window?.drift.alert).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("still diffs a real-judge window against the previous REAL window", async () => {
    let n = 0;
    const judge = new FakeModelJudge(() => ({ ...FLAT, faithfulness: n++ === 0 ? 0.9 : 0.2 }));
    const { scorer } = makeScorer({ windowSize: 1 }, { judge });
    await scorer.score(candidate());
    const second = await scorer.score(candidate());
    expect(second.window?.drift.previous).toBeCloseTo(0.9);
    expect(second.window?.drift.alert).toBe(true);
  });

  it("ignores an interleaved stub window when picking the real baseline", async () => {
    // Distinct clocks so the three windows land in three distinct files.
    const at = (min: number) => () => new Date(Date.UTC(2026, 7, 15, 0, min, 0));
    const real1 = makeScorer({ windowSize: 1 }, { judge: new FakeModelJudge(FLAT), now: at(1) });
    await real1.scorer.score(candidate());
    const stub = makeScorer({ windowSize: 1 }, { judge: new StubJudge(0.1), now: at(2) });
    await stub.scorer.score(candidate());
    // Newest window on disk is now the stub one; the baseline must skip it.
    expect((await loadAllWindows(dir))[0].judge).toBe("StubJudge");

    const real2 = makeScorer(
      { windowSize: 1 },
      { judge: new FakeModelJudge({ ...FLAT, faithfulness: 0.88 }), now: at(3) },
    );
    const out = await real2.scorer.score(candidate());

    // 0.9 (the earlier REAL window), not 0.1 (the stub one in between).
    expect(out.window?.drift.previous).toBeCloseTo(0.9);
    expect(out.window?.drift.reason).toBe("WITHIN_THRESHOLD");
    expect(out.window?.drift.alert).toBe(false);
  });
});

// ── Concurrency ceiling ─────────────────────────────────────────────────────

describe("in-flight ceiling", () => {
  it("drops candidates beyond MAX_INFLIGHT_SCORES rather than queueing them", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Deterministic: resolve once the ceiling's worth of judge calls are parked,
    // rather than guessing with a timer.
    let allParked!: () => void;
    const parked = new Promise<void>((r) => {
      allParked = r;
    });
    let started = 0;
    const judge: OnlineJudge = {
      scoreFixture: async () => {
        started += 1;
        if (started === MAX_INFLIGHT_SCORES) allParked();
        await gate;
        return FLAT;
      },
    };
    const { scorer } = makeScorer({ windowSize: 100 }, { judge });

    const held = Array.from({ length: MAX_INFLIGHT_SCORES }, () => scorer.score(candidate()));
    await parked;
    expect(started).toBe(MAX_INFLIGHT_SCORES);

    const overflow = await scorer.score(candidate());
    expect(overflow).toEqual({ scored: false, reason: "TOO_MANY_INFLIGHT" });
    // The dropped candidate never reached the judge.
    expect(started).toBe(MAX_INFLIGHT_SCORES);

    release();
    await Promise.all(held);
    // The ceiling releases: the next candidate is scored normally.
    expect((await scorer.score(candidate())).scored).toBe(true);
  });
});

// ── enabled() probe ─────────────────────────────────────────────────────────

describe("enabled() probe", () => {
  it("mirrors the kill switch", () => {
    expect(makeScorer({ enabled: true }).scorer.enabled()).toBe(true);
    expect(makeScorer({ enabled: false }).scorer.enabled()).toBe(false);
  });

  it("returns false rather than throwing when config resolution blows up", () => {
    const scorer = new OnlineEvalScorer({
      config: () => {
        throw new Error("config service not initialised");
      },
    });
    expect(scorer.enabled()).toBe(false);
  });
});

// ── Results dir is re-resolved, not pinned at construction ──────────────────

describe("results dir changes at runtime", () => {
  it("moves the budget ledger with the config, not the constructor snapshot", async () => {
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "online-scorer-b-"));
    try {
      let config = cfg({ windowSize: 1 });
      const scorer = new OnlineEvalScorer({
        config: () => config,
        judge: new FakeModelJudge(),
        random: () => 0,
        defer: (fn) => fn(),
      });
      await scorer.score(candidate());
      expect(await fs.readdir(dir)).toContain("budget.json");

      config = cfg({ windowSize: 1, resultsDir: second });
      await scorer.score(candidate());
      expect(await fs.readdir(second)).toContain("budget.json");
    } finally {
      await fs.rm(second, { recursive: true, force: true });
    }
  });
});

describe("drift alerting is gated twice", () => {
  const drifting = () => {
    let n = 0;
    return new FakeModelJudge(() => ({ ...FLAT, faithfulness: n++ === 0 ? 0.9 : 0.2 }));
  };

  it("does not dispatch when ONLINE_EVAL_DRIFT_ALERTS_ENABLED is off", async () => {
    const dispatchAlert = vi.fn(async () => ({ dispatched: true, reason: "OK" }));
    const { scorer } = makeScorer(
      { windowSize: 1, driftAlertsEnabled: false },
      { judge: drifting(), dispatchAlert },
    );
    await scorer.score(candidate());
    await scorer.score(candidate());
    expect(dispatchAlert).not.toHaveBeenCalled();
  });

  it("dispatches when alerting is enabled AND the judge is real", async () => {
    const dispatchAlert = vi.fn(async () => ({ dispatched: true, reason: "OK" }));
    const { scorer } = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      { judge: drifting(), dispatchAlert },
    );
    await scorer.score(candidate());
    const out = await scorer.score(candidate());
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    const arg = dispatchAlert.mock.calls[0][0] as unknown as OnlineEvalWindowSummary;
    expect(arg.driftAlert).toBe(true);
    expect(out.alert).toEqual({ dispatched: true, reason: "OK" });
  });

  it("never dispatches for the stub judge even with alerting enabled", async () => {
    const dispatchAlert = vi.fn(async () => ({ dispatched: true, reason: "OK" }));
    let n = 0;
    // The real stub, wrapped so we can drive its scores down between windows.
    const stub = new StubRagasJudge() as unknown as OnlineJudge & { judgeName?: string };
    stub.scoreFixture = () => ({ ...FLAT, faithfulness: n++ === 0 ? 0.9 : 0.1 });
    const { scorer } = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      { judge: stub, dispatchAlert },
    );
    await scorer.score(candidate());
    const out = await scorer.score(candidate());
    expect(out.window?.judgeMeaningful).toBe(false);
    expect(out.window?.drift.reason).toBe("SUPPRESSED_STUB_JUDGE");
    expect(dispatchAlert).not.toHaveBeenCalled();
  });

  it("an alert transport failure does not fail the sample", async () => {
    const dispatchAlert = vi.fn(async () => {
      throw new Error("webhook down");
    });
    const { scorer } = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      { judge: drifting(), dispatchAlert },
    );
    await scorer.score(candidate());
    const out = await scorer.score(candidate());
    expect(out.scored).toBe(true);
  });
});

// ── UNVERIFIABLE IS NOT ZERO (#1329) ────────────────────────────────────────
//
// #1317 made every RAGAS metric nullable, where `null` means the judge could
// not decide. Widening `OnlineJudge` to accept that WITHOUT changing the mean
// is worse than leaving the compiler red: `0 + null === 0` in JavaScript, so an
// unverifiable metric would land in the window as a confident 0.0 on
// `faithfulness` — the metric drift alerts fire on — and page an operator over
// a regression that never happened.

describe("aggregateScores excludes unverifiable metrics (#1329)", () => {
  it("excludes a null from BOTH the numerator and the denominator", () => {
    const agg = aggregateScores([
      { ...FLAT, faithfulness: 0.8 },
      { ...FLAT, faithfulness: null },
      { ...FLAT, faithfulness: 0.6 },
    ]);
    // Mean of the two SCORED values (0.7), not of three with a zero (0.466…).
    expect(agg.mean.faithfulness).toBeCloseTo(0.7);
    expect(agg.scored.faithfulness).toBe(2);
    expect(agg.unverifiable.faithfulness).toBe(1);
  });

  it("is null — never 0 — for a metric nothing in the list scored", () => {
    const agg = aggregateScores([ALL_NULL, ALL_NULL]);
    expect(agg.mean.faithfulness).toBeNull();
    expect(agg.mean.answer_relevancy).toBeNull();
    expect(agg.scored.faithfulness).toBe(0);
    expect(agg.unverifiable.faithfulness).toBe(2);
  });

  it("counts each metric independently — one null does not sink its neighbours", () => {
    const agg = aggregateScores([
      { context_precision: 0.5, context_recall: null, faithfulness: 1, answer_relevancy: 0.4 },
      { context_precision: 0.5, context_recall: 0.2, faithfulness: null, answer_relevancy: 0.6 },
    ]);
    expect(agg.mean.context_precision).toBeCloseTo(0.5);
    expect(agg.mean.context_recall).toBeCloseTo(0.2);
    expect(agg.mean.faithfulness).toBeCloseTo(1);
    expect(agg.mean.answer_relevancy).toBeCloseTo(0.5);
    expect(agg.scored).toEqual({
      context_precision: 2,
      context_recall: 1,
      faithfulness: 1,
      answer_relevancy: 2,
    });
    expect(agg.unverifiable).toEqual({
      context_precision: 0,
      context_recall: 1,
      faithfulness: 1,
      answer_relevancy: 0,
    });
  });

  it("matches averageScores in rag/ragas.ts — one convention, not two", () => {
    const list: RagasJudgement[] = [
      { ...FLAT, faithfulness: 0.9 },
      { ...FLAT, faithfulness: null },
    ];
    expect(aggregateScores(list)).toEqual(averageScores(list));
  });
});

describe("a window with an unverifiable metric (#1329)", () => {
  it("writes null, not 0, when NO sample in the window could be scored", async () => {
    const judge = new FakeModelJudge(ALL_NULL);
    const { scorer } = makeScorer({ windowSize: 2 }, { judge });
    await scorer.score(candidate());
    await scorer.score(candidate());
    // Read back through the store, not off the object we just built.
    const [w] = await loadAllWindows(dir);
    expect(w.meanScores.faithfulness).toBeNull();
    expect(w.meanScores.faithfulness).not.toBe(0);
    expect(w.sampleCount).toBe(2);
  });

  it("averages only the SCORED samples when the judge fails intermittently", async () => {
    let n = 0;
    const judge = new FakeModelJudge(() => {
      n += 1;
      // Samples 1 and 3 score; sample 2 is unverifiable.
      return n === 2
        ? { ...FLAT, faithfulness: null }
        : { ...FLAT, faithfulness: n === 1 ? 1 : 0.5 };
    });
    const { scorer } = makeScorer({ windowSize: 3 }, { judge });
    await scorer.score(candidate());
    await scorer.score(candidate());
    await scorer.score(candidate());
    const [w] = await loadAllWindows(dir);
    // (1 + 0.5) / 2 = 0.75. Counting the null as a zero would give 0.5.
    expect(w.meanScores.faithfulness).toBeCloseTo(0.75);
    expect(w.meanScores.faithfulness).not.toBeCloseTo(0.5);
  });

  it("carries the per-metric scored / unverifiable counts through the window", async () => {
    let n = 0;
    const judge = new FakeModelJudge(() => {
      n += 1;
      return n === 1 ? { ...FLAT, faithfulness: 0.9 } : { ...FLAT, faithfulness: null };
    });
    const { scorer } = makeScorer({ windowSize: 3 }, { judge });
    await scorer.score(candidate());
    await scorer.score(candidate());
    await scorer.score(candidate());
    const [w] = await loadAllWindows(dir);
    expect(w.scored.faithfulness).toBe(1);
    expect(w.unverifiable.faithfulness).toBe(2);
    // The reference-based metrics were scored on every sample here.
    expect(w.unverifiable.context_precision).toBe(0);
  });
});

describe("drift cannot fire on an unverifiable metric (#1329)", () => {
  it("reports UNVERIFIABLE_METRIC instead of a collapse to zero", () => {
    const d = computeDrift({
      current: null,
      previous: 0.9,
      thresholdPct: 0.05,
      judgeMeaningful: true,
    });
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("UNVERIFIABLE_METRIC");
    // There is no value to diff, so there is no delta.
    expect(d.delta).toBeNull();
  });

  it("distinguishes an unverifiable BASELINE from a cold start", () => {
    expect(
      computeDrift({
        current: 0.6,
        previous: null,
        thresholdPct: 0.05,
        judgeMeaningful: true,
        baselineUnverifiable: true,
      }).reason,
    ).toBe("BASELINE_UNVERIFIABLE");
    expect(
      computeDrift({ current: 0.6, previous: null, thresholdPct: 0.05, judgeMeaningful: true })
        .reason,
    ).toBe("NO_PREVIOUS_WINDOW");
  });

  // The user-visible failure this issue exists to prevent: a judge outage that
  // pages an operator. Asserted end-to-end through the real write path with
  // every gate that could suppress it turned OFF except the one under test —
  // alerting enabled, a real (non-stub) judge, and a healthy same-judge
  // baseline on disk to drift away from.
  it("raises NO drift alert when an entire window is unverifiable", async () => {
    const dispatchAlert = vi.fn(async () => ({ dispatched: true, reason: "OK" }));
    let n = 0;
    const judge = new FakeModelJudge(() => {
      n += 1;
      // Window 1: a healthy 0.9 baseline. Window 2: the judge has gone dark.
      return n === 1 ? { ...FLAT, faithfulness: 0.9 } : ALL_NULL;
    });
    const { scorer } = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      { judge, dispatchAlert },
    );
    const first = await scorer.score(candidate());
    expect(first.window?.meanScores.faithfulness).toBeCloseTo(0.9);

    const out = await scorer.score(candidate());
    expect(out.window?.judgeMeaningful).toBe(true);
    expect(out.window?.meanScores.faithfulness).toBeNull();
    expect(out.window?.drift.alert).toBe(false);
    expect(out.window?.drift.reason).toBe("UNVERIFIABLE_METRIC");
    expect(dispatchAlert).not.toHaveBeenCalled();
    expect(out.alert).toBeUndefined();
  });

  it("does not treat a recovered window as drift against an unverifiable baseline", async () => {
    const dispatchAlert = vi.fn(async () => ({ dispatched: true, reason: "OK" }));
    let n = 0;
    const judge = new FakeModelJudge(() => {
      n += 1;
      // Window 1 unverifiable, window 2 a perfectly healthy 0.9.
      return n === 1 ? ALL_NULL : { ...FLAT, faithfulness: 0.9 };
    });
    const { scorer } = makeScorer(
      { windowSize: 1, driftAlertsEnabled: true },
      { judge, dispatchAlert },
    );
    await scorer.score(candidate());
    const out = await scorer.score(candidate());
    expect(out.window?.drift.previous).toBeNull();
    expect(out.window?.drift.reason).toBe("BASELINE_UNVERIFIABLE");
    expect(dispatchAlert).not.toHaveBeenCalled();
  });
});

describe("describeJudge", () => {
  it("marks StubRagasJudge as not meaningful", () => {
    expect(describeJudge(new StubRagasJudge())).toEqual({
      name: "StubRagasJudge",
      meaningful: false,
    });
  });

  it("marks any other implementation as meaningful", () => {
    expect(describeJudge(new FakeModelJudge())).toEqual({
      name: "FakeModelJudge",
      meaningful: true,
    });
  });

  it("prefers an explicit judgeName", () => {
    const j = Object.assign(new FakeModelJudge(), { judgeName: "ModelRagasJudge" });
    expect(describeJudge(j).name).toBe("ModelRagasJudge");
  });
});

describe("status", () => {
  it("reports config, judge honesty, buffer depth and budget", async () => {
    const { scorer } = makeScorer({ windowSize: 5 });
    await scorer.score(candidate());
    const s = await scorer.status();
    expect(s).toMatchObject({
      enabled: true,
      sampleRate: 1,
      windowSize: 5,
      driftAlertsEnabled: false,
      judge: "FakeModelJudge",
      judgeMeaningful: true,
      pendingSamples: 1,
    });
    expect(s.budget.tokensUsed).toBeGreaterThan(0);
  });
});

describe("singleton", () => {
  it("returns the same instance and defaults to the stub judge", async () => {
    const a = getOnlineEvalScorer();
    expect(getOnlineEvalScorer()).toBe(a);
    // Default construction is disabled, so this is a no-op observation.
    expect(() => a.observe(candidate())).not.toThrow();
    await a.drain();
  });
});

describe("async judges (forward compatibility with #1317)", () => {
  it("awaits a judge that returns a promise", async () => {
    const judge: OnlineJudge = {
      scoreFixture: async () => FLAT,
    };
    const config = cfg({ windowSize: 1 });
    const scorer = new OnlineEvalScorer({
      config: () => config,
      judge,
      random: () => 0,
      defer: (fn) => fn(),
    });
    const out = await scorer.score(candidate());
    expect(out.scored).toBe(true);
    expect(out.window?.meanScores.faithfulness).toBeCloseTo(0.9);
  });

  it("catches a rejected judge promise", async () => {
    const judge: OnlineJudge = {
      scoreFixture: async () => {
        throw new Error("model timeout");
      },
    };
    const config = cfg();
    const scorer = new OnlineEvalScorer({
      config: () => config,
      judge,
      random: () => 0,
      defer: (fn) => fn(),
    });
    expect((await scorer.score(candidate())).reason).toBe("JUDGE_ERROR");
  });
});
