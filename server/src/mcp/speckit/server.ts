/**
 * Epic #396 / Issue #431 — `metis-speckit-mcp` stdio MCP server.
 *
 * Boots a Model Context Protocol server over stdio that exposes the nine
 * `speckit.*` commands as MCP tools. Each tool dispatches to the existing
 * METIS REST surface (`/api/projects/:id/spec-kit/commands/:cmd`) using a
 * service token — the MCP layer adds zero new business logic and simply
 * provides a transport that hosts like Claude Desktop / Cursor / Copilot
 * speak natively.
 *
 * Configuration (env vars, all required):
 *   METIS_API_BASE_URL    — origin must be on the SPECKIT_INSTALL_ALLOWED_API_HOSTS allow-list
 *   METIS_PROJECT_ID      — tenant scope (single-project per server process)
 *   METIS_SERVICE_TOKEN   — bearer token forwarded as `Authorization: Bearer …`
 *
 * Spawn: `node dist/mcp/speckit/server.js` (or via `pnpm metis-speckit-mcp`).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type SpecKitMcpConfig,
  assertConfig,
  dispatchToHttp,
  type FetchLike,
} from "./dispatcher.js";
import { SPEC_KIT_TOOLS } from "./tools.js";

export interface CreateSpecKitMcpServerOptions {
  config: SpecKitMcpConfig;
  /** Override fetch (tests + Node <18 compatibility). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Override the package version surfaced in `serverInfo`. */
  version?: string;
}

const SERVER_NAME = "metis-speckit-mcp";

/**
 * Wire the nine Spec Kit tools onto a fresh `McpServer` instance. Caller
 * is responsible for connecting the transport.
 */
export function createSpecKitMcpServer(opts: CreateSpecKitMcpServerOptions): McpServer {
  assertConfig(opts.config);
  const fetchImpl: FetchLike =
    opts.fetchImpl ??
    (async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, ok: r.ok, text: () => r.text() };
    });
  const server = new McpServer(
    { name: SERVER_NAME, version: opts.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );
  for (const tool of SPEC_KIT_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        const safeArgs = (args ?? {}) as Record<string, unknown>;
        // Tools have heterogeneous arg shapes (some take no args at all); the
        // call site is verified at runtime by the SDK against the registered
        // Zod inputSchema, so we cast through `never` to satisfy TS.
        const dispatch = tool.toDispatchInput(safeArgs as never);
        try {
          const data = await dispatchToHttp(opts.config, dispatch, fetchImpl);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text" as const, text: msg }],
          };
        }
      },
    );
  }
  return server;
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpecKitMcpConfig {
  return {
    apiBaseUrl: env.METIS_API_BASE_URL ?? "",
    projectId: env.METIS_PROJECT_ID ?? "",
    token: env.METIS_SERVICE_TOKEN ?? "",
  };
}

export { readConfigFromEnv as __readConfigFromEnvForTests };

/**
 * Smoke-test entrypoint — boots the server on stdio. Intended to be the
 * `main` of `dist/mcp/speckit/server.js`.
 */
export async function main(): Promise<void> {
  const config = readConfigFromEnv();
  const server = createSpecKitMcpServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /mcp\/speckit\/server\.(?:js|ts)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    // Stderr is the only safe channel — stdout is the MCP transport.
    process.stderr.write(`metis-speckit-mcp boot failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
