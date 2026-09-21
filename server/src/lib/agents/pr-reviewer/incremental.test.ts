/**
 * Epic #394 P2 (#405) — incremental review planner tests.
 */
import { describe, expect, it } from "vitest";
import {
  isWhitespaceOnlyDiff,
  extractChangedFiles,
  extractRenames,
  planIncrementalReview,
  renderIncrementalAddendum,
} from "./incremental.js";

const SUBSTANTIVE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index aaa..bbb 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-old line
+new line
`;

const WHITESPACE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index aaa..bbb 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-   
+   
`;

const TWO_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/b.ts b/src/b.ts
index 3..4 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-p
+q
`;

describe("isWhitespaceOnlyDiff", () => {
  it("returns true on empty input", () => {
    expect(isWhitespaceOnlyDiff("")).toBe(true);
    expect(isWhitespaceOnlyDiff("    ")).toBe(true);
  });

  it("returns true when only whitespace lines change", () => {
    expect(isWhitespaceOnlyDiff(WHITESPACE_DIFF)).toBe(true);
  });

  it("returns false on substantive change", () => {
    expect(isWhitespaceOnlyDiff(SUBSTANTIVE_DIFF)).toBe(false);
  });

  it("ignores rename / binary / new-file headers", () => {
    const renameOnly = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;
    expect(isWhitespaceOnlyDiff(renameOnly)).toBe(true);
    const binary = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;
    expect(isWhitespaceOnlyDiff(binary)).toBe(true);
    const newFile = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0..2
--- /dev/null
+++ b/new.txt
`;
    expect(isWhitespaceOnlyDiff(newFile)).toBe(true);
  });
});

describe("extractChangedFiles", () => {
  it("extracts paths from diff --git headers", () => {
    expect(extractChangedFiles(TWO_FILE_DIFF)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("falls back to +++ b/ paths when no headers exist", () => {
    const plain = `--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
+new
`;
    expect(extractChangedFiles(plain)).toEqual(["x.txt"]);
  });

  it("ignores /dev/null targets", () => {
    const del = `--- a/old.txt
+++ /dev/null
`;
    expect(extractChangedFiles(del)).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(extractChangedFiles("")).toEqual([]);
  });

  it("handles renames where a/ and b/ paths differ", () => {
    const rename = `diff --git a/old/x.ts b/new/x.ts
similarity index 100%
rename from old/x.ts
rename to new/x.ts
`;
    expect(extractChangedFiles(rename)).toEqual(["old/x.ts", "new/x.ts"]);
  });
});

describe("planIncrementalReview", () => {
  const ac1 = { id: "AC1", text: "first" };
  const ac2 = { id: "AC2", text: "second" };

  it("skips when the diff is whitespace-only and inherits all priors", () => {
    const plan = planIncrementalReview({
      diff: WHITESPACE_DIFF,
      criteria: [ac1, ac2],
      priorVerdicts: [
        { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/a.ts"] },
      ],
    });
    expect(plan.skip).toBe(true);
    expect(plan.skipReason).toBe("no_substantive_change");
    expect(plan.toReJudge).toHaveLength(0);
    expect(plan.inherited).toHaveLength(1);
  });

  it("re-judges only ACs whose evidence files changed", () => {
    const plan = planIncrementalReview({
      diff: TWO_FILE_DIFF, // src/a.ts + src/b.ts
      criteria: [ac1, ac2],
      priorVerdicts: [
        { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/a.ts"] },
        { acId: "AC2", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/unchanged.ts"] },
      ],
    });
    expect(plan.skip).toBe(false);
    expect(plan.toReJudge.map((c) => c.id)).toEqual(["AC1"]);
    expect(plan.inherited.map((v) => v.acId)).toEqual(["AC2"]);
  });

  it("re-judges ACs without prior verdicts", () => {
    const plan = planIncrementalReview({
      diff: TWO_FILE_DIFF,
      criteria: [ac1, ac2, { id: "ACnew", text: "new" }],
      priorVerdicts: [
        { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/unchanged.ts"] },
      ],
    });
    // ACnew + AC2 (no prior) re-judged. AC1 inherited because src/unchanged.ts not changed.
    expect(plan.toReJudge.map((c) => c.id).sort()).toEqual(["AC2", "ACnew"]);
    expect(plan.inherited.map((v) => v.acId)).toEqual(["AC1"]);
  });

  it("re-judges priors with empty evidence files (defensive)", () => {
    const plan = planIncrementalReview({
      diff: TWO_FILE_DIFF,
      criteria: [ac1],
      priorVerdicts: [{ acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: [] }],
    });
    expect(plan.toReJudge.map((c) => c.id)).toEqual(["AC1"]);
  });

  it("returns skip=true when all priors can be inherited", () => {
    const plan = planIncrementalReview({
      diff: TWO_FILE_DIFF,
      criteria: [ac1],
      priorVerdicts: [
        { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/elsewhere.ts"] },
      ],
    });
    expect(plan.skip).toBe(true);
    expect(plan.inherited).toHaveLength(1);
  });
});

describe("renderIncrementalAddendum", () => {
  it("formats a SHA range when both shas are present", () => {
    const out = renderIncrementalAddendum({
      reJudgedIds: ["AC1"],
      inheritedIds: ["AC2"],
      fromSha: "abcdef1234567890",
      toSha: "1234567890abcdef",
    });
    expect(out).toContain("abcdef1");
    expect(out).toContain("1234567");
    expect(out).toContain("AC1");
    expect(out).toContain("AC2");
  });

  it("returns empty when both lists are empty", () => {
    expect(
      renderIncrementalAddendum({ reJudgedIds: [], inheritedIds: [], fromSha: null, toSha: null }),
    ).toBe("");
  });

  it("falls back to 'incremental' label when shas are missing", () => {
    const out = renderIncrementalAddendum({
      reJudgedIds: [],
      inheritedIds: ["AC1"],
      fromSha: null,
      toSha: null,
    });
    expect(out).toContain("incremental");
    expect(out).toContain("none");
  });
});

// Epic #394 P2 review F3 — file rename detection invalidates inherited
// verdicts whose evidence files were renamed in lastReviewedSha..HEAD.
describe("extractRenames + planIncrementalReview rename invalidation", () => {
  const RENAME_DIFF = `diff --git a/src/old/path.ts b/src/new/path.ts
similarity index 92%
rename from src/old/path.ts
rename to src/new/path.ts
--- a/src/old/path.ts
+++ b/src/new/path.ts
@@ -1,3 +1,3 @@
 line one
-old line
+new line
`;

  it("extractRenames returns the (from, to) pair for a renamed file", () => {
    expect(extractRenames(RENAME_DIFF)).toEqual([
      { from: "src/old/path.ts", to: "src/new/path.ts" },
    ]);
  });

  it("extractRenames returns [] when no rename header is present", () => {
    const noRename = `diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(extractRenames(noRename)).toEqual([]);
  });

  it("forces re-judge of an inherited AC whose evidence file was renamed", () => {
    const plan = planIncrementalReview({
      diff: RENAME_DIFF,
      criteria: [{ id: "AC1", text: "covers the renamed file" }],
      // Prior verdict cited the OLD path — without F3 fix this would
      // be inherited forever and never re-trigger on future changes
      // to the new path.
      priorVerdicts: [
        {
          acId: "AC1",
          verdict: "satisfied",
          reasoning: "prior",
          evidenceFiles: ["src/old/path.ts"],
        },
      ],
    });
    expect(plan.skip).toBe(false);
    expect(plan.toReJudge.map((c) => c.id)).toEqual(["AC1"]);
    expect(plan.inherited).toEqual([]);
  });
});
