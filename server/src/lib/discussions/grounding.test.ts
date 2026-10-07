/**
 * #739 — the read-only tools a discussion @AI reply is offered, and the gate
 * that decides its calls. Uses a REAL ToolRegistry, toolset builder and gate;
 * only the approval-row write is a double.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const approvalRows: Array<Record<string, unknown>> = [];
vi.mock("../prisma.js", () => ({
  prisma: {
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        approvalRows.push(data);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

const { ToolRegistry } = await import("../ai/tool-registry.js");
const { DISCUSSION_NATIVE_TOOL_NOTE, DISCUSSION_TOOL_ALLOWLIST, resolveDiscussionTools } =
  await import("./grounding.js");
import type { AIProvider, RiskLevel } from "../ai/types.js";

const provider = { key: "openai", model: "m" } as unknown as AIProvider;
const session = { id: "s1", userId: "u1", projectId: "p1" };
const ON = { chatTools: true, codeSearchTools: true };

function registryWith(...tools: Array<[string, RiskLevel]>) {
  const r = new ToolRegistry();
  for (const [name, risk] of tools) {
    r.register({
      name,
      description: name,
      risk,
      schema: z.object({}).passthrough(),
      exec: async () => ({ text: "ok" }),
    });
  }
  return r;
}

const FULL = (): InstanceType<typeof ToolRegistry> =>
  registryWith(
    ["search-knowledge", "low"],
    ["search-knowledge-global", "low"],
    ["query_database", "medium"],
    ["apply_diff", "high"],
    ["list_requirements", "low"],
  );

describe("resolveDiscussionTools", () => {
  beforeEach(() => {
    approvalRows.length = 0;
  });

  it("offers only project-scoped reads: search-knowledge and the chat code tools", async () => {
    const rt = await resolveDiscussionTools({
      session,
      provider,
      model: "m",
      flags: ON,
      registry: FULL(),
      native: true,
    });
    expect(rt).not.toBeNull();
    expect(rt!.native).toBe(true);
    expect(rt!.note).toBe(DISCUSSION_NATIVE_TOOL_NOTE);
    expect(rt!.toolset.tools.map((t) => t.name).sort()).toEqual(
      ["read_file_slice", "search-knowledge", "search_code_graph", "search_code_symbols"].sort(),
    );
    // Writes, SQL, a cross-project search and other METIS tools are not offered.
    for (const absent of ["query_database", "apply_diff", "search-knowledge-global"]) {
      expect(rt!.toolset.resolve(absent)).toBeUndefined();
    }
  });

  it("follows chat's flags: no code tools when CHAT_CODE_SEARCH_TOOLS is off", async () => {
    const rt = await resolveDiscussionTools({
      session,
      provider,
      model: "m",
      flags: { chatTools: true, codeSearchTools: false },
      registry: FULL(),
      native: true,
    });
    expect(rt!.toolset.tools.map((t) => t.name)).toEqual(["search-knowledge"]);
  });

  it("offers nothing when chat's tools are off and code tools are off", async () => {
    const rt = await resolveDiscussionTools({
      session,
      provider,
      model: "m",
      flags: { chatTools: false, codeSearchTools: false },
      registry: FULL(),
      native: true,
    });
    expect(rt).toBeNull();
  });

  it("a model that is not tool-capable gets the code tools on the text protocol", async () => {
    const rt = await resolveDiscussionTools({
      session,
      provider,
      model: "m",
      flags: ON,
      registry: FULL(),
      native: false,
    });
    expect(rt!.native).toBe(false);
    expect(rt!.toolset.tools.map((t) => t.name)).toEqual([...DISCUSSION_TOOL_ALLOWLIST.slice(1)]);
    expect(rt!.note).toContain("read_file_slice");
  });

  it("a non-tool-capable model with code tools off gets no tools", async () => {
    const rt = await resolveDiscussionTools({
      session,
      provider,
      model: "m",
      flags: { chatTools: true, codeSearchTools: false },
      registry: FULL(),
      native: false,
    });
    expect(rt).toBeNull();
  });

  it("reads the native capability from the catalog when not overridden", async () => {
    const rt = await resolveDiscussionTools({
      session,
      provider: { key: "offline-stub", model: "offline-stub" } as unknown as AIProvider,
      model: "offline-stub",
      flags: { chatTools: true, codeSearchTools: false },
      registry: FULL(),
    });
    // The offline stub is not tool-capable, and code tools are off.
    expect(rt).toBeNull();
  });

  describe("the gate", () => {
    async function gate() {
      const rt = await resolveDiscussionTools({
        session,
        provider,
        model: "m",
        flags: ON,
        registry: FULL(),
        native: true,
      });
      return rt!.gate;
    }
    const ask = (toolName: string, risk: RiskLevel) => ({
      sessionId: "s1",
      userId: "u1",
      toolName,
      risk,
      args: {},
    });

    it("runs a low-risk read without a prompt, and records the decision", async () => {
      const g = await gate();
      await expect(g.evaluate(ask("search-knowledge", "low"))).resolves.toMatchObject({
        allowed: true,
        decision: "auto-approve",
      });
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0]).toMatchObject({ sessionId: "s1", toolName: "search-knowledge" });
    });

    it("denies a tool outside the allowlist even when the model names it", async () => {
      const g = await gate();
      await expect(g.evaluate(ask("list_requirements", "low"))).resolves.toMatchObject({
        allowed: false,
        reason: "not_in_agent_allowlist",
      });
    });

    it("denies a non-low call outright: nobody in a thread can approve it", async () => {
      const g = await gate();
      await expect(g.evaluate(ask("read_file_slice", "medium"))).resolves.toMatchObject({
        allowed: false,
        reason: "policy=deny",
      });
    });
  });
});
