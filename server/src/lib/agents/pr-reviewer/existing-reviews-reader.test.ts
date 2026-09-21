/**
 * Epic #394 P2 (#406) — existing-reviews-reader / dedup tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchExistingReviewComments,
  jaccardSimilarity,
  filterCandidatesAgainstExisting,
  renderExistingCommentsBlock,
  MAX_FETCHED_COMMENTS,
  type ReviewCommentsOctokit,
  type ExistingComment,
} from "./existing-reviews-reader.js";
import type { InlineCommentSuggestion } from "./prompts.js";

function mkOctokit(rows: unknown): ReviewCommentsOctokit {
  return {
    pulls: {
      listReviewComments: vi.fn(async () => ({ data: rows as Array<Record<string, unknown>> })),
    },
  } as unknown as ReviewCommentsOctokit;
}

describe("fetchExistingReviewComments", () => {
  it("normalizes Octokit rows into ExistingComment[]", async () => {
    const oct = mkOctokit([
      { id: 1, path: "src/a.ts", line: 10, body: "Use const here", user: { login: "alice" } },
      { id: 2, path: "src/b.ts", original_line: 5, body: "Refactor please" },
      { id: 3, path: "", line: 1, body: "drop me" },
      { id: 4, path: "x.ts", line: -1, body: "drop me too" },
    ]);
    const out = await fetchExistingReviewComments(oct, { owner: "o", repo: "r", prNumber: 1 });
    expect(out).toHaveLength(2);
    expect(out[0].author).toBe("alice");
    expect(out[1].line).toBe(5);
    expect(out[1].author).toBe("unknown");
  });

  it("returns [] on Octokit failure", async () => {
    const oct: ReviewCommentsOctokit = {
      pulls: {
        listReviewComments: vi.fn(async () => {
          throw new Error("403");
        }),
      },
    };
    const out = await fetchExistingReviewComments(oct, { owner: "o", repo: "r", prNumber: 1 });
    expect(out).toEqual([]);
  });

  it("returns [] when Octokit returns non-array", async () => {
    const oct = mkOctokit(undefined);
    const out = await fetchExistingReviewComments(oct, { owner: "o", repo: "r", prNumber: 1 });
    expect(out).toEqual([]);
  });

  it("caps at MAX_FETCHED_COMMENTS", async () => {
    const rows = Array.from({ length: MAX_FETCHED_COMMENTS + 5 }, (_, i) => ({
      id: i,
      path: "x.ts",
      line: 1,
      body: `comment ${i}`,
      user: { login: "u" },
    }));
    const oct = mkOctokit(rows);
    const out = await fetchExistingReviewComments(oct, { owner: "o", repo: "r", prNumber: 1 });
    expect(out).toHaveLength(MAX_FETCHED_COMMENTS);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 0 for non-overlapping inputs", () => {
    expect(jaccardSimilarity("alpha bravo charlie", "delta echo foxtrot")).toBe(0);
  });

  it("returns 1 for identical token sets", () => {
    expect(jaccardSimilarity("alpha bravo charlie", "alpha bravo charlie")).toBe(1);
  });

  it("returns 0 when either side is empty after stop-word filtering", () => {
    expect(jaccardSimilarity("the and for", "alpha bravo")).toBe(0);
    expect(jaccardSimilarity("", "alpha")).toBe(0);
  });

  it("computes a partial-overlap score", () => {
    const s = jaccardSimilarity(
      "missing null check on user object",
      "missing null check should be added",
    );
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(1);
  });
});

describe("filterCandidatesAgainstExisting", () => {
  const candidate: InlineCommentSuggestion = {
    filePath: "src/foo.ts",
    line: 42,
    body: "missing null check on user object",
    severity: "warning",
  };
  const otherFile: InlineCommentSuggestion = {
    filePath: "src/bar.ts",
    line: 42,
    body: "missing null check on user object",
    severity: "warning",
  };

  it("keeps candidates on different files", () => {
    const out = filterCandidatesAgainstExisting(
      [otherFile],
      [
        {
          id: 1,
          filePath: "src/foo.ts",
          line: 42,
          body: "missing null check",
          author: "u",
        } satisfies ExistingComment,
      ],
    );
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toHaveLength(0);
  });

  it("drops candidates that overlap above the threshold on the same file:line", () => {
    const out = filterCandidatesAgainstExisting(
      [candidate],
      [
        {
          id: 99,
          filePath: "src/foo.ts",
          line: 42,
          body: "missing null check on user object value",
          author: "u",
        },
      ],
    );
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0].matchedExistingId).toBe(99);
    expect(out.dropped[0].score).toBeGreaterThanOrEqual(0.7);
    expect(out.kept).toHaveLength(0);
  });

  it("returns all candidates when no existing comments are provided", () => {
    const out = filterCandidatesAgainstExisting([candidate, otherFile], []);
    expect(out.kept).toHaveLength(2);
    expect(out.dropped).toHaveLength(0);
  });

  it("respects custom threshold", () => {
    const out = filterCandidatesAgainstExisting(
      [candidate],
      [
        {
          id: 1,
          filePath: "src/foo.ts",
          line: 42,
          body: "missing null check totally different sentence here",
          author: "u",
        },
      ],
      0.99,
    );
    expect(out.kept).toHaveLength(1);
  });
});

describe("renderExistingCommentsBlock", () => {
  it("returns empty string for no existing comments", () => {
    expect(renderExistingCommentsBlock([])).toBe("");
  });

  it("renders a fenced block with author and path:line annotations", () => {
    const out = renderExistingCommentsBlock([
      { id: 1, filePath: "src/a.ts", line: 5, body: "x".repeat(500), author: "alice" },
    ]);
    expect(out).toContain("<existing_comments>");
    expect(out).toContain("</existing_comments>");
    expect(out).toContain("alice");
    expect(out).toContain("src/a.ts:5");
    // Body is truncated to 240 chars.
    expect(out.length).toBeLessThan(800);
  });
});
