/**
 * #1139 — on a channel where nobody can answer an approval prompt, a tool that
 * needs one is not offered to the model at all.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: { aIToolApproval: { findFirst: vi.fn(async () => null) } },
}));
const { auditCalls } = vi.hoisted(() => ({
  auditCalls: [] as Array<{ metadata: Record<string, unknown> }>,
}));
vi.mock("../../audit/audit-service.js", () => ({
  audit: (input: { metadata: Record<string, unknown> }) => auditCalls.push(input),
}));

import { LOAD_SKILL_TOOL_NAME } from "@metis/shared";
import { ApprovalGateService } from "../approval-policy.js";
import type { RiskLevel } from "../types.js";
import { executeToolCall } from "./executor.js";
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
    // PR #1234 review — but it is known as needing an approver, by any spelling.
    expect(out.runtime.toolset.needsApprover?.("inspect_schema")).toBe("inspect_schema");
    expect(out.runtime.toolset.needsApprover?.("inspect-schema")).toBe("inspect_schema");
    expect(out.runtime.toolset.needsApprover?.("search")).toBeUndefined();
    expect(out.runtime.toolset.needsApprover?.("no_such_tool")).toBeUndefined();
  });

  it("#1240 a withheld tool's other spelling never resolves to a kept tool", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool("run-check", "high"), tool("run_check", "low")]),
      SESSION,
      never,
    );
    expect(out.withheld).toEqual(["run-check"]);
    const ts = out.runtime.toolset;
    // The kept tool, by its own name, still runs.
    expect(ts.resolve("run_check")?.name).toBe("run_check");
    // The withheld tool's own spelling is refused as needing an approver — it
    // must not be respelt into the kept `run_check`.
    expect(ts.resolve("run-check")).toBeUndefined();
    expect(ts.needsApprover?.("run-check")).toBe("run-check");
  });

  it("#1240 every spelling shared with a withheld tool is blocked, multi-separator names too", async () => {
    const out = await withoutApprovalGatedTools(
      runtime([tool("a-b_c", "high"), tool("a_b-c", "low"), tool("search-knowledge", "low")]),
      SESSION,
      never,
    );
    const ts = out.runtime.toolset;
    expect(ts.resolve("a_b-c")?.name).toBe("a_b-c");
    for (const spelling of ["a-b_c", "a_b_c", "a-b-c"]) {
      expect(ts.resolve(spelling)).toBeUndefined();
      expect(ts.needsApprover?.(spelling)).toBe("a-b_c");
    }
    // A kept tool's other spelling that no withheld tool shares still resolves.
    expect(ts.resolve("search_knowledge")?.name).toBe("search-knowledge");
    expect(ts.needsApprover?.("search_knowledge")).toBeUndefined();
  });

  it("#1240 a call by the withheld tool's spelling is refused and never runs the kept tool", async () => {
    const kept = tool("run_check", "low");
    const out = await withoutApprovalGatedTools(
      runtime([tool("run-check", "high"), kept]),
      SESSION,
      never,
    );
    auditCalls.length = 0;
    const result = await executeToolCall(
      { id: "c1", name: "run-check", args: {} },
      {
        toolset: out.runtime.toolset,
        gate: new ApprovalGateService({
          sessionId: "s1",
          userId: "u1",
          policy: { low: "auto", medium: "auto", high: "auto" },
        }),
        ctx: { sessionId: "s1", userId: "u1", projectId: "p1" },
      },
    );
    expect(kept.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ executed: false, errorCode: "TOOL_DENIED" });
    expect(result.reason).toBe("no_interactive_approver");
    expect(auditCalls.map((a) => a.metadata.tool)).toEqual(["run-check"]);
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
