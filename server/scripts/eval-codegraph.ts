/**
 * Epic #712 / Issue #717 — `pnpm eval:codegraph` entrypoint.
 *
 * Reproducible, OFFLINE eval that proves a project-scoped question about a known
 * symbol returns a citable `filePath:startLine-endLine` answer from the code
 * graph. It follows the domain-eval convention (`eval:domain`): a deterministic
 * offline provider (no network / API key / gateway), a self-contained fixture
 * (synthesized micro-repo parsed by METIS's own parser — no external ingestion),
 * and a JSON result written to `eval-results/`.
 *
 *   pnpm eval:codegraph            # fail (exit 1) if the citation assertion breaks
 *   pnpm eval:codegraph --no-fail  # always exit 0 (local exploration)
 *
 * This file is thin orchestration; all logic lives in the unit-tested
 * `src/lib/eval/codegraph/*` modules.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCodegraphFixture } from "../src/lib/eval/codegraph/fixture.js";
import { createCitationEvalProvider } from "../src/lib/eval/codegraph/offline-provider.js";
import { runCodegraphCitationEval } from "../src/lib/eval/codegraph/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const failOnBreak = !process.argv.includes("--no-fail");
  const fixture = await loadCodegraphFixture();
  const provider = createCitationEvalProvider();

  const on = await runCodegraphCitationEval({ fixture, provider, enabled: true });
  const off = await runCodegraphCitationEval({ fixture, provider, enabled: false });

  const checks = {
    flagOnCites: on.cited,
    flagOnNoDisclaimer: on.disclaimer === null,
    flagOnRanTool: on.toolCalls.some((c) => c.tool === "search_code_symbols"),
    flagOffUncited: !off.cited,
    flagOffLegacyDisclaimer: off.disclaimer !== null,
  };
  const passed = Object.values(checks).every(Boolean);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `codegraph-${runId}.json`);
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        kind: "code-graph-citation",
        fixture: fixture.spec.id,
        question: fixture.spec.question,
        expectedLocator: on.expectedLocator,
        passed,
        checks,
        flagOn: { answer: on.answer, toolCalls: on.toolCalls, fusedStats: on.fusedStats },
        flagOff: { answer: off.answer },
        commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // eslint-disable-next-line no-console
  console.log(
    `Code-graph citation eval — locator=${on.expectedLocator} ` +
      `cited=${on.cited} tool=${checks.flagOnRanTool} ` +
      `flagOff-uncited=${checks.flagOffUncited} → ${resultPath}`,
  );

  if (!passed) {
    // eslint-disable-next-line no-console
    console.error("Code-graph citation eval FAILED:", JSON.stringify(checks));
    if (failOnBreak) process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:codegraph failed:", err);
  process.exit(1);
});
