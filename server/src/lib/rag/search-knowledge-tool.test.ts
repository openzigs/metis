import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import { buildSearchKnowledgeTool } from "./search-knowledge-tool.js";
import type { KnowledgeService } from "./knowledge-service.js";

function hit(over: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: "c1",
    documentId: "d1",
    filename: "file.md",
    position: 0,
    text: "body",
    score: 0.5,
    embeddingModel: "m",
    source: "upload",
    ...over,
  };
}

function stubService(hits: RetrievedChunk[]): KnowledgeService {
  return {
    search: async () => ({ hits, coverageWarning: undefined }),
  } as unknown as KnowledgeService;
}

describe("search-knowledge tool — derived label (#199)", () => {
  it("labels a degraded, module-scoped generated-doc hit and leaves primary hits unlabelled", async () => {
    const tool = buildSearchKnowledgeTool({
      service: stubService([
        hit({
          chunkId: "g1",
          filename: "generated.md",
          source: "generated",
          derived: { status: "degraded", scope: "module" },
        }),
        hit({ chunkId: "u1", filename: "upload.md" }),
      ]),
    });
    const result = await tool.exec(
      { projectId: "p1", query: "q" },
      { sessionId: "s", userId: "u" },
    );
    const [generated, upload] = result.text.split("\n\n---\n\n");
    expect(generated).toContain(
      "generated.md#0 [DERIVED: generated documentation, not a primary source; status=degraded; scope=module]",
    );
    expect(upload).not.toContain("DERIVED");
  });
});
