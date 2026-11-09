/**
 * #1867 — `pnpm eval:governing`: which governing rules apply to each
 * analyst-worded requirement, per arm, scored on
 * applicability recall (overall and on the non-resembling subset), precision,
 * citation accuracy, verdict accuracy, hard errors, ask rate and cost.
 *
 *   pnpm --filter server eval:governing --arm A0               # A0, 3 runs, $5 cap
 *   pnpm --filter server eval:governing --arms A0,A1,A2        # + the rule-summary arms, paired with A0
 *   pnpm --filter server eval:governing --arm A0 --baseline    # write baseline-A0.{json,md} into the corpus
 *   pnpm --filter server eval:governing --runs 1 --budget 1 --md
 *   pnpm --filter server eval:governing --arms A1,A2 --top-k 12
 *   pnpm --filter server eval:governing --arm A0 --concurrency 6   # requirements in parallel
 *   pnpm --filter server eval:governing --arms A0,A2 --corpus governing-02-clinic-records   # the held-out set
 *   pnpm --filter server eval:governing --arm A5 --runs 1 --corpus governing-02-clinic-records   # the shipped path (#1878)
 *   pnpm --filter server eval:governing --corpus governing-02-clinic-records \
 *     --combine a.json,b.json,c.json --reading baseline-A5-sonnet   # three invocations, one reading
 *   pnpm --filter server eval:governing --arm A5 --runs 1 --corpus governing-03-openemr-hipaa   # real HIPAA/NIST text (#2105)
 *
 * #1878 — every report records the commit it ran at and whether the tree was
 * clean, and each arm's production code path. `--combine` builds one reading
 * from several `--runs 1` invocations (no model is called); `--reading <name>`
 * also writes it to `eval-data/readings/<corpus>/<name>.{json,md}`, and is
 * refused for a run that stopped early or ran with uncommitted changes.
 *
 * The default corpus is `governing-01`, the TUNING set (#2024): iterate prompts
 * there. `governing-02` and `governing-03` (#2105, real published text) are held
 * out: read them only for a decision, and record
 * every reading in its ANNOTATION.md. Every report says which set it read.
 *
 * Every arm calls a model through the configured provider (`AI_PROVIDER` and
 * its key; DeepSeek through the Anthropic-compatible endpoint for iteration,
 * `claude-sonnet-5-5` for a decision run). Nothing else is reached: the policy,
 * the rules and the requirements are committed files, and retrieval is
 * in-process BM25, so no database, vector store or embedding model is needed.
 * The offline stub is refused: it answers nothing, and its "results" would be
 * a zero under a real arm's label.
 *
 * Arms are chosen ONLY by `--arm` / `--arms`; no environment flag changes what
 * is measured, and every report names each arm's configuration and model.
 */
/* eslint-disable no-console -- a CLI whose output is its report */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  flagValue,
  nonNegativeNumber,
  positiveInteger,
} from "../src/lib/eval/localization/cli-args.js";
import { EvalBudget } from "../src/lib/eval/localization/runner.js";
import {
  DEFAULT_RULE_TOP_K,
  buildGoverningArms,
  parseGoverningArmIds,
} from "../src/lib/eval/governing/arms.js";
import {
  GOVERNING_CORPORA,
  assertBaselineAllowed,
  loadGoverningCorpus,
  type GoverningCorpusName,
} from "../src/lib/eval/governing/corpus.js";
import { gitProvenance } from "../src/lib/eval/governing/git-provenance.js";
import {
  DEFAULT_GOVERNING_BUDGET_USD,
  DEFAULT_GOVERNING_RUNS,
  combineGoverningReports,
  readingPaths,
  runGoverningEval,
  type GoverningReport,
  toJsonReport,
  toMarkdownReport,
} from "../src/lib/eval/governing/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Write `report` to eval-results, and to the corpus's readings when `reading` names one. */
async function writeReports(
  report: GoverningReport,
  name: string,
  stem: string,
  reading: string | undefined,
): Promise<string> {
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const json = toJsonReport(report, { generatedAt: new Date().toISOString() });
  const md = toMarkdownReport(report);
  const base = path.join(resultsDir, `governing-${name}-${stem}`);
  await writeFile(`${base}.json`, json, "utf8");
  await writeFile(`${base}.md`, md, "utf8");
  if (reading) {
    const files = readingPaths(REPO_ROOT, name, reading);
    await mkdir(path.dirname(files.json), { recursive: true });
    await writeFile(files.json, json, "utf8");
    await writeFile(files.md, md, "utf8");
    console.log(`reading → ${files.json} (+ .md)`);
  }
  return base;
}

/** One line per arm: the metrics the thresholds read, failures and cost. */
function printSummary(report: GoverningReport): void {
  const f = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
  for (const a of report.arms) {
    const m = a.summary.metrics;
    console.log(
      `${a.id} [${report.corpus.purpose}]: recall=${f(m.recall.mean)} nonResembling=${f(m.nonResemblingRecall.mean)} ` +
        `precision=${f(m.precision.mean)} citation=${f(m.citationAccuracy.mean)} ` +
        `verdict=${f(m.verdictAccuracy.mean)} hardErrors=${a.summary.hardErrors} ` +
        `ask=${f(m.askRate.mean)} runs=${a.completedRuns} failures=${a.failures} ` +
        `$/req=${a.cost.usdPerRequirement === null ? "unpriced" : a.cost.usdPerRequirement.toFixed(4)}`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--arm") && argv.includes("--arms")) {
    throw new Error("pass --arm or --arms, not both");
  }
  const armIds = parseGoverningArmIds(flagValue(argv, "arms") ?? flagValue(argv, "arm"));
  const runs = positiveInteger(flagValue(argv, "runs"), DEFAULT_GOVERNING_RUNS, "runs");
  const budgetUsd = nonNegativeNumber(
    flagValue(argv, "budget"),
    DEFAULT_GOVERNING_BUDGET_USD,
    "budget",
  );
  const topK = positiveInteger(flagValue(argv, "top-k"), DEFAULT_RULE_TOP_K, "top-k");
  // Requirements assessed at once; the cap reserves the costliest call for each one in flight.
  const concurrency = positiveInteger(flagValue(argv, "concurrency"), 1, "concurrency");
  const writeBaseline = argv.includes("--baseline");
  if (writeBaseline && armIds.join(",") !== "A0") {
    throw new Error("--baseline writes A0's report only: pass --arm A0");
  }
  const name = flagValue(argv, "corpus") ?? GOVERNING_CORPORA[0];
  if (!(GOVERNING_CORPORA as readonly string[]).includes(name)) {
    throw new Error(`unknown corpus ${name}; known: ${GOVERNING_CORPORA.join(", ")}`);
  }
  const corpus = await loadGoverningCorpus(name as GoverningCorpusName);
  const reading = flagValue(argv, "reading");
  // Refuse a bad name before any model is called.
  if (reading) readingPaths(REPO_ROOT, name, reading);
  const combine = flagValue(argv, "combine");
  if (combine) {
    const sources = combine
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    const saved = await Promise.all(
      sources.map(async (f) => ({
        source: path.basename(f),
        report: JSON.parse(await readFile(path.resolve(f), "utf8")) as unknown,
      })),
    );
    const report = combineGoverningReports(corpus, saved);
    const base = await writeReports(report, name, `combined-${Date.now()}`, reading);
    if (argv.includes("--md")) console.log(toMarkdownReport(report));
    printSummary(report);
    console.log(`combined ${report.runsRequested} run(s) → ${base}.{json,md}`);
    return;
  }
  // #2024 — refuse before any model is called: a baseline written into a held-out set breaks it.
  if (writeBaseline) assertBaselineAllowed(corpus.manifest.purpose, name);
  // #2024 — say which set this reading comes from before any model is called.
  console.log(`corpus ${name}: ${corpus.manifest.purpose} set`);
  if (corpus.manifest.purpose === "held-out") {
    console.log(
      "held-out: read for a decision only, never to tune a prompt; record this reading in its ANNOTATION.md",
    );
  }

  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const live = buildProvider({ config: loadAIConfig() });
  if (live.offline) {
    throw new Error(
      "every governing arm calls a model: set AI_PROVIDER and its key (the offline stub would score zero under a real arm's label)",
    );
  }
  console.log(`arms call ${live.key}/${live.model}`);
  const arms = buildGoverningArms(armIds, { model: `${live.key}/${live.model}`, topK });

  const provenance = gitProvenance(REPO_ROOT);
  console.log(
    `at ${provenance.commit ?? "an unknown commit"}${provenance.dirty ? " (uncommitted changes)" : ""}`,
  );
  if (reading && provenance.dirty !== false) {
    throw new Error("--reading needs a clean tree, so the commit names the code that ran");
  }
  const report = await runGoverningEval(corpus, {
    arms,
    runs,
    budget: new EvalBudget(budgetUsd),
    provider: live,
    concurrency,
    provenance,
    log: (line) => console.log(line),
  });

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  if (reading && report.stopped) throw new Error("the run stopped early; not writing a reading");
  const base = await writeReports(report, name, runId, reading);
  if (writeBaseline) {
    if (report.stopped) throw new Error("the run stopped early; not writing a baseline");
    const json = toJsonReport(report, { generatedAt: new Date().toISOString() });
    await writeFile(path.join(corpus.dir, "baseline-A0.json"), json, "utf8");
    await writeFile(path.join(corpus.dir, "baseline-A0.md"), toMarkdownReport(report), "utf8");
    console.log(`baseline → ${path.join(corpus.dir, "baseline-A0.{json,md}")}`);
  }
  if (argv.includes("--md")) console.log(toMarkdownReport(report));
  printSummary(report);
  console.log(
    `→ ${base}.{json,md}${report.stopped ? ` (STOPPED: ${report.stopped.reason})` : ""} · ` +
      `spent $${report.spentUsd.toFixed(4)} of $${budgetUsd}`,
  );
  if (report.stopped) process.exitCode = 1;
}

main().catch((err) => {
  console.error("eval:governing failed:", err);
  process.exit(1);
});
