/**
 * Epic #880 — Issue #887 — `query_database` AI tool.
 *
 * Lets an agent run a read-only SQL query against a project's database
 * connector to ground answers in live data.
 *
 * Security posture (mandatory — see epic #880):
 *   - SELECT-only: {@link queryDbConnector} runs every statement through
 *     {@link validateSelectOnly} (node-sql-parser AST check + keyword
 *     backstop), so INSERT/UPDATE/DELETE/DDL/multi-statement SQL is rejected
 *     before it reaches a driver.
 *   - Project-scoped: only connectors belonging to `ctx.projectId` resolve
 *     (`getDbConnector` `findFirst`s on `{id, projectId}`). Cross-project
 *     access is impossible.
 *   - Credentials via vault; egress via the network allow-list; rows are
 *     PII-redacted and hard-capped at QUERY_DB_MAX_ROWS.
 *   - Every query emits a `connector.db.query` audit entry.
 *   - Risk = high → routed through the approval gate (always-prompt) by the
 *     {@link ToolRegistry}.
 *
 * Wire-up: registered at server boot via {@link registerQueryDatabase}.
 */
import { z } from "zod";
import { QUERY_DB_MAX_ROWS } from "@metis/shared";
import { queryDbConnector } from "../../connectors/db/db-service.js";
import { AppError } from "../../../middleware/error-handler.js";
import type { ToolDefinition, ToolResult, ToolContext } from "../types.js";

export const QUERY_DATABASE_TOOL_NAME = "query_database";

export const queryDatabaseSchema = z.object({
  connectorId: z.string().min(1).max(200).describe("Id of the project's database connector"),
  sql: z
    .string()
    .min(1)
    .max(8_000)
    .describe("A single read-only SELECT statement. Writes/DDL are rejected."),
  /** Optional client-side cap; effective cap is min(maxRows, QUERY_DB_MAX_ROWS). */
  maxRows: z.number().int().min(1).max(QUERY_DB_MAX_ROWS).optional(),
});

export type QueryDatabaseArgs = z.infer<typeof queryDatabaseSchema>;

export function createQueryDatabaseTool(): ToolDefinition<typeof queryDatabaseSchema> {
  return {
    name: QUERY_DATABASE_TOOL_NAME,
    description:
      "Run a single read-only SELECT query against a project database connector. " +
      `Returns up to ${QUERY_DB_MAX_ROWS} PII-redacted rows. Only SELECT is permitted — ` +
      "INSERT/UPDATE/DELETE/DDL are rejected. Project-scoped; credentials via vault.",
    schema: queryDatabaseSchema,
    risk: "high",
    async exec(args: QueryDatabaseArgs, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.projectId) {
        throw new AppError(
          400,
          "PROJECT_SCOPE_REQUIRED",
          "query_database requires a project-scoped session",
        );
      }
      const result = await queryDbConnector(ctx.projectId, args.connectorId, ctx.userId, args.sql);
      const rows =
        args.maxRows && result.rows.length > args.maxRows
          ? result.rows.slice(0, args.maxRows)
          : result.rows;
      const text = JSON.stringify({
        columns: result.columns,
        rowCount: rows.length,
        truncated: result.truncated || rows.length < result.rows.length,
        rows,
      });
      return {
        text,
        data: {
          columns: result.columns,
          rows,
          rowCount: rows.length,
          truncated: result.truncated || rows.length < result.rows.length,
        },
      };
    },
  };
}

export function registerQueryDatabase(registry: {
  register: (t: ToolDefinition) => void;
  unregister: (n: string) => boolean;
}): { registered: boolean } {
  registry.unregister(QUERY_DATABASE_TOOL_NAME);
  registry.register(createQueryDatabaseTool() as unknown as ToolDefinition);
  return { registered: true };
}
