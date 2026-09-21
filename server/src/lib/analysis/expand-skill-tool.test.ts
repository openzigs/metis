/**
 * Epic #515 / Issue #516 — Unit tests for expand_skill tool.
 */
import { describe, it, expect } from "vitest";
import { createExpandSkillTool } from "./expand-skill-tool.js";
import { SkillRegistry } from "./skill-loader.js";

describe("createExpandSkillTool", () => {
  function makeRegistry(): SkillRegistry {
    const registry = new SkillRegistry("lazy");
    registry.register({
      key: "code-review",
      name: "Code Review",
      trigger: "review code",
      description: "Reviews code for quality issues",
      instructions: "Full code review instructions here. Step 1: Read the diff...",
      version: "2.0.0",
    });
    registry.register({
      key: "test-plan",
      name: "Test Plan",
      trigger: "plan tests",
      description: "Creates test plans",
      instructions: "Full test planning instructions. Step 1: Identify requirements...",
      version: "1.5.0",
    });
    return registry;
  }

  it("returns tool with correct name and schema", () => {
    const registry = makeRegistry();
    const tool = createExpandSkillTool({ registry });

    expect(tool.name).toBe("expand_skill");
    expect(tool.parameters.required).toContain("skill");
    expect(tool.parameters.properties?.skill).toBeDefined();
  });

  it("returns full instructions for a known skill", async () => {
    const registry = makeRegistry();
    const tool = createExpandSkillTool({ registry });

    const result = await tool.execute({ skill: "code-review" }, { projectId: "p1" });

    expect(result.content).toContain("Full code review instructions");
  });

  it("returns error for unknown skill", async () => {
    const registry = makeRegistry();
    const tool = createExpandSkillTool({ registry });

    const result = await tool.execute({ skill: "nonexistent" }, { projectId: "p1" });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("Unknown skill");
    expect(parsed.available).toContain("code-review");
    expect(parsed.available).toContain("test-plan");
  });

  it("returns error when skill arg is missing", async () => {
    const registry = makeRegistry();
    const tool = createExpandSkillTool({ registry });

    const result = await tool.execute({}, { projectId: "p1" });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("required");
  });

  it("returns error when skill is empty string", async () => {
    const registry = makeRegistry();
    const tool = createExpandSkillTool({ registry });

    const result = await tool.execute({ skill: "" }, { projectId: "p1" });

    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("required");
  });
});
