/**
 * Tests for the agent tools (Epic #473 — Issues #474, #475, #476).
 *
 * Covers: search_code_graph, read_file_slice, list_files, search_knowledge.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { searchCodeGraphTool } from "../src/lib/analysis/tools/search-code-graph.js";
import { readFileSliceTool } from "../src/lib/analysis/tools/read-file-slice.js";
import { listFilesTool } from "../src/lib/analysis/tools/list-files.js";
import { createSearchKnowledgeTool } from "../src/lib/analysis/tools/search-knowledge.js";
import type { ToolContext } from "../src/lib/analysis/tools/types.js";

// ── Prisma mock ─────────────────────────────────────────────────────────
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    codeGraph: {
      findFirst: vi.fn(),
    },
    codeSymbol: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    codeEdge: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "../src/lib/prisma.js";
const mockPrisma = vi.mocked(prisma);

// ── Shared context ──────────────────────────────────────────────────────
const baseContext: ToolContext = { projectId: "proj-123" };

// ════════════════════════════════════════════════════════════════════════
// search_code_graph
// ════════════════════════════════════════════════════════════════════════
describe("searchCodeGraphTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns message when no code graph exists", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue(null);
    // #774 — a filter is now required to get past the unfiltered-call guard.
    const result = await searchCodeGraphTool.execute({ query: "Foo" }, baseContext);
    expect(result.content).toContain("No code graph available");
  });

  it("#774: rejects an unfiltered call instead of dumping alphabetical symbols", async () => {
    const result = await searchCodeGraphTool.execute({}, baseContext);
    expect(result.content).toContain("at least one filter");
    expect(mockPrisma.codeSymbol.findMany).not.toHaveBeenCalled();
  });

  it("searches symbols by query substring", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "UserService.findById",
        kind: "method",
        filePath: "src/services/user.ts",
        startLine: 42,
        endLine: 55,
        language: "typescript",
      },
    ] as never);

    const result = await searchCodeGraphTool.execute({ query: "UserService" }, baseContext);
    expect(result.content).toContain("UserService.findById");
    expect(result.content).toContain("src/services/user.ts:42-55");
    expect(result.content).toContain("[typescript]");
  });

  it("filters by kind", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([] as never);

    await searchCodeGraphTool.execute({ kind: "class" }, baseContext);
    expect(mockPrisma.codeSymbol.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: "class" }),
      }),
    );
  });

  it("handles calledBy edge queries", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findFirst.mockResolvedValue({ id: "sym-caller" } as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([{ toSymbolId: "sym-callee" }] as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "Database.query",
        kind: "method",
        filePath: "src/db.ts",
        startLine: 10,
        endLine: 20,
        language: "typescript",
      },
    ] as never);

    const result = await searchCodeGraphTool.execute({ calledBy: "main" }, baseContext);
    expect(result.content).toContain("Database.query");
  });

  it("returns message when calledBy symbol not found", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findFirst.mockResolvedValue(null);

    const result = await searchCodeGraphTool.execute({ calledBy: "nonexistent" }, baseContext);
    expect(result.content).toContain('No symbol matching "nonexistent"');
  });

  it("handles calls edge queries", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findFirst.mockResolvedValue({ id: "sym-callee" } as never);
    mockPrisma.codeEdge.findMany.mockResolvedValue([{ fromSymbolId: "sym-caller" }] as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      {
        qualifiedName: "Controller.handle",
        kind: "method",
        filePath: "src/ctrl.ts",
        startLine: 5,
        endLine: 15,
        language: "typescript",
      },
    ] as never);

    const result = await searchCodeGraphTool.execute({ calls: "Database.query" }, baseContext);
    expect(result.content).toContain("Controller.handle");
  });

  it("returns 'no symbols found' for empty results", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([] as never);

    const result = await searchCodeGraphTool.execute({ query: "zzz" }, baseContext);
    expect(result.content).toContain("No symbols found");
  });

  it("handles invalid/empty args gracefully", async () => {
    mockPrisma.codeGraph.findFirst.mockResolvedValue({ id: "cg-1" } as never);
    mockPrisma.codeSymbol.findMany.mockResolvedValue([] as never);

    const result = await searchCodeGraphTool.execute(null, baseContext);
    expect(result.content).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// read_file_slice
// ════════════════════════════════════════════════════════════════════════
describe("readFileSliceTool", () => {
  const tmpDir = path.join(process.cwd(), "test-clone-tmp");
  const context: ToolContext = { projectId: "p1", cloneDir: tmpDir };

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(path.join(tmpDir, "example.ts"), lines);
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "sub", "nested.ts"), "nested content\nline 2");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a file with default line range", async () => {
    const result = await readFileSliceTool.execute({ filePath: "example.ts" }, context);
    expect(result.content).toContain("example.ts (lines 1-200 of 300)");
    expect(result.content).toContain("1| line 1");
    expect(result.content).toContain("200| line 200");
    expect(result.truncated).toBe(true);
  });

  it("reads a specific line range", async () => {
    const result = await readFileSliceTool.execute(
      { filePath: "example.ts", startLine: 50, endLine: 60 },
      context,
    );
    expect(result.content).toContain("lines 50-60");
    expect(result.content).toContain("50| line 50");
    expect(result.content).toContain("60| line 60");
  });

  it("enforces max 200 lines per call", async () => {
    const result = await readFileSliceTool.execute(
      { filePath: "example.ts", startLine: 1, endLine: 300 },
      context,
    );
    expect(result.content).toContain("lines 1-200");
    expect(result.truncated).toBe(true);
  });

  /**
   * #773 — an OUT-OF-RANGE read is a BAD CALL, not a fact about the codebase. If it
   * came back as `resultCount: 0` the evidence threshold would read it as a
   * well-formed EMPTY result — "the tool worked and the thing genuinely is not
   * there" — which is an inference this call cannot support.
   */
  it("errors (never returns an empty result) when startLine is past the end of the file", async () => {
    const result = await readFileSliceTool.execute(
      { filePath: "example.ts", startLine: 5000, endLine: 5010 },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.resultCount).toBeUndefined();
    expect(result.content).toContain("past the end of");
  });

  it("reads nested files", async () => {
    const result = await readFileSliceTool.execute({ filePath: "sub/nested.ts" }, context);
    expect(result.content).toContain("nested content");
  });

  it("rejects path traversal attempts", async () => {
    const result = await readFileSliceTool.execute({ filePath: "../../etc/passwd" }, context);
    expect(result.content).toContain("Path traversal detected");
  });

  it("rejects symlinks pointing outside the clone directory", async () => {
    // Create a symlink inside the clone dir that points to /tmp (outside clone)
    const outsideDir = path.join(process.cwd(), "test-outside-symlink-target");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "sensitive data");
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(tmpDir, "escape-link.txt"));
    const result = await readFileSliceTool.execute({ filePath: "escape-link.txt" }, context);
    expect(result.content).toContain("Path traversal detected");
    // Cleanup
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("returns error for missing files", async () => {
    const result = await readFileSliceTool.execute({ filePath: "nonexistent.ts" }, context);
    expect(result.content).toContain("File not found");
  });

  it("returns error when no clone dir configured", async () => {
    const result = await readFileSliceTool.execute({ filePath: "foo.ts" }, { projectId: "p1" });
    expect(result.content).toContain("No repository clone directory");
  });

  it("returns error for missing filePath arg", async () => {
    const result = await readFileSliceTool.execute({}, context);
    // #774 — self-repairable: names the param and the keys that arrived.
    expect(result.content).toContain('requires "filePath"');
    expect(result.content).toContain("received keys: []");
  });
});

// ════════════════════════════════════════════════════════════════════════
// list_files
// ════════════════════════════════════════════════════════════════════════
describe("listFilesTool", () => {
  const tmpDir = path.join(process.cwd(), "test-list-tmp");
  const context: ToolContext = { projectId: "p1", cloneDir: tmpDir };

  beforeEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tmpDir, "src", "services"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "");
    await fs.writeFile(path.join(tmpDir, "src", "services", "user.ts"), "");
    await fs.writeFile(path.join(tmpDir, "src", "services", "auth.ts"), "");
    await fs.writeFile(path.join(tmpDir, "package.json"), "");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists files matching a glob pattern", async () => {
    const result = await listFilesTool.execute({ pattern: "src/**/*.ts" }, context);
    expect(result.content).toContain("src/index.ts");
    expect(result.content).toContain("src/services/user.ts");
    expect(result.content).toContain("src/services/auth.ts");
  });

  it("matches root-level files", async () => {
    const result = await listFilesTool.execute({ pattern: "*.json" }, context);
    expect(result.content).toContain("package.json");
  });

  it("returns message for no matches", async () => {
    const result = await listFilesTool.execute({ pattern: "*.xyz" }, context);
    expect(result.content).toContain("No files matching");
  });

  it("returns error when no clone dir", async () => {
    const result = await listFilesTool.execute({ pattern: "*.ts" }, { projectId: "p1" });
    expect(result.content).toContain("No repository clone directory");
  });

  it("returns error for missing pattern arg", async () => {
    const result = await listFilesTool.execute({}, context);
    expect(result.content).toContain('requires "pattern"');
    expect(result.content).toContain("received keys: []");
  });

  it("excludes symlinks pointing outside the clone directory", async () => {
    const outsideDir = path.join(process.cwd(), "test-outside-list-target");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "leaked.ts"), "secret");
    // Symlink file pointing outside
    await fs.symlink(path.join(outsideDir, "leaked.ts"), path.join(tmpDir, "src", "escape.ts"));
    // Symlink directory pointing outside
    await fs.symlink(outsideDir, path.join(tmpDir, "src", "outside-dir"));

    const result = await listFilesTool.execute({ pattern: "src/**/*.ts" }, context);
    expect(result.content).not.toContain("escape.ts");
    expect(result.content).not.toContain("leaked.ts");
    // Legit files should still appear
    expect(result.content).toContain("src/index.ts");
    // Cleanup
    await fs.rm(outsideDir, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════
// search_knowledge
// ════════════════════════════════════════════════════════════════════════
describe("searchKnowledgeTool", () => {
  const mockKnowledge = {
    search: vi.fn(),
  };

  const tool = createSearchKnowledgeTool({
    knowledgeService: mockKnowledge as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches knowledge base and returns formatted results", async () => {
    mockKnowledge.search.mockResolvedValue({
      hits: [
        {
          documentId: "doc-1",
          filename: "spec.md",
          position: 0,
          text: "The system shall authenticate users via OAuth2",
          score: 0.92,
        },
        {
          documentId: "doc-2",
          filename: "requirements.md",
          position: 3,
          text: "All API endpoints must return JSON",
          score: 0.85,
        },
      ],
      mode: "hybrid",
    });

    const result = await tool.execute({ query: "authentication requirements" }, baseContext);
    expect(result.content).toContain("spec.md#chunk0");
    expect(result.content).toContain("OAuth2");
    expect(result.content).toContain("requirements.md#chunk3");
    expect(mockKnowledge.search).toHaveBeenCalledWith("proj-123", "authentication requirements", {
      k: 5,
    });
  });

  it("respects custom k parameter", async () => {
    mockKnowledge.search.mockResolvedValue({ hits: [], mode: "hybrid" });
    await tool.execute({ query: "test", k: 10 }, baseContext);
    expect(mockKnowledge.search).toHaveBeenCalledWith("proj-123", "test", { k: 10 });
  });

  it("clamps k to max 15", async () => {
    mockKnowledge.search.mockResolvedValue({ hits: [], mode: "hybrid" });
    await tool.execute({ query: "test", k: 100 }, baseContext);
    expect(mockKnowledge.search).toHaveBeenCalledWith("proj-123", "test", { k: 15 });
  });

  it("returns message for no results", async () => {
    mockKnowledge.search.mockResolvedValue({ hits: [], mode: "hybrid" });
    const result = await tool.execute({ query: "unicorns" }, baseContext);
    expect(result.content).toContain("No relevant documents");
  });

  it("returns error for empty query", async () => {
    const result = await tool.execute({ query: "" }, baseContext);
    expect(result.content).toContain('requires "query"');
    expect(result.content).toContain("received keys: [query]");
  });

  it("returns error for missing args", async () => {
    const result = await tool.execute(null, baseContext);
    expect(result.content).toContain('requires "query"');
    expect(result.content).toContain("received keys: []");
  });
});

// Import afterAll for cleanup
import { afterAll } from "vitest";
