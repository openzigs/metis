import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run the private-vocabulary gate over this repository's WHOLE tree once, before the
 * test pool starts, and hand the result to the test that asserts on it (#99).
 *
 * That acceptance arm cannot be made smaller: "no private term anywhere in the tree"
 * is a claim about every tracked file. It measured 1.9 s idle and 8.1 s under the
 * suite's own parallelism, against vitest's 5 s per-test default — a red `scripts` job
 * that meant "the machine was busy", indistinguishable at a glance from one that meant
 * a term came back. Raising the timeout only moves that flake to a larger tree.
 *
 * So the scan moves out of the timed, parallel pool instead. Global setup runs before
 * any test worker exists, with no per-test timeout, so the scan competes with none of
 * this package's test files and takes as long as the tree needs. The test itself only
 * reads the result, and still fails when the gate does. `HANG_GUARD_MS` is not a
 * performance budget: it exists so a genuinely hung gate ends the run with a message
 * rather than never, and it is set two orders of magnitude above the measurement.
 *
 * The environment is inherited on purpose: the arm's contract is "whatever list this
 * environment has", exactly as before.
 *
 * @param {import("vitest/node").TestProject} project
 */
export default function setup(project) {
  project.provide("wholeTreeIdentifierScan", scanWholeTree());
}

const HANG_GUARD_MS = 300_000;

/** @returns {{ status: number | null, output: string, error: string | null }} */
export function scanWholeTree() {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const result = spawnSync(
    process.execPath,
    [path.join(scriptsDir, "verify-no-company-identifiers.mjs")],
    { cwd: path.join(scriptsDir, ".."), encoding: "utf8", timeout: HANG_GUARD_MS },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error ? String(result.error.message) : null,
  };
}
