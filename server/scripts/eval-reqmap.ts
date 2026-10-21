/**
 * Epic #726 / Issue #738 — `pnpm eval:reqmap` entrypoint.
 *
 * Reproducible, OFFLINE eval that scores the deterministic requirement→code
 * mapping path (`mapRequirementToCode` + `blastRadius` via `computeProjectImpact`
 * — the #735 analysis path) for file-level precision/recall against a set of
 * replayed PRs whose changed-file lists are committed as a self-contained
 * fixture. Follows the #717 `eval:codegraph` convention: no network / API key /
 * gateway / DB, a synthesized micro-repo parsed by METIS's own parser, and a
 * JSON result written to `eval-results/`.
 *
 *   pnpm eval:reqmap            # fail (exit 1) if the aggregate drops below the floor
 *   pnpm eval:reqmap --no-fail  # always exit 0 (local exploration)
 *   pnpm eval:reqmap --searcher bm25   # the keyword fallback arm (#1097)
 *   pnpm eval:reqmap --record-vectors  # re-record the fixture's vectors (local model)
 *
 * #1097 — the default arm is production's: the hybrid search (BM25 fused with
 * symbol embeddings) over the fixture's RECORDED vectors
 * (`vectors.gte-modernbert-base.json`, `src/lib/eval/recorded-vectors.ts`), so
 * no model is loaded. `--record-vectors` runs the hybrid arm with the local
 * `gte-modernbert-base` weights (`TRANSFORMERS_CACHE`, no network, no paid
 * model) and writes the file.
 *
 * This file is thin orchestration; all logic lives in the unit-tested
 * `src/lib/eval/reqmap/*` modules.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMemoizingBm25Searcher,
  defaultReqMapVectorsFile,
  loadReqMapFixture,
  type ReqMapFixture,
} from "../src/lib/eval/reqmap/fixture.js";
import { checkThresholds, runReqMapEval } from "../src/lib/eval/reqmap/runner.js";
import {
  buildEvalHybridSearcher,
  loadRecordedVectors,
  RecordedEmbedService,
  RecordingEmbedService,
  assertFullyRecorded,
  writeRecordedVectors,
} from "../src/lib/eval/recorded-vectors.js";
import {
  ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
  type CodeSymbolSearcher,
} from "../src/lib/traceability/requirement-code-mapping.js";

const RERECORD = "pnpm eval:reqmap --record-vectors";

/** `--searcher <hybrid|bm25>`, default hybrid (production's ranking since #1097). */
function searcherArm(argv: string[]): "hybrid" | "bm25" {
  const i = argv.indexOf("--searcher");
  return i !== -1 && argv[i + 1] === "bm25" ? "bm25" : "hybrid";
}

/** The replay's recorded embedder, checked after the run (`assertFullyRecorded`). */
let replayEmbed: RecordedEmbedService | null = null;

async function hybridSearcher(
  fixture: ReqMapFixture,
  record: RecordingEmbedService | null,
): Promise<CodeSymbolSearcher> {
  let embed;
  let model;
  if (record) {
    const { getEmbedder } = await import("../src/lib/rag/embedder.js");
    model = getEmbedder().model;
    embed = record;
  } else {
    const recording = await loadRecordedVectors(defaultReqMapVectorsFile());
    if (!recording) throw new Error(`no recorded vectors; record them with: ${RERECORD}`);
    model = recording.model;
    replayEmbed = new RecordedEmbedService(recording, RERECORD);
    embed = replayEmbed;
  }
  return buildEvalHybridSearcher({
    symbols: fixture.embeddable,
    bm25: buildMemoizingBm25Searcher(fixture.symbols),
    // The analysis path's link rules for each ranking (#1097).
    hybridOptions: ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
    embed,
    model,
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const failOnBreak = !process.argv.includes("--no-fail");
  const arm = searcherArm(process.argv);
  const fixture = await loadReqMapFixture();
  let record: RecordingEmbedService | null = null;
  if (process.argv.includes("--record-vectors")) {
    const { getEmbedder } = await import("../src/lib/rag/embedder.js");
    record = new RecordingEmbedService(getEmbedder());
  }
  const searcher = arm === "bm25" ? fixture.searcher : await hybridSearcher(fixture, record);
  const { scores, aggregate } = await runReqMapEval(fixture, searcher);
  if (replayEmbed) assertFullyRecorded(replayEmbed);
  if (record) {
    const file = defaultReqMapVectorsFile();
    const recorded = record.toFiles(
      "Recorded by `pnpm eval:reqmap --record-vectors` (#1097): the fixture's symbol texts and case queries, embedded by the local model.",
    );
    await writeRecordedVectors(file, recorded);
    // eslint-disable-next-line no-console
    console.log(`recorded ${recorded.file.keys.length} vectors (${recorded.file.model}) → ${file}`);
  }
  const { passed, checks } = checkThresholds(aggregate);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `reqmap-${runId}.json`);
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        kind: "requirement-code-mapping",
        fixture: fixture.spec.id,
        searcher: arm,
        passed,
        thresholds: checks,
        aggregate,
        cases: scores.map((s) => ({
          id: s.id,
          precision: s.precision,
          recall: s.recall,
          f1: s.f1,
          predicted: s.predicted,
          actual: s.actual,
          falsePositives: s.falsePositives,
          falseNegatives: s.falseNegatives,
        })),
        commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // eslint-disable-next-line no-console
  console.log(
    `Requirement→code mapping eval [${arm}] — cases=${aggregate.caseCount} ` +
      `macroP=${aggregate.macroPrecision.toFixed(2)} macroR=${aggregate.macroRecall.toFixed(2)} ` +
      `macroF1=${aggregate.macroF1.toFixed(2)} hitRate=${aggregate.hitRate.toFixed(2)} ` +
      `→ ${passed ? "PASS" : "FAIL"} (${resultPath})`,
  );

  if (!passed) {
    const failed = checks.filter((c) => !c.passed);
    // eslint-disable-next-line no-console
    console.error("Requirement→code mapping eval FAILED:", JSON.stringify(failed));
    if (failOnBreak) process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:reqmap failed:", err);
  process.exit(1);
});
