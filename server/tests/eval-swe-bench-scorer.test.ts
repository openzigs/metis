/**
 * Epic #194 (C.1) — SWE-bench-Pro scorer tests.
 */
import { describe, expect, it } from "vitest";

import { jaccardLines, OVERLAP_THRESHOLD, scoreTask } from "../src/lib/eval/swe-bench/scorer.js";

const expected = `diff --git a/foo.py b/foo.py
@@
-old line one
+new line one
+new line two`;

const matching = `diff --git a/foo.py b/foo.py
@@
-old line one
+new line one
+new line two`;

const partial = `diff --git a/foo.py b/foo.py
@@
+new line one
+something else`;

describe("jaccardLines", () => {
  it("returns 1 for identical patches and 0 for disjoint", () => {
    expect(jaccardLines(expected, matching)).toBe(1);
    expect(jaccardLines("+a\n+b", "+c\n+d")).toBe(0);
  });

  it("returns 1 when both inputs are empty", () => {
    expect(jaccardLines("", "")).toBe(1);
  });

  it("returns 0 when only one side is empty", () => {
    expect(jaccardLines(expected, "")).toBe(0);
    expect(jaccardLines("", expected)).toBe(0);
  });

  it("ignores diff headers when comparing", () => {
    const a = "diff --git a/x.py b/x.py\n@@\n+same line";
    const b = "diff --git a/y.py b/y.py\n@@\n+same line";
    expect(jaccardLines(a, b)).toBe(1);
  });

  it("returns a partial similarity for overlapping patches", () => {
    const sim = jaccardLines(expected, partial);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe("scoreTask", () => {
  it("fails when sandbox exited non-zero", () => {
    const result = scoreTask({
      expectedPatch: expected,
      actualPatch: matching,
      sandbox: { exitCode: 1, stdout: "", stderr: "boom" },
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reason).toContain("sandbox exit");
  });

  it("passes when sandbox is green and overlap clears the threshold", () => {
    const result = scoreTask({
      expectedPatch: expected,
      actualPatch: matching,
      sandbox: { exitCode: 0, stdout: "ok", stderr: "" },
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("fails when overlap is below the threshold", () => {
    const result = scoreTask({
      expectedPatch: expected,
      actualPatch: "+totally different",
      sandbox: { exitCode: 0, stdout: "", stderr: "" },
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(OVERLAP_THRESHOLD);
    expect(result.reason).toContain("overlap");
  });
});
