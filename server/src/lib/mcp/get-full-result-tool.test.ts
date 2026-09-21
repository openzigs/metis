/**
 * Epic #515 / Issue #518 — Unit tests for get_full_result tool.
 */
import { describe, it, expect } from "vitest";
import { createGetFullResultTool } from "./get-full-result-tool.js";
import { ProgressiveResultManager } from "./progressive-results.js";

describe("createGetFullResultTool", () => {
  function makeManager(): ProgressiveResultManager {
    return new ProgressiveResultManager({
      thresholdTokens: 10, // Low threshold to force summarization
      ttlMs: 60_000,
    });
  }

  it("returns tool with correct name and schema", () => {
    const manager = makeManager();
    const tool = createGetFullResultTool({ manager });

    expect(tool.name).toBe("get_full_result");
    expect(tool.parameters.required).toContain("id");
    expect(tool.parameters.properties?.id).toBeDefined();
  });

  it("returns full cached result by ID", async () => {
    const manager = makeManager();
    const tool = createGetFullResultTool({ manager });

    // Cache a large result
    const content = "Full content " + "x".repeat(200);
    const processResult = manager.processResult("test_tool", content);

    const result = await tool.execute({ id: processResult.cacheId }, { projectId: "p1" });

    expect(result.content).toBe(content);
  });

  it("returns error for unknown cache ID", async () => {
    const manager = makeManager();
    const tool = createGetFullResultTool({ manager });

    const result = await tool.execute({ id: "nonexistent-id" }, { projectId: "p1" });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("not found or expired");
  });

  it("returns error when id arg is missing", async () => {
    const manager = makeManager();
    const tool = createGetFullResultTool({ manager });

    const result = await tool.execute({}, { projectId: "p1" });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("required");
  });

  it("returns error when id is empty string", async () => {
    const manager = makeManager();
    const tool = createGetFullResultTool({ manager });

    const result = await tool.execute({ id: "" }, { projectId: "p1" });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("required");
  });
});
