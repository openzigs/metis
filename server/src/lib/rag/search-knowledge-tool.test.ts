import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import {
  __resetSearchKnowledgeRegistration,
  buildSearchKnowledgeTool,
  registerSearchKnowledgeTool,
} from "./search-knowledge-tool.js";
import { getToolRegistry } from "../ai/tool-registry.js";
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

/** A service that records which project each search ran against. */
function recordingService(): { service: KnowledgeService; projects: string[] } {
  const projects: string[] = [];
  const service = {
    search: async (projectId: string) => {
      projects.push(projectId);
      return { hits: [hit({ filename: "a.md" })], coverageWarning: undefined };
    },
  } as unknown as KnowledgeService;
  return { service, projects };
}

describe("search-knowledge tool — bound project default (#736)", () => {
  it("does not require projectId in its schema", () => {
    const tool = buildSearchKnowledgeTool({ service: stubService([]) });
    expect(tool.schema.safeParse({ query: "q" }).success).toBe(true);
  });

  it("searches the session's bound project when projectId is omitted", async () => {
    const { service, projects } = recordingService();
    const tool = buildSearchKnowledgeTool({ service });
    const result = await tool.exec(
      { query: "password rules" },
      { sessionId: "s", userId: "u", projectId: "cuid-p1" },
    );
    expect(result.isError).toBeUndefined();
    expect(projects).toEqual(["cuid-p1"]);
    expect(result.resultCount).toBe(1);
  });

  it("searches the bound project, never the argument, when the model passes the project NAME", async () => {
    const { service, projects } = recordingService();
    const tool = buildSearchKnowledgeTool({ service });
    const result = await tool.exec(
      { projectId: "Miniflux v2.3.3", query: "q" },
      { sessionId: "s", userId: "u", projectId: "cuid-p1" },
    );
    expect(result.isError).toBeUndefined();
    expect(projects).toEqual(["cuid-p1"]);
    expect(result.text).toContain("projectId argument was ignored");
    expect(result.text).toContain("a.md#0");
  });

  it("adds no note when the argument matches the bound project", async () => {
    const { service } = recordingService();
    const tool = buildSearchKnowledgeTool({ service });
    const result = await tool.exec(
      { projectId: "cuid-p1", query: "q" },
      { sessionId: "s", userId: "u", projectId: "cuid-p1" },
    );
    expect(result.text).not.toContain("ignored");
  });

  it("uses the argument in an unbound context", async () => {
    const { service, projects } = recordingService();
    const tool = buildSearchKnowledgeTool({ service });
    await tool.exec({ projectId: "cuid-p2", query: "q" }, { sessionId: "s", userId: "u" });
    expect(projects).toEqual(["cuid-p2"]);
  });

  it("errors, without searching, when neither the session nor the call names a project", async () => {
    const { service, projects } = recordingService();
    const tool = buildSearchKnowledgeTool({ service });
    const result = await tool.exec({ query: "q" }, { sessionId: "s", userId: "u" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("projectId is required");
    expect(projects).toEqual([]);
  });
});

describe("search-knowledge registration", () => {
  it("registers once, is idempotent, and the test seam removes it", () => {
    __resetSearchKnowledgeRegistration();
    expect(getToolRegistry().has("search-knowledge")).toBe(false);
    registerSearchKnowledgeTool({ service: stubService([]) });
    registerSearchKnowledgeTool({ service: stubService([]) });
    expect(getToolRegistry().has("search-knowledge")).toBe(true);
    __resetSearchKnowledgeRegistration();
    expect(getToolRegistry().has("search-knowledge")).toBe(false);
  });
});
