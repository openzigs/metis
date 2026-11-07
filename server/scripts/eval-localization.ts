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
 *   pnpm eval:localization --corpus localization-00-miniflux-run7-insample --arms A13 --rerank-weight 0.3
 *                                                # tune the A13 model weight on the run-7 six ALONE (#1798, #1819)
 *   pnpm eval:localization --merge <dir> --reference A12,A13   # + every arm paired with A12, then with A13 (#1806)
 *   pnpm eval:localization --arms A0,A3,A3A,A3N --shard 1/10   # #1755 analysis-agent citations (materialize first)
 *   pnpm eval:localization --arms A0,A3A,A7,A7O --reference A3A --items 0:4   # #1818 the shipped IMPACT_AGENT_SEEDS order
 *   pnpm eval:localization --merge <dir> --arms A0,A7,A7O --table-guard --embed --guard-steps 5
 *                                                # #1823 A7's table guard, 5 more steps per call
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
 *
 * #1823 — A7's table guard runs "Evaluate new requirements" once per table
 * requirement and run on the materialized repository the table corpus models
 * (`pnpm eval:materialize impact-recall-01-jpetstore` first), then reads A0 on
 * the split seeding, A7 and A7O, 3 runs each. Each step (an analysis, or a run
 * of a reading, A0's mapper reading included, #1847) is recorded in the
 * partials directory (`table-guard/records.jsonl`) as it ends, so
 * `--guard-steps <n>` takes at most n more per call and the same `--merge`
 * resumes. It needs `--embed` (the analyses' requirement texts are new) and
 * `--arms` naming A7 (which binds the eval database). #1847 — a resume is
 * refused on another fixture or repository pin, or when an analysis's stored
 * requirements no longer resolve; and once two readings are complete, their
 * paired 95% t-interval over the requirements is printed.
 *
 * #1834 — the staleness slice: A7K (A7 with the citations' freshness hidden),
 * A7S and A7SD (after each item's committed staleness patch, without and with
 * #1832's demotion), on the HELD-OUT corpora only:
 *
 *   pnpm eval:materialize localization-01-miniflux-heldout   # and -02, and impact-recall-01-jpetstore
 *   pnpm eval:localization --arms A0,A7,A7K,A7S,A7SD --reference A7,A7S --embed --items 0:4
 *   pnpm eval:localization --merge <dir> --reference A7,A7S --table-guard --embed --guard-steps 5
 *
 * The patch sets are committed in `server/scripts/eval-localization-staleness/`
 * (`pnpm eval:staleness-patches` writes them). Before the provider is built, a
 * staleness run checks that every corpus is a held-out set, loads, is
 * materialized and has a patch for every item that fits its graph, and puts
 * back any clone an earlier, killed run left patched: it fails before spending.
 */
/* eslint-disable no-console -- a CLI whose output is its report */
// #1755 — first: an agent arm binds the database to the materialized corpus before Prisma loads.
import "./eval-localization-env.js";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArms, MODEL_ARMS, parseArmIds } from "../src/lib/eval/localization/arms.js";
import { RERANK_MODEL_WEIGHT } from "../src/lib/impact-analysis/edit-candidate-reranker.js";
import type { AIProvider } from "../src/lib/ai/types.js";
import {
  assertReferenceArms,
  flagValue,
  nonNegativeNumber,
  positiveInteger,
  referenceArmIds,
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
import { ANALYSIS_ARM_IDS, STALENESS_ARM_IDS } from "../src/lib/eval/localization/analysis-arms.js";
import {
  applyOpsToClone,
  loadStalenessPatchSets,
  patchSetsDigest,
  stalenessPatchProblems,
  withStalePatch,
  type StalenessCycleDeps,
  type StalenessPatchSet,
} from "../src/lib/eval/localization/staleness.js";
import { agentArmsRequested } from "../src/lib/eval/localization/agent-env.js";
import {
  createAgentSeedGuard,
  fileGuardStore,
  guardRecordsFile,
  lazyAgentSeedGuard,
  type AgentSeedGuard,
  type GuardStaleness,
} from "../src/lib/eval/localization/table-guard-agent.js";
import {
  TABLE_GUARD_CORPUS,
  TABLE_GUARD_REPO,
} from "../src/lib/eval/localization/table-guard-source.js";
import type { CostMeter } from "../src/lib/eval/localization/cost.js";
import type { AnalysisArmIO, StalenessArmIO } from "../src/lib/eval/localization/arm-core.js";
import {
  assertEvalDatabase,
  EVAL_USER_EMAIL,
  materializeLayout,
  readMaterializedState,
  type MaterializedRepo,
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
/** #1823 — what A7's guard needs beyond the other readings. */
interface AgentGuardContext {
  /** The partials directory: the guard's analyses are recorded in it. */
  partialsDir: string;
  /** The cap's meter (this call plus earlier slices) and the cap. */
  capped: CostMeter;
  budgetUsd: number;
  /** `--guard-steps`: new steps (an analysis, or a run of a reading) this call may take. */
  maxSteps: number | undefined;
  argv: readonly string[];
  /** #1834 — the staleness cycle on the table corpus's repository (A7S, A7SD). */
  staleness: GuardStaleness | undefined;
}

async function tableGuardFor(
  meter: LedgerCostMeter,
  armIds: readonly string[],
  armProvider: AIProvider | undefined,
  embed: boolean,
  agent: AgentGuardContext,
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
  /** The split seeding's search over the fixture, from its recorded vectors (+ the local model with --embed). */
  const splitSearch = async (arm: string) => {
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
    return { file, cache, search: await buildCorpusSearch(fixtureSearchRows(fixture), cache) };
  };
  // #1786 / #1798 — an arm whose stage runs on the split seeding is read there,
  // next to A0 on the same seeding.
  const splitGuard =
    (
      arm: string,
      stage: Pick<SplitSeedingGuardDeps, "editCandidateVerifier" | "editCandidateReranker">,
    ) =>
    async (): Promise<TableGuardReading> => {
      const { file, cache, search } = await splitSearch(arm);
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
  // #1823 — A7 (and its control A7O) on the table corpus, with citations a real
  // analysis stored on the repository the corpus models.
  // #1834 — A7K reads nothing the guard can tell from A7 (no re-ingest, so no stale citation).
  const GUARD_ARMS = ["A7", "A7O", "A7S", "A7SD"] as const;
  const agentArms = armIds.filter((id) => (GUARD_ARMS as readonly string[]).includes(id));
  let agentGuard: AgentSeedGuard | null = null;
  if (agentArms.length > 0 && armProvider) {
    if (!agentArmsRequested(agent.argv)) {
      throw new Error(
        `--table-guard reads ${agentArms.join(",")} on the materialized table corpus: pass --arms (the recorded arms) so the eval database is bound`,
      );
    }
    if (!embed) {
      throw new Error(
        "A7's table guard searches with the texts of the requirements its analyses write, new on every run: pass --embed (the local model)",
      );
    }
    // #1847 — built once, on the first reading, as a promise: two readings
    // that start together share one build.
    agentGuard = lazyAgentSeedGuard(async () => {
      const io = await analysisIOFor(armProvider, [TABLE_GUARD_CORPUS]);
      const { prisma } = await import("../src/lib/prisma.js");
      const state = (await materializedStates([TABLE_GUARD_CORPUS])).get(TABLE_GUARD_CORPUS)!;
      const projectId = state.repos.find((r) => r.name === TABLE_GUARD_REPO.name)?.projectId;
      if (!projectId)
        throw new Error(`${TABLE_GUARD_CORPUS}: ${TABLE_GUARD_REPO.name} is not materialized`);
      // The analyses' requirement texts are new on every run: embedded live, never recorded.
      const { search } = await splitSearch("A7");
      return createAgentSeedGuard({
        fixture,
        search,
        options,
        runs: TABLE_GUARD_RUNS,
        model: `${armProvider.key}/${armProvider.model}`,
        repo: TABLE_GUARD_REPO,
        store: fileGuardStore(guardRecordsFile(agent.partialsDir)),
        analyze: async (text) => {
          const r = await io.pass({
            corpus: TABLE_GUARD_CORPUS,
            repo: TABLE_GUARD_REPO.name,
            text,
          });
          return { analysisId: r.analysisId, requirementIds: r.requirementIds };
        },
        loadRequirementChanges: io.loadRequirementChanges,
        loadCitations: (requirementId) =>
          io.loadCitations(requirementId, TABLE_GUARD_CORPUS, TABLE_GUARD_REPO.name),
        qualifiedNames: async (ids) =>
          new Map(
            (
              await prisma.codeSymbol.findMany({
                where: { projectId, id: { in: [...ids] } },
                select: { id: true, qualifiedName: true },
              })
            ).map((r) => [r.id, r.qualifiedName]),
          ),
        meter,
        blocked: () =>
          agent.capped.unpricedCalls() > 0
            ? "an unpriced model call"
            : agent.capped.spentUsd() >= agent.budgetUsd
              ? `budget: $${agent.capped.spentUsd().toFixed(4)} spent of $${agent.budgetUsd}`
              : null,
        maxSteps: agent.maxSteps,
        ...(agent.staleness ? { staleness: agent.staleness } : {}),
        runOnce: (opts) => runnerMod.runImpactRecallEval(fixture, opts),
        describe: (label) => `${corpusName}, ${label}, ${provider.key}/${provider.model}`,
        log: (line) => console.log(line),
      });
    });
    for (const id of agentArms) {
      const variant = id as (typeof GUARD_ARMS)[number];
      const guard = agentGuard;
      others[id] = () => guard[variant]();
    }
  }
  // #1847 — with A7's guard, A0's mapper reading is one of its recorded steps,
  // so a resumed --merge does not pay for it again.
  if (agentGuard) return memoisedA0TableGuard(agentGuard.A0, others);
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
async function materializedStates(
  corpora: readonly string[],
): Promise<Map<string, MaterializedState>> {
  const layout = materializeLayout();
  const { boundDatabaseUrl } = await import("../src/lib/prisma.js");
  assertEvalDatabase(boundDatabaseUrl, layout);
  const states = new Map<string, MaterializedState>();
  for (const corpus of corpora) {
    const state = await readMaterializedState(corpus, layout);
    if (!state)
      throw new Error(`${corpus} is not materialized: run pnpm eval:materialize ${corpus}`);
    states.set(corpus, state);
  }
  return states;
}

async function agentPassFor(
  provider: AIProvider,
  corpora: readonly LocalizationCorpusName[],
  armIds: readonly string[],
): Promise<AgentPass> {
  const states = await materializedStates(corpora);
  const { assertA3NClones, createMaterializedAgentPass } =
    await import("../src/lib/eval/localization/agent-pass.js");
  // #1819 — before any pass: A3N's file tools read only the clone.
  if (armIds.includes("A3N")) await assertA3NClones(states);
  const { prisma } = await import("../src/lib/prisma.js");
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

/**
 * #1818 — what the A7 arms read: "Evaluate new requirements" run by the real
 * orchestrator on each materialized project (the code agent, the item text as
 * `extraInstructions`), through the METERED provider, and the eval database's
 * requirements and stored citations read by production's own functions.
 */
async function analysisIOFor(
  provider: AIProvider,
  corpora: readonly string[],
): Promise<AnalysisArmIO> {
  const states = await materializedStates(corpora);
  // The analysis monthly TOKEN cap (5M by default) counts every analysis in the
  // eval database and would refuse a full run part-way; the eval's own DOLLAR
  // cap holds the spend instead. An explicit setting is kept.
  if (process.env.ANALYSIS_MONTHLY_TOKEN_CAP === undefined) {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "0";
    console.log(
      "A7: analysis monthly token cap off for the eval database (the --budget cap holds)",
    );
  }
  const { prisma } = await import("../src/lib/prisma.js");
  const user = await prisma.user.findUnique({ where: { email: EVAL_USER_EMAIL } });
  if (!user)
    throw new Error(`no ${EVAL_USER_EMAIL} in the eval database: run pnpm eval:materialize`);
  const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
  const { createMaterializedAnalysisPass } =
    await import("../src/lib/eval/localization/analysis-pass.js");
  const { prismaAgentCitationDeps } = await import("../src/lib/impact-analysis/agent-seeder.js");
  const { loadRequirementChanges } =
    await import("../src/lib/impact-analysis/impact-analysis-engine.js");
  const orchestrator = new AnalysisOrchestrator({ provider });
  const citations = prismaAgentCitationDeps(prisma);
  const projectIdOf = (corpus: string, repo: string): string => {
    const found = states.get(corpus)?.repos.find((r) => r.name === repo);
    if (!found) throw new Error(`${corpus}/${repo} is not materialized`);
    return found.projectId;
  };
  return {
    pass: createMaterializedAnalysisPass({
      states,
      start: ({ projectId, text }) =>
        orchestrator.start({
          projectId,
          startedById: user.id,
          agentKeys: ["code"],
          extraInstructions: text,
        }),
      readState: (id) =>
        prisma.analysis.findUnique({ where: { id }, select: { status: true, errorMessage: true } }),
      isActive: (id) => orchestrator.isActive(id),
      cancel: (id) => orchestrator.cancel(id, user.id),
      requirementIds: async (analysisId) =>
        (
          await prisma.requirement.findMany({
            where: { analysisId, deletedAt: null },
            select: { id: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        ).map((r) => r.id),
    }),
    loadRequirementChanges: (ids) => loadRequirementChanges(prisma, ids),
    loadCitations: (requirementId, corpus, repo) =>
      citations.loadCitations(requirementId, projectIdOf(corpus, repo)),
  };
}

/** `git -C <clone> …` with an argument array: no shell; every path was checked first. */
function gitIn(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
}

/** A patch commit's fixed identity and date: the same patch is the same commit. */
const PATCH_COMMIT_ENV = {
  GIT_AUTHOR_NAME: "metis-eval",
  GIT_AUTHOR_EMAIL: EVAL_USER_EMAIL,
  GIT_COMMITTER_NAME: "metis-eval",
  GIT_COMMITTER_EMAIL: EVAL_USER_EMAIL,
  GIT_AUTHOR_DATE: "2026-11-06T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-06T00:00:00Z",
};

/** #1834 — what the staleness arms and the table guard's staleness readings read through. */
interface StalenessWiring {
  /** The corpus search over patched rows is per corpus: the main loop adds `searchFor`. */
  arms: Omit<StalenessArmIO, "searchFor">;
  guard: GuardStaleness | undefined;
}

/**
 * #1834 — the staleness cycle, checked BEFORE the provider is built: every
 * corpus is a held-out set that loads, is materialized and has a patch for
 * each item that fits its graph (the table corpus's, with `--table-guard`, too);
 * a clone or graph an earlier, killed run left patched is put back.
 */
async function stalenessFor(
  corpora: readonly LocalizationCorpusName[],
  withGuard: boolean,
): Promise<StalenessWiring> {
  const sets = await loadStalenessPatchSets();
  const digest = patchSetsDigest(sets);
  const problems: string[] = [];
  const setOf = (name: string): StalenessPatchSet => {
    const set = sets.get(name);
    if (!set) {
      throw new Error(
        `${name} has no committed staleness patch set (server/scripts/eval-localization-staleness/; pnpm eval:staleness-patches)`,
      );
    }
    return set;
  };
  for (const name of corpora) {
    const corpus = await loadLocalizationCorpus(name);
    if (corpus.manifest.purpose !== "held-out") {
      throw new Error(
        `the staleness arms run on the held-out sets only, not ${name} (${corpus.manifest.purpose}, #1819)`,
      );
    }
    problems.push(
      ...stalenessPatchProblems(setOf(name), {
        name,
        itemIds: corpus.manifest.items.map((i) => i.id),
        symbols: corpus.symbols,
      }).map((p) => `${name}: ${p}`),
    );
  }
  const states = await materializedStates([...corpora, ...(withGuard ? [TABLE_GUARD_CORPUS] : [])]);
  const { prisma } = await import("../src/lib/prisma.js");
  const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
  const { embedProjectSymbols } = await import("../src/lib/code-graph/symbol-embedding-service.js");
  const { resolveRepoClonePath } = await import("../src/lib/connectors/repo/clone-path.js");
  if (withGuard) {
    const fixtureMod = await import("../src/lib/eval/impact-recall/fixture.js");
    const fixture = await fixtureMod.loadImpactRecallFixture(
      fixtureMod.resolveCorpusDir(TABLE_GUARD_CORPUS),
    );
    const repo = states
      .get(TABLE_GUARD_CORPUS)!
      .repos.find((r) => r.name === TABLE_GUARD_REPO.name)!;
    const rows = await prisma.codeSymbol.findMany({
      where: { projectId: repo.projectId },
      select: {
        filePath: true,
        qualifiedName: true,
        kind: true,
        language: true,
        startLine: true,
        endLine: true,
      },
    });
    problems.push(
      ...stalenessPatchProblems(setOf(TABLE_GUARD_CORPUS), {
        name: TABLE_GUARD_CORPUS,
        itemIds: fixture.requirements.map((r) => r.id),
        symbols: rows.map((r) => ({ ...r, repo: TABLE_GUARD_REPO.name })),
      }).map((p) => `${TABLE_GUARD_CORPUS}: ${p}`),
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `the staleness patch sets do not fit their corpora:\n  - ${problems.join("\n  - ")}`,
    );
  }

  /** The clone of a materialized repository, where the materialization put it. */
  const cloneOf = (repo: MaterializedRepo): string => {
    const dir = resolveRepoClonePath(repo.connectorId);
    if (path.resolve(repo.cloneDir) !== path.resolve(dir)) {
      throw new Error(
        `${repo.name}: the clone moved (${repo.cloneDir}); run pnpm eval:materialize again`,
      );
    }
    return dir;
  };
  const cycle: StalenessCycleDeps<MaterializedRepo> = {
    async applyAndCommit(repo, ops) {
      const dir = cloneOf(repo);
      await applyOpsToClone(dir, ops);
      gitIn(dir, ["add", "--all"]);
      gitIn(
        dir,
        [
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "--no-verify",
          "-m",
          "metis-eval #1834: synthetic staleness patch",
        ],
        PATCH_COMMIT_ENV,
      );
      return gitIn(dir, ["rev-parse", "HEAD"]);
    },
    async restore(repo) {
      const dir = cloneOf(repo);
      gitIn(dir, ["reset", "--quiet", "--hard", repo.sha]);
      gitIn(dir, ["clean", "-fdq"]);
    },
    async reingest(repo, commitSha) {
      await ingestCodeGraph(prisma, {
        projectId: repo.projectId,
        rootDir: cloneOf(repo),
        repoConnectionId: repo.connectorId,
        commitSha,
        incremental: true,
        // The committed rows were built with lineage off, as the materialization ingests.
        sqlLineageOverride: false,
      });
    },
    pinnedSha: (repo) => repo.sha,
    async afterRestore(repo) {
      await embedProjectSymbols(repo.projectId);
    },
  };
  // A clone or graph left patched by a killed run is put back, and its symbols embedded,
  // before anything reads it.
  for (const state of states.values()) {
    for (const repo of state.repos) {
      const dir = cloneOf(repo);
      const head = gitIn(dir, ["rev-parse", "HEAD"]);
      const dirty = gitIn(dir, ["status", "--porcelain"]) !== "";
      const graph = await prisma.codeGraph.findFirst({
        where: { projectId: repo.projectId, repoConnectionId: repo.connectorId },
        select: { commitSha: true },
      });
      if (head === repo.sha && !dirty && graph?.commitSha === repo.sha) {
        // A run killed during the restore's re-embed left symbols without vectors: embed them
        // (a no-op when every symbol has one).
        await cycle.afterRestore!(repo);
        continue;
      }
      console.log(
        `${state.corpus}/${repo.name}: left patched by an earlier run (clone ${head.slice(0, 8)}${dirty ? ", dirty" : ""}, graph ${graph?.commitSha?.slice(0, 8) ?? "none"}); restoring ${repo.sha.slice(0, 8)}`,
      );
      await cycle.restore(repo);
      await cycle.reingest(repo, repo.sha);
      await cycle.afterRestore!(repo);
    }
  }
  const repoIn =
    (corpus: string) =>
    (name: string): MaterializedRepo => {
      const repo = states.get(corpus)?.repos.find((r) => r.name === name);
      if (!repo) throw new Error(`${corpus}/${name} is not materialized`);
      return repo;
    };
  const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await run();
    } finally {
      console.log(
        `staleness: ${label} patched, read and restored in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      );
    }
  };
  console.log(
    `staleness: patch sets ${digest}; ${corpora.length + (withGuard ? 1 : 0)} corpus(es) checked`,
  );
  return {
    arms: {
      patchSetDigest: digest,
      opsFor(corpus, itemId) {
        const ops = sets.get(corpus)?.items[itemId];
        if (!ops) throw new Error(`${corpus}: no staleness patch for ${itemId}`);
        return ops;
      },
      withPatch: (corpus, ops, read) =>
        timed(corpus, () => withStalePatch(ops, repoIn(corpus), cycle, read)),
    },
    guard: withGuard
      ? {
          patchSetDigest: digest,
          opsFor(requirementId) {
            const ops = sets.get(TABLE_GUARD_CORPUS)?.items[requirementId];
            if (!ops)
              throw new Error(`${TABLE_GUARD_CORPUS}: no staleness patch for ${requirementId}`);
            return ops;
          },
          withPatch: (ops, read) =>
            timed(TABLE_GUARD_CORPUS, () =>
              withStalePatch(ops, repoIn(TABLE_GUARD_CORPUS), cycle, read),
            ),
        }
      : undefined,
  };
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
  // #1806 — report-only: also pair every arm with these, beside A0.
  const references = referenceArmIds(argv);
  const runs = positiveInteger(flagValue(argv, "runs"), DEFAULT_RUNS, "runs");
  const budgetUsd = nonNegativeNumber(flagValue(argv, "budget"), DEFAULT_BUDGET_USD, "budget");
  const rerankWeight = nonNegativeNumber(
    flagValue(argv, "rerank-weight"),
    RERANK_MODEL_WEIGHT,
    "rerank-weight",
  );
  const writeBaseline = argv.includes("--baseline");
  // #1818 — an A7 arm's impact run reads the requirements its analysis wrote,
  // whose texts are new on every run: no recording can hold their query
  // vectors, so they are embedded live and never written back.
  const analysisRun = !mergeDir && armIds.some((id) => ANALYSIS_ARM_IDS.has(id));
  if (analysisRun && !argv.includes("--embed")) {
    throw new Error(
      "an A7 arm searches with the texts of the requirements its analysis writes, new on every run: pass --embed (the local model) so they are embedded live",
    );
  }
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
  // #1819 — a mistyped --reference fails here, before the provider, the table guard or any arm spends.
  assertReferenceArms(references, reportedArmIds);
  // #1834 — a staleness run fails here, before the provider is built and before any spend,
  // when a held-out set, its materialization or its patches are missing.
  const stalenessRun = reportedArmIds.some((id) => STALENESS_ARM_IDS.has(id));
  if (stalenessRun && mergeDir && argv.includes("--table-guard") && !agentArmsRequested(argv)) {
    throw new Error(
      `--table-guard reads ${reportedArmIds.filter((id) => STALENESS_ARM_IDS.has(id)).join(",")} on the materialized table corpus: pass --arms ${reportedArmIds.join(",")} (the recorded arms) so the eval database is bound`,
    );
  }
  const staleness =
    stalenessRun && (!mergeDir || argv.includes("--table-guard"))
      ? await stalenessFor(mergeDir ? [] : corpora, argv.includes("--table-guard"))
      : undefined;
  const needsProvider =
    reportedArmIds.some((id) => MODEL_ARMS.has(id)) &&
    (!mergeDir || argv.includes("--table-guard"));
  const provider = needsProvider ? await armProviderFor(meter) : undefined;
  // #1755 — the agent arms read the materialized corpora; a merge runs no pass.
  const agentPass =
    !mergeDir && provider && armIds.some((id) => AGENT_ARM_IDS.has(id))
      ? await agentPassFor(provider, corpora, armIds)
      : undefined;
  // #1818 — the A7 arms run "Evaluate new requirements" on the materialized corpora.
  const analysis =
    !mergeDir && provider && armIds.some((id) => ANALYSIS_ARM_IDS.has(id))
      ? await analysisIOFor(provider, corpora)
      : undefined;
  const guardSteps = flagValue(argv, "guard-steps");
  if (guardSteps !== undefined && !argv.includes("--table-guard")) {
    throw new Error("--guard-steps bounds A7's table guard: pass it with --table-guard");
  }
  const tableGuard = argv.includes("--table-guard")
    ? await tableGuardFor(meter, reportedArmIds, provider, argv.includes("--embed"), {
        partialsDir: store.dir,
        capped,
        budgetUsd,
        maxSteps:
          guardSteps === undefined ? undefined : positiveInteger(guardSteps, 1, "guard-steps"),
        argv,
        staleness: staleness?.guard,
      })
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
          ...(analysis ? { analysis } : {}),
          ...(staleness
            ? {
                staleness: {
                  ...staleness.arms,
                  // #1834 — the patched rows, searched with this corpus's vectors (+ the live model).
                  searchFor: (rows) => buildCorpusSearch(rows, cache!),
                },
              }
            : {}),
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
        references,
      });
      await store.recordOtherSpend(runId, meter);
      reports.push(report);
      if (cache) {
        assertNoMissingVectors(cache);
        if (cache.embeddedCount > 0 && analysisRun) {
          console.log(
            `embedded ${cache.embeddedCount} texts live; not recorded: an A7 run's requirement texts are new on every run`,
          );
        } else if (cache.embeddedCount > 0) {
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
