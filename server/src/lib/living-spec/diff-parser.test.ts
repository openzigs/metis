/**
 * Epic #192 (A.5) — diff parser tests.
 */
import { describe, expect, it } from "vitest";
import { parseBranchIssueNumbers, parseDiffHunks, parseLinkedIssues } from "./diff-parser.js";

describe("parseLinkedIssues", () => {
  it("extracts closes/fixes/resolves keywords (case-insensitive)", () => {
    const body = "Closes #1\nFixes: #2\nresolves #3\nResolved #4\nRandom text #999\nFix #5";
    const out = parseLinkedIssues(body);
    expect(out.closes).toEqual([1, 2, 3, 4, 5]);
    expect(out.refs).toEqual([]);
  });

  it("extracts refs/references keywords", () => {
    const body = "Refs #10\nreferences #11\nRef: #12";
    const out = parseLinkedIssues(body);
    expect(out.closes).toEqual([]);
    expect(out.refs).toEqual([10, 11, 12]);
  });

  it("dedupes and sorts", () => {
    const out = parseLinkedIssues("Closes #5\nFixes #3\nCloses #5\nCloses #3");
    expect(out.closes).toEqual([3, 5]);
  });

  it("returns empty for missing/empty input", () => {
    expect(parseLinkedIssues(undefined)).toEqual({ closes: [], refs: [] });
    expect(parseLinkedIssues(null)).toEqual({ closes: [], refs: [] });
    expect(parseLinkedIssues("")).toEqual({ closes: [], refs: [] });
    expect(parseLinkedIssues("no issue refs here")).toEqual({ closes: [], refs: [] });
  });

  it("ignores #0 and non-numeric matches", () => {
    expect(parseLinkedIssues("Closes #0").closes).toEqual([]);
    expect(parseLinkedIssues("Closes #abc").closes).toEqual([]);
  });

  it("recognises all 9 GitHub closing keywords case-insensitively", () => {
    const cases = [
      "close #1",
      "Closes #2",
      "CLOSED #3",
      "fix #4",
      "Fixes #5",
      "fixed #6",
      "resolve #7",
      "Resolves #8",
      "resolved #9",
    ];
    const out = parseLinkedIssues(cases.join("\n"));
    expect(out.closes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("parseBranchIssueNumbers", () => {
  it("returns [] for null/empty", () => {
    expect(parseBranchIssueNumbers(undefined)).toEqual([]);
    expect(parseBranchIssueNumbers(null)).toEqual([]);
    expect(parseBranchIssueNumbers("")).toEqual([]);
    expect(parseBranchIssueNumbers("main")).toEqual([]);
    expect(parseBranchIssueNumbers("feature/no-numbers")).toEqual([]);
  });

  it("extracts issue numbers across the standard branch-name patterns", () => {
    const cases: Array<[string, number[]]> = [
      ["feature/123-add-thing", [123]],
      ["bugfix/issue-456-broken", [456]],
      ["gh-789", [789]],
      ["42-quick-fix", [42]],
      ["release/v1.2.3", []],
      ["fix/issue-100/sub", [100]],
      ["chore/9-bump-deps", [9]],
      ["copilot/fix-1234", [1234]],
      ["users/alice/feat/55-rework", [55]],
      ["epic-394-pr-review-mvp", [394]],
    ];
    for (const [branch, expected] of cases) {
      expect(parseBranchIssueNumbers(branch)).toEqual(expected);
    }
  });

  it("dedupes and sorts when multiple numbers appear", () => {
    expect(parseBranchIssueNumbers("epic-394-issue-398-and-394")).toEqual([394, 398]);
  });

  it("ignores zero", () => {
    expect(parseBranchIssueNumbers("feature/0-thing")).toEqual([]);
  });
});

describe("parseDiffHunks", () => {
  it("returns [] for empty input", () => {
    expect(parseDiffHunks(undefined)).toEqual([]);
    expect(parseDiffHunks("")).toEqual([]);
  });

  it("extracts filename + line ranges from a diff", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111..2222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +12,5 @@
-old
+new
+more
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`;
    const hunks = parseDiffHunks(diff);
    expect(hunks).toEqual([
      { filePath: "src/a.ts", startLine: 12, endLine: 16 },
      { filePath: "src/b.ts", startLine: 1, endLine: 1 },
    ]);
  });

  it("ignores hunk headers without a preceding file header", () => {
    const diff = "@@ -1 +1 @@\n+ orphan";
    expect(parseDiffHunks(diff)).toEqual([]);
  });
});
