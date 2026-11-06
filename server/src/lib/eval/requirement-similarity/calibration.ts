/**
 * Issue #1836 (epic #1828) — calibrate what counts as a "similar" requirement.
 *
 * Related requirements cluster together in embedding space, so a similarity
 * threshold copied from somewhere else marks "Export invoices to CSV" and
 * "Export invoices to PDF" as duplicates. The threshold #1837 labels with is
 * picked here, from a committed set of labelled, METIS-shaped pairs that is
 * heavy on exactly those hard negatives.
 *
 * Each pair's two requirements are embedded through
 * {@link formatRequirementForEmbedding} — the text the requirement index stores
 * (#1835) — and scored by cosine. Precision, recall and F1 are swept over the
 * thresholds for two positive classes: `duplicate`, and `duplicate` or `overlap`.
 * The chosen threshold is the one with the highest precision at recall of at
 * least {@link MIN_RECALL}.
 *
 * This file is the logic; `scripts/eval-req-similarity.ts` is the entrypoint
 * (`pnpm --filter @metis/server eval:req-similarity`).
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { cosineSimilarity } from "../../rag/vector-store.js";
import { formatRequirementForEmbedding } from "../../requirements/requirement-embeddings.js";

export const PAIR_LABELS = ["duplicate", "overlap", "related", "unrelated"] as const;
export type PairLabel = (typeof PAIR_LABELS)[number];

const requirementSchema = z
  .object({
    title: z.string().trim().min(1),
    body: z.string(),
    acceptanceCriteria: z.array(z.string().min(1)).optional(),
  })
  .strict();

const pairSchema = z
  .object({
    id: z.string().min(1),
    domain: z.string().min(1),
    label: z.enum(PAIR_LABELS),
    hardNegative: z.boolean().optional(),
    a: requirementSchema,
    b: requirementSchema,
  })
  .strict();

const fixtureSchema = z.object({
  version: z.literal(1),
  description: z.string().optional(),
  pairs: z.array(pairSchema).min(1),
});

export type RequirementPair = z.infer<typeof pairSchema>;
export type PairRequirement = z.infer<typeof requirementSchema>;

/** The fixture is missing or malformed: nothing is computed. */
export class PairFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairFixtureError";
  }
}

/**
 * Read and validate the pair fixture. Throws {@link PairFixtureError} for a missing
 * file, invalid JSON, a shape the schema rejects, a repeated pair id, or a
 * `hardNegative` on a positive pair (a hard negative is by definition not one).
 */
export async function loadRequirementPairs(path: string): Promise<RequirementPair[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new PairFixtureError(`pair fixture not readable at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PairFixtureError(`pair fixture is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = fixtureSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PairFixtureError(
      `pair fixture is malformed at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
    );
  }
  const seen = new Set<string>();
  for (const pair of parsed.data.pairs) {
    if (seen.has(pair.id)) throw new PairFixtureError(`pair id ${pair.id} appears twice`);
    seen.add(pair.id);
    if (pair.hardNegative && (pair.label === "duplicate" || pair.label === "overlap")) {
      throw new PairFixtureError(`pair ${pair.id} is a hard negative labelled ${pair.label}`);
    }
  }
  return parsed.data.pairs;
}

/** The text a pair requirement is embedded from: the requirement index's own format. */
export function pairRequirementText(req: PairRequirement): string {
  return formatRequirementForEmbedding({
    title: req.title,
    body: req.body,
    acceptanceCriteria: JSON.stringify(req.acceptanceCriteria ?? []),
  });
}

export interface ScoredPair {
  id: string;
  domain: string;
  label: PairLabel;
  hardNegative: boolean;
  score: number;
}

export type EmbedFn = (texts: string[]) => Promise<{ vectors: number[][]; model: string }>;

/** Embed every distinct text once (in batches) and score each pair by cosine. */
export async function scorePairs(
  pairs: readonly RequirementPair[],
  embed: EmbedFn,
  batchSize = 32,
): Promise<{ scored: ScoredPair[]; model: string }> {
  const texts = [
    ...new Set(pairs.flatMap((p) => [pairRequirementText(p.a), pairRequirementText(p.b)])),
  ];
  const vectors = new Map<string, number[]>();
  let model = "";
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const out = await embed(batch);
    if (out.vectors.length !== batch.length) {
      throw new Error(`embedder returned ${out.vectors.length} vectors for ${batch.length} texts`);
    }
    model = out.model;
    batch.forEach((t, j) => vectors.set(t, out.vectors[j]));
  }
  const scored = pairs.map((p) => ({
    id: p.id,
    domain: p.domain,
    label: p.label,
    hardNegative: p.hardNegative === true,
    score: cosineSimilarity(
      vectors.get(pairRequirementText(p.a)) as number[],
      vectors.get(pairRequirementText(p.b)) as number[],
    ),
  }));
  return { scored, model };
}

/** The thresholds the issue asks for: 0.80 to 0.98, every 0.01. */
export const THRESHOLDS: readonly number[] = Array.from(
  { length: 19 },
  (_, i) => Math.round((0.8 + i * 0.01) * 100) / 100,
);

/** The recall a chosen threshold must keep. */
export const MIN_RECALL = 0.6;

/**
 * A wider sweep, 0.50 to 0.98, for the two classes the issue's range cannot
 * place: "overlap" when no threshold in 0.80-0.98 keeps its recall, and the
 * floor below which a candidate is not similar at all ("related" vs unrelated).
 */
export const EXTENDED_THRESHOLDS: readonly number[] = Array.from(
  { length: 49 },
  (_, i) => Math.round((0.5 + i * 0.01) * 100) / 100,
);

/** The recall the "similar at all" floor must keep: it decides what an analyst ever sees. */
export const SIMILAR_MIN_RECALL = 0.9;

export interface SweepRow {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** `null` when nothing scores at or above the threshold. */
  precision: number | null;
  recall: number;
  f1: number;
}

/** Precision, recall and F1 of "score >= threshold" for the given positive labels. */
export function sweep(
  scored: readonly ScoredPair[],
  positive: ReadonlySet<PairLabel>,
  thresholds: readonly number[] = THRESHOLDS,
): SweepRow[] {
  const positives = scored.filter((s) => positive.has(s.label)).length;
  return thresholds.map((threshold) => {
    let tp = 0;
    let fp = 0;
    for (const s of scored) {
      if (s.score < threshold) continue;
      if (positive.has(s.label)) tp += 1;
      else fp += 1;
    }
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = positives === 0 ? 0 : tp / positives;
    const f1 =
      precision === null || precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    return {
      threshold,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: positives - tp,
      precision,
      recall,
      f1,
    };
  });
}

/**
 * The row with the highest precision among those with recall >= `minRecall`
 * (ties: the higher recall, then the lower threshold). `null` when no threshold
 * keeps that recall.
 */
export function chooseThreshold(
  rows: readonly SweepRow[],
  minRecall = MIN_RECALL,
): SweepRow | null {
  let best: SweepRow | null = null;
  for (const row of rows) {
    if (row.recall < minRecall || row.precision === null) continue;
    if (
      !best ||
      row.precision > (best.precision ?? 0) ||
      (row.precision === best.precision && row.recall > best.recall)
    ) {
      best = row;
    }
  }
  return best;
}

export type CalibrationClassName =
  "duplicate" | "duplicate-or-overlap" | "duplicate-or-overlap (extended)" | "similar (extended)";

export interface CalibrationClass {
  name: CalibrationClassName;
  /** The labels counted as positive. */
  positive: PairLabel[];
  minRecall: number;
  rows: SweepRow[];
  chosen: SweepRow | null;
  /** Highest precision reached at ANY threshold (recall regardless). */
  bestPrecision: number | null;
}

export interface CalibrationReport {
  model: string;
  pairs: number;
  domains: string[];
  hardNegatives: number;
  labelCounts: Record<PairLabel, number>;
  classes: CalibrationClass[];
  /** Hard negatives scoring at or above the chosen duplicate threshold. */
  hardNegativesOverDuplicate: string[];
  scored: ScoredPair[];
}

function calibrate(
  name: CalibrationClassName,
  positive: PairLabel[],
  scored: readonly ScoredPair[],
  thresholds: readonly number[],
  minRecall: number,
): CalibrationClass {
  const rows = sweep(scored, new Set(positive), thresholds);
  const precisions = rows.map((r) => r.precision).filter((p): p is number => p !== null);
  return {
    name,
    positive,
    minRecall,
    rows,
    chosen: chooseThreshold(rows, minRecall),
    bestPrecision: precisions.length > 0 ? Math.max(...precisions) : null,
  };
}

/**
 * Score the fixture and sweep: the issue's two classes over 0.80-0.98, then
 * "duplicate or overlap" and "similar at all" over {@link EXTENDED_THRESHOLDS}.
 */
export async function runCalibration(
  pairs: readonly RequirementPair[],
  embed: EmbedFn,
): Promise<CalibrationReport> {
  const { scored, model } = await scorePairs(pairs, embed);
  const labelCounts = Object.fromEntries(PAIR_LABELS.map((l) => [l, 0])) as Record<
    PairLabel,
    number
  >;
  for (const p of pairs) labelCounts[p.label] += 1;
  const dupOrOverlap: PairLabel[] = ["duplicate", "overlap"];
  const classes = [
    calibrate("duplicate", ["duplicate"], scored, THRESHOLDS, MIN_RECALL),
    calibrate("duplicate-or-overlap", dupOrOverlap, scored, THRESHOLDS, MIN_RECALL),
    calibrate(
      "duplicate-or-overlap (extended)",
      dupOrOverlap,
      scored,
      EXTENDED_THRESHOLDS,
      MIN_RECALL,
    ),
    calibrate(
      "similar (extended)",
      ["duplicate", "overlap", "related"],
      scored,
      EXTENDED_THRESHOLDS,
      SIMILAR_MIN_RECALL,
    ),
  ];
  const dupThreshold = classes[0].chosen?.threshold;
  return {
    model,
    pairs: pairs.length,
    domains: [...new Set(pairs.map((p) => p.domain))].sort(),
    hardNegatives: pairs.filter((p) => p.hardNegative).length,
    labelCounts,
    classes,
    hardNegativesOverDuplicate:
      dupThreshold === undefined
        ? []
        : scored.filter((s) => s.hardNegative && s.score >= dupThreshold).map((s) => s.id),
    scored,
  };
}

const pct = (n: number | null): string => (n === null ? "—" : n.toFixed(3));

/** The markdown summary the script prints and the issue comment quotes. */
export function renderCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = [
    `Model: \`${report.model}\` — ${report.pairs} pairs, ${report.domains.length} domains (${report.domains.join(", ")}), ${report.hardNegatives} hard negatives`,
    `Labels: ${PAIR_LABELS.map((l) => `${l} ${report.labelCounts[l]}`).join(", ")}`,
    "",
  ];
  for (const c of report.classes) {
    const range = `${c.rows[0]?.threshold.toFixed(2)}-${c.rows.at(-1)?.threshold.toFixed(2)}`;
    lines.push(`### Positive class: ${c.name} (${c.positive.join(" | ")})`, "");
    lines.push(
      "| threshold | precision | recall | F1 | TP | FP | FN |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of c.rows) {
      lines.push(
        `| ${r.threshold.toFixed(2)} | ${pct(r.precision)} | ${r.recall.toFixed(3)} | ${r.f1.toFixed(3)} | ${r.truePositives} | ${r.falsePositives} | ${r.falseNegatives} |`,
      );
    }
    lines.push(
      "",
      c.chosen
        ? `Chosen: **${c.chosen.threshold.toFixed(2)}** (precision ${pct(c.chosen.precision)}, recall ${c.chosen.recall.toFixed(3)}).`
        : `Chosen: **none** — no threshold in ${range} keeps recall >= ${c.minRecall}.`,
      `Best precision at any threshold: ${pct(c.bestPrecision)}.`,
      "",
    );
  }
  const byLabel = PAIR_LABELS.map((l) => {
    const s = report.scored.filter((p) => p.label === l).map((p) => p.score);
    const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    return `${l} mean ${mean.toFixed(3)} (min ${Math.min(...s).toFixed(3)}, max ${Math.max(...s).toFixed(3)})`;
  });
  lines.push(`Score by label: ${byLabel.join("; ")}.`);
  lines.push(
    `Hard negatives at or above the duplicate threshold: ${report.hardNegativesOverDuplicate.length === 0 ? "none" : report.hardNegativesOverDuplicate.join(", ")}.`,
  );
  return lines.join("\n");
}
