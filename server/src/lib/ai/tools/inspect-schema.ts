/**
 * Epic #880 — Issue #881 — `inspect_schema` AI tool.
 *
 * Lets an agent introspect the schema (tables + columns) of a project's
 * database connector so it can ground SQL generation in the real data model.
 *
 * Security posture (mandatory — see epic #880):
 *   - Project-scoped: the tool ONLY resolves connectors that belong to
 *     `ctx.projectId`. {@link inspectDbConnector} delegates to
 *     `getDbConnector(projectId, id)` which `findFirst`s on `{id, projectId}`,
 *     so an agent in project A can never inspect project B's connectors.
 *   - Credentials are resolved via the vault (never plaintext) and egress is
 *     gated by the network allow-list inside the db-service.
 *   - Every inspect emits a `connector.db.inspect` audit entry.
 *   - Risk = medium → routed through the approval gate (prompt-once) by the
 *     {@link ToolRegistry}.
 *
 * Wire-up: registered at server boot via {@link registerInspectSchema}.
 */
import { z } from "zod";
import { inspectDbConnector } from "../../connectors/db/db-service.js";
import { AppError } from "../../../middleware/error-handler.js";
import type { ToolDefinition, ToolResult, ToolContext } from "../types.js";

export const INSPECT_SCHEMA_TOOL_NAME = "inspect_schema";

export const inspectSchemaSchema = z.object({
  connectorId: z.string().min(1).max(200).describe("Id of the project's database connector"),
  /** Optional schema/namespace filter forwarded to the driver. */
  schema: z.string().min(1).max(200).optional(),
});

export type InspectSchemaArgs = z.infer<typeof inspectSchemaSchema>;

/** Compact, model-friendly projection of the full schema snapshot. */
interface CompactColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}
interface CompactTable {
  schema: string;
  name: string;
  columns: CompactColumn[];
}

export function createInspectSchemaTool(): ToolDefinition<typeof inspectSchemaSchema> {
  return {
    name: INSPECT_SCHEMA_TOOL_NAME,
    description:
      "Inspect the schema (tables + columns) of a project database connector. " +
      "Returns tables with their columns (name, type, nullable, primaryKey). " +
      "Read-only; project-scoped; credentials resolved via vault.",
    schema: inspectSchemaSchema,
    risk: "medium",
    async exec(args: InspectSchemaArgs, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.projectId) {
        throw new AppError(
          400,
          "PROJECT_SCOPE_REQUIRED",
          "inspect_schema requires a project-scoped session",
        );
      }
      const snapshot = await inspectDbConnector(ctx.projectId, args.connectorId, ctx.userId, {
        ...(args.schema ? { schema: args.schema } : {}),
      });
      const tables: CompactTable[] = snapshot.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.dataType,
          nullable: c.nullable,
          primaryKey: c.isPrimaryKey,
        })),
      }));
      const text =
        tables.length === 0
          ? `Connector ${args.connectorId} has no tables in the inspected schema.`
          : tables
              .map(
                (t) =>
                  `${t.schema}.${t.name}(${t.columns
                    .map((c) => `${c.name}:${c.type}${c.nullable ? "?" : ""}`)
                    .join(", ")})`,
              )
              .join("\n");
      return {
        text,
        data: { connectorId: snapshot.connectorId, driver: snapshot.driver, tables },
      };
    },
  };
}

export function registerInspectSchema(registry: {
  register: (t: ToolDefinition) => void;
  unregister: (n: string) => boolean;
}): { registered: boolean } {
  registry.unregister(INSPECT_SCHEMA_TOOL_NAME);
  registry.register(createInspectSchemaTool() as unknown as ToolDefinition);
  return { registered: true };
}
