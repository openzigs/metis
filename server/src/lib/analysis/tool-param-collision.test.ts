/**
 * P0 #774 — FORWARD GUARD on the flat-args absorption.
 *
 * `parseToolCall` absorbs FLAT top-level tool args, minus a set of protocol /
 * chain-of-thought keys (`PROTOCOL_KEYS`) and the nested-args container aliases
 * (`ARG_CONTAINER_KEYS`). That exclusion is what keeps a stray `"thought"` out of
 * a tool's arguments — but it cuts both ways: if a tool ever DECLARED a parameter
 * named `input`, `name`, `params`, `arguments`, ... then a model emitting that
 * param flat would have it SILENTLY SWALLOWED. That is precisely the arg-loss bug
 * class #774 exists to kill, and today it holds only by luck of naming.
 *
 * So: derive every registered tool's parameter names from the tools' own JSON
 * Schemas (never a hand-copied list — a hand-copied list rots and stops
 * protecting anything) and assert the intersection with the reserved keys is
 * empty. Adding a colliding param to any tool fails this test by name.
 */
import { describe, expect, it, vi } from "vitest";
import { ARG_CONTAINER_KEYS, PROTOCOL_KEYS, parseToolCall } from "./agent-loop.js";
import { assembleAgenticCodeTools } from "./orchestrator.js";
import { getChatCodeTools } from "./tools/index.js";
import type { AgentTool } from "./tools/types.js";
import type { KnowledgeService } from "../rag/knowledge-service.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../rag/fused-code-context.js";

/**
 * Stubs for the tool factories' injectable deps — no live embedder / LanceDB /
 * Prisma. Nothing is EXECUTED here; we only read each tool's declared schema.
 */
const knowledgeStub = { search: vi.fn(async () => []) } as unknown as KnowledgeService;
const searcherStub: FusedCodeSearcher = { search: vi.fn(async () => []) };
const lineLookupStub: SymbolLineLookup = { resolve: vi.fn(async () => new Map()) };

/**
 * Every tool the agent can be offered, enumerated from the REAL registries —
 * `assembleAgenticCodeTools` (analysis, #730) and `getChatCodeTools` (chat, #713).
 * A `cloneDir` is supplied so the clone-gated `read_file_slice` / `list_files`
 * tools are included. A tool newly registered in either factory is covered here
 * automatically; nothing about the tool set is restated in this test.
 */
function registeredTools(): AgentTool[] {
  const tools = [
    ...assembleAgenticCodeTools({
      knowledgeService: knowledgeStub,
      cloneDir: "/tmp/collision-guard-clone",
      fusedCodeDeps: { searcher: searcherStub, lineLookup: lineLookupStub },
    }),
    ...getChatCodeTools({ searcher: searcherStub, lineLookup: lineLookupStub }),
  ];
  // Both surfaces share `search_code_graph` / `search_code_symbols` by design.
  return [...new Map(tools.map((t) => [t.name, t])).values()];
}

/** A tool's declared param names, straight off its JSON Schema. */
function declaredParams(tool: AgentTool): string[] {
  return Object.keys(tool.parameters.properties ?? {});
}

describe("#774 — tool params must not collide with the reserved absorption keys", () => {
  it("introspects a non-trivial param set (the guard is not vacuously passing)", () => {
    const tools = registeredTools();
    expect(tools.length).toBeGreaterThanOrEqual(5);
    // If tools ever stop declaring `parameters.properties`, the collision check
    // below would compare against an empty set and pass while protecting nothing.
    const withParams = tools.filter((t) => declaredParams(t).length > 0);
    expect(withParams.length).toBeGreaterThanOrEqual(4);
    expect(declaredParams(tools.find((t) => t.name === "search_code_symbols")!)).toContain("query");
  });

  it("no registered tool declares a param that parseToolCall would swallow", () => {
    const collisions: string[] = [];

    for (const tool of registeredTools()) {
      for (const param of declaredParams(tool)) {
        const isContainer = (ARG_CONTAINER_KEYS as readonly string[]).includes(param);
        if (!isContainer && !PROTOCOL_KEYS.has(param)) continue;
        collisions.push(
          `tool "${tool.name}" declares param "${param}" which collides with an ` +
            `${isContainer ? "arg-container" : "protocol"} key — rename the param, or ` +
            `parseToolCall will silently swallow it (#774).`,
        );
      }
    }

    expect(collisions, collisions.join("\n")).toEqual([]);
  });

  it("demonstrates the hazard the guard protects against", () => {
    // A hypothetical tool declaring `input`: the model emits it FLAT, and the
    // absorption drops it — no error, no arg. This is why the guard above exists.
    const call = parseToolCall(
      JSON.stringify({ tool: "hypothetical_tool", input: "the value the model supplied" }),
      ["hypothetical_tool"],
    );
    expect(call).toEqual({ tool: "hypothetical_tool", args: {} });
  });
});
