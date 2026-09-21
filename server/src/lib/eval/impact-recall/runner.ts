/**
 * Epic #929 / Issue #930 — Impact Analysis requirement→(code, tables) recall
 * eval runner.
 *
 * For each labeled requirement, drive the REAL impact engine
 * (`computeProjectImpact`) over the fixture: `mapRequirementToCode` (the injected
 * searcher's seed set) → `blastRadius` → the #928 `crossToSchema` code→table
 * crossing. The surfaced tables + code symbols are scored against the labels by
 * the pure {@link scoreRequirement}. The runner is pure orchestration over the
 * injected fixture pieces (no process.env reads, no network, no DB, no live LLM),
 * so the CI unit test, the self-test synthetic fixture, and the offline CLI drive
 * it identically and deterministically.
 *
 * Swapping the searcher (deterministic BM25 today vs a future
 * `LlmCodeSymbolSearcher`, #931) is a ONE-param change: {@link RunImpactRecallOptions.searcherKind}
 * (or an injected `searcher`). Everything downstream — engine, crossing, scoring
 * — is identical, so the Phase-2 lift is measured by changing exactly one thing.
 */
import {
  computeProjectImpact,
  type ComputeImpactDeps,
} from "../../impact-analysis/impact-analysis-engine.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import { mapRequirementToCode } from "../../traceability/requirement-code-mapping.js";
import type { CodeSymbolSearcher } from "../../traceability/requirement-code-mapping.js";
import {
  aggregateScores,
  scoreRequirement,
  type DimensionAggregate,
  type EvalAggregate,
  type RequirementScore,
} from "./scorer.js";
import {
  DEFAULT_IMPACT_RECALL_CORPUS,
  type FixtureRequirement,
  type ImpactRecallFixture,
} from "./fixture.js";
import type { MatchQuality } from "@metis/shared";

/**
 * Which code-symbol searcher seeds the mapping — the ONE knob Phase 2 flips.
 *
 * `entity-union` (#1002) is NOT a third seeder: it is the deterministic `bm25`
 * searcher with LLM-extracted, graph-grounded entity seeds APPENDED below it, so a
 * run measures the recall the union adds while every BM25 seed is still present at
 * an unchanged confidence.
 */
export type SearcherKind = "bm25" | "llm" | "entity-union";

export interface RunImpactRecallOptions {
  /** Directly inject a searcher (wins over `searcherKind`). Used by tests. */
  searcher?: CodeSymbolSearcher;
  /** `bm25` (default, deterministic) or `llm` (Phase 2 — requires `llmSearcherFactory`). */
  searcherKind?: SearcherKind;
  /** Factory for the future LLM searcher; only consulted when `searcherKind === "llm"`. */
  llmSearcherFactory?: (fixture: ImpactRecallFixture) => CodeSymbolSearcher;
  /**
   * #1002 — factory for the entity-seed RECALL UNION searcher; only consulted when
   * `searcherKind === "entity-union"`. Injected (the CLI wires the real provider) so
   * the runner itself stays free of env reads and network.
   */
  entitySeedSearcherFactory?: (fixture: ImpactRecallFixture) => CodeSymbolSearcher;
  /**
   * #922 DAO/mapper sibling expansion. Defaults to `true` — the impact engine's
   * own default — so the harness measures the SAME behaviour production runs.
   */
  expandDaoSiblings?: boolean;
  /** Drop surfaced tables below this confidence before scoring. Default 0 (count all). */
  minTableConfidence?: number;
  /** `mapRequirementToCode` topK. Default from the engine (10). */
  topK?: number;
  /** `mapRequirementToCode` minConfidence. Default from the engine (0.3). */
  minConfidence?: number;
  /**
   * #936 — the OUTPUT relevance filter to run after the crossing. When set, only
   * the filter's PRIMARY (likely+possible) tables are scored, so this measures the
   * precision lift from pruning tangential tables. Absent ⇒ the un-filtered
   * crossing is scored (today's baseline). Injected so the harness stays
   * deterministic (the CLI wires the real LLM filter for `--filter`).
   */
  tableRelevanceFilter?: ComputeImpactDeps["tableRelevanceFilter"];
  /**
   * #1029 — factory for the column-informed table-relevance RECOVERY judge, built
   * from the fixture (it needs the manifest table->columns catalog). When set, its
   * `possible`-tier picks are merged into the scored primary set, so this measures
   * the recall lift from recovering business-vocabulary misses. Absent ⇒ no recovery
   * (the pre-#1029 behaviour). Injected so the runner stays deterministic (the CLI
   * wires the real provider).
   */
  tableRecoveryJudgeFactory?: (
    fixture: ImpactRecallFixture,
  ) => ComputeImpactDeps["tableRecoveryJudge"];
  /**
   * #959 — the cross-project CONSUMER resolver: given a requirement and the tables
   * the crossing surfaced, return the OTHER project ids that also touch those
   * shared tables. This is the seam #955/#956 wire (identity reconciliation +
   * string-match rollup). ABSENT by default ⇒ `foundConsumers` is empty, which is
   * the HONEST pre-wiring baseline (consumer recall ~0). Injected — never derived
   * from the manifest's ground truth — so the baseline is not green-washed.
   */
  consumerResolver?: (args: {
    requirement: FixtureRequirement;
    foundTables: string[];
    /**
     * #956 — the fully-qualified code symbols the run surfaced, so the resolver
     * can identify + exclude the SOURCE project (an impact run reports OTHER
     * apps). Passed through from {@link observeRequirement}.
     */
    foundCodeSymbols: string[];
    fixture: ImpactRecallFixture;
  }) => string[] | Promise<string[]>;
}

/** Regression floors for the aggregate macro scores. Configurable per run. */
export interface ImpactRecallThresholds {
  tableRecall: number;
  tablePrecision: number;
  codeRecall: number;
  codePrecision: number;
  /**
   * #959 — cross-project consumer floors. Only checked when the aggregate carries
   * a consumer dimension (a cross-project corpus). Undefined ⇒ not asserted, so
   * single-project corpora add no consumer threshold rows (byte-identical report).
   */
  consumerRecall?: number;
  consumerPrecision?: number;
}

/**
 * Default floors — set BELOW the measured baseline on the committed fixture with
 * deliberate headroom so the eval fails only on a genuine regression, never on
 * BM25 tie-break noise. These are a STRUCTURAL REGRESSION GUARD, not an
 * aspirational target: the seeder/filter work (#931/#936) must drive precision UP
 * without regressing recall, and any such improvement can lift the floors.
 *
 * As of #939 the fixture is LAYERED (domain → service → web-action → mapper), so
 * these numbers reflect the real BM25 seed-pollution + downstream fan-out the
 * live-ingested project exhibits — NOT the artificially-clean mapper-only corpus
 * the pre-#939 fixture measured (whose optimistic tblR 1.00 / tblP 0.42 gave
 * false confidence, #939).
 *
 * #1002 added REQ-11 (the vocabulary-mismatch regression case), which deterministic
 * BM25 misses entirely, so the DEFAULT (bm25) baseline on the 11-requirement corpus
 * is **tblR 0.91, tblP 0.45, codeR 0.77, codeP 0.09**: recall is DOWN from the 10-req
 * 1.00 because the new case genuinely reproduces the defect, and macro precision is
 * UP only because a requirement that surfaces NOTHING scores a VACUOUS 1.00. The
 * floors below are deliberately UNCHANGED — they already carried headroom and still
 * clear, and moving them to flatter a known-missing case would defeat the guard.
 *
 * #1016 — THESE FLOORS DESCRIBE THE DETERMINISTIC-ONLY (`--no-filter`) DIAGNOSTIC,
 * NOT WHAT PRODUCTION SHIPS. See {@link PRODUCTION_IMPACT_RECALL_THRESHOLDS} for the
 * production-configuration floors, and {@link thresholdsFor} for the dispatch. The
 * two are kept apart on purpose: quoting the unfiltered `tablePrecision` as a
 * production gate is precisely the mistake #1016 exists to make impossible.
 *
 * #1016 also aligned the corpus to production's `path/File.java::Type::member`
 * qualified names (it used dotted `org.jpetstore…` names before). That is a
 * MEASUREMENT CORRECTION, not a behaviour change — the engine is untouched — and it
 * moved the deterministic numbers to **tblR 0.9091, tblP 0.4636, codeR 0.7273,
 * codeP 0.0847** (measured 2026-07-22). The only per-requirement move is REQ-10:
 * under production-shaped names the `Order` domain class scores `order` twice
 * (`domain/Order.java::Order`, name + qualified name) and outranks the tied
 * `OrderMapper` methods, pushing `insertOrder` from rank 10 to rank 11 — outside the
 * top-K. Table precision therefore rose (5 surfaced tables → 4) and code recall fell
 * (1.00 → 0.50 on that requirement). Every floor below still clears; none were
 * moved.
 */
export const DEFAULT_IMPACT_RECALL_THRESHOLDS: ImpactRecallThresholds = {
  // Measured baseline on the committed LAYERED fixture AFTER the #943 deterministic
  // seed-denoiser, stacked on #942 (BM25, 2026-07-19): tblR 1.00, tblP 0.40,
  // codeR 0.85, codeP 0.10 — up from the pre-#943 (post-#942) tblR 0.90 / tblP 0.40 /
  // codeR 0.75. #943 query stopword removal stops the requirement's rare-in-corpus
  // prose from displacing the entity mapper, so the REQ-01 pollution MISS is
  // recovered (recall 0.90 → 1.00) and code recall rises; MACRO table precision is
  // HELD at 0.40 (the per-requirement precision gains on the polluted reqs are offset
  // at the macro level by recovering REQ-01's previously-empty, vacuously-precise
  // result). The residual over-broad tables are caller-based FAN-OUT (the order
  // write-path), which the #936 output filter — not the seed lever — prunes. Floors
  // sit BELOW the measured values with headroom so a genuine regression fails while
  // BM25 tie-break noise does not; the recall floor was lifted 0.8 → 0.9 to LOCK IN
  // the #943 recall win.
  tableRecall: 0.9,
  tablePrecision: 0.35,
  codeRecall: 0.7,
  codePrecision: 0.05,
};

/**
 * #959 — regression floors for the CROSS-PROJECT corpus (`impact-recall-02-shared-db`):
 * a storefront + a reporting/batch app over one physical database sharing
 * `account`/`orders`, plus each app's private tables.
 *
 * Measured HONEST baseline (BM25, no LLM, NO consumer resolver — pre-#955/#956,
 * 2026-07-20): tblR 1.00, tblP 1.00, codeR 1.00, codeP 0.67, AND
 * **consumerRecall 0.00 / consumerPrecision 1.00**. The clean table numbers are by
 * design — corpus-02 is a small, deliberately UN-polluted graph whose job is to
 * isolate the cross-project consumer signal (corpus-01 already measures
 * seed-pollution realism). codeP 0.67 is the honest cost of DAO-sibling seeding:
 * `account`/`order` seed BOTH the get* and the update/insert* method of the mapper,
 * so the non-target read method surfaces as a WRONG code symbol on REQ-01/REQ-02.
 * The consumer numbers are the load-bearing baseline: the engine does not yet
 * surface shared-table consumers, so every consumer is MISSED (recall 0) and
 * precision is a VACUOUS 1.00 (nothing surfaced ⇒ nothing wrong).
 *
 * Per the #939 precedent, floors sit AT or BELOW the honest measured values —
 * never above. #956 LANDED the cross-project consumer wiring: an impact run
 * against the storefront now lists the reporting app as a consumer of the shared
 * `account`/`orders` tables. The CLI wires the consumer resolver (the #955/#956
 * seam) unconditionally, so the measured values on the committed fixture rose to
 * **consumerRecall 1.00 / consumerPrecision 1.00** (BM25, no LLM, 2026-07-20).
 * The floors are lifted from the pre-wiring 0 to 0.9 (with the same tie-break
 * headroom as the table/code floors) so a regression that stops surfacing a
 * shared-table consumer fails the guard, LOCKING IN the #956 lift.
 *
 * NOTE: the honest PRE-WIRING baseline — `runImpactRecallEval(fixture)` with NO
 * consumer resolver injected — still measures consumerRecall 0.00 and therefore
 * FAILS these lifted floors; that is the guard working. The CLI + the wired-seam
 * unit tests exercise the resolver and clear the floors.
 */
export const DEFAULT_IMPACT_RECALL_THRESHOLDS_SHARED_DB: ImpactRecallThresholds = {
  tableRecall: 0.9,
  tablePrecision: 0.9,
  codeRecall: 0.9,
  codePrecision: 0.5,
  consumerRecall: 0.9,
  consumerPrecision: 0.9,
};

/**
 * #1016 — regression floors for the corpus-01 PRODUCTION configuration: BM25 seeding
 * PLUS the #936 LLM table-relevance filter, i.e. `IMPACT_LLM_TABLE_FILTER=1`.
 *
 * THE RECORDED PRODUCTION BASELINE. Measured live against the committed corpus with
 * the real Anthropic provider (`AI_PROVIDER=anthropic`, `claude-sonnet-5`), 6 runs on
 * 2026-07-22:
 *
 *   tablePrecision  mean 0.7803  (per run 0.7727 0.7879 0.7576 0.7424 0.7879 0.8333)
 *   tableRecall     0.9091 on every run
 *   codeRecall      0.7273 on every run   (the filter prunes tables, not code)
 *   codePrecision   0.0847 on every run
 *
 * The same corpus with `--no-filter` measures tablePrecision **0.4636** — the number
 * the harness used to print by default, and the number a "must not drop below 0.40"
 * gate was derived from. That gate was ~0.32 too lenient for the configuration that
 * actually ships. Only the recall/precision dimensions the filter touches differ;
 * `tableRecall` is identical because the filter prunes, never adds.
 *
 * The `tablePrecision` floor sits at 0.65 — below the WORST observed run (0.7424)
 * with the same kind of headroom the deterministic floors carry, because the filter
 * is a live LLM call and the gate is checked against the MEAN of repeated runs
 * ({@link summarizeRuns}). The other three floors are the deterministic ones
 * unchanged: the filter does not touch code seeding, so their measured values are
 * identical in both configurations.
 */
export const PRODUCTION_IMPACT_RECALL_THRESHOLDS: ImpactRecallThresholds = {
  tableRecall: 0.9,
  tablePrecision: 0.65,
  codeRecall: 0.7,
  codePrecision: 0.05,
};

/** Per-corpus threshold table for the DETERMINISTIC-only configuration (#959). */
const THRESHOLDS_BY_CORPUS: Record<string, ImpactRecallThresholds> = {
  "impact-recall-01-jpetstore": DEFAULT_IMPACT_RECALL_THRESHOLDS,
  "impact-recall-02-shared-db": DEFAULT_IMPACT_RECALL_THRESHOLDS_SHARED_DB,
};

/**
 * #1016 — per-corpus floors for the PRODUCTION configuration. A corpus absent here
 * has no separately-measured production baseline and falls back to the
 * deterministic floors, which are strictly no HIGHER (the filter only prunes), so
 * the fallback can never green-wash.
 */
const PRODUCTION_THRESHOLDS_BY_CORPUS: Record<string, ImpactRecallThresholds> = {
  "impact-recall-01-jpetstore": PRODUCTION_IMPACT_RECALL_THRESHOLDS,
};

/**
 * Resolve the regression floors for a corpus name (#959). Unknown corpora fall
 * back to the default single-project floors so a new corpus without tuned floors
 * still runs (and is guarded by the default table/code floors).
 *
 * This returns the DETERMINISTIC-configuration floors. Callers that know which
 * configuration produced their numbers should use {@link thresholdsFor}.
 */
export function thresholdsForCorpus(name: string): ImpactRecallThresholds {
  return THRESHOLDS_BY_CORPUS[name] ?? DEFAULT_IMPACT_RECALL_THRESHOLDS;
}

/**
 * #1016 — resolve floors for a corpus AND the configuration that produced the
 * numbers. Checking production numbers against the unfiltered floors (or the
 * reverse) is the class of mistake this whole issue is about, so the configuration
 * is a required input rather than an assumed default.
 */
export function thresholdsFor(
  name: string,
  configuration: ImpactRecallConfiguration,
): ImpactRecallThresholds {
  if (!configuration.isProductionConfiguration) return thresholdsForCorpus(name);
  return PRODUCTION_THRESHOLDS_BY_CORPUS[name] ?? thresholdsForCorpus(name);
}

/**
 * Parse `--corpus <name>` from an argv slice (#959), defaulting to the
 * single-project corpus. Kept here (unit-tested) so the thin CLI script only
 * wires it.
 */
export function parseCorpusName(argv: string[]): string {
  const i = argv.indexOf("--corpus");
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : DEFAULT_IMPACT_RECALL_CORPUS;
}

/**
 * #1016 — parse the #936 output relevance filter flag. It is ON BY DEFAULT because
 * production runs `IMPACT_LLM_TABLE_FILTER=1`; `--no-filter` opts out to isolate
 * deterministic behaviour. `--filter` remains accepted (and redundant) so existing
 * invocations keep working.
 *
 * Kept here, beside {@link parseCorpusName}, so the thin CLI only wires it and the
 * default-flip is unit-tested.
 */
export function parseTableFilterEnabled(argv: string[]): boolean {
  return !argv.includes("--no-filter");
}

/**
 * #1016 — parse `--runs <n>`. Defaults to 3 when the LLM filter is active, because
 * the filter is a live model call and a single sample cannot gate a
 * non-deterministic pipeline; 1 when the run is fully deterministic and repeats
 * would be byte-identical.
 */
export function parseRunCount(argv: string[], filterEnabled: boolean): number {
  const i = argv.indexOf("--runs");
  const raw = i >= 0 ? Number(argv[i + 1]) : NaN;
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return filterEnabled ? 3 : 1;
}

export interface ThresholdCheck {
  metric: keyof ImpactRecallThresholds;
  floor: number;
  value: number;
  passed: boolean;
}

// ── Configuration identity (#1016) ──────────────────────────────────────────

/**
 * #1016 — WHICH configuration a set of numbers describes.
 *
 * Until #1016 the harness defaulted to the #936 table-relevance filter OFF while
 * production runs it ON (`IMPACT_LLM_TABLE_FILTER=1`), and nothing in the output
 * said so. A macro table precision of 0.40 (filter off) was therefore quoted as a
 * regression floor for work that ships at ≈0.745 (filter on) — a gate ~0.345 too
 * lenient, set in good faith from a number that looked authoritative. Every report
 * now names its configuration so a stray figure can never again be mistaken for
 * the production baseline.
 */
export interface ImpactRecallConfiguration {
  searcher: SearcherKind;
  /** The #936 output relevance filter: `llm` (what production runs) or `off`. */
  tableFilter: "llm" | "off";
  /** True when this is exactly the configuration production ships. */
  isProductionConfiguration: boolean;
  /** Short human label for reports, e.g. `PRODUCTION (bm25 + LLM table filter)`. */
  label: string;
}

/**
 * The configuration production ships for the corpus-01 code path: deterministic
 * BM25 seeding (`IMPACT_LLM_ENTITY_SEEDS` defaults OFF) with the #936 LLM output
 * relevance filter ON (`IMPACT_LLM_TABLE_FILTER=1`).
 */
export const PRODUCTION_SEARCHER: SearcherKind = "bm25";
export const PRODUCTION_TABLE_FILTER = "llm" as const;

/** Derive the configuration identity from the resolved run options. Pure. */
export function describeConfiguration(opts: RunImpactRecallOptions): ImpactRecallConfiguration {
  const searcher: SearcherKind = opts.searcher ? "bm25" : (opts.searcherKind ?? "bm25");
  const tableFilter = opts.tableRelevanceFilter ? "llm" : "off";
  const isProductionConfiguration =
    searcher === PRODUCTION_SEARCHER && tableFilter === PRODUCTION_TABLE_FILTER;
  const label = isProductionConfiguration
    ? "PRODUCTION (bm25 seeding + #936 LLM table-relevance filter, IMPACT_LLM_TABLE_FILTER=1)"
    : `NON-PRODUCTION (searcher=${searcher}, table filter=${tableFilter})` +
      (tableFilter === "off"
        ? " — deterministic-only diagnostic; production runs the filter ON, so these numbers are NOT the shipped baseline"
        : "");
  return { searcher, tableFilter, isProductionConfiguration, label };
}

export interface ImpactRecallResult {
  fixtureId: string;
  searcherKind: SearcherKind;
  /** #1016 — which configuration produced these numbers. */
  configuration: ImpactRecallConfiguration;
  scores: RequirementScore[];
  aggregate: EvalAggregate;
  /**
   * #961 — per-requirement match quality (`strong`/`moderate`/`weak`), keyed by
   * requirement id. Reported so threshold drift in {@link deriveMatchQuality} is
   * visible run-over-run; it is NOT scored, so the recall/precision aggregates are
   * unaffected (corpus-01 metrics stay unchanged).
   */
  matchQualities: Record<string, MatchQuality>;
}

/** Turn a labeled requirement into a single `ChangedRequirement`. */
export function requirementToChange(r: FixtureRequirement): ChangedRequirement {
  return {
    requirementId: r.id,
    title: r.text,
    body: r.text,
    changeType: "added",
    bodyDelta: r.text.length,
  };
}

/**
 * Resolve the searcher for a run. `bm25` (default) returns the fixture's real
 * BM25 searcher; `llm` requires an injected factory (the Phase-2 seam, #931) and
 * throws a clear error otherwise so a mis-configured run never silently falls
 * back to BM25 and masks the comparison.
 */
export function resolveSearcher(
  fixture: ImpactRecallFixture,
  opts: RunImpactRecallOptions,
): CodeSymbolSearcher {
  if (opts.searcher) return opts.searcher;
  const kind = opts.searcherKind ?? "bm25";
  if (kind === "bm25") return fixture.searcher;
  if (kind === "entity-union") {
    if (opts.entitySeedSearcherFactory) return opts.entitySeedSearcherFactory(fixture);
    throw new Error(
      "Entity-seed union searcher requires an entitySeedSearcherFactory (#1002). Pass " +
        "searcherKind:'bm25' or inject one to measure the recall union.",
    );
  }
  if (opts.llmSearcherFactory) return opts.llmSearcherFactory(fixture);
  throw new Error(
    "LLM code-symbol searcher is not wired yet (Phase 2 / #931). Pass searcherKind:'bm25' " +
      "or inject an llmSearcherFactory to measure the LLM lift.",
  );
}

/** Run the impact engine for ONE requirement and return its surfaced sets. */
export async function observeRequirement(
  fixture: ImpactRecallFixture,
  requirement: FixtureRequirement,
  searcher: CodeSymbolSearcher,
  opts: RunImpactRecallOptions,
): Promise<{ foundTables: string[]; foundCodeSymbols: string[]; matchQuality: MatchQuality }> {
  const impact = await computeProjectImpact(requirementToChange(requirement), fixture.projectId, {
    mapRequirement: (req, projectId) =>
      mapRequirementToCode(
        req,
        projectId,
        { topK: opts.topK, minConfidence: opts.minConfidence },
        { searcher },
      ),
    dataSourceFor: () => fixture.codeDataSource,
    schemaDataSourceFor: () => fixture.schemaDataSource,
    includeSchemaImpact: true,
    expandDaoSiblings: opts.expandDaoSiblings ?? true,
    // #936 — when wired, only the filter's PRIMARY set lands in `affectedTables`,
    // so the scored precision reflects the pruning of tangential tables.
    tableRelevanceFilter: opts.tableRelevanceFilter,
    // #1029 — the recovery judge (built from the fixture catalog) merges its
    // `possible`-tier picks into the primary set, so a recovered miss is scored.
    tableRecoveryJudge: opts.tableRecoveryJudgeFactory?.(fixture),
  });

  const minConf = opts.minTableConfidence ?? 0;
  const foundTables = impact.affectedTables
    .filter((t) => t.objectKind === "table" && t.confidence >= minConf)
    .map((t) => t.tableName);
  const foundCodeSymbols = impact.affectedSymbols.map((s) => s.qualifiedName);
  // #961 — report the requirement→code match quality alongside the scored sets so
  // threshold drift is visible per requirement. It does NOT feed the scorer, so
  // corpus-01's recall/precision aggregates stay byte-identical.
  return { foundTables, foundCodeSymbols, matchQuality: impact.matchQuality };
}

/** Run the full eval across every fixture requirement and aggregate the scores. */
export async function runImpactRecallEval(
  fixture: ImpactRecallFixture,
  opts: RunImpactRecallOptions = {},
): Promise<ImpactRecallResult> {
  const searcher = resolveSearcher(fixture, opts);
  const searcherKind: SearcherKind = opts.searcher ? "bm25" : (opts.searcherKind ?? "bm25");

  const scores: RequirementScore[] = [];
  const matchQualities: Record<string, MatchQuality> = {};
  for (const r of fixture.requirements) {
    const { foundTables, foundCodeSymbols, matchQuality } = await observeRequirement(
      fixture,
      r,
      searcher,
      opts,
    );
    matchQualities[r.id] = matchQuality;
    // #959 — consumers are resolved ONLY when a resolver is injected (#955/#956);
    // by default the surfaced set is empty, the honest pre-wiring baseline. The
    // scorer is consumer-scored only when the requirement DECLARES the label, so
    // passing an empty array through for single-project corpora is inert.
    const foundConsumers =
      r.expectedConsumers !== undefined && opts.consumerResolver
        ? await opts.consumerResolver({ requirement: r, foundTables, foundCodeSymbols, fixture })
        : [];
    scores.push(
      scoreRequirement({
        id: r.id,
        text: r.text,
        expectedTables: r.expectedTables,
        expectedCodeSymbols: r.expectedCodeSymbols,
        expectedConsumers: r.expectedConsumers,
        foundTables,
        foundCodeSymbols,
        foundConsumers,
      }),
    );
  }

  return {
    fixtureId: fixture.manifest.id,
    searcherKind,
    configuration: describeConfiguration(opts),
    scores,
    aggregate: aggregateScores(scores),
    matchQualities,
  };
}

// ── Multi-run measurement (#1016) ───────────────────────────────────────────

/** Per-metric spread across repeated runs. */
export interface MetricSpread {
  values: number[];
  mean: number;
  min: number;
  max: number;
}

/** Aggregated view of N repeated runs of the SAME configuration. */
export interface ImpactRecallRunSummary {
  runCount: number;
  configuration: ImpactRecallConfiguration;
  /** Every run, in order. `runs[0]` supplies the per-requirement detail in reports. */
  runs: ImpactRecallResult[];
  /**
   * Mean-of-runs aggregate. Thresholds are checked against THIS, not a single run:
   * the #936 filter is an LLM call and therefore non-deterministic, so one run is
   * not a valid gate.
   */
  meanAggregate: EvalAggregate;
  spreads: Partial<Record<keyof ImpactRecallThresholds, MetricSpread>>;
  /**
   * ABSOLUTE surfaced-table count per requirement, one entry per run. Precision is
   * a ratio and hides magnitude — "0.75 precision" over 4 tables and over 40 tables
   * are very different answers for a business analyst.
   */
  surfacedTableCounts: Record<string, number[]>;
}

function spreadOf(values: number[]): MetricSpread {
  return {
    values,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function meanDimension(dims: DimensionAggregate[]): DimensionAggregate {
  const mean = (pick: (d: DimensionAggregate) => number): number =>
    dims.reduce((sum, d) => sum + pick(d), 0) / dims.length;
  return {
    labeledCount: dims[0].labeledCount,
    macroRecall: mean((d) => d.macroRecall),
    macroPrecision: mean((d) => d.macroPrecision),
    microRecall: mean((d) => d.microRecall),
    microPrecision: mean((d) => d.microPrecision),
    hitRate: mean((d) => d.hitRate),
  };
}

/**
 * Fold N runs of one configuration into a mean aggregate + per-metric spread. Pure,
 * so the CLI and the unit tests agree on what "the number" is.
 */
export function summarizeRuns(runs: ImpactRecallResult[]): ImpactRecallRunSummary {
  if (runs.length === 0) throw new Error("summarizeRuns requires at least one run");
  const codeDims = runs.map((r) => r.aggregate.code).filter((c): c is DimensionAggregate => !!c);
  const consumerDims = runs
    .map((r) => r.aggregate.consumers)
    .filter((c): c is DimensionAggregate => !!c);

  const meanAggregate: EvalAggregate = {
    requirementCount: runs[0].aggregate.requirementCount,
    tables: meanDimension(runs.map((r) => r.aggregate.tables)),
    code: codeDims.length > 0 ? meanDimension(codeDims) : null,
  };
  if (consumerDims.length > 0) meanAggregate.consumers = meanDimension(consumerDims);

  const spreads: ImpactRecallRunSummary["spreads"] = {
    tableRecall: spreadOf(runs.map((r) => r.aggregate.tables.macroRecall)),
    tablePrecision: spreadOf(runs.map((r) => r.aggregate.tables.macroPrecision)),
  };
  if (codeDims.length > 0) {
    spreads.codeRecall = spreadOf(codeDims.map((d) => d.macroRecall));
    spreads.codePrecision = spreadOf(codeDims.map((d) => d.macroPrecision));
  }
  if (consumerDims.length > 0) {
    spreads.consumerRecall = spreadOf(consumerDims.map((d) => d.macroRecall));
    spreads.consumerPrecision = spreadOf(consumerDims.map((d) => d.macroPrecision));
  }

  const surfacedTableCounts: Record<string, number[]> = {};
  for (const run of runs) {
    for (const score of run.scores) {
      (surfacedTableCounts[score.id] ??= []).push(score.tables.found.length);
    }
  }

  return {
    runCount: runs.length,
    configuration: runs[0].configuration,
    runs,
    meanAggregate,
    spreads,
    surfacedTableCounts,
  };
}

/**
 * Run the eval `runCount` times under ONE configuration and summarize. Runs are
 * sequential so a live-LLM configuration does not fan out concurrent provider
 * calls.
 */
export async function runImpactRecallEvalRepeated(
  fixture: ImpactRecallFixture,
  opts: RunImpactRecallOptions = {},
  runCount = 1,
): Promise<ImpactRecallRunSummary> {
  const n = Math.max(1, Math.floor(runCount));
  const runs: ImpactRecallResult[] = [];
  for (let i = 0; i < n; i += 1) runs.push(await runImpactRecallEval(fixture, opts));
  return summarizeRuns(runs);
}

/**
 * Compare an aggregate against the regression floors. Pure — returns a per-metric
 * breakdown and an overall pass so the CI test and the CLI agree on exactly what
 * "regressed" means. A dimension with no labels (e.g. code, if unlabeled) passes
 * its checks vacuously.
 */
export function checkThresholds(
  aggregate: EvalAggregate,
  thresholds: ImpactRecallThresholds = DEFAULT_IMPACT_RECALL_THRESHOLDS,
): { passed: boolean; checks: ThresholdCheck[] } {
  const rows: Array<Pick<ThresholdCheck, "metric" | "floor" | "value">> = [
    { metric: "tableRecall", floor: thresholds.tableRecall, value: aggregate.tables.macroRecall },
    {
      metric: "tablePrecision",
      floor: thresholds.tablePrecision,
      value: aggregate.tables.macroPrecision,
    },
    { metric: "codeRecall", floor: thresholds.codeRecall, value: aggregate.code?.macroRecall ?? 1 },
    {
      metric: "codePrecision",
      floor: thresholds.codePrecision,
      value: aggregate.code?.macroPrecision ?? 1,
    },
  ];
  // #959 — consumer rows are added ONLY for a cross-project corpus (aggregate has a
  // consumer dimension) AND when the thresholds declare consumer floors. This keeps
  // the single-project check output byte-identical to the pre-#959 four-row shape.
  if (aggregate.consumers && thresholds.consumerRecall !== undefined) {
    rows.push({
      metric: "consumerRecall",
      floor: thresholds.consumerRecall,
      value: aggregate.consumers.macroRecall,
    });
  }
  if (aggregate.consumers && thresholds.consumerPrecision !== undefined) {
    rows.push({
      metric: "consumerPrecision",
      floor: thresholds.consumerPrecision,
      value: aggregate.consumers.macroPrecision,
    });
  }
  const checks: ThresholdCheck[] = rows.map((c) => ({ ...c, passed: c.value >= c.floor }));
  return { passed: checks.every((c) => c.passed), checks };
}

// ── Rendering (machine- + human-readable) ───────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The machine-readable (JSON-serializable) result shape written to disk. */
export function toJsonReport(
  result: ImpactRecallResult,
  thresholds: ImpactRecallThresholds = DEFAULT_IMPACT_RECALL_THRESHOLDS,
  summary?: ImpactRecallRunSummary,
): Record<string, unknown> {
  // #1016 — when repeated runs were made, the gated aggregate is the MEAN, not one
  // sample of a non-deterministic LLM configuration.
  const gated = summary?.meanAggregate ?? result.aggregate;
  const { passed, checks } = checkThresholds(gated, thresholds);
  return {
    kind: "impact-analysis-recall",
    fixture: result.fixtureId,
    searcher: result.searcherKind,
    // #1016 — WHICH configuration these numbers describe. Never omit: a number
    // without its configuration is how the 0.40-vs-0.745 mix-up happened.
    configuration: result.configuration,
    runCount: summary?.runCount ?? 1,
    ...(summary
      ? { spreads: summary.spreads, surfacedTableCounts: summary.surfacedTableCounts }
      : {}),
    passed,
    thresholds: checks,
    aggregate: gated,
    ...(summary ? { perRunAggregates: summary.runs.map((r) => r.aggregate) } : {}),
    requirements: result.scores.map((s) => ({
      id: s.id,
      text: s.text,
      tables: s.tables,
      code: s.code,
      // #961 — report the (unscored) requirement→code match quality so threshold
      // drift is visible; the scored recall/precision fields above are unchanged.
      matchQuality: result.matchQualities[s.id],
      // #959 — emit the consumer score only when the requirement was consumer-
      // scored, so single-project requirements serialize exactly as before.
      ...(s.consumers ? { consumers: s.consumers } : {}),
    })),
    commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
  };
}

/** Render a human-readable Markdown report so before/after runs diff cleanly. */
export function toMarkdownReport(
  result: ImpactRecallResult,
  thresholds: ImpactRecallThresholds = DEFAULT_IMPACT_RECALL_THRESHOLDS,
  summary?: ImpactRecallRunSummary,
): string {
  const aggregate = summary?.meanAggregate ?? result.aggregate;
  const { passed, checks } = checkThresholds(aggregate, thresholds);
  const cfg = result.configuration;
  const lines: string[] = [];
  lines.push(`# Impact Analysis recall eval — \`${result.fixtureId}\``);
  lines.push("");
  // #1016 — the configuration is the FIRST thing a reader sees, because a number
  // quoted without it was how a 0.40 (filter OFF) floor got applied to work that
  // ships at ≈0.745 (filter ON).
  lines.push(`## Configuration — ${cfg.label}`);
  lines.push("");
  lines.push(
    `Searcher: **${cfg.searcher}** · Table relevance filter (#936): **${cfg.tableFilter}** · ` +
      `Runs: **${summary?.runCount ?? 1}** · Requirements: **${aggregate.requirementCount}** · ` +
      `Result: **${passed ? "PASS" : "FAIL"}**`,
  );
  lines.push("");
  if (!cfg.isProductionConfiguration) {
    lines.push(
      "> ⚠️ **These numbers do NOT describe the shipped configuration.** Production runs " +
        "`IMPACT_LLM_TABLE_FILTER=1` (the #936 output relevance filter). Do not quote this run " +
        "as a baseline or derive a regression floor from it — run `pnpm eval:impact-recall` " +
        "with its defaults for that.",
    );
    lines.push("");
  }
  if (summary && summary.runCount > 1) {
    lines.push("## Spread across runs");
    lines.push("");
    lines.push("| Metric | Mean | Min | Max | Per-run |");
    lines.push("|--------|------|-----|-----|---------|");
    for (const [metric, spread] of Object.entries(summary.spreads)) {
      if (!spread) continue;
      lines.push(
        `| ${metric} | ${spread.mean.toFixed(4)} | ${spread.min.toFixed(4)} | ${spread.max.toFixed(4)} | ` +
          `${spread.values.map((v) => v.toFixed(4)).join(", ")} |`,
      );
    }
    lines.push("");
    lines.push(
      "> The gated value is the **mean** — the #936 filter is an LLM call, so a single run " +
        "is not a valid gate.",
    );
    lines.push("");
  }
  lines.push("## Per-requirement");
  lines.push("");
  lines.push(
    "| Req | Text | Match | Tbl found (n) | Tbl recall | Tbl prec | HIT | WRONG (over-broad) | MISS | Code recall | Code prec |",
  );
  lines.push(
    "|-----|------|-------|---------------|-----------|----------|-----|--------------------|------|-------------|-----------|",
  );
  for (const s of result.scores) {
    const t = s.tables;
    // #961 — match-quality column (unscored) surfaces threshold drift per requirement.
    const mq = result.matchQualities[s.id] ?? "n/a";
    // #1016 — the ABSOLUTE surfaced-table count beside the ratio: precision alone
    // cannot distinguish "3 tables, 2 right" from "30 tables, 20 right".
    const counts = summary?.surfacedTableCounts[s.id] ?? [t.found.length];
    const countCell =
      counts.length > 1 ? `${counts.join(", ")} (mean ${mean(counts).toFixed(1)})` : `${counts[0]}`;
    lines.push(
      `| ${s.id} | ${s.text} | ${mq} | ${countCell} | ${pct(t.recall)} | ${pct(t.precision)} | ${t.hit.join(", ") || "—"} | ${t.wrong.join(", ") || "—"} | ${t.miss.join(", ") || "—"} | ${s.code ? pct(s.code.recall) : "n/a"} | ${s.code ? pct(s.code.precision) : "n/a"} |`,
    );
  }
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push(
    "| Dimension | Macro recall | Macro precision | Micro recall | Micro precision | Hit rate |",
  );
  lines.push(
    "|-----------|--------------|-----------------|--------------|-----------------|----------|",
  );
  const td = aggregate.tables;
  lines.push(
    `| Tables | ${pct(td.macroRecall)} | ${pct(td.macroPrecision)} | ${pct(td.microRecall)} | ${pct(td.microPrecision)} | ${pct(td.hitRate)} |`,
  );
  if (aggregate.code) {
    const cd = aggregate.code;
    lines.push(
      `| Code   | ${pct(cd.macroRecall)} | ${pct(cd.macroPrecision)} | ${pct(cd.microRecall)} | ${pct(cd.microPrecision)} | ${pct(cd.hitRate)} |`,
    );
  }
  // #959 — the consumer row appears only for a cross-project corpus, so a
  // single-project report is byte-identical to the pre-#959 rendering.
  if (aggregate.consumers) {
    const co = aggregate.consumers;
    lines.push(
      `| Consumers | ${pct(co.macroRecall)} | ${pct(co.macroPrecision)} | ${pct(co.microRecall)} | ${pct(co.microPrecision)} | ${pct(co.hitRate)} |`,
    );
  }
  lines.push("");
  lines.push("## Thresholds");
  lines.push("");
  for (const c of checks) {
    lines.push(
      `- ${c.passed ? "✅" : "❌"} \`${c.metric}\` ${pct(c.value)} (floor ${pct(c.floor)})`,
    );
  }
  lines.push("");
  lines.push("## Baseline note");
  lines.push("");
  // #959 — the note is corpus-specific. The single-project (corpus-01) text is kept
  // BYTE-IDENTICAL; the cross-project corpus surfaces its own consumer baseline.
  if (aggregate.consumers) {
    lines.push(
      "> **Honest CROSS-PROJECT baseline (#959, BM25, no LLM, NO consumer resolver — " +
        `pre-#955/#956): tblR ${td.macroRecall.toFixed(2)}, tblP ${td.macroPrecision.toFixed(2)}, ` +
        `consumerR ${aggregate.consumers.macroRecall.toFixed(2)}, consumerP ` +
        `${aggregate.consumers.macroPrecision.toFixed(2)}.** The storefront + reporting apps ` +
        "share `account`/`orders` over one database, but the impact engine does NOT yet " +
        "surface cross-project consumers, so every consumer is MISSED (recall 0.00) and " +
        "precision is a VACUOUS 1.00 (nothing surfaced ⇒ nothing wrong). This is the " +
        "yardstick: when #955 (identity reconciliation) and #956 (consumers in impact " +
        "results) land, the SAME run must show consumer recall climb — the lift is measured, " +
        "not asserted. Floors sit at/below these values (#939 precedent), never above.",
    );
  } else {
    // #1016 — the recorded PRODUCTION baseline comes first, so a reader who stops
    // after one paragraph takes away the number that actually ships.
    lines.push(
      "> **#1016 — RECORDED PRODUCTION BASELINE (bm25 + #936 LLM table filter, i.e. " +
        "`IMPACT_LLM_TABLE_FILTER=1`; live Anthropic `claude-sonnet-5`, 6 runs, " +
        "2026-07-22): tblP mean 0.7803 (0.7424–0.8333), tblR 0.9091, codeR 0.7273, " +
        "codeP 0.0847.** The SAME corpus with `--no-filter` measures tblP **0.4636**. " +
        "Until #1016 the harness printed the 0.4636-shaped number BY DEFAULT and named " +
        'no configuration, and a regression gate of *"must not drop below 0.40"* was ' +
        "derived from it — roughly 0.32 too lenient for the configuration that ships. " +
        "Any figure quoted from this harness must carry its configuration; the " +
        "unfiltered numbers below are a deterministic DIAGNOSTIC, not the baseline.",
    );
    lines.push("");
    lines.push(
      "> **Deterministic (`--no-filter`) diagnostic baseline on the LAYERED fixture " +
        "(post-#943 seed denoiser, stacked on #942, BM25): tblR 0.9091, tblP 0.4636, " +
        "codeR 0.7273, codeP 0.0847** (re-measured 2026-07-22 after #1016 aligned the " +
        "corpus to production's `path/File.java::Type::member` qualified names; the " +
        "engine is unchanged, so the move from the pre-#1016 tblP 0.4545 / codeR 0.7727 " +
        "is a MEASUREMENT CORRECTION, not a behaviour regression).",
    );
    lines.push("");
    lines.push(
      "> **Historical note — the PRE-#1016 corpus (dotted `org.jpetstore…` names), " +
        "retained for provenance. These numbers are superseded: (post-#943 deterministic seed " +
        "denoiser, stacked on #942, BM25, 2026-07-19): tblR 1.00, tblP 0.40, codeR 0.85, " +
        "codeP 0.10** (up from the pre-#943/post-#942 tblR 0.90 / tblP 0.40 / codeR 0.75). " +
        "The fixture models the full domain → service → web-action → mapper layering, so " +
        "plain BM25 corpus-IDF let the requirement's rare-in-corpus PROSE (`add…to`, " +
        '`status`, `flag`) out-rank the entity mapper — e.g. "Add a discontinued flag to ' +
        'product" MISSED `product`. #943 strips English function words + generic ' +
        "CRUD/attribute boilerplate from the QUERY so the entity nouns anchor the seed: " +
        "`product` is recovered (recall 0.90 → 1.00), code recall rises (0.75 → 0.85), and " +
        "per-requirement precision improves on the polluted reqs — while MACRO table " +
        "precision is HELD at 0.40 (recovering REQ-01's previously-empty, vacuously-precise " +
        "result trades macro precision for the recovered recall). The RESIDUAL over-broad " +
        'tables (e.g. "Compute the checkout total" still surfacing account/orderstatus/' +
        "sequence) are caller-based FAN-OUT over the order write-path — which the #936 " +
        "output relevance filter (not the seed lever) must prune without regressing recall.",
    );
    lines.push("");
    lines.push(
      "> **#1002 — REQ-11 is the VOCABULARY-MISMATCH regression case** (a loyalty " +
        "requirement naming the account entity only as \"the shopper's saved billing and " +
        'delivery details" and the order entity only as "a purchase"). Deterministic BM25 ' +
        "MISSES both expected tables, taking the 11-requirement baseline to tblR 0.91 / " +
        "tblP 0.45 / codeR 0.77 / codeP 0.09 — where the macro precision RISE is a VACUOUS " +
        "1.00 for surfacing nothing, not a win. `--searcher entity-union` unions " +
        "graph-grounded LLM entity seeds BELOW the deterministic ones and recovers it " +
        "(measured live, Anthropic, 2026-07-22: tblR 1.00 / tblP 0.39 / codeR 0.86 / codeP " +
        "0.11), with the surfaced sets of the other TEN requirements byte-identical. The " +
        "macro precision move is entirely REQ-11 trading its vacuous 1.00 for a real 0.29; " +
        "it is nonetheless BELOW the 0.40 ten-requirement baseline, which is why " +
        "`IMPACT_LLM_ENTITY_SEEDS` ships DEFAULT OFF. (The figures in this paragraph were " +
        "measured on the PRE-#1016 dotted corpus and with the table filter OFF.)",
    );
  }
  lines.push("");
  return lines.join("\n");
}
