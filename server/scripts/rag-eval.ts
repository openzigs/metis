/**
 * Epic #157 — RAGAS evaluation runner.
 *
 * Loads the golden set from `server/eval/rag-golden.jsonl`, runs the judge
 * resolved by `resolveRagasJudgeForRun` (the deterministic STUB unless
 * `RAGAS_JUDGE=model` — #1317), optionally compares against a baseline file at
 * `coverage/ragas-baseline.json`, and writes the result to
 * `coverage/ragas-results.json`.
 *
 *   pnpm rag:eval                 # stub judge — offline, hermetic, free
 *   RAGAS_JUDGE=model pnpm rag:eval   # real evaluator model (needs credentials)
 *
 * Exit status 0 when no regression > REGRESSION_THRESHOLD, else 1 (so the CI
 * job fails). Pass `--no-fail` for a soft mode that always exits 0.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ragasResultSchema } from "@metis/shared";
import { buildProvider, loadAIConfig } from "../src/lib/ai/index.js";
import { resolveRagasJudgeForRun } from "../src/lib/rag/model-ragas-judge.js";
import { type RagasFixture, REGRESSION_THRESHOLD, runEval } from "../src/lib/rag/ragas.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "..");
const GOLDEN = path.join(SERVER_ROOT, "eval", "rag-golden.jsonl");
const COVERAGE = path.join(SERVER_ROOT, "coverage");
const RESULT_FILE = path.join(COVERAGE, "ragas-results.json");
const BASELINE_FILE = path.join(COVERAGE, "ragas-baseline.json");

async function loadFixtures(): Promise<RagasFixture[]> {
  const raw = await readFile(GOLDEN, "utf8");
  const out: RagasFixture[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RagasFixture);
    } catch {
      // skip malformed line — surfaced via fixture count diff
    }
  }
  return out;
}

async function loadBaseline() {
  try {
    const raw = await readFile(BASELINE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const ok = ragasResultSchema.safeParse(parsed);
    if (ok.success) return ok.data.current;
  } catch {
    // No baseline yet — fresh installs skip the regression check.
  }
  return null;
}

async function main() {
  const fixtures = await loadFixtures();
  const baseline = await loadBaseline();
  // #1317 — the STUB is the default. `buildProvider` is a THUNK, called only
  // when `RAGAS_JUDGE=model` is set, so a default run never reads credentials
  // and stays hermetic, offline and free. Passing the thunk rather than nothing
  // is what makes the flag actually reachable from this script.
  const judge = resolveRagasJudgeForRun({
    buildProvider: () => buildProvider({ config: loadAIConfig() }),
  });
  // eslint-disable-next-line no-console
  console.log(`RAGAS — judge=${judge.constructor.name}`);
  const result = await runEval({ fixtures, baseline, judge });
  await mkdir(COVERAGE, { recursive: true });
  await writeFile(RESULT_FILE, JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `RAGAS — fixtures=${result.fixtures} current=${JSON.stringify(result.current)} ` +
      `scored=${JSON.stringify(result.scored)} unverifiable=${JSON.stringify(result.unverifiable)} ` +
      `regressions=${result.regressions.length}`,
  );
  const failOnRegression = !process.argv.includes("--no-fail");
  if (failOnRegression && result.regressions.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `FAIL — ${result.regressions.length} regressions > ${REGRESSION_THRESHOLD}: ${JSON.stringify(result.regressions)}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("rag-eval failed:", err);
  process.exit(1);
});
