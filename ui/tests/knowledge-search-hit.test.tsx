/**
 * #717 — a Knowledge search hit prints the score its order comes from, labels a
 * keyword-only hit instead of showing it as 0.000, and names a repository file
 * by its real path.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { KnowledgeSearchHit } from "@/components/projects/knowledge-search-hit";
import type { RetrievedChunk } from "@/lib/projects-api";

function hit(over: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "c1",
    documentId: "d1",
    filename: "notes.md",
    position: 0,
    text: "body",
    score: 0.75,
    embeddingModel: "m",
    source: "upload",
    ...over,
  };
}

function renderHit(h: RetrievedChunk) {
  render(
    <ul>
      <KnowledgeSearchHit hit={h} />
    </ul>,
  );
}

describe("KnowledgeSearchHit (#717)", () => {
  it("names a repository file by its path and keeps the stored key in the tooltip", () => {
    renderHit(
      hit({
        filename: "connector:repo:conn1:src/internal/model/feed.go",
        path: "internal/model/feed.go",
        position: 2,
        source: "repo",
      }),
    );
    const name = screen.getByTestId("search-hit-name");
    expect(name).toHaveTextContent("internal/model/feed.go#2");
    expect(name).not.toHaveTextContent("src/");
    expect(name).toHaveAttribute("title", "connector:repo:conn1:src/internal/model/feed.go");
  });

  it("prints the rank score and labels a keyword-only hit rather than 0.000", () => {
    renderHit(hit({ score: 0, rankScore: 0.5, matchedBy: ["lexical"] }));
    expect(screen.getByTestId("search-hit-relevance")).toHaveTextContent("relevance 0.500");
    expect(screen.getByTestId("search-hit-match")).toHaveTextContent("keyword match");
    expect(screen.getByTestId("search-hit")).not.toHaveTextContent("0.000");
  });

  it("shows the cosine as secondary detail for a dense match", () => {
    renderHit(hit({ score: 0.756, rankScore: 0.98, matchedBy: ["dense", "lexical"] }));
    expect(screen.getByTestId("search-hit-relevance")).toHaveTextContent("relevance 0.980");
    expect(screen.getByTestId("search-hit-match")).toHaveTextContent("similarity 0.756");
  });

  it("falls back to filename and score for a hit from an older server", () => {
    renderHit(hit({ filename: "spec.md", score: 0.42 }));
    expect(screen.getByTestId("search-hit-name")).toHaveTextContent("spec.md#0");
    expect(screen.getByTestId("search-hit-relevance")).toHaveTextContent("relevance 0.420");
    expect(screen.queryByTestId("search-hit-match")).toBeNull();
  });
});
