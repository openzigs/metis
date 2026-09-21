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
 *
 * This file is thin orchestration; all logic lives in the unit-tested
 * `src/lib/eval/reqmap/*` modules.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReqMapFixture } from "../src/lib/eval/reqmap/fixture.js";
import { checkThresholds, runReqMapEval } from "../src/lib/eval/reqmap/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const failOnBreak = !process.argv.includes("--no-fail");
  const fixture = await loadReqMapFixture();
  const { scores, aggregate } = await runReqMapEval(fixture);
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
    `Requirement→code mapping eval — cases=${aggregate.caseCount} ` +
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
