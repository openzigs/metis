import { describe, expect, it } from "vitest";

import {
  NIGHTLY_REQUIRED_OUTPUTS,
  REPORT_PATH_SAMPLE,
  classifyNightlyEvalOutputs,
  expandStatusEntries,
  formatClassificationReport,
  parsePorcelainEntries,
} from "./eval-results-commit-core.mjs";

/**
 * Issue #1333 — unit tests for the nightly eval-results commit guard's decision
 * core.
 *
 * The defect this replaces was a guard that could only ever say "nothing to do":
 * `git status --porcelain eval-results` does not list ignored files, so a freshly
 * written — but gitignored — envelope produced an empty string and the step
 * exited 0. Every arm below therefore checks that an EMPTY or IGNORED result set
 * is a FAILURE, never a pass.
 */

const DOMAIN = "eval-results/2026-08-29T03-00-00-000Z.json";
const AC = "eval-results/answer-correctness/2026-08-29T03-00-10-000Z.json";

describe("parsePorcelainEntries", () => {
  it("reads the two-letter code and the path from each line", () => {
    const out = ["?? eval-results/a.json", "!! eval-results/b.json", " M eval-results/c.json"].join(
      "\n",
    );
    expect(parsePorcelainEntries(out)).toEqual([
      { code: "??", path: "eval-results/a.json" },
      { code: "!!", path: "eval-results/b.json" },
      { code: " M", path: "eval-results/c.json" },
    ]);
  });

  it("ignores blank lines and trailing whitespace", () => {
    expect(parsePorcelainEntries("\n?? eval-results/a.json\n\n")).toEqual([
      { code: "??", path: "eval-results/a.json" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePorcelainEntries("")).toEqual([]);
  });

  it("unquotes a path git had to quote", () => {
    expect(parsePorcelainEntries('?? "eval-results/a b.json"')).toEqual([
      { code: "??", path: "eval-results/a b.json" },
    ]);
  });

  it("keeps the destination path of a rename entry", () => {
    expect(parsePorcelainEntries("R  eval-results/old.json -> eval-results/new.json")).toEqual([
      { code: "R ", path: "eval-results/new.json" },
    ]);
  });
});

describe("expandStatusEntries", () => {
  it("maps a file entry straight through", () => {
    const byPath = expandStatusEntries({
      entries: [{ code: "??", path: DOMAIN }],
      foundPaths: [DOMAIN],
    });
    expect(byPath.get(DOMAIN)).toBe("??");
  });

  it("applies a directory entry's code to every found path beneath it", () => {
    // git collapses an untracked-or-ignored directory to a single trailing-slash
    // entry. That collapse is exactly how the whole of `eval-results/` read as
    // one `!!` line under the old rule.
    const byPath = expandStatusEntries({
      entries: [{ code: "!!", path: "eval-results/" }],
      foundPaths: [DOMAIN, AC],
    });
    expect(byPath.get(DOMAIN)).toBe("!!");
    expect(byPath.get(AC)).toBe("!!");
  });

  it("does not let a directory entry override a more specific file entry", () => {
    const byPath = expandStatusEntries({
      entries: [
        { code: "!!", path: "eval-results/" },
        { code: "??", path: DOMAIN },
      ],
      foundPaths: [DOMAIN, AC],
    });
    expect(byPath.get(DOMAIN)).toBe("??");
    expect(byPath.get(AC)).toBe("!!");
  });

  it("leaves a found path with no matching entry unmapped", () => {
    const byPath = expandStatusEntries({ entries: [], foundPaths: [DOMAIN] });
    expect(byPath.has(DOMAIN)).toBe(false);
  });

  it("does not treat a sibling prefix as a parent directory", () => {
    const byPath = expandStatusEntries({
      entries: [{ code: "!!", path: "eval-results/answer/" }],
      foundPaths: ["eval-results/answer-correctness/x.json"],
    });
    expect(byPath.has("eval-results/answer-correctness/x.json")).toBe(false);
  });
});

describe("NIGHTLY_REQUIRED_OUTPUTS", () => {
  const match = (id, p) => NIGHTLY_REQUIRED_OUTPUTS.find((g) => g.id === id).match(p);

  it("matches a domain envelope at the top level", () => {
    expect(match("domain", DOMAIN)).toBe(true);
  });

  it("does not match an ad-hoc harness artifact as a domain envelope", () => {
    // `loadAllRuns` reads every top-level *.json and drops what does not parse,
    // so these live in the same directory but are NOT the nightly's output.
    expect(match("domain", "eval-results/embed-retrieval-2026-07-13T07-41-49-054Z.json")).toBe(
      false,
    );
    expect(match("domain", "eval-results/hybrid-ab-2026-08-01.json")).toBe(false);
    expect(match("domain", "eval-results/impact-feedback-harvest-2026-08-01.json")).toBe(false);
  });

  it("does not match a markdown report or a nested file as a domain envelope", () => {
    expect(match("domain", "eval-results/2026-08-29T03-00-00-000Z.md")).toBe(false);
    expect(match("domain", "eval-results/online/2026-08-29.json")).toBe(false);
  });

  it("matches an answer-correctness envelope in its subdirectory", () => {
    expect(match("answer-correctness", AC)).toBe(true);
    expect(match("answer-correctness", DOMAIN)).toBe(false);
  });
});

describe("classifyNightlyEvalOutputs", () => {
  const classify = (foundPaths, statusPairs) =>
    classifyNightlyEvalOutputs({
      foundPaths,
      statusByPath: new Map(statusPairs),
    });

  it("passes when every required output is present and committable", () => {
    const result = classify(
      [DOMAIN, AC],
      [
        [DOMAIN, "??"],
        [AC, "??"],
      ],
    );
    expect(result.verdict).toBe("COMMIT");
    expect(result.committablePaths).toEqual([DOMAIN, AC]);
  });

  it("treats a modification of an already-tracked envelope as committable", () => {
    const result = classify(
      [DOMAIN, AC],
      [
        [DOMAIN, " M"],
        [AC, "??"],
      ],
    );
    expect(result.verdict).toBe("COMMIT");
  });

  it("FAILS when a required output was written but is gitignored — the #1333 defect", () => {
    const result = classify(
      [DOMAIN, AC],
      [
        [DOMAIN, "!!"],
        [AC, "!!"],
      ],
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.groups.map((g) => g.status)).toEqual(["ignored", "ignored"]);
    expect(result.ignoredPaths).toEqual([DOMAIN, AC]);
  });

  it("FAILS when nothing was written at all — an empty set is not 'nothing to do'", () => {
    const result = classify([], []);
    expect(result.verdict).toBe("FAIL");
    expect(result.groups.every((g) => g.status === "missing")).toBe(true);
  });

  it("FAILS when the envelope on disk is an unchanged tracked file from a prior run", () => {
    // The runner checks out the repo fresh, so the 66 historical envelopes are
    // always on disk. Finding one must never stand in for writing a new one.
    const result = classify([DOMAIN, AC], [[AC, "??"]]);
    expect(result.verdict).toBe("FAIL");
    expect(result.groups.find((g) => g.id === "domain").status).toBe("unchanged");
  });

  it("FAILS when only one of the two required outputs landed", () => {
    const result = classify([DOMAIN], [[DOMAIN, "??"]]);
    expect(result.verdict).toBe("FAIL");
    expect(result.groups.find((g) => g.id === "answer-correctness").status).toBe("missing");
  });

  it("FAILS when an unrelated ad-hoc artifact is the only thing that changed", () => {
    // "the directory is dirty" is not the question. This is the arm that stops
    // the guard degrading back into a bare `git status` emptiness check.
    const adhoc = "eval-results/embed-retrieval-2026-08-29T00-00-00-000Z.json";
    const result = classify([adhoc], [[adhoc, "??"]]);
    expect(result.verdict).toBe("FAIL");
    expect(result.committablePaths).toEqual([]);
  });

  it("prefers the committable path when a group has both an ignored and a committable file", () => {
    const other = "eval-results/2026-08-28T03-00-00-000Z.json";
    const result = classify(
      [other, DOMAIN, AC],
      [
        [other, "!!"],
        [DOMAIN, "??"],
        [AC, "??"],
      ],
    );
    expect(result.verdict).toBe("COMMIT");
    expect(result.groups.find((g) => g.id === "domain").status).toBe("committable");
  });
});

describe("formatClassificationReport", () => {
  it("names the ignore rule as the cause when a written output is ignored", () => {
    const result = classifyNightlyEvalOutputs({
      foundPaths: [DOMAIN, AC],
      statusByPath: new Map([
        [DOMAIN, "!!"],
        [AC, "!!"],
      ]),
    });
    const report = formatClassificationReport(result);
    expect(report).toContain("gitignored");
    expect(report).toContain(DOMAIN);
    expect(report).toContain("#1333");
  });

  it("says the eval wrote nothing when the directory is empty", () => {
    const report = formatClassificationReport(
      classifyNightlyEvalOutputs({ foundPaths: [], statusByPath: new Map() }),
    );
    expect(report).toMatch(/wrote no|no new/i);
  });

  it("caps a long path list and counts the remainder", () => {
    // On the day #1333 was fixed the `unchanged` arm matched 44 historical
    // envelopes, and one more lands every night. An uncapped list buries the
    // single line that says what is actually wrong.
    const many = Array.from(
      { length: REPORT_PATH_SAMPLE + 5 },
      (_, i) => `eval-results/2026-08-${String(i + 10)}T03-00-00-000Z.json`,
    );
    const report = formatClassificationReport(
      classifyNightlyEvalOutputs({ foundPaths: many, statusByPath: new Map() }),
    );
    expect(report.match(/unchanged:/g) ?? []).toHaveLength(REPORT_PATH_SAMPLE);
    expect(report).toContain("…and 5 more");
  });

  it("lists what will be committed on the passing path", () => {
    const report = formatClassificationReport(
      classifyNightlyEvalOutputs({
        foundPaths: [DOMAIN, AC],
        statusByPath: new Map([
          [DOMAIN, "??"],
          [AC, "??"],
        ]),
      }),
    );
    expect(report).toContain(DOMAIN);
    expect(report).toContain(AC);
  });
});
