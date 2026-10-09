import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  annotations,
  exitCode,
  levelFor,
  parseReports,
  relativePath,
  retryRecord,
  summaryMarkdown,
} from "./vitest-retry-core.mjs";
import VitestRetryReporter from "./vitest-retry-reporter.mjs";

/** A stand-in for a finished vitest `TestCase` (only what the reporter reads). */
function testCase({ state = "passed", retryCount = 0, line = 7, diagnostic = true } = {}) {
  return {
    fullName: "suite > leaks a once-value",
    module: { moduleId: "/repo/server/src/a.test.ts" },
    location: line === null ? undefined : { line, column: 3 },
    result: () => ({ state }),
    diagnostic: () => (diagnostic ? { retryCount } : undefined),
  };
}

const rec = (over = {}) => ({
  file: "/repo/server/src/a.test.ts",
  name: "suite > leaks",
  line: 7,
  retries: 1,
  ...over,
});

describe("retryRecord", () => {
  it("records a test that passed after a retry", () => {
    expect(retryRecord(testCase({ retryCount: 2 }))).toEqual({
      file: "/repo/server/src/a.test.ts",
      name: "suite > leaks a once-value",
      line: 7,
      retries: 2,
    });
  });

  it("ignores a test that passed first time", () => {
    expect(retryRecord(testCase({ retryCount: 0 }))).toBeNull();
  });

  it("ignores a test that failed every attempt — that already fails the run", () => {
    expect(retryRecord(testCase({ state: "failed", retryCount: 2 }))).toBeNull();
  });

  it("ignores a skipped test and one with no diagnostic", () => {
    expect(retryRecord(testCase({ state: "skipped", retryCount: 1 }))).toBeNull();
    expect(retryRecord(testCase({ diagnostic: false }))).toBeNull();
  });

  it("keeps a test with no location, line null", () => {
    expect(retryRecord(testCase({ retryCount: 1, line: null }))?.line).toBeNull();
  });
});

describe("parseReports", () => {
  it("merges every report's records", () => {
    const a = JSON.stringify({ root: "/x", retried: [rec()] });
    const b = JSON.stringify({ root: "/y", retried: [rec({ name: "other", line: undefined })] });
    expect(parseReports([a, b])).toEqual([rec(), rec({ name: "other", line: null })]);
  });

  it("reads an empty report as nothing retried", () => {
    expect(parseReports([JSON.stringify({ retried: [] })])).toEqual([]);
  });

  it("throws on a report without a retried array — a broken wiring must not read as clean", () => {
    expect(() => parseReports(["{}"])).toThrow(/not a vitest retry report/);
    expect(() => parseReports(["null"])).toThrow(/not a vitest retry report/);
  });

  it("throws on a malformed record", () => {
    expect(() => parseReports([JSON.stringify({ retried: [{ file: "a" }] })])).toThrow(/malformed/);
    expect(() => parseReports([JSON.stringify({ retried: [null] })])).toThrow(/malformed/);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseReports(["{"])).toThrow();
  });
});

describe("levelFor", () => {
  it("fails the nightly and warns everywhere else", () => {
    expect(levelFor("schedule", undefined)).toBe("error");
    expect(levelFor("pull_request", undefined)).toBe("warning");
    expect(levelFor("push", "")).toBe("warning");
    expect(levelFor(undefined, undefined)).toBe("warning");
  });

  it("honours an explicit override", () => {
    expect(levelFor("pull_request", "error")).toBe("error");
    expect(levelFor("schedule", "warning")).toBe("warning");
  });

  it("rejects an unknown override rather than guessing", () => {
    expect(() => levelFor("schedule", "fail")).toThrow(/VITEST_RETRY_LEVEL/);
  });
});

describe("relativePath", () => {
  it("strips the repo root, including a trailing slash and Windows separators", () => {
    expect(relativePath("/repo/server/a.ts", "/repo")).toBe("server/a.ts");
    expect(relativePath("/repo/server/a.ts", "/repo/")).toBe("server/a.ts");
    expect(relativePath("C:\\repo\\ui\\b.ts", "C:\\repo")).toBe("ui/b.ts");
  });

  it("leaves a path outside the root alone", () => {
    expect(relativePath("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts");
    expect(relativePath("/repository/a.ts", "/repo")).toBe("/repository/a.ts");
  });
});

describe("annotations", () => {
  it("emits one annotation per test, at the given level, on the repo-relative file and line", () => {
    const [line] = annotations([rec({ retries: 2 })], "warning", "/repo");
    expect(line).toMatch(/^::warning file=server\/src\/a\.test\.ts,line=7,title=/);
    expect(line).toContain('"suite > leaks" failed 2 time(s) before passing');
    expect(annotations([rec()], "error", "/repo")[0]).toMatch(/^::error /);
  });

  it("omits line when unknown", () => {
    expect(annotations([rec({ line: null })], "warning", "/repo")[0]).not.toContain("line=");
  });

  it("escapes workflow-command metacharacters so a test name cannot forge a command", () => {
    const [line] = annotations(
      [rec({ file: "/repo/a,b:c%.ts", name: "x\n::error::forged 100%" })],
      "warning",
      "/repo",
    );
    expect(line).toContain("file=a%2Cb%3Ac%25.ts");
    expect(line).not.toContain("\n");
    expect(line).toContain("x%0A::error::forged 100%25");
  });

  it("returns nothing for no records", () => {
    expect(annotations([], "error", "/repo")).toEqual([]);
  });
});

describe("summaryMarkdown", () => {
  it("says none when nothing was retried", () => {
    expect(summaryMarkdown([], "error", "/repo")).toContain("None.");
  });

  it("tabulates each retried test and states the verdict", () => {
    const md = summaryMarkdown([rec({ name: "a | b" }), rec({ line: null })], "error", "/repo");
    expect(md).toContain("2 test(s) needed a retry — **fails this run**");
    expect(md).toContain("| `server/src/a.test.ts:7` | a \\| b | 1 |");
    expect(md).toContain("| `server/src/a.test.ts` | suite > leaks | 1 |");
    expect(summaryMarkdown([rec()], "warning", "/repo")).toContain("a warning on this run");
  });
});

describe("exitCode", () => {
  it("is 1 only for retried tests at error level", () => {
    expect(exitCode([rec()], "error")).toBe(1);
    expect(exitCode([rec()], "warning")).toBe(0);
    expect(exitCode([], "error")).toBe(0);
  });
});

describe("VitestRetryReporter", () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function run(env, cases) {
    const logged = [];
    const reporter = new VitestRetryReporter({ env, log: (m) => logged.push(m) });
    reporter.onInit({ config: { root: "/repo/server" } });
    for (const c of cases) reporter.onTestCaseResult(c);
    reporter.onTestRunEnd();
    return logged.join("\n");
  }

  it("writes a report naming each retried test, and logs them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-retry-"));
    dirs.push(dir);
    const out = path.join(dir, "nested");
    const logged = run({ VITEST_RETRY_REPORT_DIR: out }, [
      testCase({ retryCount: 1 }),
      testCase({ retryCount: 0 }),
    ]);
    const files = fs.readdirSync(out);
    expect(files).toEqual([`server-${process.pid}.json`]);
    const report = JSON.parse(fs.readFileSync(path.join(out, files[0]), "utf8"));
    expect(report.root).toBe("/repo/server");
    expect(parseReports([JSON.stringify(report)])).toEqual([
      {
        file: "/repo/server/src/a.test.ts",
        name: "suite > leaks a once-value",
        line: 7,
        retries: 1,
      },
    ]);
    expect(logged).toContain("1 test(s) passed only after a retry");
    expect(logged).toContain("/repo/server/src/a.test.ts:7 > suite > leaks a once-value");
  });

  it("writes an empty report when nothing was retried, and logs nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-retry-"));
    dirs.push(dir);
    const logged = run({ VITEST_RETRY_REPORT_DIR: dir }, [testCase()]);
    const [file] = fs.readdirSync(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).retried).toEqual([]);
    expect(logged).toBe("");
  });

  it("writes nothing without VITEST_RETRY_REPORT_DIR but still logs", () => {
    const logged = run({}, [testCase({ retryCount: 1, line: null })]);
    expect(logged).toContain("/repo/server/src/a.test.ts > suite");
  });

  it("defaults to process.env and stderr", () => {
    const reporter = new VitestRetryReporter();
    expect(reporter.env).toBe(process.env);
    expect(typeof reporter.log).toBe("function");
  });
});
