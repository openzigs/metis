/**
 * Epic #396 / Issue #431 — tool registry unit tests.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SPEC_KIT_TOOLS, findTool } from "./tools.js";

describe("SPEC_KIT_TOOLS", () => {
  it("exposes the nine canonical commands as snake_case MCP tools", () => {
    expect(SPEC_KIT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "speckit_analyze",
        "speckit_checklist",
        "speckit_clarify",
        "speckit_constitution",
        "speckit_implement",
        "speckit_plan",
        "speckit_specify",
        "speckit_tasks",
        "speckit_taskstoissues",
      ].sort(),
    );
  });

  it("every tool has a non-empty description and a Zod-shaped input schema", () => {
    for (const tool of SPEC_KIT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.inputSchema).toBe("object");
      // The shape must be parseable as a Zod object.
      const schema = z.object(tool.inputSchema);
      expect(schema).toBeInstanceOf(z.ZodObject);
    }
  });

  it("each tool's toDispatchInput returns a canonical speckit.* command", () => {
    for (const tool of SPEC_KIT_TOOLS) {
      // Use the schema's defaults / .parse({}) on tools that accept zero args.
      const schema = z.object(tool.inputSchema);
      const parsed = schema.safeParse({});
      if (parsed.success) {
        const dispatch = tool.toDispatchInput(parsed.data);
        expect(dispatch.command).toMatch(/^speckit\./);
      }
    }
  });

  it("speckit_specify forwards the prompt as input and optional featureSlug as body", () => {
    const tool = findTool("speckit_specify")!;
    const dispatch = tool.toDispatchInput({ prompt: "Add OAuth", featureSlug: "001-oauth" });
    expect(dispatch).toEqual({
      command: "speckit.specify",
      input: "Add OAuth",
      body: { featureSlug: "001-oauth" },
    });
  });

  it("speckit_plan forwards featureSlug + force header", () => {
    const tool = findTool("speckit_plan")!;
    const dispatch = tool.toDispatchInput({ featureSlug: "001-thing", force: true });
    expect(dispatch.command).toBe("speckit.plan");
    expect(dispatch.body).toEqual({ featureSlug: "001-thing" });
    expect(dispatch.force).toBe(true);
  });

  it("speckit_taskstoissues includes parentEpicNumber + dryRun when provided", () => {
    const tool = findTool("speckit_taskstoissues")!;
    const dispatch = tool.toDispatchInput({
      featureSlug: "001-thing",
      repo: { owner: "acme", name: "proj" },
      parentEpicNumber: 42,
      dryRun: true,
    });
    expect(dispatch.body).toEqual({
      featureSlug: "001-thing",
      repo: { owner: "acme", name: "proj" },
      parentEpicNumber: 42,
      dryRun: true,
    });
  });

  it("speckit_checklist passes mode + domains through", () => {
    const tool = findTool("speckit_checklist")!;
    const dispatch = tool.toDispatchInput({
      featureSlug: "001-thing",
      mode: "overwrite",
      domains: ["security", "performance"],
    });
    expect(dispatch.body).toEqual({
      featureSlug: "001-thing",
      mode: "overwrite",
      domains: ["security", "performance"],
    });
  });

  it("zero-arg tools (tasks/analyze/implement) return only the command", () => {
    for (const name of ["speckit_tasks", "speckit_analyze", "speckit_implement"] as const) {
      const tool = findTool(name)!;
      const dispatch = tool.toDispatchInput({});
      expect(dispatch).toEqual({ command: name.replace("_", ".") });
    }
  });

  it("findTool returns undefined for unknown names", () => {
    expect(findTool("nope")).toBeUndefined();
  });
});
