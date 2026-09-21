/**
 * Epic #394 (#399) — diff-fetcher tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchPrDiff,
  globToRegExp,
  PR_REVIEW_DEFAULT_MAX_DIFF_BYTES,
  PR_REVIEW_DEFAULT_SKIP_GLOBS,
  stripSkipGlobs,
  type DiffFetchOctokit,
} from "./diff-fetcher.js";

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index aaa..bbb 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-old
+new
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index ccc..ddd 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-x
+y
diff --git a/dist/bundle.js b/dist/bundle.js
index eee..fff 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1 @@
-a
+b
`;

function mkOctokit(diff: unknown): DiffFetchOctokit {
  const get = vi.fn(async () => ({ data: diff }));
  return { pulls: { get } } as DiffFetchOctokit;
}

describe("globToRegExp", () => {
  it("matches single-segment wildcards", () => {
    expect(globToRegExp("*.lock").test("pnpm.lock")).toBe(true);
    expect(globToRegExp("*.lock").test("a/b.lock")).toBe(false);
  });
  it("matches doublestar across segments", () => {
    expect(globToRegExp("**/*.lock").test("a/b/c.lock")).toBe(true);
    expect(globToRegExp("**/dist/**").test("server/dist/foo.js")).toBe(true);
    expect(globToRegExp("**/dist/**").test("server/src/foo.js")).toBe(false);
  });
  it("matches literal filenames", () => {
    expect(globToRegExp("pnpm-lock.yaml").test("pnpm-lock.yaml")).toBe(true);
    expect(globToRegExp("pnpm-lock.yaml").test("ui/pnpm-lock.yaml")).toBe(false);
  });
});

describe("stripSkipGlobs", () => {
  it("strips files matching the default skip globs", () => {
    const out = stripSkipGlobs(SAMPLE_DIFF, PR_REVIEW_DEFAULT_SKIP_GLOBS);
    expect(out.skippedFiles).toEqual(["pnpm-lock.yaml", "dist/bundle.js"]);
    expect(out.diff).toContain("src/foo.ts");
    expect(out.diff).not.toContain("pnpm-lock.yaml");
    expect(out.diff).not.toContain("dist/bundle.js");
  });

  it("returns the diff untouched when globs is empty", () => {
    const out = stripSkipGlobs(SAMPLE_DIFF, []);
    expect(out.diff).toBe(SAMPLE_DIFF);
    expect(out.skippedFiles).toEqual([]);
  });

  it("returns empty result for empty input", () => {
    expect(stripSkipGlobs("", PR_REVIEW_DEFAULT_SKIP_GLOBS)).toEqual({
      diff: "",
      skippedFiles: [],
    });
  });
});

describe("fetchPrDiff", () => {
  it("fetches via octokit.pulls.get with diff format and returns filtered diff", async () => {
    const octokit = mkOctokit(SAMPLE_DIFF);
    const out = await fetchPrDiff({
      octokit,
      owner: "acme",
      repo: "proj",
      prNumber: 7,
    });
    expect(out.tooLarge).toBe(false);
    expect(out.diff).toContain("src/foo.ts");
    expect(out.skippedFiles).toContain("pnpm-lock.yaml");
    const callArgs = (octokit.pulls.get as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs).toMatchObject({
      owner: "acme",
      repo: "proj",
      pull_number: 7,
      mediaType: { format: "diff" },
    });
  });

  it("flags tooLarge when raw diff exceeds the cap", async () => {
    const big = "x".repeat(2_000);
    const octokit = mkOctokit(big);
    const out = await fetchPrDiff({
      octokit,
      owner: "a",
      repo: "b",
      prNumber: 1,
      maxBytes: 1_000,
    });
    expect(out.tooLarge).toBe(true);
    expect(out.diff).toBe("");
    expect(out.rawBytes).toBe(2_000);
  });

  it("uses the default cap when maxBytes is null/undefined/zero", async () => {
    const octokit = mkOctokit(SAMPLE_DIFF);
    const out = await fetchPrDiff({
      octokit,
      owner: "a",
      repo: "b",
      prNumber: 1,
      maxBytes: 0,
    });
    expect(out.tooLarge).toBe(false);
    expect(out.rawBytes).toBeLessThan(PR_REVIEW_DEFAULT_MAX_DIFF_BYTES);
  });

  it("coerces non-string responses safely", async () => {
    const octokit = mkOctokit(undefined);
    const out = await fetchPrDiff({
      octokit,
      owner: "a",
      repo: "b",
      prNumber: 1,
    });
    expect(out.diff).toBe("");
    expect(out.tooLarge).toBe(false);
  });

  it("uses per-project skip globs override when provided", async () => {
    const octokit = mkOctokit(SAMPLE_DIFF);
    const out = await fetchPrDiff({
      octokit,
      owner: "a",
      repo: "b",
      prNumber: 1,
      skipGlobs: ["src/foo.ts"],
    });
    expect(out.skippedFiles).toEqual(["src/foo.ts"]);
    expect(out.diff).toContain("pnpm-lock.yaml");
  });
});
