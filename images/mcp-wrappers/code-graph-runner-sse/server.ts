/**
 * Epic #298 / Issue #310 — code-graph-runner-sse MCP server.
 *
 * Hosts five tools backed by reads against the METIS `code_graphs`,
 * `code_symbols`, `code_edges` tables (Prisma). All five are deterministic —
 * no LLM, no outbound network, no file-system reads.
 *
 *   get_call_graph(file, depth?)  — symbols + their callees up to `depth` hops
 *   who_calls(symbol)             — list every caller of a qualified symbol
 *   defined_in(symbol)            — single { filePath, line } | null
 *   imports_of(file)              — both directions of import edges for a file
 *   outline(file)                 — flat list of symbols in `file` ordered by line
 *
 * The MCP transport layer is stdio (the ENTRYPOINT script bridges it to SSE
 * via `mcp-proxy`). Each tool delegates to a pure handler in `tools/*.ts` so
 * the same code is unit-testable from the METIS server-side test suite via
 * `server/tests/lib/code-graph/queries/*.test.ts` without booting the image.
 *
 * The `web-tree-sitter` runtime + WASM grammars are bundled per #307 AC for
 * future use (e.g. server-side symbol resolution at query time). v1 query
 * paths read the pre-computed graph directly; the WASM parsers are loaded
 * lazily so cold-start cost is paid only when a tool actually re-parses.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PrismaClient } from "@prisma/client";

import { getCallGraph, getCallGraphSchema } from "./queries/get_call_graph.js";
import { whoCalls, whoCallsSchema } from "./queries/who_calls.js";
import { definedIn, definedInSchema } from "./queries/defined_in.js";
import { importsOf, importsOfSchema } from "./queries/imports_of.js";
import { outline, outlineSchema } from "./queries/outline.js";

const prisma = new PrismaClient();
const server = new McpServer({ name: "code-graph-runner", version: "1.0.0" });

server.tool(
  "get_call_graph",
  "Symbols defined in `file` plus what they call up to `depth` hops (default 1).",
  getCallGraphSchema.shape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await getCallGraph(prisma, args)) }],
  }),
);

server.tool(
  "who_calls",
  "List every caller of `symbol` (qualified name).",
  whoCallsSchema.shape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await whoCalls(prisma, args)) }],
  }),
);

server.tool(
  "defined_in",
  "Resolve `symbol` (qualified name) to { filePath, line } or null.",
  definedInSchema.shape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await definedIn(prisma, args)) }],
  }),
);

server.tool(
  "imports_of",
  "Both directions of import edges for `file`.",
  importsOfSchema.shape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await importsOf(prisma, args)) }],
  }),
);

server.tool(
  "outline",
  "Flat list of symbols in `file` ordered by line.",
  outlineSchema.shape,
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await outline(prisma, args)) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
