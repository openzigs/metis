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
 * An `mcp:<server>:…` ref also counts when `<server>` is a CONFIGURED MCP
 * server the agent's project may use, even while that server is stopped and
 * so has no tool in the live registry: saving is a statement about config,
 * not uptime. While such a server IS running its tools are known exactly, and
 * `mcp:<server>:<tool>` must name one of them. Run-time matching is unchanged
 * (exact names), so accepting a ref here never widens what an agent may call.
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

/**
 * The `<server>` segment an MCP server's tools carry (`mcp:<server>:<tool>`) —
 * the same slug `formatToolName` (mcp/tool-bridge.ts) builds; a test pins the two.
 */
export function mcpLabelSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** `<server>` of an `mcp:<server>:<rest>` ref with a non-empty rest, else null. */
function mcpServerOf(ref: string): string | null {
  const m = /^mcp:([^:]+):(.+)$/.exec(ref);
  return m ? m[1]! : null;
}

/**
 * The refs in `refs` that name no tool METIS has (see the module comment).
 * `configuredMcpServers` — the slugs of the MCP servers configured for the
 * agent's project (see `mcpLabelSlug`); empty = only the live registry counts.
 */
export function unknownToolRefs(
  refs: readonly string[],
  known: ReadonlySet<string>,
  configuredMcpServers: ReadonlySet<string> = new Set(),
): string[] {
  const mcpPrefixes = new Set<string>();
  const liveServers = new Set<string>();
  for (const name of known) {
    if (!name.startsWith("mcp:")) continue;
    const parts = name.split(":");
    if (parts.length >= 3) {
      mcpPrefixes.add(`mcp:${parts[1]}:*`);
      liveServers.add(parts[1]!);
    }
  }
  // A configured server with no live tool (stopped, not yet started).
  const offline = (ref: string): boolean => {
    const server = mcpServerOf(ref);
    return server !== null && configuredMcpServers.has(server) && !liveServers.has(server);
  };
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
      if (!mcpPrefixes.has(ref) && !offline(ref)) unknown.push(ref);
      continue;
    }
    if (!known.has(ref) && !offline(ref)) unknown.push(ref);
  }
  return unknown;
}
