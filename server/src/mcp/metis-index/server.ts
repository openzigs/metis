/**
 * #2331 — `metis-index-mcp`: METIS's governed index over MCP, on stdio.
 *
 * An external agent (Claude Code, Cursor, Claude Desktop, …) queries the index
 * METIS builds — code context, symbols, call graph, file slices, requirements,
 * index status, the projects it may read — through eight `metis_*` tools.
 * There is no LLM in this server: the client agent does the reasoning, and no
 * tool path constructs a model provider.
 *
 * Unlike `metis-speckit-mcp` (a REST client), this server runs IN PROCESS
 * against METIS's own database, vector store and clones, so it is launched on
 * a host that runs the METIS server, with the server's environment
 * (`DATABASE_URL`, the LanceDB path, the clone root, the embedder settings).
 * The identity it runs as is NOT taken from that environment: it is the
 * caller's own METIS API token, resolved to its user on every call
 * (`identity.ts`), and every result passes that user's project access and
 * per-document ACLs (`dispatcher.ts`).
 *
 * Configuration:
 *   METIS_API_TOKEN — the caller's own METIS API token (`metis_…`, scope `acp:read`).
 *
 * Spawn: `node dist/mcp/metis-index/server.js`, or `pnpm --filter @metis/server metis-index-mcp`.
 * Client configuration: docs/integrations/metis-index-mcp.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import winston from "winston";
import { logger } from "../../lib/logger.js";
import { toolInputSchema } from "../speckit/tools.js";
import { dispatchIndexTool, type DispatchEnv, type IndexToolOutput } from "./dispatcher.js";
import { McpAuthError, resolveMcpCaller, type TokenVerifier } from "./identity.js";
import { buildSharedImpls, INDEX_TOOLS, type IndexToolDef, type SharedImplDeps } from "./tools.js";

export const SERVER_NAME = "metis-index-mcp";
export const CREDENTIAL_ENV = "METIS_API_TOKEN";

export interface CreateIndexMcpServerOptions {
  /** The caller's own METIS API token. */
  credential: string;
  verify?: TokenVerifier;
  audit?: DispatchEnv["audit"];
  log?: DispatchEnv["log"];
  /** Test seams for the shared implementations (the hybrid searcher). */
  deps?: SharedImplDeps;
  version?: string;
}

/** `structuredContent` of every successful call (`IndexToolOutput`). */
const outputShape = {
  tool: z.string(),
  projectId: z.string().nullable(),
  result: z.string(),
  resultCount: z.number().int().nullable(),
  truncated: z.boolean(),
  citations: z.array(z.record(z.string(), z.unknown())),
  instructions: z.string().nullable(),
};

/**
 * What a client that reads `content` (most agents do) reads after the result:
 * its count, whether it was cut, and #2324's instructions, AFTER the data as
 * chat places them. The full object, citations with their permalinks
 * included, is the `structuredContent`.
 *
 * Not the MCP spec's suggested serialized-JSON text block: in the `mcp` arm of
 * `pnpm eval:ba-qa` (23 questions, Sonnet 5.5), a JSON copy (escaped newlines,
 * the citation array again) read 45,661 input tokens per question and had 39
 * results cut by the tool loop's cap; this text, 41,022 and 19 (#2331).
 */
export function resultTrailer(output: IndexToolOutput): string {
  const count = output.resultCount === null ? "" : `Results: ${output.resultCount}`;
  const cut = output.truncated
    ? "Truncated: there is more; narrow the query or the line range to see it."
    : "";
  return [count, cut, output.instructions ?? ""].filter((l) => l !== "").join("\n");
}

/** Register the eight `metis_*` tools on a fresh server; the caller connects the transport. */
export function createIndexMcpServer(opts: CreateIndexMcpServerOptions): McpServer {
  const env: DispatchEnv = {
    credential: opts.credential,
    impls: buildSharedImpls(opts.deps),
    ...(opts.verify ? { verify: opts.verify } : {}),
    ...(opts.audit ? { audit: opts.audit } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  };
  const server = new McpServer(
    { name: SERVER_NAME, version: opts.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );
  for (const def of INDEX_TOOLS as readonly IndexToolDef[]) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: toolInputSchema(def.inputSchema),
        outputSchema: outputShape,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: unknown) => {
        const out = await dispatchIndexTool(def, args ?? {}, env);
        if (out.isError) {
          return { isError: true, content: [{ type: "text" as const, text: out.message }] };
        }
        return {
          content: [
            { type: "text" as const, text: out.output.result },
            { type: "text" as const, text: resultTrailer(out.output) },
          ],
          structuredContent: { ...out.output },
        };
      },
    );
  }
  return server;
}

/**
 * stdout IS the MCP transport: a log line written there corrupts the stream.
 * Send every level of the server's logger, and `console.log`/`info`/`debug`,
 * to stderr.
 */
export function routeLogsToStderr(
  target: { transports: winston.transport[] } = logger,
  con: Pick<Console, "log" | "info" | "debug" | "error"> = console,
): void {
  const all = Object.fromEntries(Object.keys(winston.config.npm.levels).map((l) => [l, true]));
  for (const t of target.transports) {
    if (t instanceof winston.transports.Console) {
      (t as unknown as { stderrLevels: Record<string, boolean> }).stderrLevels = all;
    }
  }
  const toStderr = (...a: unknown[]): void => con.error(...a);
  con.log = toStderr;
  con.info = toStderr;
  con.debug = toStderr;
}

/**
 * Boot on stdio. Refuses to start without a credential, or with one that does
 * not resolve to an active METIS user (it is resolved again on every call).
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  routeLogsToStderr();
  const credential = env[CREDENTIAL_ENV] ?? "";
  try {
    await resolveMcpCaller(credential);
  } catch (err) {
    if (err instanceof McpAuthError) throw new Error(`${CREDENTIAL_ENV}: ${err.message}`);
    throw err;
  }
  const server = createIndexMcpServer({ credential });
  await server.connect(new StdioServerTransport());
}

const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /mcp\/metis-index\/server\.(?:js|ts)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${SERVER_NAME} boot failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
