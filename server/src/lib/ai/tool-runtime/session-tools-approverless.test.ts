/**
 * #1139 — on a channel where nobody can answer an approval prompt, a tool that
 * needs one is not offered to the model at all.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: { aIToolApproval: { findFirst: vi.fn(async () => null) } },
}));

import { LOAD_SKILL_TOOL_NAME } from "@metis/shared";
import type { RiskLevel } from "../types.js";
import { withoutApprovalGatedTools, type SessionToolRuntime } from "./session-tools.js";
import { makeToolset } from "./toolset.js";
import type { RuntimeTool } from "./types.js";

function tool(name: string, risk: RiskLevel, extra: Partial<RuntimeTool> = {}): RuntimeTool {
  return {
    name,
    wireName: name,
    description: name,
    parameters: { type: "object" },
    risk,
    source: "metis",
    validate: (args) => ({ ok: true, args }),
    execute: vi.fn(async () => ({ text: "ok" })),
    ...extra,
  };
}

function runtime(
  tools: RuntimeTool[],
  mode: SessionToolRuntime["mode"] = "native",
): SessionToolRuntime {
  return {
    mode,
    toolset: makeToolset(tools, [{ name: "hidden_by_agent", risk: "low" }]),
    schemaBlock: "",
    agentAllowlist: null,
    skillMode: "progressive",
    skillCatalog: [],
    approvalOverride: null,
    subAgents: null,
  };
}

const SESSION = {
  id: "s1",
  policy: JSON.stringify({ low: "auto", medium: "prompt-once", high: "always-prompt" }),
};
const never = async () => false;

describe("withoutApprovalGatedTools", () => {
  it("withholds prompt-once and always-prompt tools and keeps the auto ones", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool("search", "low"), tool("inspect_schema", "medium"), tool("drop", "high")]),
      SESSION,
      never,
    );
    expect(out.withheld).toEqual(["inspect_schema", "drop"]);
    expect(out.runtime.mode).toBe("native");
    expect(out.runtime.toolset.tools.map((t) => t.name)).toEqual(["search"]);
    expect(out.runtime.toolset.specs().map((s) => s.name)).toEqual(["search"]);
    // The agent allowlist's own withheld list survives.
    expect(out.runtime.toolset.withheld("hidden_by_agent")).toBeDefined();
    // A withheld tool no longer resolves, so a call to it cannot reach the gate.
    expect(out.runtime.toolset.resolve("inspect_schema")).toBeUndefined();
  });

  it("keeps a prompt-once tool this session already approved", async () => {
    const remembered = vi.fn(async (name: string) => name === "inspect_schema");
    const out = await withoutApprovalGatedTools(
      runtime([tool("inspect_schema", "medium")]),
      SESSION,
      remembered,
    );
    expect(out.withheld).toEqual([]);
    expect(remembered).toHaveBeenCalledWith("inspect_schema", "medium");
  });

  it("withholds when the approval memory cannot be read (fails closed)", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool("inspect_schema", "medium")]),
      SESSION,
      async () => {
        throw new Error("db down");
      },
    );
    expect(out.withheld).toEqual(["inspect_schema"]);
  });

  it("withholds a tool governance forces to a prompt, even under auto", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([
        tool("mcp_forced", "low", { forcePrompt: true }),
        tool("mcp_now", "low", { forcePromptNow: async () => true }),
        tool("mcp_unreadable", "low", {
          forcePromptNow: async () => {
            throw new Error("governance unreadable");
          },
        }),
        tool("mcp_free", "low", { forcePromptNow: async () => false }),
      ]),
      SESSION,
      never,
    );
    expect(out.withheld).toEqual(["mcp_forced", "mcp_now", "mcp_unreadable"]);
    expect(out.runtime.toolset.tools.map((t) => t.name)).toEqual(["mcp_free"]);
  });

  it("leaves a policy=deny tool to the gate (refused at once)", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool("inspect_schema", "medium")]),
      { id: "s1", policy: JSON.stringify({ low: "auto", medium: "deny", high: "deny" }) },
      never,
    );
    expect(out.withheld).toEqual([]);
  });

  it("the session agent's override tightens the policy first", async () => {
    const rt = runtime([tool("search", "low")]);
    rt.approvalOverride = { low: "always-prompt" };
    const out = await withoutApprovalGatedTools(rt, SESSION, never);
    expect(out.withheld).toEqual(["search"]);
  });

  it("turns tools off when none is left, and skills inline without load_skill", async () => {
    const out = await withoutApprovalGatedTools(runtime([tool("drop", "high")]), SESSION, never);
    expect(out.runtime.mode).toBe("off");
    expect(out.runtime.toolset.tools).toEqual([]);
    expect(out.runtime.skillMode).toBe("inline");
  });

  it("keeps progressive skills while load_skill is still offered", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool(LOAD_SKILL_TOOL_NAME, "low"), tool("drop", "high")]),
      SESSION,
      never,
    );
    expect(out.runtime.skillMode).toBe("progressive");
  });

  it("returns the runtime untouched when nothing needs a person, or off the native path", async () => {
    const native = runtime([tool("search", "low")]);
    expect((await withoutApprovalGatedTools(native, SESSION, never)).runtime).toBe(native);
    const text = runtime([tool("drop", "high")], "text");
    const out = await withoutApprovalGatedTools(text, SESSION, never);
    expect(out.runtime).toBe(text);
    expect(out.withheld).toEqual([]);
  });

  it("defaults to the session's approval memory", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool("inspect_schema", "medium")]),
      SESSION,
    );
    expect(out.withheld).toEqual(["inspect_schema"]);
  });
});
