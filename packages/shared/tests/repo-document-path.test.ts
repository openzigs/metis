/**
 * #717 — a repository-sourced document's stored filename is an internal key,
 * `connector:repo:<connectorId>:src/<relPath>` for a source file. The `src/`
 * segment is the ingester's namespace marker, not a directory in the repo, so a
 * citation built from it pointed at files that do not exist.
 */
import { describe, expect, it } from "vitest";
import { repoDocumentPath, retrievedChunkSchema } from "../src/project.js";

describe("repoDocumentPath (#717)", () => {
  it("strips the connector key and the src/ namespace marker from a source file", () => {
    expect(repoDocumentPath("connector:repo:cmurla7px:src/internal/model/feed.go")).toBe(
      "internal/model/feed.go",
    );
  });

  it("keeps a real top-level src/ directory (only the marker is removed)", () => {
    expect(repoDocumentPath("connector:repo:c1:src/src/index.ts")).toBe("src/index.ts");
  });

  it("returns the repo-root name for metadata units (README, OVERVIEW, manifests)", () => {
    expect(repoDocumentPath("connector:repo:c1:README.md")).toBe("README.md");
    expect(repoDocumentPath("connector:repo:c1:go.mod")).toBe("go.mod");
  });

  it("returns undefined for anything that is not a repository key", () => {
    expect(repoDocumentPath("notes.md")).toBeUndefined();
    expect(repoDocumentPath("connector:db:c1:OVERVIEW.md")).toBeUndefined();
    expect(repoDocumentPath("connector:repo:c1:")).toBeUndefined();
    expect(repoDocumentPath("connector:repo:c1:src/")).toBeUndefined();
    expect(repoDocumentPath("")).toBeUndefined();
  });

  it("the retrieved-chunk contract accepts the optional rank/path fields", () => {
    const base = {
      chunkId: "chunk00001",
      documentId: "document01",
      filename: "connector:repo:c1:src/a.go",
      position: 0,
      text: "x",
      score: 0,
      embeddingModel: "m",
      source: "repo",
    };
    expect(retrievedChunkSchema.parse(base)).toEqual(base);
    const extended = { ...base, rankScore: 0.5, matchedBy: ["lexical"], path: "a.go" };
    expect(retrievedChunkSchema.parse(extended)).toEqual(extended);
    expect(retrievedChunkSchema.safeParse({ ...base, matchedBy: ["vector"] }).success).toBe(false);
  });
});
