/**
 * Multi-project requirement-change → code-impact analysis — Epic #159.
 *
 * Shared between the server (Zod validation at the API boundary) and the UI
 * (form types / API contracts). Covers the four new persistence models added
 * in #160 plus the request/response DTOs consumed by the engine (#162),
 * routes (#163), and UI (#164–#166).
 *
 * One `ImpactAnalysis` spans MANY projects: a single requirements-change
 * document can impact e.g. both WMS and ORDERBATCH. Per-project results are
 * carried by `ImpactItem` rows, each owning a set of `ImpactAffectedSymbol`
 * rows (direct matches + transitive blast-radius).
 */
import { z } from "zod";
import { CHANGE_SEVERITIES, CHANGE_TYPES } from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";
import type { ImpactAffectedTableView } from "./schema-impact.js";

// ---- Constants -------------------------------------------------------------

/** Lifecycle status of an impact-analysis run. Mirrors ChangeAnalysis. */
export const IMPACT_ANALYSIS_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ImpactAnalysisStatus = (typeof IMPACT_ANALYSIS_STATUSES)[number];

/** Provenance of a requirement→code mapping. */
export const REQUIREMENT_CODE_MAPPING_SOURCES = ["semantic", "manual"] as const;
export type RequirementCodeMappingSource = (typeof REQUIREMENT_CODE_MAPPING_SOURCES)[number];

/**
 * How an affected symbol relates to the changed requirement.
 *   - `direct`     — matched directly by the requirement→code mapper.
 *   - `caller`     — transitively calls a directly-affected symbol.
 *   - `importer`   — transitively imports a directly-affected symbol.
 *   - `dependency` — a downstream dependency reached via the graph.
 */
export const IMPACT_AFFECTED_RELATIONS = ["direct", "caller", "importer", "dependency"] as const;
export type ImpactAffectedRelation = (typeof IMPACT_AFFECTED_RELATIONS)[number];

// ---- Match quality (#961) --------------------------------------------------

/**
 * #961 — how well the changed requirement's wording SEEDED into code.
 *   - `strong`   — a high-confidence, clearly-standout seed match: the
 *                  requirement named an entity/screen the matcher recognised.
 *   - `moderate` — a usable but not standout match.
 *   - `weak`     — the requirement seeded poorly (no seed, or only low-confidence
 *                  / scattered near-tied seeds). The downstream impact is likely
 *                  thin or wrong; the UI surfaces a "re-word the requirement"
 *                  banner rather than rendering it as a confident result.
 */
export const MATCH_QUALITIES = ["strong", "moderate", "weak"] as const;
export type MatchQuality = (typeof MATCH_QUALITIES)[number];

/**
 * #961/#994 — one requirement→code SEED: a direct-match confidence plus the
 * file path it matched, in [0,1]. Confidences are produced by
 * {@link normalizeConfidence} (`server/src/lib/traceability/requirement-code-mapping.ts`),
 * which normalizes RELATIVE to the top hit in the result set — so **the top
 * seed in any non-empty set is always ~1.0**. `deriveMatchQuality` therefore
 * cannot read seed confidence as an absolute "how well-named was this entity"
 * signal; it can only compare seeds to EACH OTHER (spread) and, when several
 * are near-tied, ask whether they plausibly name the SAME entity (file-path
 * coherence). The `filePath` is what makes that coherence check possible.
 */
export interface MatchQualitySeed {
  /** Top-normalized seed confidence in [0,1] (see the type doc above). */
  confidence: number;
  /** File path of the matched symbol — feeds the coherence discriminator. */
  filePath: string;
}

/**
 * #994 — WHY a `weak` grade fired, so the UI/summarizer can give an honest,
 * differentiated caveat instead of one generic "didn't name an entity" line:
 *   - `"no-entity"` — zero seeds at all (the requirement matched no code).
 *   - `"scattered"` — several near-tied seeds with no dominant shared entity
 *     (generic wording that fanned out across unrelated areas).
 *   - `null` — not weak (`strong`/`moderate`), no reason to surface.
 */
export type MatchQualityReason = "no-entity" | "scattered" | null;

/** #994 — {@link deriveMatchQuality}'s full result: the grade plus WHY. */
export interface MatchQualityResult {
  quality: MatchQuality;
  reason: MatchQualityReason;
}

/**
 * #961/#994 — DOCUMENTED, deterministic thresholds for {@link deriveMatchQuality}.
 *
 * IMPORTANT: seed confidences are TOP-NORMALIZED (see {@link MatchQualitySeed}),
 * so the top seed of any non-empty set is always ≈1.0 — an ABSOLUTE confidence
 * floor (e.g. "top must be ≥ 0.7") is always-true or always-false and carries no
 * signal. These thresholds are deliberately all RELATIVE (spread between seeds,
 * or coherence among a near-tied pack) — never absolute confidence gates.
 */
export const MATCH_QUALITY_THRESHOLDS = {
  /**
   * The top seed must beat the runner-up by at least this margin to count as a
   * clear, unambiguous winner (a single seed is a winner by definition — there
   * is no runner-up to be ambiguous against). Below the margin, the top match is
   * one of a near-tied pack — ambiguous, not standout.
   */
  CLEAR_WINNER_SPREAD: 0.15,
  /**
   * This many near-tied seeds (spread below {@link CLEAR_WINNER_SPREAD}) trips
   * the coherence discriminator instead of the default `moderate` grade: a
   * dominant shared entity across the pack (per {@link DOMINANT_TOKEN_SHARE})
   * reads as one real feature scattered across files ⇒ `moderate`; no dominant
   * entity reads as truly scattered/generic wording ⇒ `weak`.
   */
  SCATTERED_SEED_COUNT: 5,
  /**
   * Among a near-tied pack (≥ `SCATTERED_SEED_COUNT`), the most common basename
   * token must appear in at least this fraction of the seeds' file paths to count
   * as a dominant, coherent entity (e.g. `order` across ≥half of `Order*`/
   * `LineItem*` files). Below this share, no token dominates ⇒ scattered.
   */
  DOMINANT_TOKEN_SHARE: 0.5,
} as const;

/**
 * #994 — split a file basename (extension stripped) into lowercase
 * camelCase/PascalCase word tokens, e.g. `"OrderCancellationHandler.ts"` →
 * `["order", "cancellation", "handler"]`. Mirrors the identifier-splitting
 * convention the server's BM25 tokenizer (`tokenizeCode` in
 * `server/src/lib/code-graph/hybrid-search.ts`) uses for consistency, but is
 * reimplemented package-locally here since `packages/shared` has no server
 * dependency. Pure, deterministic, no I/O.
 */
function tokenizeBasename(filePath: string): string[] {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const stem = base.replace(/\.[^./\\]+$/, "");
  const expanded = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return expanded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * #994 — Candidate A coherence discriminator: the share of `seeds` whose file
 * BASENAME contains the single most common basename token (each seed counted
 * at most once per token). `1.0` when every seed's basename shares one word
 * (e.g. all `Order*`/`LineItem*`); low when basenames name unrelated entities
 * (e.g. `Account`/`Item`/`Orders`/`Cart`). Exported for calibration/tests —
 * this is the candidate wired into {@link deriveMatchQuality}.
 */
export function dominantBasenameTokenShare(seeds: readonly MatchQualitySeed[]): number {
  if (seeds.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const seed of seeds) {
    for (const token of new Set(tokenizeBasename(seed.filePath))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const count of counts.values()) if (count > max) max = count;
  return max / seeds.length;
}

/**
 * #994 — Candidate B coherence discriminator (EVALUATED, NOT SHIPPED — see the
 * {@link deriveMatchQuality} doc for why). The share of `seeds` whose file lives
 * in the single most common directory. Rejected during calibration: a flat
 * layout (e.g. many unrelated models under one `src/models/` directory) makes
 * genuinely scattered seeds look "coherent" by directory alone, false-negativing
 * the `weak` grade the scattered-seed regression fixture requires. Exported so
 * the rejection is verifiable in tests, not just asserted in a comment.
 */
export function dominantDirectoryShare(seeds: readonly MatchQualitySeed[]): number {
  if (seeds.length === 0) return 0;
  const dirOf = (filePath: string): string => {
    const parts = filePath.split(/[/\\]/);
    parts.pop();
    return parts.join("/") || ".";
  };
  const counts = new Map<string, number>();
  for (const seed of seeds) {
    const dir = dirOf(seed.filePath);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) if (count > max) max = count;
  return max / seeds.length;
}

/**
 * #961/#994 — derive a per-item {@link MatchQualityResult} from the
 * requirement→code SEEDs. Pure + deterministic (no LLM, no I/O). The same
 * function runs at engine time (over the raw match confidences+paths, for the
 * summarizer) and at read time (over the persisted direct-symbol
 * confidences+paths, for the API/UI), so both paths agree byte-for-byte.
 *
 * Rules (thresholds in {@link MATCH_QUALITY_THRESHOLDS}; see that doc for why
 * they are all RELATIVE, never absolute-confidence gates):
 *   1. Zero seeds ⇒ `weak` / reason `"no-entity"` (the requirement matched no code).
 *   2. A clear winner — a single seed, or the top beats the runner-up by ≥
 *      `CLEAR_WINNER_SPREAD` — ⇒ `strong` (a standout match, whatever its
 *      absolute confidence: a lone seed IS the top-normalized hit).
 *   3. `SCATTERED_SEED_COUNT`+ near-tied seeds (no clear winner): run the
 *      coherence discriminator ({@link dominantBasenameTokenShare}). A dominant
 *      shared entity (≥ `DOMINANT_TOKEN_SHARE`) ⇒ `moderate` (one real feature,
 *      scattered across its own files — e.g. `Order*`/`LineItem*`); no dominant
 *      entity ⇒ `weak` / reason `"scattered"` (generic wording that fanned out
 *      across unrelated areas — e.g. `Account`/`Item`/`Orders`/`Cart`).
 *   4. Otherwise (a near-tied pack smaller than `SCATTERED_SEED_COUNT`) ⇒ `moderate`.
 */
export function deriveMatchQualityDetailed(seeds: readonly MatchQualitySeed[]): MatchQualityResult {
  const T = MATCH_QUALITY_THRESHOLDS;
  const valid = seeds
    .filter((s) => Number.isFinite(s.confidence))
    .slice()
    .sort((a, b) => b.confidence - a.confidence);
  const seedCount = valid.length;
  if (seedCount === 0) return { quality: "weak", reason: "no-entity" };

  // A single seed stands out by definition; otherwise measure the top-vs-runner-up gap.
  const spread = seedCount === 1 ? Infinity : valid[0].confidence - valid[1].confidence;
  const clearWinner = spread >= T.CLEAR_WINNER_SPREAD;
  if (clearWinner) return { quality: "strong", reason: null };

  if (seedCount >= T.SCATTERED_SEED_COUNT) {
    const share = dominantBasenameTokenShare(valid);
    if (share >= T.DOMINANT_TOKEN_SHARE) return { quality: "moderate", reason: null };
    return { quality: "weak", reason: "scattered" };
  }

  return { quality: "moderate", reason: null };
}

/**
 * #961/#994 — thin back-compat wrapper over {@link deriveMatchQualityDetailed}
 * for callers that only need the bare {@link MatchQuality} (e.g. the impact-recall
 * eval harness's reported-not-scored metric).
 */
export function deriveMatchQuality(seeds: readonly MatchQualitySeed[]): MatchQuality {
  return deriveMatchQualityDetailed(seeds).quality;
}

/**
 * Issue #966 (Epic #960) — a BA's relevance verdict on one affected-table row.
 * `relevant` confirms the crossing was useful; `not-relevant` flags it as noise.
 * v1 is CAPTURE-ONLY: this has NO effect on the impact engine or the #936 LLM
 * relevance filter — it is harvested (human-reviewed) into eval-corpus labels.
 */
export const IMPACT_TABLE_FEEDBACK_VERDICTS = ["relevant", "not-relevant"] as const;
export type ImpactTableFeedbackVerdict = (typeof IMPACT_TABLE_FEEDBACK_VERDICTS)[number];

// ---- RequirementCodeMapping ------------------------------------------------

export const requirementCodeMappingSchema = z.object({
  id: idSchema,
  requirementId: idSchema,
  projectId: idSchema,
  /** Null when the matched candidate is an unresolved/external symbol. */
  codeSymbolId: idSchema.nullable(),
  filePath: z.string().min(1).max(1024),
  startLine: z.number().int().min(0).nullable(),
  endLine: z.number().int().min(0).nullable(),
  confidence: z.number().min(0).max(1),
  source: z.enum(REQUIREMENT_CODE_MAPPING_SOURCES),
  createdAt: dateSchema,
});
export type RequirementCodeMapping = z.infer<typeof requirementCodeMappingSchema>;

// ---- ImpactAnalysis --------------------------------------------------------

export const impactAnalysisSchema = z
  .object({
    id: idSchema,
    status: z.enum(IMPACT_ANALYSIS_STATUSES),
    /** Source document when the run was triggered from an uploaded file. */
    documentId: idSchema.nullable(),
    /** Raw change text when triggered from a pasted/posted body. */
    sourceText: z.string().nullable(),
    summary: z.string().max(8192).nullable(),
    startedById: idSchema,
    startedAt: dateSchema,
    completedAt: dateSchema.nullable(),
    errorMessage: z.string().max(4096).nullable(),
    totalImpactedSymbols: z.number().int().min(0),
  })
  .merge(timestampsSchema);
export type ImpactAnalysis = z.infer<typeof impactAnalysisSchema>;

// ---- ImpactItem ------------------------------------------------------------

export const impactItemSchema = z.object({
  id: idSchema,
  impactAnalysisId: idSchema,
  projectId: idSchema,
  /** Null for removals where no head requirement persists. */
  requirementId: idSchema.nullable(),
  changeType: z.enum(CHANGE_TYPES),
  severity: z.enum(CHANGE_SEVERITIES),
  impactScore: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  affectedFileCount: z.number().int().min(0),
  affectedSymbolCount: z.number().int().min(0),
  /** #932 — persisted BA-readable per-item narrative (null when not generated). */
  summary: z.string().max(8192).nullable(),
  createdAt: dateSchema,
});
export type ImpactItem = z.infer<typeof impactItemSchema>;

// ---- ImpactAffectedSymbol --------------------------------------------------

export const impactAffectedSymbolSchema = z.object({
  id: idSchema,
  impactItemId: idSchema,
  codeSymbolId: idSchema.nullable(),
  filePath: z.string().min(1).max(1024),
  qualifiedName: z.string().min(1).max(1024),
  startLine: z.number().int().min(0).nullable(),
  endLine: z.number().int().min(0).nullable(),
  relation: z.enum(IMPACT_AFFECTED_RELATIONS),
  /** BFS distance from the direct match (0 for direct hits). */
  depth: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});
export type ImpactAffectedSymbol = z.infer<typeof impactAffectedSymbolSchema>;

// ---- Request DTOs ----------------------------------------------------------

/**
 * Create an impact analysis. Exactly one of `documentId` or `text` must be
 * supplied as the change source. `projectIds` must contain at least one id;
 * the multi-project flow (two or more) is the headline capability.
 */
export const createImpactAnalysisSchema = z
  .object({
    documentId: idSchema.optional(),
    text: z.string().trim().min(1).max(500_000).optional(),
    projectIds: z.array(idSchema).min(1, "at least one projectId is required").max(50),
    /**
     * Epic #168 — when true, the engine also crosses code → mapper/entity →
     * table → column and reports affected tables/columns + suggested DDL.
     * Defaults to true; set false to skip the schema dimension.
     */
    includeSchemaImpact: z.boolean().optional().default(true),
    /**
     * When true, the blast radius also walks DOWNSTREAM dependencies (what the
     * changed code *uses*), not just upstream callers/importers. Defaults to
     * FALSE: downstream dependencies broaden the blast radius and add noise to
     * the "who is impacted by this change" signal, so they are opt-in.
     */
    includeDependencies: z.boolean().optional().default(false),
  })
  .refine((v) => Boolean(v.documentId) || Boolean(v.text), {
    message: "either documentId or text is required",
    path: ["documentId"],
  });
/**
 * Request payload type for callers. Uses `z.input` so optional-with-default
 * fields (e.g. `includeSchemaImpact`) remain optional for the client — the
 * server applies the defaults when it parses.
 */
export type CreateImpactAnalysisInput = z.input<typeof createImpactAnalysisSchema>;
/** Parsed payload (defaults applied) — used server-side after validation. */
export type CreateImpactAnalysisParsed = z.infer<typeof createImpactAnalysisSchema>;

/**
 * Issue #966 (Epic #960) — mark one affected-table row relevant/not-relevant.
 * `columnName` omitted/null ⇒ a table-level verdict; set ⇒ a column-level one.
 */
export const impactTableFeedbackInputSchema = z.object({
  tableName: z.string().trim().min(1).max(1024),
  columnName: z.string().trim().min(1).max(255).nullable().optional(),
  verdict: z.enum(IMPACT_TABLE_FEEDBACK_VERDICTS),
});
export type ImpactTableFeedbackInput = z.infer<typeof impactTableFeedbackInputSchema>;

// ---- API response aggregates -----------------------------------------------

/** A single affected symbol surfaced in the detail view. */
export interface ImpactAffectedSymbolView {
  id: string;
  codeSymbolId: string | null;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: ImpactAffectedRelation;
  depth: number;
  confidence: number;
}

/**
 * #962 (epic #960) — a callout that an impacted database table's WRITE path
 * (the code symbols that `writes`/`persists-to` it) is reached by NO test. Purely
 * a QA-handoff signal for a BA: "this mutation is not covered — verify before
 * shipping". Computed deterministically at read time from the persisted schema
 * graph (the `writes`/`persists-to` edges + the incoming test-file edges into the
 * writing symbols, classified by the shared `isTestFilePath` heuristic) — no LLM,
 * no migration. Emitted ONLY for tables that HAVE a write path but no covering
 * test; a fully-covered (or read-only) table produces no gap.
 */
export interface WritePathCoverageGap {
  /** Physical/schema-qualified name of the affected table whose writes are untested. */
  tableName: string;
  /**
   * #1012 — qualified names of the table's writing symbols that NO test reaches,
   * sorted + deduped for deterministic rendering. Per-WRITER, not per-table: before
   * #1012 a single covered writer cleared the whole table, silently hiding an
   * untested sibling writer. Always non-empty (a gap with no uncovered writer is
   * not emitted).
   */
  writingSymbols: string[];
  /**
   * #1012 — qualified names of this table's OTHER writing symbols that a test does
   * reach, sorted + deduped. Empty ⇒ no writer of this table is tested at all;
   * non-empty ⇒ the table is PARTIALLY covered and only {@link writingSymbols} need
   * QA attention. Lets a BA tell "nothing here is tested" from "one of these two
   * mutations is tested".
   */
  coveredWritingSymbols: string[];
}

/**
 * Issue #966 (Epic #960) — one BA's relevance verdict on an affected-table row,
 * persisted for later harvest into eval-corpus labels. CAPTURE-ONLY: rendering
 * this has no effect on the engine or the #936 filter.
 */
export interface ImpactTableFeedbackView {
  id: string;
  impactItemId: string;
  tableName: string;
  /** Null ⇒ a table-level verdict; set ⇒ a column-level verdict. */
  columnName: string | null;
  verdict: ImpactTableFeedbackVerdict;
  userId: string;
  /** Display name snapshotted at mark time (no User join needed to render it). */
  userDisplayName: string;
  createdAt: string;
}

/** One (project, requirement-change) row with its affected symbols. */
export interface ImpactItemView {
  id: string;
  projectId: string;
  requirementId: string | null;
  /** Human-readable title of the changed requirement (joined for display). */
  requirementTitle: string | null;
  changeType: (typeof CHANGE_TYPES)[number];
  severity: (typeof CHANGE_SEVERITIES)[number];
  impactScore: number;
  confidence: number;
  /**
   * #961 — how well the requirement's wording seeded into code
   * (`strong`/`moderate`/`weak`), derived deterministically from the seed
   * confidences by {@link deriveMatchQuality}. A `weak` item drives the UI's
   * low-confidence banner: the requirement didn't clearly name an entity/screen,
   * so its impact may be thin or wrong. Distinct from the #936 relevance tiers
   * (which grade individual affected TABLES, not the requirement→code match).
   */
  matchQuality: MatchQuality;
  /**
   * #994 — WHY {@link matchQuality} is `weak` (`null` otherwise). Lets the UI/
   * summarizer give an honest, differentiated caveat instead of one generic
   * "didn't name an entity" line — see {@link MatchQualityReason}.
   */
  matchQualityReason: MatchQualityReason;
  affectedFileCount: number;
  affectedSymbolCount: number;
  /**
   * #932 — BA-readable per-item narrative + severity summary, generated post-hoc
   * by the LLM impact summarizer from the DETERMINISTIC facts only. Null when the
   * summarizer did not run (flag off / provider offline / malformed / ungrounded);
   * the deterministic impact data is unchanged either way.
   */
  summary: string | null;
  /**
   * PRODUCTION-code affected symbols only. #962 (epic #960) — symbols whose file
   * is a test path (per the shared `isTestFilePath` heuristic) are SPLIT OUT into
   * {@link affectedTests} so the blast radius a BA scans is not polluted by the
   * project's own test files (which naturally appear as callers of the changed
   * code). Byte-identical to the pre-#962 list for a project with no impacted
   * test files.
   */
  affectedSymbols: ImpactAffectedSymbolView[];
  /**
   * #962 (epic #960) — the affected symbols whose file is a TEST path (per the
   * shared `isTestFilePath` heuristic), grouped out of {@link affectedSymbols}.
   * These are the tests that already cover (call/import) the impacted code — the
   * "tests covering the impacted code" group the QA handoff needs, with a count.
   * Empty when no impacted symbol lives in a test file.
   */
  affectedTests: ImpactAffectedSymbolView[];
  /**
   * #962 (epic #960) — impacted tables whose WRITE path (the symbols that
   * `writes`/`persists-to` them) is reached by no test. A deterministic
   * QA-handoff callout; empty when every written table has a covering test, when
   * no affected table has a write path, or when the schema graph is unavailable.
   */
  writePathGaps: WritePathCoverageGap[];
  /**
   * Epic #168 — affected database tables/columns + suggested DDL (text only).
   * PRIMARY set only: rows the #936 relevance filter judged `likely`/`possible`,
   * plus every non-table row and every legacy/flag-off row (null tier).
   */
  affectedTables: ImpactAffectedTableView[];
  /**
   * #936 — low-confidence SECONDARY bucket: tables the LLM relevance filter
   * judged `unlikely` (tangential fan-out from the #928 crossing), pruned from
   * {@link affectedTables} for precision but retained here so a BA can still see
   * them (recall safety). Empty when the filter did not run.
   */
  affectedTablesSecondary: ImpactAffectedTableView[];
  /**
   * Issue #966 (Epic #960) — accumulated BA feedback on this item's affected
   * tables (both the primary and secondary buckets share this one list; a
   * consumer filters by `tableName`/`columnName`). Empty when no one has marked
   * anything yet.
   */
  feedback: ImpactTableFeedbackView[];
}

/** List-view summary row for `GET /api/impact-analyses`. */
export interface ImpactAnalysisSummary {
  id: string;
  status: ImpactAnalysisStatus;
  documentId: string | null;
  summary: string | null;
  projectCount: number;
  /**
   * #61 — the run's projects the caller can access (all of them for an admin).
   * `projectCount` still counts every project in the run, as it always has; a
   * project the caller cannot see is counted there but never named here.
   */
  projectIds: string[];
  totalImpactedSymbols: number;
  startedAt: string;
  completedAt: string | null;
  /**
   * Issue #965 (Epic #960) — the original run this run re-executes ("rerun-of"
   * lineage), or null for an original (first) run. Lets the list flag a re-run row
   * and link back to its parent. Original runs are immutable.
   */
  rerunOfId: string | null;
}

/**
 * Epic #954 (#956) — a physical table impacted in TWO OR MORE of the run's
 * selected projects. When a run spans 2+ projects, a table touched by ≥2 of
 * them is a "shared impact" the report flags at the run level (distinct from the
 * per-item cross-project CONSUMER dimension, which reports sibling projects that
 * were NOT selected in the run). Deterministic + derived — no persistence.
 */
export interface SharedTableImpact {
  /** Bare physical table name (schema-qualified prefix stripped for grouping). */
  tableName: string;
  /** The run's selected project ids whose items impacted this table (≥2, sorted). */
  projectIds: string[];
}

/** Full per-project breakdown for `GET /api/impact-analyses/:id`. */
export interface ImpactAnalysisDetail {
  id: string;
  status: ImpactAnalysisStatus;
  documentId: string | null;
  sourceText: string | null;
  summary: string | null;
  errorMessage: string | null;
  totalImpactedSymbols: number;
  startedAt: string;
  completedAt: string | null;
  /**
   * Distinct project ids covered by this run: the projects it was STARTED for
   * (`impact_analysis_projects`, persisted at creation — #70) followed by any
   * further projects its items name. Non-empty for every run created since #70,
   * which is what lets the read routes authorize a run that has no items yet.
   */
  projectIds: string[];
  /**
   * #88 — the actor who started the run. Load-bearing for authorization, not
   * display: a pre-#70 run with neither persisted projects nor items belongs to
   * no project the access filter can name, and its starter is then the only
   * non-admin principal who may still read it.
   */
  startedById: string;
  items: ImpactItemView[];
  /**
   * Epic #954 (#956) — tables impacted across ≥2 of the run's selected projects
   * ("shared impact"). Empty for single-project runs and for multi-project runs
   * with no overlapping table. Deterministically sorted by table name.
   */
  sharedTableImpacts: SharedTableImpact[];
  /**
   * Issue #965 (Epic #960) — the original run this run re-executes, or null for an
   * original run. Present so the detail view can render the drift diff (this run
   * vs its parent) and a "re-run of …" lineage crumb. Original runs are immutable.
   */
  rerunOfId: string | null;
}

// ---- Re-run + drift (#965) -------------------------------------------------

/**
 * Issue #965 (Epic #960) — per-requirement drift status when comparing a re-run
 * (head) against its original (base):
 *   - `added`     — the requirement produced impact in the head run but not the base.
 *   - `removed`   — it produced impact in the base run but not the head.
 *   - `changed`   — present in both, but its affected tables/symbols/confidence/
 *                   severity differ.
 *   - `unchanged` — present in both with byte-identical impact (excluded from the
 *                   report list; surfaced only in the roll-up counts).
 */
export const IMPACT_DRIFT_STATUSES = ["added", "removed", "changed", "unchanged"] as const;
export type ImpactDriftStatus = (typeof IMPACT_DRIFT_STATUSES)[number];

/** #965 — a single affected-table row whose relevance tier changed between runs. */
export interface ImpactDriftTierChange {
  /** Physical table name (or routine name) of the row. */
  tableName: string;
  /** Column name for a column-level row, else null (table/routine level). */
  columnName: string | null;
  /** Tier in the base run (null ⇒ primary/untiered). */
  fromTier: "likely" | "possible" | "unlikely" | null;
  /** Tier in the head run (null ⇒ primary/untiered). */
  toTier: "likely" | "possible" | "unlikely" | null;
}

/**
 * #965 — the drift of ONE requirement's impact between the base and head runs,
 * keyed on `requirementId` when present else a stable hash of the requirement
 * title (see the server differ). All list fields are deterministically sorted.
 */
export interface RequirementDrift {
  /** Stable per-(project, requirement) key the differ matched base↔head on. */
  key: string;
  projectId: string;
  requirementId: string | null;
  requirementTitle: string | null;
  status: ImpactDriftStatus;
  /** Affected-table identities present in head but not base (`table` / `table.column`). */
  tablesAdded: string[];
  /** Affected-table identities present in base but not head. */
  tablesRemoved: string[];
  /** Tables present in both whose relevance tier changed. */
  tablesTierChanged: ImpactDriftTierChange[];
  /** Affected code-symbol identities (`file::qualifiedName`) new in head. */
  symbolsAdded: string[];
  /** Affected code-symbol identities removed in head. */
  symbolsRemoved: string[];
  /** head.confidence − base.confidence (0 when either side is absent). */
  confidenceDelta: number;
  /** Non-null only when the item's severity changed between runs. */
  severityChanged: { from: ImpactItemView["severity"]; to: ImpactItemView["severity"] } | null;
}

/** #965 — roll-up counts across all requirement drifts (for the diff summary chips). */
export interface ImpactDriftSummary {
  requirementsAdded: number;
  requirementsRemoved: number;
  requirementsChanged: number;
  requirementsUnchanged: number;
  tablesAdded: number;
  tablesRemoved: number;
  symbolsAdded: number;
  symbolsRemoved: number;
}

/**
 * Issue #965 (Epic #960) — the deterministic drift report for `GET
 * /api/impact-analyses/:id/drift`: what changed between a re-run (head) and its
 * original (base). Computed as a PURE function over the two runs' PERSISTED rows —
 * the old run is never re-analyzed. An identical code graph ⇒ empty `requirements`
 * and all-zero `summary` (the determinism guarantee).
 */
export interface ImpactDriftReport {
  /** The head (re-run) analysis id. */
  headAnalysisId: string;
  /** The base (original) analysis id, or null when the run has no parent. */
  baseAnalysisId: string | null;
  /** Requirement drifts with an actual change (status ≠ `unchanged`), sorted. */
  requirements: RequirementDrift[];
  summary: ImpactDriftSummary;
}

/** Response returned immediately by `POST /api/impact-analyses`. */
export interface CreateImpactAnalysisResponse {
  id: string;
  status: ImpactAnalysisStatus;
  projectIds: string[];
}
