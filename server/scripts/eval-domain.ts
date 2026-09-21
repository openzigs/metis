/**
 * Epic #803 (Epic 09) — `pnpm eval:domain` entrypoint.
 *
 * Runs the BA-pipeline regression suite against the golden corpus in
 * `eval-data/`, writes `eval-results/<runId>.json`, dispatches a drift alert
 * through the existing notification channel when corpus F1 drops > 5%
 * week-over-week, and exits non-zero on drift so CI flags the build.
 *
 *   pnpm eval:domain            # fail (exit 1) on drift
 *   pnpm eval:domain --no-fail  # always exit 0 (local exploration)
 *
 * The corpus is auto-discovered, so adding `eval-data/corpus/<id>/source.md` +
 * `expected.json` is picked up on the next run with no code change.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineExtractor } from "../src/lib/eval/domain/extractor.js";
import { runDomainEval } from "../src/lib/eval/domain/runner.js";
import { dispatchDriftAlert } from "../src/lib/eval/domain/drift-alert.js";
import { describeBaselineStaleness } from "@metis/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const failOnDrift = !process.argv.includes("--no-fail");
  const commit = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null;

  const { result, resultPath } = await runDomainEval({
    extractor: createOfflineExtractor(),
    corpus: { dir: path.join(REPO_ROOT, "eval-data") },
    resultsDir: path.join(REPO_ROOT, "eval-results"),
    commit,
  });

  // eslint-disable-next-line no-console
  console.log(
    `Domain Eval — items=${result.itemCount} ` +
      `F1=${(result.corpusF1 * 100).toFixed(1)}% ` +
      `P=${(result.corpusPrecision * 100).toFixed(1)}% ` +
      `R=${(result.corpusRecall * 100).toFixed(1)}% ` +
      `ROUGE-L=${(result.meanRougeL * 100).toFixed(1)}% ` +
      `→ ${resultPath}`,
  );

  // #1333 — the drift verdict has to be readable in the nightly's own job
  // summary, caveat included. `drift.reason` already carries the staleness
  // sentence; this puts it somewhere a human will actually look.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const staleness = describeBaselineStaleness(result.drift);
    try {
      appendFileSync(
        summaryPath,
        [
          "### Domain eval drift verdict",
          "",
          `- Run \`${result.runId}\` — corpus F1 ${(result.corpusF1 * 100).toFixed(1)}%`,
          `- Verdict: ${result.drift.alert ? "**DRIFT**" : "within threshold"}`,
          `- ${result.drift.reason}`,
          ...(staleness ? ["", `> :warning: ${staleness}`] : []),
          "",
        ].join("\n"),
      );
    } catch {
      // A summary that cannot be written must not change the run's outcome.
    }
  }

  if (result.drift.alert) {
    const outcome = await dispatchDriftAlert(result);
    // eslint-disable-next-line no-console
    console.error(
      `DRIFT — ${result.drift.reason.replace(/\.$/, "")}. ` +
        `Alert dispatched=${outcome.dispatched} (${outcome.reason}).`,
    );
    if (failOnDrift) process.exit(1);
  } else {
    // `drift.reason` may already end in a full stop (the #1333 staleness
    // sentence does), so do not append a second one.
    // eslint-disable-next-line no-console
    console.log(`Drift check — ${result.drift.reason.replace(/\.$/, "")}.`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:domain failed:", err);
  process.exit(1);
});
