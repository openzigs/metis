/**
 * #142 — the chat code tools' names, so an agent's `tools:` allowlist may name
 * them (they are offered by the chat tool runtime, not the ToolRegistry). A
 * dependency-free module so the agent service can import it without pulling in
 * the code-search implementations.
 */
export const CHAT_CODE_TOOL_NAMES: readonly string[] = ["search_code_graph", "search_code_symbols"];
