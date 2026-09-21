/**
 * Epic #157 — Red-team CI runner.
 *
 *   pnpm red-team
 *
 * Loads fixtures from `server/eval/red-team/`, runs the default defense, and
 * exits 1 if the failure count exceeds RED_TEAM_MAX_FAILURES (default 0).
 * Writes the report to `coverage/red-team-results.json`.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures, runRedTeam } from "../src/lib/rag/red-team-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "..");
const FIXTURE_ROOT = path.join(SERVER_ROOT, "eval", "red-team");
const RESULT_FILE = path.join(SERVER_ROOT, "coverage", "red-team-results.json");

async function main() {
  const fixtures = await loadFixtures(FIXTURE_ROOT);
  const report = runRedTeam({ fixtures });
  await mkdir(path.dirname(RESULT_FILE), { recursive: true });
  await writeFile(RESULT_FILE, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `RED-TEAM — total=${report.total} passed=${report.passed} failed=${report.failed} score=${report.score.toFixed(3)}`,
  );
  const maxFailures = Number.parseInt(process.env.RED_TEAM_MAX_FAILURES ?? "0", 10);
  if (report.failed > maxFailures) {
    // eslint-disable-next-line no-console
    console.error(
      `FAIL — ${report.failed} failures > RED_TEAM_MAX_FAILURES=${maxFailures}\n` +
        report.attacks
          .filter((a) => !a.pass)
          .map((a) => `  • ${a.attack}: ${a.observed}`)
          .join("\n"),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("red-team runner failed:", err);
  process.exit(1);
});
