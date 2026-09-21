/**
 * Epic #803 (Epic 09) — Domain Eval regression-suite schemas.
 *
 * Shared between the server runner (`server/src/lib/eval/domain/*`) and the
 * `/eval/leaderboard` Domain Eval UI tab. Everything is file-backed: the
 * runner writes a {@link DomainEvalRunResult} JSON envelope to
 * `eval-results/<timestamp>.json`, and the read API streams those envelopes
 * back to the UI. There is intentionally no Prisma model — the committed JSON
 * files are the source of truth so a developer can add a corpus item without
 * any code or schema change.
 */
import { z } from "zod";
import { REQUIREMENT_PRIORITIES, REQUIREMENT_TYPES } from "./constants.js";

/** Document genres represented in the golden corpus. */
export const DOMAIN_DOC_TYPES = ["prd", "brd", "user-story"] as const;
export type DomainDocType = (typeof DOMAIN_DOC_TYPES)[number];

/**
 * A single golden / predicted requirement. Mirrors the BA pipeline's
 * `RequirementInput` (title + description + type + priority) with an optional
 * `confidence` that predictions carry and golden items omit.
 */
export const domainRequirementSchema = z.object({
  /** Stable id within the doc (e.g. "R1"). Used for diff alignment. */
  id: z.string().min(1).max(64),
  type: z.enum(REQUIREMENT_TYPES),
  title: z.string().min(1).max(255),
  /** Free-form description text — the ROUGE-L target. */
  description: z.string().min(1),
  priority: z.enum(REQUIREMENT_PRIORITIES),
  /** Present on extractor predictions; absent on golden items. */
  confidence: z.number().min(0).max(1).optional(),
});
export type DomainRequirement = z.infer<typeof domainRequirementSchema>;

/** Per-corpus-item metadata declared in `eval-data/manifest.json`. */
export const domainCorpusItemMetaSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(255),
  docType: z.enum(DOMAIN_DOC_TYPES),
  /** Source attribution — synthetic/original docs note license cleanliness. */
  source: z.string().min(1).max(255).default("original-synthetic"),
  license: z.string().min(1).max(64).default("CC0-1.0"),
});
export type DomainCorpusItemMeta = z.infer<typeof domainCorpusItemMetaSchema>;

export const domainManifestSchema = z.object({
  version: z.number().int().min(1).default(1),
  items: z.array(domainCorpusItemMetaSchema).default([]),
});
export type DomainManifest = z.infer<typeof domainManifestSchema>;

/** One aligned expected↔predicted pair within an item's score. */
export const domainMatchSchema = z.object({
  expectedId: z.string().nullable(),
  predictedId: z.string().nullable(),
  /** Token-set similarity of the two titles ∈ [0,1]. */
  titleSimilarity: z.number().min(0).max(1),
  /** ROUGE-L F1 over the two descriptions ∈ [0,1]. */
  rougeL: z.number().min(0).max(1),
  /** Prediction confidence carried through for calibration ∈ [0,1]. */
  confidence: z.number().min(0).max(1).nullable(),
});
export type DomainMatch = z.infer<typeof domainMatchSchema>;

export const domainItemResultSchema = z.object({
  itemId: z.string(),
  docType: z.enum(DOMAIN_DOC_TYPES),
  title: z.string(),
  truePositives: z.number().int().min(0),
  falsePositives: z.number().int().min(0),
  falseNegatives: z.number().int().min(0),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  f1: z.number().min(0).max(1),
  meanRougeL: z.number().min(0).max(1),
  matches: z.array(domainMatchSchema),
  expected: z.array(domainRequirementSchema),
  predicted: z.array(domainRequirementSchema),
});
export type DomainItemResult = z.infer<typeof domainItemResultSchema>;

/** One confidence-vs-correctness calibration bin (0.0–0.1 … 0.9–1.0). */
export const domainCalibrationBinSchema = z.object({
  bucket: z.string(),
  lowerBound: z.number().min(0).max(1),
  upperBound: z.number().min(0).max(1),
  count: z.number().int().min(0),
  meanConfidence: z.number().min(0).max(1),
  /** Fraction of predictions in this bin that were correct (matched). */
  accuracy: z.number().min(0).max(1),
});
export type DomainCalibrationBin = z.infer<typeof domainCalibrationBinSchema>;

/**
 * Issue #1333 — how old a baseline may be before "week-over-week" is a lie.
 *
 * `selectBaseline` deliberately reaches for a run at least 7 days old, so a
 * healthy nightly compares against roughly that. A baseline older than twice
 * the window means at least a week of envelopes is MISSING from the history,
 * not that nothing changed. Between 2026-07-21 and the #1333 fix every nightly
 * compared against the same 2026-07-21 run and reported WITHIN_THRESHOLD; the
 * intervening greens are one comparison repeated, not evidence of stability.
 */
export const STALE_BASELINE_DAYS = 14;

export const domainDriftSchema = z.object({
  previousF1: z.number().min(0).max(1).nullable(),
  /** currentF1 − previousF1 (negative = regression). */
  deltaF1: z.number().nullable(),
  /** Drop threshold as a fraction (0.05 = 5%). */
  thresholdPct: z.number().min(0).max(1),
  /** True when F1 dropped more than `thresholdPct` week-over-week. */
  alert: z.boolean(),
  reason: z.string(),
  /**
   * The run this verdict was measured against (#1333).
   *
   * All three fields below default rather than being required: `readRun`
   * `safeParse`s each envelope and DROPS what fails, so making them mandatory
   * would silently delete the 66 envelopes written before this change — losing
   * the very history the fix exists to restore.
   */
  baselineRunId: z.string().nullable().default(null),
  /** Age of `baselineRunId` in days at the moment of this run (#1333). */
  baselineAgeDays: z.number().nullable().default(null),
  /** True when the baseline is older than {@link STALE_BASELINE_DAYS} (#1333). */
  staleBaseline: z.boolean().default(false),
});
export type DomainDrift = z.infer<typeof domainDriftSchema>;

/**
 * One sentence naming the history gap, or `null` when the baseline is healthy.
 *
 * Shared by the CLI (`pnpm eval:domain`), the Slack drift alert and the Domain
 * Eval UI tab so the caveat cannot be present in one report and missing from
 * another — a green verdict measured against stale history has to read as
 * qualified everywhere it is read.
 */
export function describeBaselineStaleness(drift: DomainDrift): string | null {
  if (!drift.staleBaseline || drift.baselineAgeDays == null) return null;
  const days = Math.round(drift.baselineAgeDays);
  return (
    `STALE BASELINE: compared against \`${drift.baselineRunId ?? "unknown"}\`, ` +
    `${days} days old — this is NOT a week-over-week comparison. No envelope was ` +
    `recorded in between, so the intervening runs are missing history rather than ` +
    `green results (#1333).`
  );
}

export const domainEvalRunResultSchema = z.object({
  /** Filename-safe run id, typically the ISO-ish UTC timestamp. */
  runId: z.string().min(1),
  schemaVersion: z.number().int().min(1).default(1),
  model: z.string().min(1),
  startedAt: z.string(),
  completedAt: z.string(),
  itemCount: z.number().int().min(0),
  /** Micro-averaged precision/recall/F1 over the whole corpus. */
  corpusPrecision: z.number().min(0).max(1),
  corpusRecall: z.number().min(0).max(1),
  corpusF1: z.number().min(0).max(1),
  meanRougeL: z.number().min(0).max(1),
  totalTokens: z.number().int().min(0),
  totalCostCents: z.number().int().min(0),
  commit: z.string().nullable(),
  calibration: z.array(domainCalibrationBinSchema),
  drift: domainDriftSchema,
  items: z.array(domainItemResultSchema),
});
export type DomainEvalRunResult = z.infer<typeof domainEvalRunResultSchema>;

/** Compact summary used by the trend chart / run list (no per-item payload). */
export const domainEvalRunSummarySchema = domainEvalRunResultSchema
  .omit({ items: true, calibration: true })
  .extend({
    /** True when this run breached the drift threshold. */
    driftAlert: z.boolean(),
  });
export type DomainEvalRunSummary = z.infer<typeof domainEvalRunSummarySchema>;

export function toDomainRunSummary(run: DomainEvalRunResult): DomainEvalRunSummary {
  return {
    runId: run.runId,
    schemaVersion: run.schemaVersion,
    model: run.model,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    itemCount: run.itemCount,
    corpusPrecision: run.corpusPrecision,
    corpusRecall: run.corpusRecall,
    corpusF1: run.corpusF1,
    meanRougeL: run.meanRougeL,
    totalTokens: run.totalTokens,
    totalCostCents: run.totalCostCents,
    commit: run.commit,
    drift: run.drift,
    driftAlert: run.drift.alert,
  };
}
