import fs from "node:fs";
import path from "node:path";

import { retryRecord } from "./vitest-retry-core.mjs";

/**
 * #964 — a vitest reporter that records every test which passed only after a
 * retry. Registered next to `default` in `server/vitest.config.ts` and
 * `ui/vitest.config.ts`.
 *
 * Always: prints the retried tests by name at the end of the run (the default
 * reporter shows only a file-level tick, which is how #963's six leaks hid).
 * When `VITEST_RETRY_REPORT_DIR` is set (CI): also writes
 * `<dir>/<root basename>-<pid>.json` — even when nothing was retried, so the
 * runner can tell "wired, nothing retried" from "never wired". The runner,
 * `scripts/vitest-retried-tests.mjs`, turns the files into annotations.
 */
export default class VitestRetryReporter {
  /** @param {{ env?: NodeJS.ProcessEnv, log?: (msg: string) => void }} [options] */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((msg) => process.stderr.write(`${msg}\n`));
    this.root = process.cwd();
    /** @type {NonNullable<ReturnType<typeof retryRecord>>[]} */
    this.retried = [];
  }

  /** @param {{ config: { root: string } }} vitest */
  onInit(vitest) {
    this.root = vitest.config.root;
  }

  /** @param {Parameters<typeof retryRecord>[0]} testCase */
  onTestCaseResult(testCase) {
    const record = retryRecord(testCase);
    if (record) this.retried.push(record);
  }

  onTestRunEnd() {
    if (this.retried.length > 0) {
      this.log(`\n[#964] ${this.retried.length} test(s) passed only after a retry:`);
      for (const r of this.retried) {
        this.log(
          `  - ${r.file}${r.line !== null ? `:${r.line}` : ""} > ${r.name} (${r.retries} failed attempt(s))`,
        );
      }
    }
    const dir = this.env.VITEST_RETRY_REPORT_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${path.basename(this.root)}-${process.pid}.json`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ root: this.root, retried: this.retried }, null, 2)}\n`,
    );
  }
}
