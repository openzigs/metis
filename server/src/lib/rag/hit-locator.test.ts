import { describe, expect, it } from "vitest";
import { displayFilename, formatHitLocator, formatHitScore } from "./hit-locator.js";

describe("formatHitLocator (#717)", () => {
  it("names a repository file by its real path", () => {
    expect(
      formatHitLocator({
        filename: "connector:repo:c1:src/internal/model/feed.go",
        path: "internal/model/feed.go",
        position: 2,
      }),
    ).toBe("internal/model/feed.go#2");
  });

  it("falls back to the filename when there is no path", () => {
    expect(formatHitLocator({ filename: "notes.md", position: 0 })).toBe("notes.md#0");
  });
});

describe("formatHitScore (#717)", () => {
  it("prints the rank score, not the dense cosine", () => {
    expect(formatHitScore({ score: 0, rankScore: 0.5, matchedBy: ["dense", "lexical"] }, 3)).toBe(
      "score=0.500",
    );
  });

  it("labels a lexical-only hit instead of letting it read as irrelevant", () => {
    expect(formatHitScore({ score: 0, rankScore: 0.49, matchedBy: ["lexical"] }, 4)).toBe(
      "score=0.4900, keyword match",
    );
  });

  it("falls back to score for a hit without a rank score", () => {
    expect(formatHitScore({ score: 0.73 }, 3)).toBe("score=0.730");
  });
});

describe("displayFilename (#717)", () => {
  const key = "connector:repo:c1:src/internal/model/feed.go";

  it("names a repo row by its repository-relative path", () => {
    expect(displayFilename({ filename: key, source: "repo" })).toBe("internal/model/feed.go");
  });

  it("keeps the stored name for a non-repo row carrying a repo-shaped name (#547)", () => {
    expect(displayFilename({ filename: key, source: "upload" })).toBe(key);
    expect(displayFilename({ filename: key })).toBe(key);
  });

  it("keeps a repo row's name when it is not a repository key", () => {
    expect(displayFilename({ filename: "notes.md", source: "repo" })).toBe("notes.md");
  });
});
