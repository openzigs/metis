/**
 * Epic #780 / Issue #788 — `pnpm eval:embed-retrieval` entrypoint.
 *
 * The GATE on the #783 default-model flip: a before/after retrieval eval on
 * METIS's actual use case (natural-language requirement → code symbol), run
 * across five embedding arms (incumbent bge-small, candidate gte-modernbert with
 * correct CLS pooling, the deliberately WRONG mean-pooled candidate, the fp32
 * candidate, and a chance-level hash floor).
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --skip-fp32
 *   pnpm eval:embed-retrieval --hash-only          # no weights, wiring smoke only
 *
 * Real ONNX weights are required (the whole point is to measure real vectors),
 * so the run is OPT-IN behind the SAME env gate #781 introduced for its
 * download-dependent integration tests — no new mechanism, and CI's default job
 * never pulls hundreds of MB of weights.
 *
 * Outputs (both written to `eval-results/`, the markdown also committed under
 * `docs/`):
 *   - `embed-retrieval-<runId>.json` — machine-readable verdict the #783 PR cites
 *   - `embed-retrieval-<runId>.md`   — the results table
 *
 * Exit code is 1 when the verdict is NO-GO or INVALID (unless `--no-fail`), so
 * the eval can gate a workflow.
 *
 * This file is thin orchestration; all logic lives in the unit-tested
 * `src/lib/eval/embed-retrieval/*` modules.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FusedCodeSearcher } from "../src/lib/rag/fused-code-context.js";
import { createCrossEncoderReranker } from "../src/lib/rag/reranker.js";
import {
  compareRerankArm,
  MIN_IMPORTANT_DELTA,
  renderRerankDecision,
  renderRerankSweep,
  RERANK_K,
  RERANK_POOL_DEPTHS,
  scoreRerankArm,
  type RerankArmResult,
  type RerankSearch,
  type RerankSweepReport,
} from "../src/lib/eval/embed-retrieval/rerank-sweep.js";
import {
  buildPassageTexts,
  createRerankingSearcher,
} from "../src/lib/eval/embed-retrieval/rerank-searcher.js";
import { withWiredCorpus } from "../src/lib/eval/embed-retrieval/wired-runner.js";
import {
  ARMS,
  armByRole,
  createArmEmbedFn,
  type ArmSpec,
} from "../src/lib/eval/embed-retrieval/arms.js";
import {
  corpusDir,
  DEFAULT_CORPUS_ID,
  loadEmbedRetrievalCorpus,
  type EmbedRetrievalCorpus,
} from "../src/lib/eval/embed-retrieval/corpus.js";
import {
  formatMeanWithCi,
  renderIntervalSection,
  renderStrataSection,
} from "../src/lib/eval/embed-retrieval/interval-report.js";
import {
  aggregateByStratum,
  type QueryScore,
  type StrataByQueryId,
  type StratumMetrics,
} from "../src/lib/eval/embed-retrieval/metrics.js";
import { renderReport, toJsonArtifact } from "../src/lib/eval/embed-retrieval/report.js";
import {
  createEmptyVectorStore,
  runArm,
  runLexicalBaseline,
  LEXICAL_ONLY_WEIGHTS,
  type ArmRunResult,
} from "../src/lib/eval/embed-retrieval/runner.js";
import { corpusSymbolIndex } from "../src/lib/eval/embed-retrieval/wired-runner.js";
import {
  assertProductionReachableFields,
  compareLexicalArm,
  createLexicalArmSearch,
  excludeQueries,
  LEXICAL_ARMS,
  MIN_IMPORTANT_BM25_DELTA,
  MIN_IMPORTANT_FUSED_DELTA,
  renderLexicalArms,
  renderLexicalDecision,
  renderSnakeStratum,
  scoreLexicalArm,
  SNAKE_UPPER_BOUND_QUERY_IDS,
  summariseSnakeStratum,
  underscoreSymbolShare,
  type LexicalArmResult,
  type LexicalComparison,
  type LexicalSearchDeps,
  type SnakeStratumSummary,
} from "../src/lib/eval/embed-retrieval/lexical-ab.js";
import { DEFAULT_WEIGHTS, type SearchWeights } from "../src/lib/code-graph/hybrid-search.js";
import type { EmbedService } from "../src/lib/code-graph/symbol-embeddings.js";
import { runWiredArm, runWiredSweep } from "../src/lib/eval/embed-retrieval/wired-runner.js";
import { renderMissSets, renderSweep } from "../src/lib/eval/embed-retrieval/weight-sweep.js";
import {
  bootstrapMean,
  computeSignificance,
  type MeanWithCi,
} from "../src/lib/eval/embed-retrieval/stats.js";
import { computeVerdict, type ArmRole } from "../src/lib/eval/embed-retrieval/verdict.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Reuses #781's gate — real weights only when explicitly asked for. */
const DOWNLOAD_ENABLED = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1";

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

/**
 * `--corpus <id>` / `--corpus=<id>` (#1157).
 *
 * Defaults to {@link DEFAULT_CORPUS_ID}. `embedretrieval-01-nl-to-code` stays
 * reachable by name, because committed `eval-results/*.md` cite it and re-running
 * "the old baseline" has to mean the old corpus.
 */
function parseCorpusId(argv: readonly string[]): string {
  const inline = argv.find((a) => a.startsWith("--corpus="));
  if (inline) return inline.slice("--corpus=".length);
  const idx = argv.indexOf("--corpus");
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return DEFAULT_CORPUS_ID;
}

/** The declared strata of every query that has them, keyed by query id. */
function strataByQueryId(corpus: EmbedRetrievalCorpus): StrataByQueryId {
  const map = new Map<string, Record<string, string>>();
  for (const q of corpus.queries) {
    if (!q.strata) continue;
    map.set(q.id, {
      naming: q.strata.naming,
      keywordFree: String(q.strata.keywordFree),
    });
  }
  return map;
}

/** Bootstrap CI + per-stratum slice for one channel's per-query scores. */
function summarise(
  scores: readonly QueryScore[],
  corpus: EmbedRetrievalCorpus,
): { ci: MeanWithCi; strata: StratumMetrics[] } {
  return {
    ci: bootstrapMean(scores.map((s) => s.ndcgAtK[10] ?? 0)),
    strata: aggregateByStratum(scores, strataByQueryId(corpus)),
  };
}

function corpusHeader(corpus: EmbedRetrievalCorpus): string {
  return (
    `Corpus ${corpus.spec.id}: ${corpus.symbols.length} symbols ` +
    `(${corpus.docs.length} embeddable), ${corpus.queries.length} requirements`
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const failOnBreak = !argv.includes("--no-fail");
  const hashOnly = argv.includes("--hash-only");
  const skipFp32 = argv.includes("--skip-fp32");
  const wired = argv.includes("--wired");
  const lexical = argv.includes("--lexical");
  const corpusId = parseCorpusId(argv);

  // Issue #797 — REALISED vs POTENTIAL.
  //
  // The default mode scores each arm through an in-memory harness that builds its
  // own vector store and symbol index. That is the embedder's POTENTIAL, and it is
  // what #788 reported (0.402 nDCG@10 for the candidate). Production took a
  // different path entirely: `search_code_symbols` was handed a NO-OP vector store,
  // so it embedded nothing and the potential was never realised.
  //
  // `--wired` scores the same corpus through the components #797 actually wires:
  // the real pipeline, the real store adapter, a real VectorStore, the real
  // model-tag filter and the real HybridCodeSearch. Whatever comes out is the
  // REALISED number, and it is reported next to the potential one whether or not it
  // flatters the change.
  // #1157 — the weights-free arm. Runs before every download gate below because
  // it needs no weights at all, which is the entire point of it existing.
  if (lexical) {
    await runLexical(corpusId);
    return;
  }
  // #1158 — the cross-encoder rerank arm, ON vs OFF at several pool depths.
  if (argv.includes("--rerank")) {
    await runRerank(corpusId, argv);
    return;
  }
  // #1159 — the lexical A/B: snake_case tokenization and BM25 document enrichment,
  // measured as separate levers before any combined arm.
  if (argv.includes("--lexical-ab")) {
    await runLexicalAb(corpusId, argv);
    return;
  }
  if (wired && argv.includes("--sweep")) {
    await runSweep(corpusId);
    return;
  }
  if (wired) {
    await runWired(argv.includes("--all-arms"), corpusId);
    return;
  }

  let selected: ArmSpec[] = ARMS.filter((a) => !(skipFp32 && a.role === "candidate-fp32"));
  if (hashOnly) {
    selected = selected.filter((a) => !a.requiresWeights);
  } else if (!DOWNLOAD_ENABLED) {
    // eslint-disable-next-line no-console
    console.error(
      "eval:embed-retrieval needs REAL model weights. Re-run with:\n" +
        "  EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval\n" +
        "(or `--hash-only` to smoke-test the wiring without downloading anything).",
    );
    process.exit(1);
  }

  const corpus = await loadEmbedRetrievalCorpus(corpusDir(corpusId));
  log(corpusHeader(corpus));

  const results: Array<{ spec: ArmSpec; result: ArmRunResult }> = [];
  const byRole: Partial<Record<ArmRole, ArmRunResult>> = {};
  for (const spec of selected) {
    const started = Date.now();
    const result = await runArm(spec.id, corpus, createArmEmbedFn(spec));
    results.push({ spec, result });
    byRole[spec.role] = result;
    const v = result.channels.vector;
    log(
      `  ${spec.id.padEnd(26)} vector nDCG@10=${(v.ndcgAtK[10] ?? 0).toFixed(3)} ` +
        `MRR=${v.mrr.toFixed(3)} R@5=${(v.recallAtK[5] ?? 0).toFixed(3)} ` +
        `| hybrid nDCG@10=${(result.channels.hybrid.ndcgAtK[10] ?? 0).toFixed(3)} ` +
        `(${((Date.now() - started) / 1000).toFixed(0)}s)`,
    );
  }

  const verdict = computeVerdict(byRole);
  const significance = computeSignificance(byRole);
  const ranAt = new Date().toISOString();

  // #1157 — the interval goes around the arm the decision rests on. Fall back to
  // whatever was actually run, so `--hash-only` still emits an interval rather
  // than a bare mean.
  const headlineResult = byRole.candidate ?? results[results.length - 1]?.result;
  const headlineSummary = headlineResult
    ? summarise(headlineResult.vectorQueries, corpus)
    : { ci: bootstrapMean([]), strata: [] };

  const renderInput = {
    corpusId: corpus.spec.id,
    docCount: corpus.docs.length,
    queryCount: corpus.queries.length,
    results,
    verdict,
    significance,
    headline: {
      armId: headlineResult?.armId ?? "none",
      ci: headlineSummary.ci,
      strata: headlineSummary.strata,
    },
    ranAt,
  };

  log(`  headline vector nDCG@10 ${formatMeanWithCi(headlineSummary.ci)}`);
  for (const c of significance) {
    log(
      `  ${c.label.padEnd(38)} Δ=${c.meanDelta.toFixed(3)} ` +
        `95% CI [${c.ciLow.toFixed(3)}, ${c.ciHigh.toFixed(3)}] sign p=${c.signTestP.toFixed(3)}`,
    );
  }

  const runId = ranAt.replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const jsonPath = path.join(resultsDir, `embed-retrieval-${runId}.json`);
  const mdPath = path.join(resultsDir, `embed-retrieval-${runId}.md`);
  await writeFile(jsonPath, `${JSON.stringify(toJsonArtifact(renderInput), null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderReport(renderInput), "utf8");

  log(`\n${verdict.outcome}: ${verdict.summary}`);
  log(`Wrote ${jsonPath}\n      ${mdPath}`);

  if (verdict.outcome !== "GO" && failOnBreak && !hashOnly) {
    // #808 audit — this branch only runs when `!hashOnly`, i.e. after the arm
    // loop above has loaded REAL ONNX weights (gated by
    // `EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1`, checked at the top of `main()`).
    // `process.exit()` here would race onnxruntime-node's native teardown the
    // same way it did in `embed-migrate.ts` (#808) and `prefetch-embeddings-model.ts`
    // / `embed-smoke.ts` (#785). `process.exitCode` lets Node drain and exit
    // naturally once ORT releases its session.
    process.exitCode = 1;
  }
}

/**
 * PR #803 review (B1) — `--wired --sweep`: settle `DEFAULT_WEIGHTS` on evidence.
 *
 * The vector channel finds the flagship symbol; RRF at the incumbent weights then
 * demotes it below the limit `search_code_symbols` returns, so the agent never sees
 * it. This sweeps the weight ratio over the wired production path and reports, for
 * each setting, retrieval quality (nDCG@10), the exact-name regression guard, and the
 * only question that decides the issue: is the flagship symbol inside the tool's
 * DEFAULT limit?
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --wired --sweep
 */
/**
 * Epic #1156 opens with "there is no remaining win in weight tuning — do not propose
 * one", and a committed artifact whose headline line reads `CHOSEN: bm25=0.4` reads as
 * proposing exactly that (PR #1174 review). `chooseWeights` optimises exact-name
 * preservation and miss-set stability, NOT nDCG@10 — on `embedretrieval-02` it picks a
 * row scoring 0.246 while the committed `DEFAULT_WEIGHTS` (0.05/0.95) scores 0.276. It
 * is the harness's own selection heuristic, and it is pre-existing behaviour. Say so
 * next to the row rather than letting the word "CHOSEN" carry a recommendation.
 */
const CHOSEN_IS_NOT_A_PROPOSAL =
  "NOTE: `CHOSEN` below is this harness's own selection heuristic " +
  "(`chooseWeights`), which optimises exact-name preservation and miss-set stability, " +
  "NOT nDCG@10. It is NOT a recommendation to move `DEFAULT_WEIGHTS`, and epic #1156 " +
  "explicitly rules weight tuning out of scope. Compare the nDCG@10 column instead.";

async function runSweep(corpusId: string): Promise<void> {
  if (!DOWNLOAD_ENABLED) {
    // eslint-disable-next-line no-console
    console.error(
      "eval:embed-retrieval --wired --sweep needs REAL model weights. Re-run with:\n" +
        "  EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --wired --sweep",
    );
    process.exit(1);
  }

  const corpus = await loadEmbedRetrievalCorpus(corpusDir(corpusId));
  const spec = armByRole("candidate");
  log(corpusHeader(corpus));
  log(`Sweeping RRF weights on the WIRED path with ${spec.label}\n`);

  const report = await runWiredSweep(corpus, createArmEmbedFn(spec), spec.model);
  log(renderSweep(report));

  const chosen = report.chosen;
  log(
    chosen
      ? `\n${CHOSEN_IS_NOT_A_PROPOSAL}\n` +
          `CHOSEN: bm25=${chosen.weights.bm25Weight} vector=${chosen.weights.vectorWeight} ` +
          `(nDCG@10 ${chosen.hybridNdcg10.toFixed(3)} vs incumbent ` +
          `${report.incumbent.hybridNdcg10.toFixed(3)}; exact-name ` +
          `${(chosen.exactNameTop1 * 100).toFixed(0)}% vs incumbent ` +
          `${(report.incumbent.exactNameTop1 * 100).toFixed(0)}%; flagship NL rank ` +
          `${report.incumbent.flagshipRank ?? "absent"} → ${chosen.flagshipRank ?? "absent"}, ` +
          `inside the tool's default top-15: ${chosen.flagshipWithinDefaultLimit ? "YES" : "NO"})`
      : "\nNO SETTING QUALIFIES: every arm regresses exact-name lookup. Report this, " +
          "do not massage it.",
  );
  // The miss SET, compared — not just the count (PR #803 review, M4).
  log(`\n${renderMissSets(report)}`);

  const ranAt = new Date().toISOString();
  const runId = ranAt.replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const mdPath = path.join(resultsDir, `embed-retrieval-sweep-${runId}.md`);
  await writeFile(
    mdPath,
    `# RRF weight sweep on the wired path (#797 / PR #803 B1)\n\n` +
      `Arm: \`${spec.label}\`. Corpus: \`${corpus.spec.id}\` (\`snapshotCommit\` ` +
      `${corpus.spec.snapshotCommit}) — ${corpus.symbols.length} symbols ` +
      `(${corpus.docs.length} embeddable), ${corpus.queries.length} requirements. ` +
      `Run: ${ranAt}\n\n` +
      `Every \`nDCG@10\` carries a bootstrap 95% CI (#1157). Two rows whose intervals ` +
      `overlap are not ranked by this table.\n\n` +
      `\`flagship rank\` is \`assertWithinBudget\` for the keyword-free requirement BM25 ` +
      `cannot answer at any depth. The last column is the question the issue actually asks: ` +
      `does \`search_code_symbols\` hand the symbol to the agent at its DEFAULT limit?\n\n` +
      `> **${CHOSEN_IS_NOT_A_PROPOSAL}**\n\n` +
      `${renderSweep(report)}\n\n` +
      `## Exact-name miss sets\n\n` +
      `The \`exact-name #1\` column is a COUNT. A setting can hold the count and still swap ` +
      `WHICH names it misses, so the sets are compared by name here (PR #803 review, M4).\n\n` +
      `\`\`\`\n${renderMissSets(report)}\n\`\`\`\n`,
    "utf8",
  );
  log(`\nWrote ${mdPath}`);
}

/**
 * Epic #1156 / Issue #1158 — `--rerank`: does a cross-encoder over a widened pool
 * earn its latency on the CODE path?
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --rerank
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --rerank --pools=20,50
 *
 * The OFF arm is production's real default — `createDefaultCodeSearcher` with no
 * reranker named, which resolves `getReranker()` while `RAG_RERANK` is unset and
 * therefore gets the no-op. The ON arms name a cross-encoder EXPLICITLY
 * (`createCrossEncoderReranker`) rather than flipping `RAG_RERANK`, because flipping
 * the process-wide flag would turn the baseline on as well and there would be nothing
 * left to compare against.
 *
 * `--skip-exact-name` drops the exact-name regression suite (one extra search per
 * ground-truth symbol per arm). It is on by default: #1158's stop condition is
 * "no regression in the exact-name MISS SET", which cannot be checked without it.
 */
const RERANK_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

/** `--pools=20,50,100`; defaults to {@link RERANK_POOL_DEPTHS}. */
function parsePools(argv: readonly string[]): number[] {
  const inline = argv.find((a) => a.startsWith("--pools="));
  const raw = inline
    ? inline.slice("--pools=".length)
    : argv[argv.indexOf("--pools") + 1] && argv.includes("--pools")
      ? argv[argv.indexOf("--pools") + 1]
      : null;
  if (!raw) return [...RERANK_POOL_DEPTHS];
  const pools = raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (pools.length === 0) throw new Error(`--pools received no usable depths: "${raw}"`);
  return pools;
}

/**
 * Bytes the cross-encoder actually occupies on disk.
 *
 * `reranker.ts:6` claims "≈150 MB ONNX". #1158 requires that claim be CONFIRMED
 * rather than repeated, so this walks the resolved transformers.js cache directory
 * for the model and sums it. Returns `null` when the weights are not on disk, which
 * is a legitimate answer (a cold worktree) and must not be reported as zero.
 */
async function measureModelBytes(modelId: string): Promise<{ bytes: number; dir: string } | null> {
  const roots = [
    process.env.TRANSFORMERS_CACHE,
    path.join(REPO_ROOT, "node_modules", "@huggingface", "transformers", ".cache"),
  ].filter((r): r is string => Boolean(r));

  for (const root of roots) {
    const dir = path.join(root, ...modelId.split("/"));
    const total = await sumFileBytes(dir);
    if (total > 0) return { bytes: total, dir };
  }
  return null;
}

async function sumFileBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await sumFileBytes(full);
    else if (e.isFile()) total += (await stat(full)).size;
  }
  return total;
}

async function runRerank(corpusId: string, argv: readonly string[]): Promise<void> {
  if (!DOWNLOAD_ENABLED) {
    // eslint-disable-next-line no-console
    console.error(
      "eval:embed-retrieval --rerank needs REAL model weights (embedder AND cross-encoder).\n" +
        "Re-run with:\n" +
        "  EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --rerank",
    );
    process.exit(1);
  }

  const corpus = await loadEmbedRetrievalCorpus(corpusDir(corpusId));
  const spec = armByRole("candidate");
  const pools = parsePools(argv);
  const skipExactName = argv.includes("--skip-exact-name");
  log(corpusHeader(corpus));
  log(
    `Cross-encoder rerank ON vs OFF at pool depths ${pools.join(" / ")} → top-${RERANK_K}, ` +
      `embedder ${spec.label}\n`,
  );

  const footprint = await measureModelBytes(RERANK_MODEL_ID);
  log(
    footprint
      ? `  ${RERANK_MODEL_ID} on disk: ${(footprint.bytes / 1e6).toFixed(1)} MB ` +
          `(${footprint.bytes} bytes) in ${footprint.dir}`
      : `  ${RERANK_MODEL_ID} is NOT on disk yet — the footprint will be measured after ` +
          `the first load.`,
  );

  const report = await withWiredCorpus(
    corpus,
    createArmEmbedFn(spec),
    spec.model,
    async (wired): Promise<RerankSweepReport> => {
      const rank =
        (searcher: FusedCodeSearcher): RerankSearch =>
        async (query, limit) =>
          (await searcher.search(query, corpus.projectId, { limit })).map((h) => h.symbolId);

      // OFF — production's default searcher, verbatim, `RAG_RERANK` untouched.
      const off = await scoreRerankArm(corpus, rank(wired.searcher), "rerank-off", null, {
        skipExactName,
      });
      log(`  rerank OFF          nDCG@10=${off.ndcg10.toFixed(3)} MRR=${off.mrr.toFixed(3)}`);

      // The cold model load, timed on its own so the per-query warm numbers below are
      // steady state rather than "steady state plus one ONNX session construction".
      const reranker = createCrossEncoderReranker();
      const coldStart = performance.now();
      await reranker.rerank("cold cross-encoder load probe", [
        { chunkId: "probe", text: "function probe in probe.ts" },
      ]);
      const coldModelLoadMs = performance.now() - coldStart;
      log(`  cold cross-encoder load: ${coldModelLoadMs.toFixed(0)} ms`);

      const passages = buildPassageTexts(corpus);
      const on: RerankArmResult[] = [];
      for (const pool of pools) {
        const searcher = createRerankingSearcher(wired.searcher, reranker, {
          poolSize: pool,
          passages,
        });
        const arm = await scoreRerankArm(corpus, rank(searcher), `rerank-on-${pool}`, pool, {
          skipExactName,
        });
        on.push(arm);
        log(
          `  rerank ON pool=${String(pool).padEnd(4)} nDCG@10=${arm.ndcg10.toFixed(3)} ` +
            `MRR=${arm.mrr.toFixed(3)}`,
        );
      }

      const after = await measureModelBytes(RERANK_MODEL_ID);
      return {
        off,
        on,
        comparisons: on.map((arm) => compareRerankArm(off, arm)),
        minDelta: MIN_IMPORTANT_DELTA,
        coldModelLoadMs,
        modelBytes: after?.bytes ?? footprint?.bytes ?? null,
      };
    },
  );

  for (const c of report.comparisons) {
    log(
      `  pool=${String(c.poolSize).padEnd(4)} Δ=${c.paired.meanDelta.toFixed(3)} ` +
        `95% CI [${c.paired.ciLow.toFixed(3)}, ${c.paired.ciHigh.toFixed(3)}] ` +
        `sign p=${c.paired.signTestP.toFixed(3)} non-zero ${c.nonZeroDeltas}/${c.paired.n} ` +
        `added p50=${c.addedWarmP50Ms.toFixed(0)}ms p95=${c.addedWarmP95Ms.toFixed(0)}ms ` +
        `→ ${c.verdict}`,
    );
  }

  const strata = strataByQueryId(corpus);
  const strataSections = [
    `### rerank OFF\n\n${renderStrataSection(aggregateByStratum(report.off.perQuery, strata))}`,
    ...report.on.map(
      (arm) =>
        `### rerank ON, pool ${arm.poolSize}\n\n` +
        `${renderStrataSection(aggregateByStratum(arm.perQuery, strata))}`,
    ),
  ].join("\n\n");

  const ranAt = new Date().toISOString();
  const runId = ranAt.replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const mdPath = path.join(resultsDir, `embed-retrieval-rerank-${runId}.md`);
  await writeFile(
    mdPath,
    `# Cross-encoder rerank on the code path — ON vs OFF (#1158)\n\n` +
      `Corpus: \`${corpus.spec.id}\` (\`snapshotCommit\` ${corpus.spec.snapshotCommit}) — ` +
      `${corpus.symbols.length} symbols (${corpus.docs.length} embeddable), ` +
      `${corpus.queries.length} requirements. Embedder: \`${spec.label}\`. ` +
      `Cross-encoder: \`${RERANK_MODEL_ID}\`. Run: ${ranAt}\n\n` +
      `**Pre-registered minimum practically-important delta: +${MIN_IMPORTANT_DELTA.toFixed(3)} ` +
      `nDCG@10**, fixed in \`rerank-sweep.ts\` before the first arm was run.\n\n` +
      `**Model footprint on disk: ${
        report.modelBytes === null
          ? "not resolvable"
          : `${(report.modelBytes / 1e6).toFixed(1)} MB (${report.modelBytes} bytes)`
      }.** \`reranker.ts:6\` claims "≈150 MB ONNX"; the measured number is the one above.\n\n` +
      `**Cold cross-encoder load: ${report.coldModelLoadMs.toFixed(0)} ms**, timed on its own ` +
      `so the per-query figures below are warm steady state.\n\n` +
      `## Quality\n\n${renderRerankSweep(report)}\n\n` +
      `## Decision (the #1157 rule, applied)\n\n${renderRerankDecision(report)}\n\n` +
      `\`SHIP\` = paired CI excludes zero AND its lower bound clears ` +
      `+${MIN_IMPORTANT_DELTA.toFixed(3)}. ` +
      `\`DIRECTION-ESTABLISHED-MAGNITUDE-NOT\` = CI excludes zero, lower bound below the bar. ` +
      `\`NOT-ESTABLISHED\` = CI straddles zero at this n. On disagreement between the ` +
      `bootstrap and the sign test, believe the sign test (\`stats.ts\` header); the ` +
      `\`non-zero Δ\` column is there because a sparse delta vector degrades bootstrap tail ` +
      `coverage.\n\n` +
      `## Per-stratum\n\n${strataSections}\n\n` +
      `## Exact-name miss sets\n\n` +
      (skipExactName
        ? `NOT MEASURED — this run passed \`--skip-exact-name\`.\n`
        : `\`\`\`\nOFF (${report.off.exactNameMisses.length}/${report.off.exactNameCount}): ` +
          `${[...report.off.exactNameMisses].sort().join(", ") || "none"}\n` +
          report.on
            .map(
              (arm) =>
                `ON pool=${arm.poolSize} (${arm.exactNameMisses.length}/${arm.exactNameCount}): ` +
                `${[...arm.exactNameMisses].sort().join(", ") || "none"}`,
            )
            .join("\n") +
          `\n\`\`\`\n`),
    "utf8",
  );
  log(`\nWrote ${mdPath}`);
}

/**
 * Epic #1156 / Issue #1159 — `--lexical-ab`: two lexical levers, measured SEPARATELY.
 *
 *   pnpm eval:embed-retrieval --lexical-ab                       # pure BM25 only
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --lexical-ab
 *
 * The pure-BM25 half needs no weights and no network, so it always runs; it is also
 * the CLEANEST read on this change, because the lexical channel is the only thing that
 * moved. The fused half needs real vectors and is skipped (loudly, in the artifact)
 * without them.
 *
 * The fused arms share ONE embed pass: the tokenizer cannot change a vector, so
 * re-embedding per arm would burn four times the ONNX minutes to reproduce the same
 * store — and, worse, would let q8 batch jitter (#807) leak into a comparison that is
 * supposed to isolate the lexical channel.
 */
async function runLexicalAb(corpusId: string, argv: readonly string[]): Promise<void> {
  const corpus = await loadEmbedRetrievalCorpus(corpusDir(corpusId));
  // #1159's own warning, enforced: a corpus that populates `signature`/`docstring`
  // would let the document-enrichment arm measure a BM25 document production cannot
  // build. Fail before spending four arms on a number nobody could act on.
  assertProductionReachableFields(corpus);

  const bm25Only = argv.includes("--bm25-only") || !DOWNLOAD_ENABLED;
  const reach = underscoreSymbolShare(corpus);
  log(corpusHeader(corpus));
  log(
    `Lexical A/B: ${LEXICAL_ARMS.length} arms. ${reach.withUnderscore}/${reach.total} indexed ` +
      `symbol names carry an underscore (${(reach.share * 100).toFixed(1)}%) — the ceiling on ` +
      `what lever 1 can reach at all.\n`,
  );

  const snakeIds = new Set(
    corpus.queries.filter((q) => q.strata?.naming === "snake").map((q) => q.id),
  );

  /** Score all four arms over one set of deps, and compare each to the baseline. */
  const runChannel = async (
    channel: string,
    deps: Omit<LexicalSearchDeps, "weights">,
    weights: SearchWeights,
    minDelta: number,
  ): Promise<{
    arms: LexicalArmResult[];
    comparisons: LexicalComparison[];
    /** The SAME decision statistic, re-derived without the five upper-bound queries. */
    cleanComparisons: LexicalComparison[];
    strata: SnakeStratumSummary[];
  }> => {
    const arms: LexicalArmResult[] = [];
    for (const spec of LEXICAL_ARMS) {
      const search = createLexicalArmSearch({ ...deps, weights }, spec.config);
      const arm = await scoreLexicalArm(corpus, search, spec);
      arms.push(arm);
      log(
        `  ${channel} ${spec.id.padEnd(10)} nDCG@10=${arm.ndcg10.toFixed(3)} ` +
          `MRR=${arm.mrr.toFixed(3)} exact-name #1=${(arm.exactNameTop1 * 100).toFixed(0)}% ` +
          `(${arm.exactNameCount})`,
      );
    }
    const baseline = arms[0];
    const comparisons = arms.slice(1).map((arm) => compareLexicalArm(baseline, arm, minDelta));
    for (const c of comparisons) {
      log(
        `  ${channel} ${c.armId.padEnd(10)} Δ=${c.paired.meanDelta >= 0 ? "+" : ""}` +
          `${c.paired.meanDelta.toFixed(3)} 95% CI [${c.paired.ciLow.toFixed(3)}, ` +
          `${c.paired.ciHigh.toFixed(3)}] sign p=${c.paired.signTestP.toFixed(3)} ` +
          `non-zero ${c.nonZeroDeltas}/${c.paired.n} → ${c.verdict}`,
      );
    }
    // The decision statistic, re-derived over the corpus MINUS the five disclosed
    // upper-bound queries. Reported ALWAYS, not only when it agrees: on this corpus all
    // five sit among the movers, so the full-set verdict is partly carried by them and a
    // reader who sees only the full-set row inherits a flattered baseline (PR #1177).
    const cleanArms = arms.map((a) => excludeQueries(a));
    const cleanComparisons = cleanArms
      .slice(1)
      .map((arm) => compareLexicalArm(cleanArms[0], arm, minDelta));
    for (const c of cleanComparisons) {
      log(
        `  ${channel} ${c.armId.padEnd(10)} MINUS the 5: Δ=${c.paired.meanDelta >= 0 ? "+" : ""}` +
          `${c.paired.meanDelta.toFixed(3)} 95% CI [${c.paired.ciLow.toFixed(3)}, ` +
          `${c.paired.ciHigh.toFixed(3)}] sign p=${c.paired.signTestP.toFixed(3)} ` +
          `${c.paired.wins}/${c.paired.losses}/${c.paired.ties} n=${c.paired.n} → ${c.verdict}`,
      );
    }

    return {
      arms,
      comparisons,
      cleanComparisons,
      strata: arms.map((a) => summariseSnakeStratum(a, snakeIds)),
    };
  };

  // --- pure BM25: `1.00 / 0.00`, no embedder reachable at all ---
  const refusing: EmbedService = {
    async embed() {
      throw new Error("the pure-BM25 lexical arms must reach no embedder");
    },
  };
  const bm25 = await runChannel(
    "bm25 ",
    {
      vectorStore: createEmptyVectorStore(),
      symbolIndex: corpusSymbolIndex(corpus.searchable),
      embedService: refusing,
      projectId: corpus.projectId,
    },
    LEXICAL_ONLY_WEIGHTS,
    MIN_IMPORTANT_BM25_DELTA,
  );

  // --- fused at DEFAULT_WEIGHTS, through the production wired path ---
  let fused: Awaited<ReturnType<typeof runChannel>> | null = null;
  if (!bm25Only) {
    const spec = armByRole("candidate");
    log(`\nEmbedding the corpus once with ${spec.label} for the fused arms\n`);
    fused = await withWiredCorpus(corpus, createArmEmbedFn(spec), spec.model, (wired) =>
      runChannel(
        "fused",
        {
          vectorStore: wired.vectorStore,
          symbolIndex: corpusSymbolIndex(corpus.searchable),
          embedService: wired.embedService,
          projectId: corpus.projectId,
        },
        DEFAULT_WEIGHTS,
        MIN_IMPORTANT_FUSED_DELTA,
      ),
    );
  }

  const ranAt = new Date().toISOString();
  const runId = ranAt.replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const mdPath = path.join(resultsDir, `embed-retrieval-lexical-ab-${runId}.md`);

  const channelSection = (
    title: string,
    minDelta: number,
    r: Awaited<ReturnType<typeof runChannel>>,
  ): string =>
    `## ${title}\n\n` +
    `**Pre-registered minimum practically-important delta: +${minDelta.toFixed(3)} nDCG@10**, ` +
    `fixed in \`lexical-ab.ts\` before the first arm was run.\n\n` +
    `${renderLexicalArms(r.arms[0], r.arms.slice(1), r.comparisons)}\n\n` +
    `### Decision (the #1157 rule, applied) — ALL ${corpus.queries.length} queries\n\n` +
    `${renderLexicalDecision(r.comparisons)}\n\n` +
    `### Decision EXCLUDING the five upper-bound queries — n=${corpus.queries.length - SNAKE_UPPER_BOUND_QUERY_IDS.length}\n\n` +
    `The same statistic, same bar, same rule, re-derived over the corpus MINUS ` +
    `${SNAKE_UPPER_BOUND_QUERY_IDS.join(", ")}. **Read this table and the one above ` +
    `together.** The stratum table below discloses the five, but the CLASSIFICATION is ` +
    `read off the decision statistic, so disclosing only the stratum leaves a verdict ` +
    `that may rest entirely on the flattered queries looking clean. Where the two ` +
    `verdicts differ, the weaker one is the one a follow-up issue should inherit as its ` +
    `baseline.\n\n` +
    `${renderLexicalDecision(r.cleanComparisons)}\n\n` +
    `### \`naming: snake\` — with and without the five upper-bound queries\n\n` +
    `${renderSnakeStratum(r.strata)}\n\n` +
    `### Exact-name miss sets, by NAME\n\n\`\`\`\n` +
    r.arms
      .map(
        (a) =>
          `${a.armId} (${a.exactNameMisses.length}/${a.exactNameCount}): ` +
          `${[...a.exactNameMisses].sort().join(", ") || "none"}`,
      )
      .join("\n") +
    `\n\`\`\`\n`;

  await writeFile(
    mdPath,
    `# Lexical matching: snake_case split and BM25 document enrichment (#1159)\n\n` +
      `Corpus: \`${corpus.spec.id}\` (\`snapshotCommit\` ${corpus.spec.snapshotCommit}) — ` +
      `${corpus.symbols.length} symbols (${corpus.docs.length} embeddable), ` +
      `${corpus.queries.length} requirements. Run: ${ranAt}\n\n` +
      `**Two levers, four arms, measured separately.** #1156's rule is that retrieval ` +
      `changes are not additive and cannot be batched (#931 regressed precision as a seeder ` +
      `while #936 improved it 0.40 → 0.75 as a filter). A combined arm is reported, but it ` +
      `is reported LAST and it decides nothing on its own.\n\n` +
      `**Reach ceiling:** ${reach.withUnderscore} of ${reach.total} indexed symbol names ` +
      `carry an underscore (${(reach.share * 100).toFixed(1)}%). Lever 1 cannot move a query ` +
      `whose targets are all camelCase, so read every aggregate against this number.\n\n` +
      `**Do not quote 0.474 as this corpus's baseline** — that was the retired 30-query ` +
      `\`embedretrieval-01\`, a different scale. The wired figure on this corpus is 0.276 ` +
      `(95% CI [0.218, 0.335], n=127).\n\n` +
      `\`SHIP\` = paired CI excludes zero AND its lower bound clears the bar. ` +
      `\`DIRECTION-ESTABLISHED-MAGNITUDE-NOT\` = CI excludes zero, lower bound below the ` +
      `bar. \`NOT-ESTABLISHED\` = CI straddles zero at this n. On disagreement between the ` +
      `bootstrap and the sign test, believe the sign test (\`stats.ts\` header); the ` +
      `\`non-zero Δ\` column is there because a sparse delta vector degrades bootstrap tail ` +
      `coverage.\n\n` +
      `### The five upper-bound queries\n\n` +
      `${SNAKE_UPPER_BOUND_QUERY_IDS.join(", ")} carry their target table's words verbatim ` +
      `over bare one-line header passages (#1157 disclosed this; #1158's review confirmed ` +
      `it). A lexical gain concentrated there is close to tautological, so BOTH the snake ` +
      `stratum AND the decision statistic below are reported WITH and WITHOUT them — the ` +
      `stratum because that is where the effect is largest, and the decision statistic ` +
      `because that is where the verdict actually comes from.\n\n` +
      `${channelSection(
        "Pure BM25 (`1.00 / 0.00`) — the cleanest read on this change",
        MIN_IMPORTANT_BM25_DELTA,
        bm25,
      )}\n` +
      (fused
        ? channelSection(
            "Fused at `DEFAULT_WEIGHTS` (`0.05 / 0.95`) — the production channel",
            MIN_IMPORTANT_FUSED_DELTA,
            fused,
          )
        : `## Fused at \`DEFAULT_WEIGHTS\`\n\nNOT MEASURED — this run had no model weights ` +
          `(\`EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1\`) or passed \`--bm25-only\`.\n`),
    "utf8",
  );
  log(`\nWrote ${mdPath}`);
}

/**
 * Issue #1157 — the WEIGHTS-FREE lexical baseline.
 *
 * `--lexical` scores the production `HybridCodeSearch` on its BM25-only branch. It
 * downloads nothing, so it runs where the vector arms cannot, and it is the arm
 * sub-issue #1159 changes. Its job here is to characterise a NEW corpus — its
 * spread, and therefore how wide the interval around ANY number measured on it
 * will be — without waiting on 150 MB of ONNX.
 *
 * It is NOT a substitute for the wired re-baseline: the epic's headline is the
 * hybrid channel at `DEFAULT_WEIGHTS`, and that needs vectors. Read this file as
 * "what the lexical channel does on this corpus, and how noisy this corpus is",
 * never as the corpus's hybrid baseline.
 */
async function runLexical(corpusId: string): Promise<void> {
  const corpus = await loadEmbedRetrievalCorpus(corpusDir(corpusId));
  log(corpusHeader(corpus));
  log("Scoring the BM25-only channel (no embedder, no weights, no network)\n");

  const scores = await runLexicalBaseline(corpus);
  const { ci, strata } = summarise(scores, corpus);
  const mrr = scores.reduce((s, q) => s + q.reciprocalRank, 0) / (scores.length || 1);
  log(`  lexical nDCG@10 ${formatMeanWithCi(ci)}  MRR=${mrr.toFixed(3)}`);
  for (const s of strata) {
    log(
      `  ${`${s.key}=${s.value}`.padEnd(24)} n=${String(s.queryCount).padStart(3)} ` +
        `nDCG@10=${s.ndcgAt10.toFixed(3)} MRR=${s.mrr.toFixed(3)}`,
    );
  }

  const ranAt = new Date().toISOString();
  const runId = ranAt.replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const mdPath = path.join(resultsDir, `embed-retrieval-lexical-${runId}.md`);
  await writeFile(
    mdPath,
    `# Lexical (BM25-only) baseline — corpus characterisation (#1157)\n\n` +
      `Corpus: \`${corpus.spec.id}\` (\`snapshotCommit\` ${corpus.spec.snapshotCommit}) — ` +
      `${corpus.symbols.length} symbols (${corpus.docs.length} embeddable), ` +
      `${corpus.queries.length} requirements. Run: ${ranAt}\n\n` +
      `The production \`HybridCodeSearch\` on its BM25-only branch (empty vector store,\n` +
      `\`vectorWeight: 0\`). **No embedder is loaded and none can be** — the harness passes\n` +
      `an embed service that throws.\n\n` +
      `**This is not the corpus's hybrid baseline.** The epic's headline metric is the\n` +
      `hybrid channel at \`DEFAULT_WEIGHTS\`, which needs real vectors; run\n` +
      `\`--wired\` for that. What this file establishes is the corpus's SPREAD, and\n` +
      `therefore how wide the interval around any number measured on it will be.\n\n` +
      `| Metric | Value |\n|---|---|\n` +
      `| nDCG@10 | ${ci.mean.toFixed(3)} |\n| MRR | ${mrr.toFixed(3)} |\n\n` +
      `${renderIntervalSection({ metricLabel: "lexical (BM25-only) nDCG@10", stats: ci })}\n\n` +
      `${renderStrataSection(strata)}\n`,
    "utf8",
  );
  log(`\nWrote ${mdPath}`);
}

/** Issue #797 — score the candidate arm(s) through the PRODUCTION retrieval path. */
async function runWired(allArms: boolean, corpusId: string): Promise<void> {
  if (!DOWNLOAD_ENABLED) {
    // eslint-disable-next-line no-console
    console.error(
      "eval:embed-retrieval --wired needs REAL model weights. Re-run with:\n" +
        "  EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm eval:embed-retrieval --wired",
    );
    process.exit(1);
  }

  const corpus = await loadEmbedRetrievalCorpus(corpusDir(corpusId));
  log(corpusHeader(corpus));
  log("Scoring POTENTIAL (#788 in-memory harness) vs REALISED (#797 wired production path)\n");

  // By default only the ACTIVE model is scored: "realised" is a statement about the
  // model production actually runs (#783's candidate). `--all-arms` widens it to
  // every weight-bearing arm, which costs a full re-embed of the corpus per arm.
  const specs = allArms
    ? ARMS.filter((a) => a.requiresWeights)
    : [armByRole("candidate")].filter((a) => a.requiresWeights);

  const rows: string[] = [];
  rows.push(
    `| arm | potential hybrid nDCG@10 | realised hybrid nDCG@10 | realised hybrid 95% CI | realised vector nDCG@10 |`,
  );
  rows.push(`| --- | --- | --- | --- | --- |`);

  // #1157 — the interval and the strata belong to the REALISED hybrid channel:
  // that is the number the epic re-baselines against, so that is the number that
  // has to carry error bars.
  const sections: string[] = [];

  for (const spec of specs) {
    const embed = createArmEmbedFn(spec);
    const potential = await runArm(spec.id, corpus, embed);
    const realised = await runWiredArm(spec.id, corpus, embed, spec.model);

    const p = potential.channels.hybrid.ndcgAtK[10] ?? 0;
    const r = realised.hybrid.ndcgAtK[10] ?? 0;
    const rv = realised.vector.ndcgAtK[10] ?? 0;
    const pv = potential.channels.vector.ndcgAtK[10] ?? 0;
    const { ci, strata } = summarise(realised.perQuery, corpus);

    log(
      `  ${spec.id.padEnd(26)} potential hybrid=${p.toFixed(3)} vector=${pv.toFixed(3)} | ` +
        `REALISED hybrid=${r.toFixed(3)} vector=${rv.toFixed(3)} ` +
        `(embedded ${realised.embedded} symbols)`,
    );
    log(`  ${" ".repeat(26)} REALISED hybrid nDCG@10 ${formatMeanWithCi(ci)}`);
    rows.push(
      `| ${spec.id} | ${p.toFixed(3)} | ${r.toFixed(3)} | ` +
        `[${ci.ciLow.toFixed(3)}, ${ci.ciHigh.toFixed(3)}] | ${rv.toFixed(3)} |`,
    );
    sections.push(
      renderIntervalSection({
        metricLabel: `\`${spec.id}\` realised hybrid nDCG@10`,
        stats: ci,
      }),
      renderStrataSection(strata),
    );
  }

  const ranAt = new Date().toISOString();
  const runId = ranAt.replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const mdPath = path.join(resultsDir, `embed-retrieval-wired-${runId}.md`);
  await writeFile(
    mdPath,
    `# Realised vs potential retrieval (#797), with error bars (#1157)\n\n` +
      `Corpus: \`${corpus.spec.id}\` (\`snapshotCommit\` ${corpus.spec.snapshotCommit}) — ` +
      `${corpus.symbols.length} symbols (${corpus.docs.length} embeddable), ` +
      `${corpus.queries.length} requirements. Run: ${ranAt}\n\n` +
      `**Potential** = #788's in-memory harness (its own store + index).\n` +
      `**Realised** = the wired production path: \`SymbolEmbeddingPipeline\` →\n` +
      `\`createSymbolEmbeddingStore\` → a real \`VectorStore\` →\n` +
      `\`createSymbolVectorStore\` (model-tag filter) → \`HybridCodeSearch\`.\n\n` +
      `A number measured on THIS corpus is not comparable to one measured on\n` +
      `\`embedretrieval-01-nl-to-code\`. A different symbol pool and a different query set\n` +
      `is a different SCALE, not a better or worse score.\n\n` +
      `${rows.join("\n")}\n\n` +
      `${sections.join("\n\n")}\n`,
    "utf8",
  );
  log(`\nWrote ${mdPath}`);
}

main().catch((err) => {
  // #808 audit — `main()` (and the `--wired`/`--sweep` paths it delegates to)
  // can throw AFTER real ONNX weights were loaded for scoring, so this
  // catch-all needs the same `process.exitCode` fix as the branch above and
  // as `embed-migrate.ts`'s `.catch()` handler.
  // eslint-disable-next-line no-console
  console.error("eval:embed-retrieval failed:", err);
  process.exitCode = 1;
});
