/**
 * #2326 — `CHAT_INDEX_STATUS=false` takes `get_index_status` out of chat. The
 * flag is read the way the chat route reads it (`resolveSessionTools` with no
 * injected flags), so a `loadSessionToolsFlags` that ignored the key, or a
 * `resolveSessionTools` that dropped the option, fails here (#2384 panel).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: new Proxy(
    {},
    {
      // Any model: every read finds nothing (no agent, no skill, no MCP server).
      get: () => ({
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => 0),
      }),
    },
  ),
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

import { INDEX_STATUS_TOOL_NAME } from "../../analysis/tools/index-status.js";
import { loadSessionToolsFlags, resolveSessionTools } from "./session-tools.js";
import type { AIProvider } from "../types.js";

const KEYS = ["CHAT_INDEX_STATUS", "CHAT_TOOLS", "CHAT_CODE_SEARCH_TOOLS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const provider = { key: "openai", model: "gpt-4o" } as unknown as AIProvider;

async function offeredTools(): Promise<string[]> {
  const rt = await resolveSessionTools({
    session: { id: "s1", userId: "u1", projectId: "p1", agentId: null },
    provider,
    model: "gpt-4o",
    mcp: null,
    agents: { callable: [] },
  });
  return rt.toolset.tools.map((t) => t.name);
}

describe("CHAT_INDEX_STATUS in chat (#2326)", () => {
  it("is read by loadSessionToolsFlags: on unless turned off", () => {
    delete process.env.CHAT_INDEX_STATUS;
    expect(loadSessionToolsFlags().indexStatus).toBe(true);
    process.env.CHAT_INDEX_STATUS = "false";
    expect(loadSessionToolsFlags().indexStatus).toBe(false);
  });

  it("offers get_index_status by default, and not when the key is false", async () => {
    // Only the code tools: no registry, MCP or sub-agents in the way.
    process.env.CHAT_TOOLS = "false";
    process.env.CHAT_CODE_SEARCH_TOOLS = "true";
    delete process.env.CHAT_INDEX_STATUS;
    const on = await offeredTools();
    expect(on).toContain(INDEX_STATUS_TOOL_NAME);
    expect(on).toContain("search_code_symbols");

    process.env.CHAT_INDEX_STATUS = "false";
    const off = await offeredTools();
    expect(off).not.toContain(INDEX_STATUS_TOOL_NAME);
    // Only that tool goes: the other code tools stay.
    expect(off).toContain("search_code_symbols");
  });
});
