import { describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import {
  __resetSearchKnowledgeRegistration,
  buildSearchKnowledgeTool,
  registerSearchKnowledgeTool,
} from "./search-knowledge-tool.js";
import { getToolRegistry } from "../ai/tool-registry.js";
import type { KnowledgeService } from "./knowledge-service.js";
import { codeVersionIndexOf, NO_CODE_VERSIONS } from "../code-graph/code-version.js";

// #2225 — the caller's role read is covered in tests/rag-acl-user-retrieval-2225.test.ts.
vi.mock("./acl.js", async (original) => ({
  ...(await original<typeof import("./acl.js")>()),
  resolveAclActor: async (userId: string) => ({ userId, role: "reader" }),
}));

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

describe("search-knowledge tool — paths and scores (#717)", () => {
  it("cites a repository file by its real path and prints the rank score", async () => {
    const tool = buildSearchKnowledgeTool({
      service: stubService([
        hit({
          chunkId: "r1",
          filename: "connector:repo:conn1:src/internal/model/feed.go",
          path: "internal/model/feed.go",
          position: 2,
          source: "repo",
          score: 0,
          rankScore: 0.5,
          matchedBy: ["lexical"],
        }),
      ]),
      loadVersions: async () => NO_CODE_VERSIONS,
    });
    const result = await tool.exec(
      { projectId: "p1", query: "q" },
      { sessionId: "s", userId: "u" },
    );
    expect(result.text).toContain("[1] (score=0.5000, keyword match) internal/model/feed.go#2");
    expect(result.text).not.toContain("src/internal");
    expect(result.text).not.toContain("score=0.0000");
  });
});

describe("search-knowledge tool — the citation contract of code-derived hits (#2325)", () => {
  const SHA = "c".repeat(40);
  const versions = codeVersionIndexOf([
    {
      repoConnectionId: "conn1",
      commitSha: SHA,
      repo: { provider: "github", ownerOrOrg: "acme", repoName: "app", apiBaseUrl: null },
    },
  ]);

  it("states the repository's indexed commit on a source hit, and nothing on a document", async () => {
    const loadVersions = vi.fn(async () => versions);
    const tool = buildSearchKnowledgeTool({
      service: stubService([
        hit({
          chunkId: "r1",
          filename: "connector:repo:conn1:src/internal/model/feed.go",
          path: "internal/model/feed.go",
          position: 2,
          source: "repo",
          matchedBy: ["dense", "lexical"],
        }),
        hit({ chunkId: "u1", filename: "FRD-12.md", source: "upload" }),
      ]),
      loadVersions,
    });
    const result = await tool.exec(
      { query: "q" },
      { sessionId: "s", userId: "u", projectId: "p1" },
    );
    expect(loadVersions).toHaveBeenCalledWith("p1");
    expect(result.citations).toEqual([
      {
        path: "internal/model/feed.go",
        startLine: null,
        endLine: null,
        commitSha: SHA,
        permalink: `https://github.com/acme/app/blob/${SHA}/internal/model/feed.go`,
        matchedBy: ["dense", "lexical"],
        truncated: false,
        totalLines: null,
        stale: false,
      },
    ]);
    expect(result.text).toContain(`Code version: indexed commit ${SHA.slice(0, 12)}.`);
  });

  it("reads no versions and adds no line when no hit is code", async () => {
    const loadVersions = vi.fn(async () => versions);
    const tool = buildSearchKnowledgeTool({
      service: stubService([hit({ filename: "FRD-12.md", source: "upload" })]),
      loadVersions,
    });
    const result = await tool.exec(
      { query: "q" },
      { sessionId: "s", userId: "u", projectId: "p1" },
    );
    expect(loadVersions).not.toHaveBeenCalled();
    expect(result.citations).toBeUndefined();
    expect(result.text).not.toContain("Code version");
  });

  it("does not treat an upload stored under a repository-shaped name as code", async () => {
    const tool = buildSearchKnowledgeTool({
      service: stubService([hit({ filename: "connector:repo:conn1:src/x.go", source: "upload" })]),
      loadVersions: async () => versions,
    });
    const result = await tool.exec(
      { query: "q" },
      { sessionId: "s", userId: "u", projectId: "p1" },
    );
    expect(result.citations).toBeUndefined();
  });
});
