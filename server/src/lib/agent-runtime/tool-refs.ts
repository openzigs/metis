/**
 * #238 — ONE check of an agent's `tools` allowlist against the tools METIS
 * really has, for both kinds of agent (#74 library agents, custom agents).
 *
 * A ref is known when it is:
 *   • the exact name of a registered tool (`ToolRegistry`, MCP-bridged
 *     `mcp:<server>:<tool>` included) or a chat code tool
 *     (`search_code_graph` / `search_code_symbols` — offered by the chat tool
 *     runtime, not the registry);
 *   • `mcp:*`, or `mcp:<server>:*` when at least one tool of that server is
 *     registered (a typo'd prefix still fails loudly);
 *   • an agent tool: `load_skill` (#146), `agent:*`, `agent:library:*`,
 *     `agent:custom:*` or one agent's `agent:<kind>:<id>` (#147).
 * Anything else — `search_documents`, a URL, a bare `*` — is unknown. An
 * unknown ref never widens what an agent may call (the allowlist is matched
 * exactly at run time), but it silently takes away a tool the author meant
 * to give, so it is refused when the definition is saved.
 */
import { LOAD_SKILL_TOOL_NAME, SUBAGENT_TOOL_PREFIX } from "@metis/shared";
import { CHAT_CODE_TOOL_NAMES } from "../analysis/tools/chat-code-tool-names.js";
import type { ToolRegistry } from "../ai/tool-registry.js";
import { parseAgentRef } from "./definition.js";

/** Every tool name an allowlist may name exactly: the registry plus the chat code tools. */
export function knownToolNames(registry: Pick<ToolRegistry, "list">): Set<string> {
  return new Set([...registry.list().map((t) => t.name), ...CHAT_CODE_TOOL_NAMES]);
}

/** The refs in `refs` that name no tool METIS has (see the module comment). */
export function unknownToolRefs(refs: readonly string[], known: ReadonlySet<string>): string[] {
  const mcpPrefixes = new Set<string>();
  for (const name of known) {
    if (!name.startsWith("mcp:")) continue;
    const parts = name.split(":");
    if (parts.length >= 3) mcpPrefixes.add(`mcp:${parts[1]}:*`);
  }
  const unknown: string[] = [];
  for (const ref of refs) {
    if (ref === "mcp:*" || ref === LOAD_SKILL_TOOL_NAME) continue;
    if (ref.startsWith(SUBAGENT_TOOL_PREFIX)) {
      const rest = ref.slice(SUBAGENT_TOOL_PREFIX.length);
      if (rest === "*" || rest === "library:*" || rest === "custom:*") continue;
      if (parseAgentRef(rest)) continue;
      unknown.push(ref);
      continue;
    }
    if (ref.endsWith(":*")) {
      if (!mcpPrefixes.has(ref)) unknown.push(ref);
      continue;
    }
    if (!known.has(ref)) unknown.push(ref);
  }
  return unknown;
}
