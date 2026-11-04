/**
 * #1753 — `pnpm eval:localization`: file localization of analyst-worded
 * requirements on the HELD-OUT corpora, per arm, with paired tests against A0.
 *
 *   pnpm eval:localization                       # A0 on both held-out sets, 3 runs, $35 cap
 *   pnpm eval:localization --arms A0,A4          # + an arm, compared with A0 on the same items
 *   pnpm eval:localization --corpus localization-02-fixture-portfolio
 *   pnpm eval:localization --in-sample           # also the six run-7 issues (never a gain claim)
 *   pnpm eval:localization --runs 1 --budget 10  # fewer runs, a lower dollar cap
 *   pnpm eval:localization --table-guard         # + table precision on impact-recall-01 (live provider)
 *   pnpm eval:localization --embed               # embed missing vectors with the local model
 *   pnpm eval:localization --md                  # print the Markdown report
 *   pnpm eval:localization --baseline            # A0 only: write baseline-A0.{json,md} into each corpus
 *
 * When both held-out corpora run, a POOLED report compares each arm with A0
 * over all 40 held-out items at once, stratified by corpus
 * (`localization-pooled-<run>.{json,md}`): one corpus alone can only resolve a
 * gap of 20 points or more (#1770). The in-sample set is never pooled.
 *
 * One dollar cap covers the whole invocation: every corpus and every
 * table-precision guard is checked against the same spend and look-ahead.
 *
 * Arms are chosen ONLY by `--arms`; no `IMPACT_LLM_*` variable changes what is
 * measured, and every report names each arm's configuration.
 *
 * Vectors. A0 searches with production's hybrid ranking, which needs a vector
 * for every symbol and every query. They are recorded next to the corpus's
 * symbol rows (`vectors.<model>.{json,bin}`). The fixture set's recording is
 * committed; Miniflux's (about 5.4 MB) is not, so the first Miniflux run needs
 * `--embed` and the local model:
 *
 *   EMBED_BACKEND=xenova EMBED_MODEL=Alibaba-NLP/gte-modernbert-base \
 *   TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
 *   pnpm eval:localization --embed
 *
 * Without `--embed`, a text with no recorded vector FAILS the run rather than
 * letting the search fall back to BM25 under the hybrid label.
 *
 * The table guard needs a live provider (`AI_PROVIDER=…` and its key): it is
 * the #936 LLM table filter, and an offline stub would report unfiltered
 * numbers under the production label (#1016), so it fails loud instead.
 */
/* eslint-disable no-console -- a CLI whose output is its report */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArms, MODEL_ARMS, parseArmIds } from "../src/lib/eval/localization/arms.js";
import type { AIProvider } from "../src/lib/ai/types.js";
import {
  flagValue,
  nonNegativeNumber,
  positiveInteger,
} from "../src/lib/eval/localization/cli-args.js";
import {
  LOCALIZATION_CORPORA,
  loadLocalizationCorpus,
  resolveSymbolsPath,
  type LocalizationCorpus,
  type LocalizationCorpusName,
} from "../src/lib/eval/localization/corpus.js";
import { LedgerCostMeter, meterProvider } from "../src/lib/eval/localization/cost.js";
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_RUNS,
  EvalBudget,
  memoisedA0TableGuard,
  poolHeldOutReports,
  runLocalizationEval,
  toMarkdownReport,
  toPooledMarkdownReport,
  type LocalizationReport,
  type TableGuard,
} from "../src/lib/eval/localization/runner.js";
import {
  EmbedCache,
  assertNoMissingVectors,
  buildCorpusSearch,
} from "../src/lib/eval/localization/search.js";
import { loadRecordedVectors, writeRecordedVectors } from "../src/lib/eval/recorded-vectors.js";
import type { EmbedService } from "../src/lib/code-graph/symbol-embeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The corpora to run: one by name, else both held-out sets (+ the in-sample one on request). */
function corporaFor(argv: string[]): LocalizationCorpusName[] {
  const named = flagValue(argv, "corpus");
  if (named) {
    if (!(LOCALIZATION_CORPORA as readonly string[]).includes(named)) {
      throw new Error(`unknown corpus ${named}; known: ${LOCALIZATION_CORPORA.join(", ")}`);
    }
    return [named as LocalizationCorpusName];
  }
  const heldOut: LocalizationCorpusName[] = [
    "localization-01-miniflux-heldout",
    "localization-02-fixture-portfolio",
  ];
  return argv.includes("--in-sample")
    ? [...heldOut, "localization-00-miniflux-run7-insample"]
    : heldOut;
}

/** Where a corpus's vectors live: beside its symbol rows, so two corpora on one snapshot share them. */
function vectorsFileFor(corpus: LocalizationCorpus, model: string): string {
  const symbolsDir = path.dirname(resolveSymbolsPath(corpus.dir, corpus.manifest));
  return path.join(symbolsDir, `vectors.${model.split("/").pop()}.json`);
}

async function embedCacheFor(
  corpus: LocalizationCorpus,
  embed: boolean,
): Promise<{ cache: EmbedCache; file: string }> {
  let inner: EmbedService | null = null;
  let model = process.env.EMBED_MODEL ?? "Alibaba-NLP/gte-modernbert-base";
  if (embed) {
    const { getEmbedder } = await import("../src/lib/rag/embedder.js");
    inner = getEmbedder();
    model = getEmbedder().model;
  }
  const file = vectorsFileFor(corpus, model);
  const recorded = await loadRecordedVectors(file);
  const cache = new EmbedCache(
    recorded,
    inner,
    `pnpm eval:localization --corpus ${corpus.name} --embed (with the local model)`,
  );
  return { cache, file };
}

/**
 * The table-precision guard rail for A0: impact-recall-01 in the PRODUCTION
 * configuration (BM25 seeding + the #936 LLM table filter), 3 runs, metered.
 * Measured once and memoised: every later reading, and every other arm's, is
 * free, so the runner does not hold it under the cap (#1779).
 */
async function tableGuardFor(meter: LedgerCostMeter): Promise<TableGuard> {
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const provider = buildProvider({ config: loadAIConfig() });
  if (provider.offline) {
    throw new Error(
      "--table-guard needs a live provider: the #936 table filter is an LLM call, and an offline " +
        "stub would report unfiltered numbers under the production label (#1016).",
    );
  }
  const metered = meterProvider(provider, meter);
  const { filterAffectedTablesByRelevance } =
    await import("../src/lib/impact-analysis/table-relevance-filter.js");
  const fixtureMod = await import("../src/lib/eval/impact-recall/fixture.js");
  const runnerMod = await import("../src/lib/eval/impact-recall/runner.js");
  return memoisedA0TableGuard(async () => {
    const fixture = await fixtureMod.loadImpactRecallFixture(
      fixtureMod.resolveCorpusDir("impact-recall-01-jpetstore"),
    );
    const summary = await runnerMod.runImpactRecallEvalRepeated(
      fixture,
      {
        consumerResolver: (args) => fixtureMod.resolveFixtureConsumers(args),
        tableRelevanceFilter: (text, tables) =>
          filterAffectedTablesByRelevance(text, tables, metered, { enabled: true }),
      },
      3,
    );
    return {
      measured: true,
      tablePrecision: summary.meanAggregate.tables.macroPrecision,
      runs: summary.runCount,
      configuration: `impact-recall-01-jpetstore, ${summary.configuration.label}, ${provider.key}/${provider.model}`,
    };
  });
}

/**
 * The live provider a model-backed arm calls, METERED so every call is priced by
 * the usage ledger and held under the cap. Refuses the offline stub: it answers
 * nothing, and its "results" would be A0's under the arm's label.
 */
async function armProviderFor(meter: LedgerCostMeter): Promise<AIProvider> {
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const provider = buildProvider({ config: loadAIConfig() });
  if (provider.offline) {
    throw new Error(
      "a model-backed arm needs a live provider (AI_PROVIDER and its key); the offline stub would report A0 under the arm's label",
    );
  }
  console.log(`model arms call ${provider.key}/${provider.model}`);
  return meterProvider(provider, meter);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const armIds = parseArmIds(argv);
  const runs = positiveInteger(flagValue(argv, "runs"), DEFAULT_RUNS, "runs");
  const budgetUsd = nonNegativeNumber(flagValue(argv, "budget"), DEFAULT_BUDGET_USD, "budget");
  const writeBaseline = argv.includes("--baseline");
  if (writeBaseline && armIds.length > 1) throw new Error("--baseline writes A0's report only");
  const meter = new LedgerCostMeter();
  const budget = new EvalBudget(budgetUsd);
  const reports: LocalizationReport[] = [];
  const provider = armIds.some((id) => MODEL_ARMS.has(id))
    ? await armProviderFor(meter)
    : undefined;
  const tableGuard = argv.includes("--table-guard") ? await tableGuardFor(meter) : undefined;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });

  for (const name of corporaFor(argv)) {
    const corpus = await loadLocalizationCorpus(name);
    const { cache, file } = await embedCacheFor(corpus, argv.includes("--embed"));
    const search = await buildCorpusSearch(corpus.symbols, cache);
    const arms = buildArms(armIds, { search, ...(provider ? { provider } : {}) });
    const report = await runLocalizationEval(corpus, { arms, runs, budget, meter, tableGuard });
    reports.push(report);
    assertNoMissingVectors(cache);
    if (cache.embeddedCount > 0) {
      await writeRecordedVectors(
        file,
        cache.toFiles(
          "Recorded by `pnpm eval:localization --embed` (#1753): the corpus symbols' embedding texts and the requirement queries, embedded by the local model.",
        ),
      );
      console.log(`recorded ${cache.embeddedCount} new vectors → ${file}`);
    }
    const json = `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`;
    const md = toMarkdownReport(report);
    const base = path.join(resultsDir, `localization-${name}-${runId}`);
    await writeFile(`${base}.json`, json, "utf8");
    await writeFile(`${base}.md`, md, "utf8");
    if (writeBaseline) {
      if (report.stopped) throw new Error("the run stopped early; not writing a baseline");
      await writeFile(path.join(corpus.dir, "baseline-A0.json"), json, "utf8");
      await writeFile(path.join(corpus.dir, "baseline-A0.md"), md, "utf8");
    }
    if (argv.includes("--md")) console.log(md);
    for (const a of report.arms) {
      const g = a.aggregate;
      console.log(
        `[${name}] ${a.id}: R@5=${g.recallAt5.toFixed(2)} R@10=${g.recallAt10.toFixed(2)} ` +
          `editP=${g.editPrecision.toFixed(2)} MRR=${g.mrr.toFixed(2)} items=${g.items} ` +
          `runs=${a.completedRuns} $=${g.totalCostUsd === null ? "unpriced" : g.totalCostUsd.toFixed(4)}`,
      );
    }
    console.log(
      `  → ${base}.{json,md}${report.stopped ? ` (STOPPED: ${report.stopped.reason})` : ""}`,
    );
    if (report.stopped) process.exitCode = 1;
  }
  if (reports.filter((r) => r.corpus.purpose === "held-out").length >= 2) {
    const pooled = poolHeldOutReports(reports);
    const base = path.join(resultsDir, `localization-pooled-${runId}`);
    await writeFile(
      `${base}.json`,
      `${JSON.stringify({ ...pooled, generatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    const md = toPooledMarkdownReport(pooled);
    await writeFile(`${base}.md`, md, "utf8");
    if (argv.includes("--md")) console.log(md);
    console.log(`[pooled] ${pooled.items} held-out items → ${base}.{json,md}`);
  }
  console.log(`total spent: $${meter.spentUsd().toFixed(4)} of $${budgetUsd}`);
}

main().catch((err) => {
  console.error("eval:localization failed:", err);
  process.exit(1);
});
