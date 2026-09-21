/**
 * Epic #803 (Epic 09) — Domain Eval runner.
 *
 * Drives the regression loop:
 *   1. Load the golden corpus (auto-discovered from `eval-data/`).
 *   2. Run the injected BA-pipeline {@link DomainExtractor} per document.
 *   3. Score each item (F1 / precision / recall + ROUGE-L).
 *   4. Micro-average the corpus, build the confidence calibration histogram.
 *   5. Compare F1 to the week-over-week baseline → drift verdict.
 *   6. Write `eval-results/<runId>.json` (the file-backed source of truth).
 *
 * Pure of any DB: the committed JSON envelopes are what the UI and the drift
 * check read, so adding a corpus item never needs a migration.
 */
import { calibrationBins, precisionRecallF1, scoreItem, type PredictionOutcome } from "./scorer.js";
import { loadCorpus, type LoadCorpusOptions } from "./corpus.js";
import { loadAllRuns, writeRun, defaultResultsDir } from "./results-store.js";
import type { DomainExtractor } from "./extractor.js";
import {
  STALE_BASELINE_DAYS,
  describeBaselineStaleness,
  toDomainRunSummary,
  type DomainCalibrationBin,
  type DomainDrift,
  type DomainEvalRunResult,
  type DomainItemResult,
} from "@metis/shared";

export const DEFAULT_DRIFT_THRESHOLD_PCT = 0.05;

export interface RunDomainEvalInput {
  /** The BA pipeline (or offline stub) under test. */
  extractor: DomainExtractor;
  /** Corpus source — defaults to scanning `<cwd>/eval-data`. */
  corpus?: LoadCorpusOptions;
  /** Where to read prior runs / write this run. Defaults to `<cwd>/eval-results`. */
  resultsDir?: string;
  /** Clock seam for deterministic run ids. */
  now?: () => Date;
  /** Drift threshold as a fraction (default 5%). */
  driftThresholdPct?: number;
  /** Commit SHA recorded on the run envelope. */
  commit?: string | null;
  /** Persist the result JSON (default true). */
  writeResult?: boolean;
  /** Test seam — supply prior runs instead of reading the filesystem. */
  priorRuns?: DomainEvalRunResult[];
}

export interface RunDomainEvalOutput {
  result: DomainEvalRunResult;
  resultPath: string | null;
}

export function makeRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Pick the week-over-week baseline: the most recent prior run that is at least
 * ~7 days older than `current`; if none is that old, fall back to the most
 * recent prior run so consecutive nightly runs still guard against regressions.
 */
export function selectBaseline(
  priorRuns: DomainEvalRunResult[],
  currentStart: Date,
  targetAgeDays = 7,
): DomainEvalRunResult | null {
  const older = priorRuns
    .filter((r) => new Date(r.startedAt).getTime() < currentStart.getTime())
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  if (older.length === 0) return null;
  const cutoff = currentStart.getTime() - targetAgeDays * 86_400_000;
  const aged = older.find((r) => new Date(r.startedAt).getTime() <= cutoff);
  return aged ?? older[0];
}

/**
 * @param currentStart When this run started — required, not optional, so the
 *   baseline's age can never be silently omitted from a verdict (#1333).
 */
export function computeDrift(
  currentF1: number,
  baseline: DomainEvalRunResult | null,
  thresholdPct: number,
  currentStart: Date,
): DomainDrift {
  if (!baseline) {
    return {
      previousF1: null,
      deltaF1: null,
      thresholdPct,
      alert: false,
      reason: "NO_BASELINE",
      baselineRunId: null,
      baselineAgeDays: null,
      staleBaseline: false,
    };
  }
  const deltaF1 = currentF1 - baseline.corpusF1;
  const alert = deltaF1 < -thresholdPct;
  const baselineAgeDays =
    (currentStart.getTime() - new Date(baseline.startedAt).getTime()) / 86_400_000;
  const staleBaseline = baselineAgeDays > STALE_BASELINE_DAYS;
  const drift: DomainDrift = {
    previousF1: baseline.corpusF1,
    deltaF1,
    thresholdPct,
    alert,
    reason: alert
      ? `F1 dropped ${Math.abs(deltaF1 * 100).toFixed(1)}% > ${(thresholdPct * 100).toFixed(0)}%`
      : "WITHIN_THRESHOLD",
    baselineRunId: baseline.runId,
    baselineAgeDays,
    staleBaseline,
  };
  // A verdict measured against stale history is not the verdict it appears to
  // be, so the caveat rides on `reason` — the one field every reporting surface
  // already prints (#1333).
  const staleness = describeBaselineStaleness(drift);
  return staleness ? { ...drift, reason: `${drift.reason} — ${staleness}` } : drift;
}

export async function runDomainEval(input: RunDomainEvalInput): Promise<RunDomainEvalOutput> {
  const nowFn = input.now ?? (() => new Date());
  const startedAt = nowFn();
  const thresholdPct = input.driftThresholdPct ?? DEFAULT_DRIFT_THRESHOLD_PCT;
  const resultsDir = input.resultsDir ?? defaultResultsDir();

  const corpus = await loadCorpus(input.corpus);

  const items: DomainItemResult[] = [];
  const predictionOutcomes: PredictionOutcome[] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let rougeSum = 0;
  let rougeCount = 0;
  let totalTokens = 0;
  let totalCostCents = 0;

  for (const item of corpus) {
    const extraction = await input.extractor.extract(item);
    totalTokens += extraction.tokens;
    totalCostCents += extraction.costCents;
    const scored = scoreItem({
      itemId: item.id,
      docType: item.docType,
      title: item.title,
      expected: item.expected,
      predicted: extraction.requirements,
    });
    items.push(scored);
    tp += scored.truePositives;
    fp += scored.falsePositives;
    fn += scored.falseNegatives;
    for (const m of scored.matches) {
      if (m.predictedId && m.confidence != null) {
        predictionOutcomes.push({ confidence: m.confidence, correct: Boolean(m.expectedId) });
      }
      if (m.expectedId && m.predictedId) {
        rougeSum += m.rougeL;
        rougeCount += 1;
      }
    }
  }

  const corpusPrf = precisionRecallF1(tp, fp, fn);
  const meanRougeL = rougeCount === 0 ? 0 : rougeSum / rougeCount;
  const calibration: DomainCalibrationBin[] = calibrationBins(predictionOutcomes);

  const priorRuns = input.priorRuns ?? (await loadAllRuns(resultsDir));
  const baseline = selectBaseline(priorRuns, startedAt);
  const drift = computeDrift(corpusPrf.f1, baseline, thresholdPct, startedAt);

  const completedAt = nowFn();
  const result: DomainEvalRunResult = {
    runId: makeRunId(startedAt),
    schemaVersion: 1,
    model: input.extractor.name,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    itemCount: corpus.length,
    corpusPrecision: corpusPrf.precision,
    corpusRecall: corpusPrf.recall,
    corpusF1: corpusPrf.f1,
    meanRougeL,
    totalTokens,
    totalCostCents,
    commit: input.commit ?? null,
    calibration,
    drift,
    items,
  };
  // Re-validate the summary projection is consistent (cheap invariant guard).
  void toDomainRunSummary(result);

  let resultPath: string | null = null;
  if (input.writeResult !== false) {
    resultPath = await writeRun(resultsDir, result);
  }
  return { result, resultPath };
}
