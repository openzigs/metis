/**
 * #964 — flag tests that passed only after a vitest retry. Pure logic; the vitest
 * reporter that collects the records is `vitest-retry-reporter.mjs`, the CI runner
 * that reads them is `scripts/vitest-retried-tests.mjs`.
 *
 * `server/vitest.config.ts` sets `retry: 2` (and `ui/vitest.config.ts` does under
 * CI) to absorb I/O-timing flakes. A retry hides a DETERMINISTIC bug just as well:
 * PR #963 found six tests that failed on every first attempt — a mock once-value
 * leaked between tests — and stayed green on CI for over a day, because the
 * default reporter prints only a file-level tick. A test that is green only on its
 * second or third attempt is therefore surfaced by name: a warning annotation on a
 * pull request, a failure on the nightly run.
 */

/** Report levels the runner understands. `error` fails the job; `warning` annotates. */
export const LEVELS = ["warning", "error"];

/**
 * The record for one finished vitest `TestCase`, or `null` when it did not pass
 * only after a retry. A test that FAILED every attempt already fails the run, so
 * it is not reported here; a skipped or pending one never ran.
 *
 * @param {{ fullName: string, module: { moduleId: string }, location?: { line?: number },
 *   result: () => { state: string }, diagnostic: () => ({ retryCount?: number } | undefined) }} testCase
 * @returns {{ file: string, name: string, line: number | null, retries: number } | null}
 */
export function retryRecord(testCase) {
  if (testCase.result().state !== "passed") return null;
  const retries = testCase.diagnostic()?.retryCount ?? 0;
  if (!(retries > 0)) return null;
  return {
    file: testCase.module.moduleId,
    name: testCase.fullName,
    line: testCase.location?.line ?? null,
    retries,
  };
}

/**
 * Merge the JSON reports the reporter wrote (one per vitest process). Throws on a
 * report that is not the reporter's shape: a malformed file is a broken wiring,
 * and reading it as "nothing retried" would make this check pass unchecked.
 *
 * @param {string[]} texts raw file contents
 * @returns {{ file: string, name: string, line: number | null, retries: number }[]}
 */
export function parseReports(texts) {
  const records = [];
  for (const text of texts) {
    const report = JSON.parse(text);
    if (!report || !Array.isArray(report.retried)) {
      throw new Error("not a vitest retry report: missing a `retried` array");
    }
    for (const r of report.retried) {
      if (
        typeof r?.file !== "string" ||
        typeof r.name !== "string" ||
        typeof r.retries !== "number"
      ) {
        throw new Error(`malformed retry record: ${JSON.stringify(r)}`);
      }
      records.push({
        file: r.file,
        name: r.name,
        line: typeof r.line === "number" ? r.line : null,
        retries: r.retries,
      });
    }
  }
  return records;
}

/**
 * The level for a run. An explicit override wins; otherwise the nightly
 * (`schedule`) fails and every other event warns — retry still exists for genuine
 * timing flakes, which must not turn an unrelated pull request red.
 *
 * @param {string | undefined} eventName `GITHUB_EVENT_NAME`
 * @param {string | undefined} override `VITEST_RETRY_LEVEL`
 * @returns {"warning" | "error"}
 */
export function levelFor(eventName, override) {
  if (override !== undefined && override !== "") {
    if (!LEVELS.includes(override)) {
      throw new Error(`VITEST_RETRY_LEVEL must be one of ${LEVELS.join(", ")}; got "${override}"`);
    }
    return /** @type {"warning" | "error"} */ (override);
  }
  return eventName === "schedule" ? "error" : "warning";
}

/**
 * GitHub workflow-command escaping for a message.
 *
 * @param {string} s
 */
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * GitHub workflow-command escaping for a property value.
 *
 * @param {string} s
 */
function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * Make a path repo-relative (POSIX) so the annotation lands on the diff.
 *
 * @param {string} file absolute path
 * @param {string} repoRoot absolute repository root
 */
export function relativePath(file, repoRoot) {
  const f = file.replace(/\\/g, "/");
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f;
}

/**
 * One GitHub annotation line per retried test.
 *
 * @param {{ file: string, name: string, line: number | null, retries: number }[]} records
 * @param {"warning" | "error"} level
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function annotations(records, level, repoRoot) {
  return records.map((r) => {
    const props = [`file=${escapeProperty(relativePath(r.file, repoRoot))}`];
    if (r.line !== null) props.push(`line=${r.line}`);
    props.push(`title=${escapeProperty("Test passed only after a retry (#964)")}`);
    const msg =
      `"${r.name}" failed ${r.retries} time(s) before passing. Retry hides deterministic ` +
      "bugs as well as timing flakes; make it pass with --retry=0.";
    return `::${level} ${props.join(",")}::${escapeData(msg)}`;
  });
}

/**
 * Markdown for `$GITHUB_STEP_SUMMARY`.
 *
 * @param {{ file: string, name: string, line: number | null, retries: number }[]} records
 * @param {"warning" | "error"} level
 * @param {string} repoRoot
 */
export function summaryMarkdown(records, level, repoRoot) {
  if (records.length === 0) return "### Tests that passed only after a retry (#964)\n\nNone.\n";
  const verdict = level === "error" ? "**fails this run**" : "a warning on this run";
  const rows = records.map((r) => {
    const where = relativePath(r.file, repoRoot) + (r.line !== null ? `:${r.line}` : "");
    // Backslashes first, so a name ending in `\` cannot un-escape the pipe after it.
    const name = r.name.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| \`${where}\` | ${name} | ${r.retries} |`;
  });
  return [
    "### Tests that passed only after a retry (#964)",
    "",
    `${records.length} test(s) needed a retry — ${verdict}. Each must pass with \`--retry=0\`.`,
    "",
    "| File | Test | Failed attempts |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/**
 * The runner's exit code: 1 only when something was retried AND the level is
 * `error`.
 *
 * @param {unknown[]} records
 * @param {"warning" | "error"} level
 */
export function exitCode(records, level) {
  return records.length > 0 && level === "error" ? 1 : 0;
}
