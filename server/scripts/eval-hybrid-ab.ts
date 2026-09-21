/**
 * #335 (Epic #331, Phase 4) — `pnpm eval:domain:ab` entrypoint.
 *
 * The hybrid A/B ROLLOUT GATE: runs the SAME fixture corpus through two docs-gen
 * configurations and emits a pass/fail verdict that gates flipping the #333/#334
 * defaults ON:
 *   Arm A — "all-Sonnet" (baseline): hybrid routing OFF (everything cloud).
 *   Arm B — "local+escalation" (candidate): hybrid routing ON + judge-gated
 *           escalation ON (literal/reconstruction → local, narrative → cloud,
 *           below-threshold local sections re-run on the cloud provider).
 *
 * Output: a human comparison table (stdout) + a machine-readable JSON summary
 * (written to `eval-results/hybrid-ab-<runId>.json`, also echoed with
 * `--json`). Exit code is NON-ZERO when the gate FAILS, so it can gate a rollout
 * in CI or a manual run.
 *
 *   pnpm eval:domain:ab            # run live (requires local + cloud providers)
 *   pnpm eval:domain:ab --json     # also print the JSON summary to stdout
 *   pnpm eval:domain:ab --no-fail  # always exit 0 (exploration)
 *
 * IMPORTANT: this operator tool talks to REAL providers. It is NOT run in CI —
 * CI exercises the aggregation/gate LOGIC with a mocked evaluator (see
 * `src/lib/eval/hybrid-ab/*.test.ts`). This file is coverage-excluded like the
 * other operator scripts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAbEval } from "../src/lib/eval/hybrid-ab/runner.js";
import { renderAbReport } from "../src/lib/eval/hybrid-ab/report.js";
import { DEFAULT_AB_CORPUS } from "../src/lib/eval/hybrid-ab/corpus.js";
import {
  createLiveSectionEvaluator,
  type LiveSectionInput,
} from "../src/lib/eval/hybrid-ab/live-evaluator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Live corpus resolution. The default checked-in corpus has no committed source
 * text (it is a shape fixture), so an operator running this against real
 * projects should replace this resolver with one that returns the section's real
 * prompt + grounding. Left minimal so the script is runnable end-to-end.
 */
function resolveSection(sectionId: string): LiveSectionInput {
  return {
    prompt: `Synthesize documentation section "${sectionId}" from the project facts.`,
    grounding: { sources: [], sourceIds: new Set<string>(), isEmpty: true },
  };
}

async function main() {
  const failOnGate = !process.argv.includes("--no-fail");
  const echoJson = process.argv.includes("--json");
  const commit = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null;

  const evaluate = createLiveSectionEvaluator({ resolveSection });
  const result = await runAbEval({ corpus: DEFAULT_AB_CORPUS, evaluate, commit });

  // eslint-disable-next-line no-console
  console.log(renderAbReport(result));

  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await fs.mkdir(resultsDir, { recursive: true });
  const runId = result.startedAt.replace(/[:.]/g, "-");
  const outPath = path.join(resultsDir, `hybrid-ab-${runId}.json`);
  await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
  // eslint-disable-next-line no-console
  console.log(`\nJSON summary → ${outPath}`);
  if (echoJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  }

  if (!result.verdict.passed && failOnGate) {
    // eslint-disable-next-line no-console
    console.error(
      "Rollout gate FAILED — do NOT flip DOCS_GEN_HYBRID_ROUTING / DOCS_GEN_JUDGE_ESCALATION defaults.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:domain:ab failed:", err);
  process.exit(1);
});
