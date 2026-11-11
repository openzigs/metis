/**
 * #2229 — `pnpm eval:doc-understanding`: how well each way of reading a
 * business document finds its requirements and the questions a business
 * analyst would want raised, scored on requirement recall and precision,
 * section coverage, question precision, ambiguity recall and cost per document.
 *
 *   pnpm --filter server eval:doc-understanding                      # arms A,B,C, 1 run, $10 cap
 *   pnpm --filter server eval:doc-understanding --arms A,B --runs 3
 *   pnpm --filter server eval:doc-understanding --corpus docunderstanding-01-clinic-booking
 *   pnpm --filter server eval:doc-understanding --reading baseline-sonnet   # also write eval-data/readings/doc-understanding/
 *   pnpm --filter server eval:doc-understanding --combine a.json,b.json --reading baseline-sonnet   # no model call
 *
 * A slow model may not read the whole corpus in one sitting: run one
 * `--corpus` (or one `--arms`) at a time, then `--combine` the reports into
 * one reading.
 *
 * Arms (see `src/lib/eval/doc-understanding/arms.ts`): A is today's document
 * agent over 10 retrieved chunks; B is the whole document in one call; C reads
 * section by section with a document summary, glossary and actors, then
 * reduces. Arms are chosen ONLY by `--arms`; no environment flag changes what
 * is measured.
 *
 * Every arm and the judge call a model through the configured provider
 * (`AI_PROVIDER` and its key: DeepSeek through the Anthropic-compatible
 * endpoint for iteration, `claude-sonnet-5-5` for a decision run). Nothing
 * else is reached: the documents and labels are committed files and retrieval
 * is in-process BM25. The offline stub is refused.
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
import { gitProvenance } from "../src/lib/eval/governing/git-provenance.js";
import { buildDocArms, parseDocArmIds } from "../src/lib/eval/doc-understanding/arms.js";
import {
  DOC_UNDERSTANDING_CORPORA,
  loadDocUnderstandingCorpus,
} from "../src/lib/eval/doc-understanding/corpus.js";
import {
  DEFAULT_DOC_BUDGET_USD,
  DEFAULT_DOC_RUNS,
  DEFAULT_SECTION_CONCURRENCY,
  combineReports,
  runDocUnderstandingEval,
  type DocUnderstandingReport,
  toJsonReport,
  toMarkdownReport,
} from "../src/lib/eval/doc-understanding/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** A reading name: letters, digits, dots, dashes and underscores only (it becomes a file name). */
function readingName(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(raw)) {
    throw new Error(
      `--reading must be letters, digits, ".", "-" or "_", not ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const armIds = parseDocArmIds(flagValue(argv, "arms") ?? flagValue(argv, "arm"));
  const runs = positiveInteger(flagValue(argv, "runs"), DEFAULT_DOC_RUNS, "runs");
  const budgetUsd = nonNegativeNumber(flagValue(argv, "budget"), DEFAULT_DOC_BUDGET_USD, "budget");
  const concurrency = positiveInteger(
    flagValue(argv, "concurrency"),
    DEFAULT_SECTION_CONCURRENCY,
    "concurrency",
  );
  const names = (flagValue(argv, "corpus") ?? DOC_UNDERSTANDING_CORPORA.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rawReading = flagValue(argv, "reading");
  const reading = rawReading ? readingName(rawReading) : undefined;
  const combine = flagValue(argv, "combine");
  if (combine) {
    const sources = combine
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    const saved = await Promise.all(
      sources.map(
        async (f) => JSON.parse(await readFile(path.resolve(f), "utf8")) as DocUnderstandingReport,
      ),
    );
    if (reading && saved.some((r) => r.provenance.dirty !== false)) {
      throw new Error("--reading needs every combined run to come from a clean tree");
    }
    // `--arms` keeps only those arms of each report (one setting per arm in a reading).
    const keep = new Set(
      flagValue(argv, "arms") || flagValue(argv, "arm")
        ? armIds
        : saved.flatMap((r) => r.arms.map((a) => a.id)),
    );
    const kept = saved.map((r) => ({ ...r, arms: r.arms.filter((a) => keep.has(a.id as never)) }));
    await writeOut(combineReports(kept), reading, argv.includes("--md"));
    return;
  }
  const items = await loadDocUnderstandingCorpus(names);

  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const live = buildProvider({ config: loadAIConfig() });
  if (live.offline) {
    throw new Error(
      "every arm and the judge call a model: set AI_PROVIDER and its key (the offline stub would score zero under a real arm's label)",
    );
  }
  const model = `${live.key}/${live.model}`;
  console.log(`arms ${armIds.join(",")} and the judge call ${model}`);
  const provenance = gitProvenance(REPO_ROOT);
  console.log(
    `at ${provenance.commit ?? "an unknown commit"}${provenance.dirty ? " (uncommitted changes)" : ""}`,
  );
  if (reading && provenance.dirty !== false) {
    throw new Error("--reading needs a clean tree, so the commit names the code that ran");
  }

  const report = await runDocUnderstandingEval(items, {
    arms: buildDocArms(armIds, model),
    runs,
    budget: new EvalBudget(budgetUsd),
    provider: live,
    sectionConcurrency: concurrency,
    provenance,
    log: (line) => console.log(line),
  });
  await writeOut(report, reading, argv.includes("--md"));
}

/** Write the report to eval-results, and to the readings when `reading` names one. */
async function writeOut(
  report: DocUnderstandingReport,
  reading: string | undefined,
  printMd: boolean,
): Promise<void> {
  const json = toJsonReport(report, { generatedAt: new Date().toISOString() });
  const md = toMarkdownReport(report);
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const base = path.join(
    resultsDir,
    `doc-understanding-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await writeFile(`${base}.json`, json, "utf8");
  await writeFile(`${base}.md`, md, "utf8");
  console.log(`report → ${base}.{json,md}`);
  if (reading) {
    if (report.stopped) throw new Error("the run stopped early; not writing a reading");
    const dir = path.join(REPO_ROOT, "eval-data", "readings", "doc-understanding");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${reading}.json`), json, "utf8");
    await writeFile(path.join(dir, `${reading}.md`), md, "utf8");
    console.log(`reading → ${path.join(dir, reading)}.{json,md}`);
  }
  if (printMd) console.log(md);
  console.log(`spent $${report.spentUsd.toFixed(4)} (judge $${report.judgeSpentUsd.toFixed(4)})`);
  if (report.stopped) {
    console.log(`stopped early: ${report.stopped.reason}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
