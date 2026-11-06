/**
 * Issue #1836 — `pnpm --filter @metis/server eval:req-similarity` entrypoint.
 *
 * Embeds every labelled requirement pair in
 * `src/lib/eval/requirement-similarity/__fixtures__/pairs.json` with the
 * CONFIGURED embedder (`getEmbedder()`, the one the requirement index uses),
 * then prints precision, recall and F1 for "duplicate" and for "duplicate or
 * overlap" at thresholds 0.80-0.98, and the threshold with the highest
 * precision at recall >= 0.6.
 *
 *   pnpm --filter @metis/server eval:req-similarity
 *   pnpm --filter @metis/server eval:req-similarity -- --fixture <path> --json <out.json>
 *
 * No LLM call. The fixture is validated BEFORE the embedder is loaded: a missing
 * or malformed fixture exits 2 having computed nothing. The chosen thresholds are
 * committed by hand to `src/lib/requirements/requirement-similarity-config.ts`,
 * with the run cited.
 *
 * Thin orchestration; the logic is the unit-tested `calibration.ts`.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/lib/rag/embedder.js";
import {
  loadRequirementPairs,
  PairFixtureError,
  renderCalibrationReport,
  runCalibration,
} from "../src/lib/eval/requirement-similarity/calibration.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.join(
  here,
  "..",
  "src",
  "lib",
  "eval",
  "requirement-similarity",
  "__fixtures__",
  "pairs.json",
);

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const fixture = argValue("--fixture") ?? DEFAULT_FIXTURE;
  let pairs;
  try {
    pairs = await loadRequirementPairs(fixture);
  } catch (err) {
    if (err instanceof PairFixtureError) {
      process.stderr.write(`eval:req-similarity: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const embedder = getEmbedder();
  const report = await runCalibration(pairs, (texts) => embedder.embed(texts));
  if (embedder.fellBack) {
    process.stderr.write(
      "eval:req-similarity: the embedder fell back to the hash stub; scores are not semantic\n",
    );
    return 1;
  }
  process.stdout.write(`${renderCalibrationReport(report)}\n`);
  const out = argValue("--json");
  if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${String(err instanceof Error ? (err.stack ?? err.message) : err)}\n`);
    process.exit(1);
  },
);
