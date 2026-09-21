/**
 * Issue #1333 — decision core for the nightly eval-results commit guard.
 *
 * ## The defect this exists to make impossible
 *
 * Since #1382 the envelopes are published to the dedicated `eval-results` BRANCH
 * rather than to `main` (ADR 0015), and the runner mounts that branch as a worktree
 * at `eval-results/` so this core's question is unchanged: for each required output,
 * is there a NEW file on disk that git will accept? Only the repository answering it
 * moved.
 *
 * `eval-domain-nightly.yml` used to decide whether it had anything to commit
 * with:
 *
 * ```bash
 * if [ -z "$(git status --porcelain eval-results)" ]; then
 *   echo "No new domain eval results to commit."; exit 0
 * fi
 * ```
 *
 * `git status --porcelain` does not list ignored files. `eval-results/` went
 * into `.gitignore` on 2026-07-21 (#983), so from that day a freshly written
 * `eval-results/<runId>.json` produced an empty string, the guard printed
 * "No new domain eval results" and exited 0. Five weeks of nightly envelopes
 * were produced and discarded, with a green job every night — and
 * `drift-alert` spent those five weeks comparing against a history frozen on
 * the day the ignore rule landed.
 *
 * ## The rule this core encodes
 *
 * **An empty result set is a FAILURE, never a no-op.** The nightly's job is to
 * produce envelopes; producing none means something broke. So the guard asks a
 * different question from the old one: not "is anything dirty?" but "for each
 * output the nightly is required to produce, is there a NEW file on disk that
 * git will actually accept?" Three distinct answers fail, each with its own
 * message:
 *
 * - `ignored`   — written, but an ignore rule would discard it (the #1333 bug).
 * - `unchanged` — only a tracked file from a previous run is on disk. The
 *                 runner checks out fresh, so history is always present; it
 *                 must never stand in for this run's output.
 * - `missing`   — nothing matching was written at all.
 *
 * The core is pure so every one of those arms is unit-testable; the runner
 * (`scripts/eval-results-commit-guard.mjs`) supplies the filesystem walk and
 * the `git status` output.
 */

/** The directory the nightly writes into, relative to the repository root. */
export const EVAL_RESULTS_DIR = "eval-results";

/**
 * The outputs the nightly workflow is required to produce on every run.
 *
 * `domain` is `eval-results/<runId>.json`, where `runId` is the ISO-ish UTC
 * timestamp `makeRunId` builds — hence the leading-digit test, which keeps the
 * ad-hoc harness artifacts that share the directory (`embed-retrieval-*`,
 * `hybrid-ab-*`, `impact-feedback-harvest-*`, …) out of the required set. Those
 * are local run outputs and stay ignored; see ADR 0012.
 *
 * `answer-correctness` is #1319's fragment, deliberately in a subdirectory so
 * `loadAllRuns` (which parses every top-level `*.json` as a domain envelope)
 * never sees it.
 *
 * @type {ReadonlyArray<{ id: string, label: string, match: (path: string) => boolean }>}
 */
export const NIGHTLY_REQUIRED_OUTPUTS = Object.freeze([
  Object.freeze({
    id: "domain",
    label: `domain eval envelope (${EVAL_RESULTS_DIR}/<runId>.json)`,
    /** @param {string} p */
    match: (p) => new RegExp(`^${EVAL_RESULTS_DIR}/[0-9][^/]*\\.json$`).test(p),
  }),
  Object.freeze({
    id: "answer-correctness",
    label: `answer-correctness envelope (${EVAL_RESULTS_DIR}/answer-correctness/*.json)`,
    /** @param {string} p */
    match: (p) => new RegExp(`^${EVAL_RESULTS_DIR}/answer-correctness/[^/]+\\.json$`).test(p),
  }),
]);

/** Porcelain status codes that mean "git will take this in a commit". */
const COMMITTABLE_CODES = new Set(["??", "A ", "AM", "M ", " M", "MM", "R ", "RM", "AD", "MD"]);

/**
 * Git quotes a path containing whitespace or non-ASCII bytes; undo that.
 *
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(1, -1);
  }
}

/**
 * Parse `git status --porcelain` output into `{ code, path }` records.
 *
 * The first two characters are the status code (`??`, `!!`, ` M`, …), then a
 * space, then the path. A rename entry carries `old -> new`; the destination is
 * what a later commit would contain, so that is what is kept.
 *
 * @param {string} stdout
 * @returns {{ code: string, path: string }[]}
 */
export function parsePorcelainEntries(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3).replace(/\s+$/, "");
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    if (rest === "") continue;
    out.push({ code, path: unquote(rest) });
  }
  return out;
}

/**
 * Resolve each found path to the status code git reported for it.
 *
 * git collapses an untracked-or-ignored *directory* into one trailing-slash
 * entry — under the old blanket rule the whole of `eval-results/` came back as
 * a single `!! eval-results/` line — so a directory entry has to be expanded
 * over the paths actually on disk beneath it. An exact file entry always wins
 * over a directory entry, because it is the more specific statement.
 *
 * @param {{ entries: {code: string, path: string}[], foundPaths: string[] }} input
 * @returns {Map<string, string>}
 */
export function expandStatusEntries({ entries, foundPaths }) {
  const byPath = new Map();
  const dirEntries = entries.filter((e) => e.path.endsWith("/"));
  for (const found of foundPaths) {
    const dir = dirEntries.find((e) => found.startsWith(e.path));
    if (dir) byPath.set(found, dir.code);
  }
  for (const entry of entries) {
    if (entry.path.endsWith("/")) continue;
    byPath.set(entry.path, entry.code);
  }
  return byPath;
}

/**
 * Decide whether the nightly has a committable set of outputs.
 *
 * @param {{
 *   foundPaths: string[],
 *   statusByPath: Map<string, string>,
 *   required?: ReadonlyArray<{ id: string, label: string, match: (path: string) => boolean }>,
 * }} input
 */
export function classifyNightlyEvalOutputs({
  foundPaths,
  statusByPath,
  required = NIGHTLY_REQUIRED_OUTPUTS,
}) {
  const groups = required.map((group) => {
    const matched = foundPaths.filter((p) => group.match(p));
    const committable = matched.filter((p) => COMMITTABLE_CODES.has(statusByPath.get(p) ?? ""));
    const ignored = matched.filter((p) => statusByPath.get(p) === "!!");

    /** @type {"committable"|"ignored"|"unchanged"|"missing"} */
    let status;
    if (committable.length > 0) status = "committable";
    else if (ignored.length > 0) status = "ignored";
    else if (matched.length > 0) status = "unchanged";
    else status = "missing";

    return { id: group.id, label: group.label, status, committable, ignored, matched };
  });

  const committablePaths = groups.flatMap((g) => (g.status === "committable" ? g.committable : []));
  const ignoredPaths = groups.flatMap((g) => g.ignored);
  const verdict = groups.every((g) => g.status === "committable") ? "COMMIT" : "FAIL";

  return { verdict, groups, committablePaths, ignoredPaths };
}

/**
 * How many example paths a report lists per group.
 *
 * The `unchanged` arm matches every historical envelope in the directory — 44
 * of them on the day #1333 was fixed, and one more every night after. Printing
 * all of them buried the one line that says what is wrong, so the list is
 * capped and the remainder counted.
 */
export const REPORT_PATH_SAMPLE = 3;

/** @param {string[]} paths @param {string} label @returns {string[]} */
function samplePaths(paths, label) {
  const shown = paths.slice(0, REPORT_PATH_SAMPLE);
  const lines = shown.map((p) => `           ${label}: ${p}`);
  if (paths.length > shown.length) {
    lines.push(`           …and ${paths.length - shown.length} more`);
  }
  return lines;
}

/**
 * Render a human report. Every failing arm names the path and the reason, so
 * the log says what is wrong rather than "No new domain eval results".
 *
 * @param {ReturnType<typeof classifyNightlyEvalOutputs>} classification
 * @returns {string}
 */
export function formatClassificationReport(classification) {
  const lines = [];
  for (const group of classification.groups) {
    switch (group.status) {
      case "committable":
        lines.push(`OK       ${group.label}`);
        lines.push(...samplePaths(group.committable, "will commit"));
        break;
      case "ignored":
        lines.push(
          `FAILED   ${group.label}: written, but gitignored — git would silently ` +
            `discard it. Either the \`eval-results\` branch is not checked out at ` +
            `${EVAL_RESULTS_DIR}/ (so \`main\`'s blanket ignore rule applies), or an ` +
            `ignore rule was added on the branch (#1333, ADR 0012, ADR 0015).`,
        );
        lines.push(...samplePaths(group.ignored, "ignored"));
        break;
      case "unchanged":
        lines.push(
          `FAILED   ${group.label}: the only files on disk are unchanged tracked ` +
            `envelopes from earlier runs — this run wrote nothing new (#1333).`,
        );
        lines.push(...samplePaths(group.matched, "unchanged"));
        break;
      default:
        lines.push(
          `FAILED   ${group.label}: the eval wrote no matching file. A nightly that ` +
            `produces no envelope is a failure, not a no-op (#1333).`,
        );
    }
  }
  lines.push(
    classification.verdict === "COMMIT"
      ? `VERDICT  COMMIT — ${classification.committablePaths.length} path(s) to commit.`
      : `VERDICT  FAIL — the nightly produced nothing committable.`,
  );
  return lines.join("\n");
}
