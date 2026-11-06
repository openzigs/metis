import { describe, expect, it } from "vitest";
import { extractCitedFiles, jaccard, sameFiles } from "./cited-files.js";

const REPO = [
  "internal/api/opml_handlers.go",
  "internal/reader/opml/handler.go",
  "internal/fever/handler.go",
  "internal/ui/opml_import.go",
  "client/client.go",
  "README.md",
];

describe("extractCitedFiles", () => {
  it("reads full paths, line-suffixed paths and backticked paths", () => {
    const answer =
      "See `internal/api/opml_handlers.go:25-35` and internal/ui/opml_import.go, " +
      "plus **client/client.go** (L10).";
    expect(extractCitedFiles(answer, REPO).files).toEqual([
      "client/client.go",
      "internal/api/opml_handlers.go",
      "internal/ui/opml_import.go",
    ]);
  });

  it("resolves a partial path that matches one file, and counts one that matches several", () => {
    const r = extractCitedFiles("opml/handler.go does it; handler.go too.", REPO);
    expect(r.files).toEqual(["internal/reader/opml/handler.go"]);
    expect(r.ambiguous).toEqual(["handler.go"]);
  });

  it("resolves a bare name that is unique", () => {
    expect(extractCitedFiles("opml_import.go", REPO).files).toEqual(["internal/ui/opml_import.go"]);
  });

  it("strips the repository name and a leading ./", () => {
    expect(
      extractCitedFiles("miniflux/client/client.go and ./README.md", REPO, "miniflux").files,
    ).toEqual(["README.md", "client/client.go"]);
  });

  it("ignores hosts, import paths and files the repository does not hold", () => {
    const answer =
      "https://www.youtube.com/watch?v=x — miniflux.app/v2/internal/config — internal/gone.go";
    expect(extractCitedFiles(answer, REPO)).toEqual({ files: [], ambiguous: [] });
  });

  it("does not read a longer extension as a shorter one", () => {
    expect(extractCitedFiles("client/client.gox", REPO).files).toEqual([]);
  });
});

describe("sameFiles / jaccard", () => {
  it("compares as sets", () => {
    expect(sameFiles(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameFiles(["a"], ["a", "b"])).toBe(false);
    expect(sameFiles(["a", "c"], ["a", "b"])).toBe(false);
    expect(sameFiles([], [])).toBe(true);
  });

  it("measures overlap", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
  });
});
