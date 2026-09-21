/**
 * Epic #596 / Issue #621 — Code Graph-First Strategy unit tests.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { CodeGraphFirstStrategy } from "../src/lib/analysis/strategies/code-graph-first.js";
import { ASTSummaryCache } from "../src/lib/analysis/ast-summary-cache.js";
import type { AgentTool, ToolContext } from "../src/lib/analysis/tools/types.js";

function createMockTool(name: string, content = "full file content"): AgentTool {
  return {
    name,
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({ content }),
  };
}

describe("CodeGraphFirstStrategy", () => {
  let cache: ASTSummaryCache;
  let strategy: CodeGraphFirstStrategy;
  const context: ToolContext = { projectId: "test-project" };

  const TS_SOURCE = [
    "export function greet(name: string): string {",
    '  return "Hello " + name;',
    "}",
  ].join("\n");

  beforeEach(() => {
    cache = new ASTSummaryCache();
    strategy = new CodeGraphFirstStrategy({ cache });
  });

  describe("wrapTools", () => {
    it("wraps file-read tools", () => {
      const tools = [createMockTool("read_file_slice"), createMockTool("search_code_graph")];
      const wrapped = strategy.wrapTools(tools);
      expect(wrapped).toHaveLength(2);
      // read_file_slice is intercepted, search_code_graph is not
      expect(wrapped[0].execute).not.toBe(tools[0].execute);
      expect(wrapped[1].execute).toBe(tools[1].execute);
    });

    it("returns original tools in bypass mode", () => {
      const bypassed = new CodeGraphFirstStrategy({ cache, bypass: true });
      const tools = [createMockTool("read_file_slice")];
      const wrapped = bypassed.wrapTools(tools);
      expect(wrapped[0].execute).toBe(tools[0].execute);
    });
  });

  describe("cache hit", () => {
    it("returns AST summary instead of full file read", async () => {
      await cache.indexFile("src/service.ts", TS_SOURCE);
      const tool = createMockTool("read_file_slice");
      const wrapped = strategy.wrapTool(tool);

      const result = await wrapped.execute({ filePath: "src/service.ts" }, context);

      expect(result.content).toContain("AST Summary");
      expect(result.content).toContain("greet");
      expect(tool.execute).not.toHaveBeenCalled();
      expect(strategy.stats.cacheHits).toBe(1);
      expect(strategy.stats.fallthroughs).toBe(0);
    });
  });

  describe("cache miss", () => {
    it("falls through to original tool on cache miss", async () => {
      const tool = createMockTool("read_file_slice");
      const wrapped = strategy.wrapTool(tool);

      const result = await wrapped.execute({ filePath: "unknown.ts" }, context);

      expect(result.content).toBe("full file content");
      expect(tool.execute).toHaveBeenCalled();
      expect(strategy.stats.fallthroughs).toBe(1);
    });
  });

  describe("fallthrough rate alert", () => {
    it("triggers alert when rate exceeds threshold", async () => {
      const lowThreshold = new CodeGraphFirstStrategy({
        cache,
        alertThreshold: 0.2,
      });
      const tool = createMockTool("read_file");

      // Generate enough misses to trigger alert (10+ lookups needed)
      for (let i = 0; i < 12; i++) {
        const wrapped = lowThreshold.wrapTool(tool);
        await wrapped.execute({ filePath: `miss-${i}.ts` }, context);
      }

      expect(lowThreshold.stats.alertTriggered).toBe(true);
      expect(lowThreshold.stats.fallthroughRate).toBeGreaterThan(0.2);
    });

    it("does not trigger alert under threshold", async () => {
      await cache.indexFile("hit.ts", TS_SOURCE);
      const tool = createMockTool("read_file");

      // 10+ lookups, mostly hits
      for (let i = 0; i < 12; i++) {
        const wrapped = strategy.wrapTool(tool);
        await wrapped.execute({ filePath: "hit.ts" }, context);
      }

      expect(strategy.stats.alertTriggered).toBe(false);
    });

    it("does not alert with too few samples", async () => {
      const lowThreshold = new CodeGraphFirstStrategy({
        cache,
        alertThreshold: 0.01,
      });
      const tool = createMockTool("read_file");
      const wrapped = lowThreshold.wrapTool(tool);
      await wrapped.execute({ filePath: "miss.ts" }, context);

      // Only 1 lookup — below minimum sample size
      expect(lowThreshold.stats.alertTriggered).toBe(false);
    });
  });

  describe("non-file tools pass through unchanged", () => {
    it("does not intercept non-file tools", async () => {
      const tool = createMockTool("search_knowledge");
      const wrapped = strategy.wrapTool(tool);
      expect(wrapped.execute).toBe(tool.execute);
    });
  });

  describe("missing filePath arg", () => {
    it("falls through when no filePath in args", async () => {
      const tool = createMockTool("read_file");
      const wrapped = strategy.wrapTool(tool);
      await wrapped.execute({}, context);
      expect(tool.execute).toHaveBeenCalled();
    });
  });

  describe("resetStats", () => {
    it("resets all counters", async () => {
      const tool = createMockTool("read_file");
      const wrapped = strategy.wrapTool(tool);
      await wrapped.execute({ filePath: "miss.ts" }, context);
      expect(strategy.stats.intercepted).toBe(1);

      strategy.resetStats();
      expect(strategy.stats.intercepted).toBe(0);
      expect(strategy.stats.fallthroughs).toBe(0);
      expect(strategy.stats.cacheHits).toBe(0);
      expect(strategy.stats.alertTriggered).toBe(false);
    });
  });
});
