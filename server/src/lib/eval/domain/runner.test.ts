/**
 * Epic #803 (Epic 09) — runner unit tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STALE_BASELINE_DAYS, type DomainEvalRunResult } from "@metis/shared";
import type { DomainCorpusItem } from "./corpus.js";
import { createOfflineExtractor, type DomainExtractor } from "./extractor.js";
import {
  DEFAULT_DRIFT_THRESHOLD_PCT,
  computeDrift,
  makeRunId,
  runDomainEval,
  selectBaseline,
} from "./runner.js";

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "domain-runner-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true });
});

function corpusItem(
  id: string,
  doc: string,
  expected: DomainCorpusItem["expected"],
): DomainCorpusItem {
  return { id, title: id, docType: "prd", source: "s", license: "l", document: doc, expected };
}

const SAMPLE = corpusItem(
  "prd-1",
  ["- The system must allow users to sign in with email and password."].join("\n"),
  [
    {
      id: "R1",
      type: "feature",
      title: "Sign in with email",
      description: "users sign in with email and password",
      priority: "high",
    },
  ],
);

function priorRun(runId: string, startedAt: string, f1: number): DomainEvalRunResult {
  return {
    runId,
    schemaVersion: 1,
    model: "offline-stub",
    startedAt,
    completedAt: startedAt,
    itemCount: 1,
    corpusPrecision: f1,
    corpusRecall: f1,
    corpusF1: f1,
    meanRougeL: 0.8,
    totalTokens: 1,
    totalCostCents: 0,
    commit: null,
    calibration: [],
    drift: {
      previousF1: null,
      deltaF1: null,
      thresholdPct: 0.05,
      alert: false,
      reason: "NO_BASELINE",
      baselineRunId: null,
      baselineAgeDays: null,
      staleBaseline: false,
    },
    items: [],
  };
}

describe("makeRunId", () => {
  it("produces a filename-safe id from the timestamp", () => {
    expect(makeRunId(new Date("2026-02-01T03:04:05.678Z"))).toBe("2026-02-01T03-04-05-678Z");
  });
});

describe("selectBaseline", () => {
  const now = new Date("2026-02-10T00:00:00.000Z");
  it("returns null when there are no prior runs", () => {
    expect(selectBaseline([], now)).toBeNull();
  });
  it("prefers a run at least ~7 days older", () => {
    const week = priorRun("week", "2026-02-01T00:00:00.000Z", 0.9);
    const yesterday = priorRun("yest", "2026-02-09T00:00:00.000Z", 0.7);
    expect(selectBaseline([yesterday, week], now)?.runId).toBe("week");
  });
  it("falls back to the most recent prior run when none is a week old", () => {
    const a = priorRun("a", "2026-02-08T00:00:00.000Z", 0.9);
    const b = priorRun("b", "2026-02-09T00:00:00.000Z", 0.8);
    expect(selectBaseline([a, b], now)?.runId).toBe("b");
  });
  it("ignores runs newer than the current run", () => {
    const future = priorRun("future", "2026-03-01T00:00:00.000Z", 0.5);
    const past = priorRun("past", "2026-02-01T00:00:00.000Z", 0.9);
    expect(selectBaseline([future, past], now)?.runId).toBe("past");
  });
});

const AT = (iso: string) => new Date(iso);

describe("computeDrift", () => {
  it("reports NO_BASELINE with no alert when there is no baseline", () => {
    const d = computeDrift(0.9, null, 0.05, AT("2026-01-08T00:00:00.000Z"));
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("NO_BASELINE");
    expect(d.previousF1).toBeNull();
    expect(d.baselineRunId).toBeNull();
    expect(d.baselineAgeDays).toBeNull();
    expect(d.staleBaseline).toBe(false);
  });
  it("alerts when F1 drops more than the threshold", () => {
    const baseline = priorRun("b", "2026-01-01T00:00:00.000Z", 0.95);
    const d = computeDrift(0.85, baseline, 0.05, AT("2026-01-08T00:00:00.000Z"));
    expect(d.alert).toBe(true);
    expect(d.deltaF1).toBeCloseTo(-0.1, 5);
  });
  it("does not alert within the threshold", () => {
    const baseline = priorRun("b", "2026-01-01T00:00:00.000Z", 0.9);
    const d = computeDrift(0.88, baseline, 0.05, AT("2026-01-08T00:00:00.000Z"));
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("WITHIN_THRESHOLD");
  });
  it("does not alert when F1 improves", () => {
    const baseline = priorRun("b", "2026-01-01T00:00:00.000Z", 0.8);
    expect(computeDrift(0.95, baseline, 0.05, AT("2026-01-08T00:00:00.000Z")).alert).toBe(false);
  });

  // Issue #1333 — the reporting half. Between 2026-07-21 and the fix, every
  // nightly compared against the SAME 2026-07-21 envelope and reported
  // WITHIN_THRESHOLD. Those greens are one comparison repeated; the verdict has
  // to say so rather than reading as five weeks of stability.
  describe("baseline staleness (#1333)", () => {
    it("records the baseline run and its age on a healthy comparison", () => {
      const baseline = priorRun("b", "2026-01-01T00:00:00.000Z", 0.9);
      const d = computeDrift(0.9, baseline, 0.05, AT("2026-01-08T00:00:00.000Z"));
      expect(d.baselineRunId).toBe("b");
      expect(d.baselineAgeDays).toBeCloseTo(7, 5);
      expect(d.staleBaseline).toBe(false);
      expect(d.reason).toBe("WITHIN_THRESHOLD");
    });

    it("flags a baseline older than the stale window and says so in the reason", () => {
      const baseline = priorRun("2026-07-21T03-00-00-000Z", "2026-07-21T03:00:00.000Z", 0.9);
      const d = computeDrift(0.9, baseline, 0.05, AT("2026-08-29T03:00:00.000Z"));
      expect(d.staleBaseline).toBe(true);
      expect(Math.round(d.baselineAgeDays ?? 0)).toBe(39);
      expect(d.reason).toContain("WITHIN_THRESHOLD");
      expect(d.reason).toContain("STALE BASELINE");
      expect(d.reason).toContain("2026-07-21T03-00-00-000Z");
    });

    it("carries the staleness caveat into an ALERTING verdict too", () => {
      const baseline = priorRun("old", "2026-07-21T03:00:00.000Z", 0.95);
      const d = computeDrift(0.5, baseline, 0.05, AT("2026-08-29T03:00:00.000Z"));
      expect(d.alert).toBe(true);
      expect(d.reason).toContain("STALE BASELINE");
    });

    it("does not flag a baseline exactly at the stale window boundary", () => {
      const baseline = priorRun("b", "2026-01-01T00:00:00.000Z", 0.9);
      const d = computeDrift(0.9, baseline, 0.05, AT("2026-01-15T00:00:00.000Z"));
      expect(d.baselineAgeDays).toBeCloseTo(STALE_BASELINE_DAYS, 5);
      expect(d.staleBaseline).toBe(false);
    });

    it("flags one day past the window", () => {
      const baseline = priorRun("b", "2026-01-01T00:00:00.000Z", 0.9);
      expect(computeDrift(0.9, baseline, 0.05, AT("2026-01-16T00:00:00.000Z")).staleBaseline).toBe(
        true,
      );
    });
  });
});

describe("runDomainEval", () => {
  it("scores an in-memory corpus and returns a perfect-ish run", async () => {
    const { result, resultPath } = await runDomainEval({
      extractor: createOfflineExtractor(),
      corpus: { inMemory: [SAMPLE] },
      priorRuns: [],
      writeResult: false,
      now: () => new Date("2026-02-10T00:00:00.000Z"),
    });
    expect(resultPath).toBeNull();
    expect(result.itemCount).toBe(1);
    expect(result.corpusF1).toBe(1);
    expect(result.model).toBe("offline-stub");
    expect(result.drift.reason).toBe("NO_BASELINE");
    expect(result.runId).toBe("2026-02-10T00-00-00-000Z");
  });

  it("uses the default drift threshold", () => {
    expect(DEFAULT_DRIFT_THRESHOLD_PCT).toBeCloseTo(0.05, 5);
  });

  it("flags drift against a strong week-old baseline when the extractor degrades", async () => {
    const baseline = priorRun("base", "2026-02-01T00:00:00.000Z", 1);
    const degraded: DomainExtractor = {
      name: "degraded",
      extract: () => ({ requirements: [], tokens: 1, costCents: 0, latencyMs: 0 }),
    };
    const { result } = await runDomainEval({
      extractor: degraded,
      corpus: { inMemory: [SAMPLE] },
      priorRuns: [baseline],
      writeResult: false,
      now: () => new Date("2026-02-10T00:00:00.000Z"),
    });
    expect(result.corpusF1).toBe(0);
    expect(result.drift.alert).toBe(true);
    expect(result.drift.previousF1).toBe(1);
  });

  it("writes the result JSON when persistence is enabled", async () => {
    const dir = await tmp();
    const { result, resultPath } = await runDomainEval({
      extractor: createOfflineExtractor(),
      corpus: { inMemory: [SAMPLE] },
      resultsDir: dir,
      priorRuns: [],
      now: () => new Date("2026-02-10T00:00:00.000Z"),
    });
    expect(resultPath).not.toBeNull();
    const written = JSON.parse(await fs.readFile(resultPath!, "utf8"));
    expect(written.runId).toBe(result.runId);
    expect(written.corpusF1).toBe(1);
  });

  it("builds a confidence calibration histogram", async () => {
    const { result } = await runDomainEval({
      extractor: createOfflineExtractor(),
      corpus: { inMemory: [SAMPLE] },
      priorRuns: [],
      writeResult: false,
    });
    expect(result.calibration).toHaveLength(10);
    const populated = result.calibration.filter((b) => b.count > 0);
    expect(populated.length).toBeGreaterThan(0);
  });
});
