/**
 * #2295 — the code-search tools went on by default in #2243, measured on models
 * that call tools natively. A model that cannot (some local runtimes) would get
 * them through the text-protocol loop, which does not stream and was never
 * measured, so there they stay off unless the deployment sets
 * `CHAT_CODE_SEARCH_TOOLS=true`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));

import type { AIProvider } from "../types.js";
import { loadSessionToolsFlags, resolveSessionTools } from "./session-tools.js";

const KEY = "CHAT_CODE_SEARCH_TOOLS";

const provider = (nativeToolCalls: boolean) =>
  ({
    name: "stub",
    capabilities: { nativeToolCalls, responseFormat: false },
  }) as unknown as AIProvider;

function resolve(nativeToolCalls: boolean) {
  return resolveSessionTools({
    session: { id: "s1", userId: "u1", projectId: "p1", agentId: null },
    provider: provider(nativeToolCalls),
    model: "m",
    // The deployment's own flags, read from config as the route reads them.
    flags: { ...loadSessionToolsFlags(), chatTools: false, subAgents: false },
    mcp: null,
  });
}

describe("resolveSessionTools — models without native tool calls (#2295)", () => {
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("offers no code tools on the text protocol when the flag is unset", async () => {
    delete process.env[KEY];
    const rt = await resolve(false);
    expect(rt.mode).toBe("off");
    expect(rt.toolset.tools).toEqual([]);
    expect(rt.schemaBlock).toBe("");
  });

  it("still offers them natively to a tool-capable model when the flag is unset", async () => {
    delete process.env[KEY];
    const rt = await resolve(true);
    expect(rt.mode).toBe("native");
    expect(rt.toolset.resolve("read_file_slice")).toBeDefined();
  });

  it("offers them on the text protocol when the deployment sets the flag", async () => {
    process.env[KEY] = "true";
    const rt = await resolve(false);
    expect(rt.mode).toBe("text");
    expect(rt.toolset.tools.map((t) => t.name).sort()).toEqual(
      ["read_file_slice", "search_code_graph", "search_code_symbols"].sort(),
    );
    expect(rt.schemaBlock).toContain("read_file_slice");
  });
});
