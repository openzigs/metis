/**
 * #954 — argv handling for `scripts/walkthrough/fixes-since.mjs`, with its I/O injected so the
 * tests drive it on fixtures. The decisions live in `./walkthrough-fixes-core.mjs`; this module
 * reads the files, picks the mode and decides the exit code.
 *
 * Two modes:
 *
 *   fixes-since --out <fixes.json> [--since <sha>] [--previous <run.json>]
 *               [--map <fix-phase-map.json>] [--comment <scope.md> --run <N>]
 *     List the fixes to verify: PRs merged since `--since` (default: the previous run's
 *     `metisSha`), placed by the map, plus the previous run's unconfirmed fixes.
 *
 *   fixes-since --close-list <run.json>
 *     After a run: the issues it confirmed that are still open.
 */

import { parseRunInfo } from "./walkthrough-slideshow-core.mjs";
import {
  collectFixes,
  confirmedOpenIssues,
  fixLine,
  parsePhaseMap,
  renderScopeComment,
} from "./walkthrough-fixes-core.mjs";

export const FIX_PHASE_MAP_PATH = "docs/walkthroughs/fix-phase-map.json";

export const USAGE =
  "Usage: fixes-since.mjs --out <fixes.json> [--since <sha>] [--previous <run.json>]\n" +
  "                       [--map <fix-phase-map.json>] [--comment <scope.md> --run <N>]\n" +
  "       fixes-since.mjs --close-list <run.json>";

/**
 * @typedef {object} CliIo
 * @property {(args: string[]) => string} git
 * @property {(args: string[]) => string} gh
 * @property {(file: string) => string} readFile
 * @property {(file: string, text: string) => void} writeFile
 * @property {(msg: string) => void} log
 * @property {(msg: string) => void} error
 */

const VALUE_FLAGS = new Set([
  "--out",
  "--since",
  "--previous",
  "--map",
  "--comment",
  "--run",
  "--close-list",
]);

/**
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string>, error: string | null }}
 */
export function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!VALUE_FLAGS.has(arg)) return { flags, error: `unknown argument "${arg}"` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { flags, error: `${arg} needs a value` };
    }
    flags[arg] = value;
    i++;
  }
  return { flags, error: null };
}

/**
 * Read and validate a `run.json`.
 *
 * @param {CliIo} io
 * @param {string} file
 */
function readRun(io, file) {
  const parsed = parseRunInfo(io.readFile(file));
  if (parsed.errors.length > 0 || !parsed.run) {
    throw new Error(`invalid ${file}:\n  ${parsed.errors.join("\n  ")}`);
  }
  return parsed.run;
}

/**
 * @param {string[]} argv
 * @param {CliIo} io
 * @returns {number} exit code: 0 done, 1 failed, 2 bad arguments
 */
export function runFixesSince(argv, io) {
  const { flags, error } = parseFlags(argv);
  if (error) {
    io.error(`${error}\n${USAGE}`);
    return 2;
  }
  try {
    if (flags["--close-list"] !== undefined) {
      const run = readRun(io, flags["--close-list"]);
      const open = confirmedOpenIssues(run, io);
      io.log(
        open.length
          ? `Confirmed and still open — close each with a link to the results comment:\n${open.map((n) => `  #${n}`).join("\n")}`
          : "No confirmed issue is still open.",
      );
      return 0;
    }
    if (flags["--out"] === undefined) {
      io.error(`--out is required\n${USAGE}`);
      return 2;
    }
    if (flags["--comment"] !== undefined && flags["--run"] === undefined) {
      io.error(`--comment needs --run <N> for its heading\n${USAGE}`);
      return 2;
    }

    const previousRun = flags["--previous"] ? readRun(io, flags["--previous"]) : null;
    const since = flags["--since"] ?? previousRun?.metisSha;
    if (!since) {
      io.error(`--since is required when --previous has no "metisSha"\n${USAGE}`);
      return 2;
    }
    const mapPath = flags["--map"] ?? FIX_PHASE_MAP_PATH;
    const parsedMap = parsePhaseMap(io.readFile(mapPath));
    if (!parsedMap.map) throw new Error(`invalid ${mapPath}:\n  ${parsedMap.errors.join("\n  ")}`);

    const doc = collectFixes({ since, map: parsedMap.map, previousRun, io });
    io.writeFile(flags["--out"], `${JSON.stringify(doc, null, 2)}\n`);
    if (flags["--comment"] !== undefined) {
      io.writeFile(flags["--comment"], renderScopeComment(doc, { run: flags["--run"] }));
    }

    const carried = doc.fixes.filter((f) => f.carried).length;
    io.log(
      `${doc.fixes.length} fix(es) to verify (${carried} carried forward from the previous run), ` +
        `${doc.excluded.length} excluded by the map, ${doc.skipped.length} PR(s) not walkthrough-relevant, ` +
        `${doc.dependabot.length} Dependabot PR(s). ` +
        `Wrote ${flags["--out"]}.`,
    );
    for (const fix of doc.fixes) io.log(`  [${fix.wave}] ${fixLine(fix).slice(2)}`);
    for (const d of doc.dependabot.filter((x) => x.runtime)) {
      io.log(`Runtime dependency bump: PR #${d.pr} ${d.title}`);
    }
    for (const c of doc.noPr) io.log(`First-parent commit with no PR number: ${c}`);
    if (doc.unmapped.length > 0) {
      io.error(
        `\n${doc.unmapped.length} relevant PR(s) the map does not place. Add each to ${mapPath}` +
          " (by issue or PR) and re-run, or move it into fixes[] by hand; fill-brief refuses a" +
          " fixes.json with unmapped entries:",
      );
      for (const u of doc.unmapped) {
        const closes = u.issues.length
          ? ` (closes ${u.issues.map((n) => `#${n}`).join(", ")})`
          : "";
        io.error(`  PR #${u.pr}${closes}: ${u.title} — ${u.reason}`);
      }
    }
    return 0;
  } catch (err) {
    io.error(`fixes-since failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
