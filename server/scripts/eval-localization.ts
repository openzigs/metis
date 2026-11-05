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
 *   pnpm eval:localization --arms A0,A4 --table-guard  # + A4 on the split seeding, next to A0 on it (#1786)
 *   pnpm eval:localization --arms A0,A13,A13C,A13S     # #1798 re-order: A0 base, A12 base, shuffled pool
 *   pnpm eval:localization --in-sample --arms A13 --rerank-weight 0.3  # tune the A13 model weight (#1798)
 *   pnpm eval:localization --arms A0,A3,A3A,A3N --shard 1/10   # #1755 analysis-agent citations (materialize first)
 *   pnpm eval:localization --embed               # embed missing vectors with the local model
 *   pnpm eval:localization --md                  # print the Markdown report
 *   pnpm eval:localization --baseline            # A0 only: write baseline-A0.{json,md} into each corpus
 *
 * Slices, resume and merge (#1800). Every run records each requirement's score
 * as a partial file under `eval-results/localization-partials-<run>/` (printed),
 * so a slow arm can be measured in steps of under ten minutes:
 *
 *   pnpm eval:localization --arms A0,A4 --shard 1/3                  # a slice; prints its partials directory
 *   pnpm eval:localization --arms A0,A4 --shard 2/3 --resume <dir>   # the next slice, same directory
 *   pnpm eval:localization --arms A0,A4 --items 0:10 --resume <dir>  # or by item range (0-based, end exclusive)
 *   pnpm eval:localization --arms A0,A4 --resume <dir>               # resume a stopped run: only missing items run
 *   pnpm eval:localization --merge <dir> [--table-guard]             # the report from the partial files; runs nothing
 *
 * The cap and the unpriced-call stop hold across slices (spend is read from the
 * partial files), a changed configuration refuses to resume or merge, and every
 * report lists the requirements still missing.
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
// #1755 — first: an agent arm binds the database to the materialized corpus before Prisma loads.
import "./eval-localization-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArms, MODEL_ARMS, parseArmIds } from "../src/lib/eval/localization/arms.js";
import { RERANK_MODEL_WEIGHT } from "../src/lib/impact-analysis/edit-candidate-reranker.js";
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
  PartialStore,
  describeSlice,
  parseItemSlice,
  recordedArms,
  runFingerprint,
  seedBudget,
  sliceItemIds,
  withRecordedSpend,
} from "../src/lib/eval/localization/partials.js";
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
  type RunCheckpoint,
  type TableGuard,
  type TableGuardReading,
} from "../src/lib/eval/localization/runner.js";
import {
  MAPPER_SEEDING,
  fixtureEditCandidateReranker,
  fixtureEditCandidateVerifier,
  fixtureSearchRows,
  measureSplitSeedingGuard,
  type SplitSeedingGuardDeps,
} from "../src/lib/eval/localization/table-guard.js";
import type {
  ImpactRecallRunSummary,
  RunImpactRecallOptions,
} from "../src/lib/eval/impact-recall/runner.js";
import {
  EmbedCache,
  assertNoMissingVectors,
  buildCorpusSearch,
} from "../src/lib/eval/localization/search.js";
import { loadRecordedVectors, writeRecordedVectors } from "../src/lib/eval/recorded-vectors.js";
import type { EmbedService } from "../src/lib/code-graph/symbol-embeddings.js";
import type { LocalizationArm } from "../src/lib/eval/localization/arms.js";
import { AGENT_ARM_IDS, type AgentPass } from "../src/lib/eval/localization/agent-arms.js";
import {
  assertEvalDatabase,
  materializeLayout,
  readMaterializedState,
  type MaterializedState,
} from "../src/lib/eval/localization/materialize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
/** Runs per table-precision reading: the #936 filter is a live model call (#1016). */
const TABLE_GUARD_RUNS = 3;

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
 * The table-precision guard rail: impact-recall-01 with the live #936 table
 * filter, 3 runs, metered. A0 is read on the mapper path, the configuration
 * the impact-recall floors were measured on. #1786 — A4's check runs only on
 * the split seeding, so A4 is read on the split seeding plus the check, next to
 * A0 on the split seeding alone, on the same corpus, provider and run count.
 * Each reading is measured once and memoised: every later reading is free, so
 * the runner does not hold it under the cap (#1779).
 */
async function tableGuardFor(
  meter: LedgerCostMeter,
  armIds: readonly string[],
  armProvider: AIProvider | undefined,
  embed: boolean,
): Promise<TableGuard> {
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
  const corpusName = "impact-recall-01-jpetstore";
  const fixture = await fixtureMod.loadImpactRecallFixture(fixtureMod.resolveCorpusDir(corpusName));
  const options: RunImpactRecallOptions = {
    consumerResolver: (args) => fixtureMod.resolveFixtureConsumers(args),
    tableRelevanceFilter: (text, tables) =>
      filterAffectedTablesByRelevance(text, tables, metered, { enabled: true }),
  };
  const describe = (summary: ImpactRecallRunSummary) =>
    `${corpusName}, ${summary.configuration.label}, ${provider.key}/${provider.model}`;
  const runRepeated = (opts: RunImpactRecallOptions) =>
    runnerMod.runImpactRecallEvalRepeated(fixture, opts, TABLE_GUARD_RUNS);

  const others: Record<string, () => Promise<TableGuardReading>> = {};
  // #1786 / #1798 — an arm whose stage runs on the split seeding is read there,
  // next to A0 on the same seeding.
  const splitGuard =
    (
      arm: string,
      stage: Pick<SplitSeedingGuardDeps, "editCandidateVerifier" | "editCandidateReranker">,
    ) =>
    async (): Promise<TableGuardReading> => {
      const file = fixtureMod.recordedVectorsFile(fixtureMod.resolveCorpusDir(corpusName));
      let inner: EmbedService | null = null;
      if (embed) {
        const { getEmbedder } = await import("../src/lib/rag/embedder.js");
        inner = getEmbedder();
      }
      const cache = new EmbedCache(
        await loadRecordedVectors(file),
        inner,
        `pnpm eval:localization --arms A0,${arm} --table-guard --embed (with the local model)`,
      );
      const search = await buildCorpusSearch(fixtureSearchRows(fixture), cache);
      const reading = await measureSplitSeedingGuard({
        search,
        options,
        ...stage,
        runRepeated,
        describe,
      });
      assertNoMissingVectors(cache);
      if (cache.embeddedCount > 0) {
        await writeRecordedVectors(
          file,
          cache.toFiles(
            "Recorded by `pnpm eval:impact-recall --searcher hybrid --record-vectors` (#1097) and `pnpm eval:localization --table-guard --embed` (#1786): the corpus's symbol texts and requirement queries, embedded by the local model.",
          ),
        );
        console.log(`recorded ${cache.embeddedCount} new vectors → ${file}`);
      }
      return reading;
    };
  if (armIds.includes("A4") && armProvider) {
    others.A4 = splitGuard("A4", {
      editCandidateVerifier: fixtureEditCandidateVerifier(fixture, armProvider),
    });
  }
  // #1798 — A13's re-order (A0's base order; production has no shuffle and no
  // A12 base on this path, so A13C and A13S are not read here).
  if (armIds.includes("A13") && armProvider) {
    others.A13 = splitGuard("A13", {
      editCandidateReranker: fixtureEditCandidateReranker(fixture, armProvider),
    });
  }
  return memoisedA0TableGuard(async () => {
    const summary = await runRepeated(options);
    return {
      measured: true,
      tablePrecision: summary.meanAggregate.tables.macroPrecision,
      runs: summary.runCount,
      configuration: describe(summary),
      seeding: MAPPER_SEEDING,
    };
  }, others);
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

/**
 * #1755 — the analysis agent pass for the A3 arms, over the materialized
 * corpora. Refuses a database other than the eval one (the env binding in
 * `eval-localization-env.ts` must have run) and a corpus not materialized.
 */
async function agentPassFor(
  provider: AIProvider,
  corpora: readonly LocalizationCorpusName[],
): Promise<AgentPass> {
  const layout = materializeLayout();
  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  assertEvalDatabase(boundDatabaseUrl, layout);
  const states = new Map<string, MaterializedState>();
  for (const corpus of corpora) {
    const state = await readMaterializedState(corpus, layout);
    if (!state)
      throw new Error(`${corpus} is not materialized: run pnpm eval:materialize ${corpus}`);
    states.set(corpus, state);
  }
  const { createMaterializedAgentPass } =
    await import("../src/lib/eval/localization/agent-pass.js");
  const { assembleAgenticCodeTools } = await import("../src/lib/analysis/orchestrator.js");
  const { assembleAgenticPassSeeds, resolveDatabaseAwareDecision } =
    await import("../src/lib/analysis/agentic-pass-context.js");
  const { extractNewRequirementCandidates } =
    await import("../src/lib/analysis/new-requirements.js");
  const { getKnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
  return createMaterializedAgentPass({
    provider,
    states,
    async loadProject(projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, description: true, databaseAwareAnalysis: true },
      });
      if (!project)
        throw new Error(`materialized project ${projectId} is not in the eval database`);
      const decision = await resolveDatabaseAwareDecision(projectId, project.databaseAwareAnalysis);
      return {
        name: project.name,
        description: project.description,
        databaseAware: decision.enabled,
      };
    },
    assembleSeeds: (input) => assembleAgenticPassSeeds(input),
    graphTools: (cloneDir) =>
      assembleAgenticCodeTools({ knowledgeService: getKnowledgeService(), cloneDir }),
    extractRequirements: (text) => extractNewRequirementCandidates(text),
  });
}

/** #1800 — the corpora a merge reports: those the directory holds, or the one named. */
async function mergeCorporaFor(
  argv: string[],
  store: PartialStore,
): Promise<LocalizationCorpusName[]> {
  const held = await store.corpora();
  const named = flagValue(argv, "corpus");
  if (named && !held.includes(named)) {
    throw new Error(`${store.dir} holds no partial results for ${named}`);
  }
  const wanted = LOCALIZATION_CORPORA.filter((c) => (named ? c === named : held.includes(c)));
  if (wanted.length === 0) throw new Error(`${store.dir} holds no partial results`);
  return wanted;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mergeDir = flagValue(argv, "merge");
  const resumeDir = flagValue(argv, "resume");
  const slice = parseItemSlice(flagValue(argv, "items"), flagValue(argv, "shard"));
  if (mergeDir && (resumeDir || slice)) {
    throw new Error("--merge runs nothing: it takes no --resume, --items or --shard");
  }
  if (slice && argv.includes("--table-guard")) {
    throw new Error("--table-guard reads every arm once: pass it to --merge, not to a slice");
  }
  const armIds = parseArmIds(argv);
  const runs = positiveInteger(flagValue(argv, "runs"), DEFAULT_RUNS, "runs");
  const budgetUsd = nonNegativeNumber(flagValue(argv, "budget"), DEFAULT_BUDGET_USD, "budget");
  const rerankWeight = nonNegativeNumber(
    flagValue(argv, "rerank-weight"),
    RERANK_MODEL_WEIGHT,
    "rerank-weight",
  );
  const writeBaseline = argv.includes("--baseline");
  if (writeBaseline && armIds.length > 1) throw new Error("--baseline writes A0's report only");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const store = new PartialStore(
    path.resolve(mergeDir ?? resumeDir ?? path.join(resultsDir, `localization-partials-${runId}`)),
  );
  // #1800 — the cap counts what every earlier slice in this directory spent.
  const prior = await store.readRecordedSpend();
  const meter = new LedgerCostMeter();
  const capped = withRecordedSpend(meter, prior);
  const budget = new EvalBudget(budgetUsd);
  seedBudget(budget, prior);
  const reports: LocalizationReport[] = [];
  const corpora = mergeDir ? await mergeCorporaFor(argv, store) : corporaFor(argv);
  // A merge reports the arms the slices recorded, and runs none: its provider
  // is needed only for A4's table guard.
  const reportedArmIds = mergeDir ? await store.recordedArmIds(corpora) : armIds;
  const needsProvider =
    reportedArmIds.some((id) => MODEL_ARMS.has(id)) &&
    (!mergeDir || argv.includes("--table-guard"));
  const provider = needsProvider ? await armProviderFor(meter) : undefined;
  // #1755 — the agent arms read the materialized corpora; a merge runs no pass.
  const agentPass =
    !mergeDir && provider && armIds.some((id) => AGENT_ARM_IDS.has(id))
      ? await agentPassFor(provider, corpora)
      : undefined;
  const tableGuard = argv.includes("--table-guard")
    ? await tableGuardFor(meter, reportedArmIds, provider, argv.includes("--embed"))
    : undefined;
  console.log(
    `partials: ${store.dir} (${mergeDir ? "merge" : describeSlice(slice)}; ` +
      `$${prior.spentUsd.toFixed(4)} spent by earlier slices)`,
  );

  try {
    for (const name of corpora) {
      const corpus = await loadLocalizationCorpus(name);
      let arms: LocalizationArm[];
      let corpusRuns = runs;
      let checkpoint: RunCheckpoint;
      let runItem: (item: { id: string }) => boolean;
      let cache: EmbedCache | null = null;
      let vectorsFile = "";
      if (mergeDir) {
        const opened = await store.openForMerge(corpus);
        const recordedIds = opened.fingerprint.arms.map((a) => a.id);
        if (argv.includes("--arms") && recordedIds.join(",") !== armIds.join(",")) {
          throw new Error(
            `--merge: ${name} recorded arms ${recordedIds.join(",")}, not ${armIds.join(",")}`,
          );
        }
        if (argv.includes("--runs") && opened.fingerprint.runs !== runs) {
          throw new Error(
            `--merge: ${name} recorded ${opened.fingerprint.runs} run(s), not ${runs}`,
          );
        }
        arms = recordedArms(opened.fingerprint);
        corpusRuns = opened.fingerprint.runs;
        checkpoint = opened.checkpoint;
        runItem = () => false;
      } else {
        ({ cache, file: vectorsFile } = await embedCacheFor(corpus, argv.includes("--embed")));
        const search = await buildCorpusSearch(corpus.symbols, cache);
        arms = buildArms(armIds, {
          search,
          rerankWeight,
          meter: capped,
          ...(provider ? { provider } : {}),
          ...(agentPass ? { agentPass } : {}),
        });
        checkpoint = await store.openForRun(corpus, runFingerprint(corpus, arms, runs));
        const ids = sliceItemIds(corpus.manifest.items, slice);
        runItem = (item) => ids.has(item.id);
      }
      const report = await runLocalizationEval(corpus, {
        arms,
        runs: corpusRuns,
        budget,
        meter: capped,
        tableGuard,
        checkpoint,
        runItem,
      });
      await store.recordOtherSpend(runId, meter);
      reports.push(report);
      if (cache) {
        assertNoMissingVectors(cache);
        if (cache.embeddedCount > 0) {
          await writeRecordedVectors(
            vectorsFile,
            cache.toFiles(
              "Recorded by `pnpm eval:localization --embed` (#1753): the corpus symbols' embedding texts and the requirement queries, embedded by the local model.",
            ),
          );
          console.log(`recorded ${cache.embeddedCount} new vectors → ${vectorsFile}`);
        }
      }
      const json = `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`;
      const md = toMarkdownReport(report);
      const base = path.join(resultsDir, `localization-${name}-${runId}`);
      await writeFile(`${base}.json`, json, "utf8");
      await writeFile(`${base}.md`, md, "utf8");
      if (writeBaseline) {
        if (report.stopped) throw new Error("the run stopped early; not writing a baseline");
        if (report.missing.length > 0) {
          throw new Error("requirements are missing a score; not writing a baseline");
        }
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
      const missing = report.missing.reduce((n, m) => n + m.items.length, 0);
      console.log(
        `  → ${base}.{json,md}${report.stopped ? ` (STOPPED: ${report.stopped.reason})` : ""}` +
          `${missing > 0 ? ` (${missing} requirement score(s) missing)` : ""}`,
      );
      if (report.stopped) process.exitCode = 1;
    }
  } finally {
    // The table guard's spend lives in no requirement file: record it even on a failure.
    await store.recordOtherSpend(runId, meter);
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
  if (!mergeDir) {
    console.log(`next slice or resume: --resume ${store.dir} · report: --merge ${store.dir}`);
  }
  console.log(
    `total spent: $${capped.spentUsd().toFixed(4)} of $${budgetUsd} ` +
      `($${meter.spentUsd().toFixed(4)} by this invocation)`,
  );
}
main().catch((err) => {
  console.error("eval:localization failed:", err);
  process.exit(1);
});
