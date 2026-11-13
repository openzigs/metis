/**
 * #142 — the chat code tools' names, so an agent's `tools:` allowlist may name
 * them (they are offered by the chat tool runtime, not the ToolRegistry). A
 * dependency-free module so the agent service can import it without pulling in
 * the code-search implementations.
 *
 * #727 — and their one-line descriptors, so the agent authoring picker
 * (`GET /api/ai/tools`) can offer them. Before #727 the picker listed only the
 * registry, so a "code reviewer" custom agent could not be given a code tool,
 * although the built-in Architect names two of them. They are read-only and
 * project-scoped, which is why the runtime wraps them as `low` risk
 * (`codeRuntimeTool`).
 */
export const CHAT_CODE_TOOL_DESCRIPTORS: ReadonlyArray<{
  name: string;
  description: string;
  risk: "low";
}> = [
  {
    name: "search_code_graph",
    description:
      "Exact qualified-name, caller and callee lookup over the project's indexed code graph.",
    risk: "low",
  },
  {
    name: "search_code_symbols",
    description:
      "Keyword + semantic search over the project's code symbols, each with a file:line locator.",
    risk: "low",
  },
  {
    // #736 — chat's bounded file read.
    name: "read_file_slice",
    description: "Read up to 200 numbered lines of a file in the project's repository.",
    risk: "low",
  },
  {
    // #2326 — whether the index is failed, partial or still being built.
    name: "get_index_status",
    description:
      "Report the project's index: last indexed commit and time, how the last run ended, and coverage.",
    risk: "low",
  },
  {
    // #2327 — offered when CHAT_CODE_SEARCH_PRIMITIVES is on.
    name: "grep_files",
    description: "Find a literal text in the project's repository files, as path:line matches.",
    risk: "low",
  },
  {
    // #2327 — offered when CHAT_CODE_SEARCH_PRIMITIVES is on.
    name: "list_files",
    description: "List the project's repository files matching a glob.",
    risk: "low",
  },
  {
    // #2329 — whole symbols for a question (offered when CHAT_CODE_CONTEXT_TOOL is on).
    name: "search_code_context",
    description:
      "Whole functions and classes for a question about the code, adjacent matches merged, each with a file:line locator.",
    risk: "low",
  },
];

export const CHAT_CODE_TOOL_NAMES: readonly string[] = CHAT_CODE_TOOL_DESCRIPTORS.map(
  (t) => t.name,
);
