/**
 * Epic #929 / Issue #930 — `pnpm eval:impact-recall` entrypoint.
 *
 * Runs the REAL Impact Analysis engine (`computeProjectImpact` + the #928
 * code→table crossing) over a committed corpus and reports requirement→(code,
 * tables) recall AND precision.
 *
 * ── WHICH CONFIGURATION THIS MEASURES (#1016) ───────────────────────────────
 *
 * **By default this harness measures the PRODUCTION configuration**: deterministic
 * BM25 seeding plus the #936 LLM table-relevance filter over the crossing output,
 * i.e. what a deployment running `IMPACT_LLM_TABLE_FILTER=1` actually does.
 *
 * It did not always. Until #1016 the filter was an opt-in `--filter` flag that
 * defaulted OFF, so the default number described a configuration nobody ships:
 *
 *   | Configuration                        | Macro table precision |
 *   |--------------------------------------|-----------------------|
 *   | old harness default (filter OFF)     | ≈0.40                 |
 *   | production (`IMPACT_LLM_TABLE_FILTER=1`) | ≈0.745             |
 *
 * A "must not drop below 0.40" regression gate was set from the unfiltered number
 * and was therefore ~0.345 too lenient. A harness that measures a configuration
 * nobody ships is worse than no harness: it emits confident wrong numbers that then
 * gate decisions. Every report now NAMES its configuration, and the non-production
 * path is labelled as such in the output.
 *
 * Because the filter is a live LLM call, the default is **3 runs with the spread
 * reported** and the thresholds are checked against the MEAN — a single sample of a
 * non-deterministic pipeline is not a valid gate.
 *
 *   pnpm eval:impact-recall                 # PRODUCTION config, 3 runs, gated on the mean
 *   pnpm eval:impact-recall --no-filter     # deterministic-only diagnostic (NOT the baseline)
 *   pnpm eval:impact-recall --runs 5        # more samples
 *   pnpm eval:impact-recall --no-fail       # always exit 0 (local exploration)
 *   pnpm eval:impact-recall --md            # also print the Markdown report
 *   pnpm eval:impact-recall --searcher llm  # measure the #931 LLM seeder lift
 *   pnpm eval:impact-recall --searcher entity-union  # measure the #1002 recall UNION
 *   pnpm eval:impact-recall --corpus impact-recall-02-shared-db  # the #959 cross-project corpus
 *
 * The production configuration needs a live provider, e.g.
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=… pnpm eval:impact-recall --md
 * With an offline-stub provider the #936 filter degrades to a deterministic
 * passthrough — which would silently produce UNFILTERED numbers under a
 * "production" label, the exact failure #1016 exists to prevent. The run therefore
 * FAILS LOUD instead; use `--no-filter` to measure the deterministic path on
 * purpose.
 *
 * `--corpus <name>` (#959) selects a registered corpus (default
 * `impact-recall-01-jpetstore`). The cross-project `impact-recall-02-shared-db`
 * corpus also reports CONSUMER recall/precision.
 *
 * The corpus is checked against the qualified-name convention the ingest emitters
 * actually produce before anything is measured (#1016,
 * `src/lib/eval/impact-recall/name-convention.ts`) — a corpus modelling a different
 * world fails loudly rather than quietly reporting numbers for it.
 *
 * This file is thin orchestration; all logic lives in the unit-tested
 * `src/lib/eval/impact-recall/*` modules. It is CI-wireable but GUARDED (opt-in),
 * so it never blocks unrelated PRs.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureEntityVocabulary,
  fixtureTableCatalog,
  loadImpactRecallFixture,
  resolveCorpusDir,
  resolveFixtureConsumers,
} from "../src/lib/eval/impact-recall/fixture.js";
import {
  checkThresholds,
  describeConfiguration,
  parseCorpusName,
  parseRunCount,
  parseTableFilterEnabled,
  runImpactRecallEvalRepeated,
  thresholdsFor,
  toJsonReport,
  toMarkdownReport,
  type RunImpactRecallOptions,
  type SearcherKind,
} from "../src/lib/eval/impact-recall/runner.js";
import { LlmCodeSymbolSearcher } from "../src/lib/traceability/requirement-code-mapping.js";
import { EntitySeedUnionSearcher } from "../src/lib/traceability/requirement-entity-seeds.js";
import { filterAffectedTablesByRelevance } from "../src/lib/impact-analysis/table-relevance-filter.js";
import { recoverAffectedTables } from "../src/lib/impact-analysis/table-relevance-judge-recovery.js";
import { impactLlmTableJudgeEnabled } from "../src/lib/impact-analysis/table-relevance-judge.js";
import { buildProvider, loadAIConfig } from "../src/lib/ai/index.js";
import type { AIProvider } from "../src/lib/ai/types.js";

/** Parse `--searcher <bm25|llm|entity-union>` (default bm25 — what production seeds with). */
function parseSearcherKind(argv: string[]): SearcherKind {
  const i = argv.indexOf("--searcher");
  if (i < 0) return "bm25";
  const next = argv[i + 1];
  if (next === "llm") return "llm";
  if (next === "entity-union") return "entity-union";
  return "bm25";
}

/**
 * #1029 — is the column-informed table-relevance RECOVERY judge enabled? `--judge`
 * forces it on, `--no-judge` off; otherwise follow the `IMPACT_LLM_TABLE_JUDGE` env
 * flag, so once that defaults on the default eval measures it.
 */
function parseTableJudgeEnabled(argv: string[]): boolean {
  if (argv.includes("--no-judge")) return false;
  if (argv.includes("--judge")) return true;
  return impactLlmTableJudgeEnabled();
}

/**
 * #936 — build the OUTPUT relevance filter. Uses the real AIProvider from config.
 */
function buildTableRelevanceFilter(
  provider: AIProvider,
): RunImpactRecallOptions["tableRelevanceFilter"] {
  return (requirementText, tables) =>
    filterAffectedTablesByRelevance(requirementText, tables, provider, { enabled: true });
}

/**
 * Build the run options. The provider is built once and shared by the #931 searcher,
 * the #1002 union and the #936 filter.
 */
function buildRunOptions(argv: string[]): RunImpactRecallOptions {
  const searcherKind = parseSearcherKind(argv);
  const withFilter = parseTableFilterEnabled(argv);
  const withJudge = parseTableJudgeEnabled(argv);
  // #956 — the cross-project consumer resolver (the #955/#956 seam) is ALWAYS
  // wired: it is inert on the single-project corpus (no requirement declares
  // `expectedConsumers`, so the runner never calls it), and on the cross-project
  // corpus it moves consumer recall off the honest 0.00 baseline. It derives
  // consumers from the fixture GRAPH keyed on the engine's own output — never
  // from the answer key — so the lift is measured, not asserted.
  const opts: RunImpactRecallOptions = {
    consumerResolver: (args) => resolveFixtureConsumers(args),
  };
  if (searcherKind === "bm25" && !withFilter && !withJudge) return opts;
  const provider = buildProvider({ config: loadAIConfig() });
  if (searcherKind === "llm") {
    opts.searcherKind = "llm";
    opts.llmSearcherFactory = (fx) => new LlmCodeSymbolSearcher(fx.searcher, provider);
  }
  if (searcherKind === "entity-union") {
    // #1002 — the deterministic BM25 searcher DECORATED with graph-grounded entity
    // seeds. The vocabulary comes from the fixture's own graph, so nothing outside
    // the corpus can ever be seeded.
    opts.searcherKind = "entity-union";
    opts.entitySeedSearcherFactory = (fx) =>
      new EntitySeedUnionSearcher(fx.searcher, provider, async () =>
        fixtureEntityVocabulary(fx.manifest),
      );
  }
  if (withFilter) {
    if (provider.offline) {
      // An offline stub makes the filter a passthrough, which would report
      // UNFILTERED numbers under the PRODUCTION label — the #1016 defect exactly.
      throw new Error(
        "the #936 table-relevance filter is ON (the production default) but the resolved " +
          "AI provider is an OFFLINE STUB, which makes the filter a no-op passthrough. That " +
          "would report UNFILTERED numbers under a production label. Set real provider " +
          "credentials (e.g. AI_PROVIDER=anthropic ANTHROPIC_API_KEY=…), or pass --no-filter " +
          "to measure the deterministic-only path on purpose.",
      );
    }
    opts.tableRelevanceFilter = buildTableRelevanceFilter(provider);
  }
  if (withJudge) {
    // #1029 — column-informed RECOVERY judge, built per fixture (needs the manifest
    // table->columns catalog). Its `possible`-tier picks merge into the scored
    // primary set; an offline provider makes the judge a deterministic passthrough.
    opts.tableRecoveryJudgeFactory = (fixture) => (requirementText, _projectId, surfaced) =>
      recoverAffectedTables({
        requirementText,
        surfacedTableNames: surfaced,
        catalog: fixtureTableCatalog(fixture.manifest),
        provider,
        options: { enabled: true },
      });
  }
  return opts;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const failOnBreak = !process.argv.includes("--no-fail");
  const printMd = process.argv.includes("--md");
  const corpus = parseCorpusName(process.argv);
  const runCount = parseRunCount(process.argv, parseTableFilterEnabled(process.argv));

  const runOptions = buildRunOptions(process.argv);
  // #1016 — floors are resolved for the CONFIGURATION being measured, so production
  // numbers can never be gated against the unfiltered floors (or the reverse).
  const thresholds = thresholdsFor(corpus, describeConfiguration(runOptions));

  // Throws on a corpus whose qualified names diverge from what ingest emits (#1016).
  const fixture = await loadImpactRecallFixture(resolveCorpusDir(corpus));
  const summary = await runImpactRecallEvalRepeated(fixture, runOptions, runCount);
  const result = summary.runs[0];
  const { passed, checks } = checkThresholds(summary.meanAggregate, thresholds);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `impact-recall-${corpus}-${runId}.json`);
  await writeFile(
    resultPath,
    `${JSON.stringify(toJsonReport(result, thresholds, summary), null, 2)}\n`,
    "utf8",
  );

  if (printMd) {
    // eslint-disable-next-line no-console
    console.log(toMarkdownReport(result, thresholds, summary));
  }

  const t = summary.meanAggregate.tables;
  const c = summary.meanAggregate.code;
  const co = summary.meanAggregate.consumers;
  const consumerStr = co
    ? ` consR=${co.macroRecall.toFixed(2)} consP=${co.macroPrecision.toFixed(2)}`
    : "";
  const spread = summary.spreads.tablePrecision;
  const spreadStr =
    summary.runCount > 1 && spread
      ? ` [tblP spread ${spread.min.toFixed(3)}–${spread.max.toFixed(3)} over ${summary.runCount} runs]`
      : "";
  // eslint-disable-next-line no-console
  console.log(
    `Impact recall eval [${result.fixtureId}] — ${result.configuration.label}\n` +
      `  reqs=${summary.meanAggregate.requirementCount} ` +
      `tblR=${t.macroRecall.toFixed(2)} tblP=${t.macroPrecision.toFixed(2)} ` +
      `codeR=${(c?.macroRecall ?? 1).toFixed(2)} codeP=${(c?.macroPrecision ?? 1).toFixed(2)}` +
      `${consumerStr}${spreadStr} → ${passed ? "PASS" : "FAIL"} (${resultPath})`,
  );

  if (!passed) {
    const failed = checks.filter((x) => !x.passed);
    // eslint-disable-next-line no-console
    console.error("Impact recall eval FAILED:", JSON.stringify(failed));
    if (failOnBreak) process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:impact-recall failed:", err);
  process.exit(1);
});
