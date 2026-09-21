/**
 * Issue #1312 — describe_table tool.
 *
 * The agentic code agent reasons about database columns constantly ("this data
 * element is net-new", "that column already exists") but had no way to check:
 * its toolset could search code and documents, never the live schema. It
 * therefore asserted schema facts on inference alone, and the passive schema
 * summary is token-budgeted, so the very tables a requirement is about can be
 * present by NAME ONLY (#1310's overflow index) with no column detail.
 *
 * This closes that loop: given a table name the agent has seen — in the overflow
 * index, in a query in the source, or in a document — it can fetch that table's
 * real columns and foreign keys on demand.
 *
 * Read-only and safe: it reuses `introspectProjectSchema`, the same read-only
 * connector introspection the passive summary uses, so it can never run DDL and
 * is scoped to the caller's project. Introspection is memoised per tool instance
 * (one instance per run), so an agent describing eight tables costs one round
 * trip, not eight.
 */
import type { DbTableInfo } from "@metis/shared";
import type { AgentTool, ToolContext, ToolResult, JSONSchema } from "./types.js";
import { missingParamError } from "./arg-errors.js";
import { renderTableBlock, tableQualifiedName } from "../schema-context.js";

/** Cap tables per call so one call cannot blow the turn's context budget. */
const MAX_TABLES_PER_CALL = 8;

/**
 * Cap a single requested name. The name is echoed back on a miss, and the model
 * controls it, so an unbounded value would let one malformed call flood the
 * transcript. Real identifiers are far shorter than this.
 */
const MAX_NAME_CHARS = 128;

/** Cap the reflected driver error for the same reason. */
const MAX_ERROR_CHARS = 200;

/** How many near-miss names to offer back when a lookup finds nothing. */
const MAX_SUGGESTIONS = 10;

export interface DescribeTableArgs {
  tables: string[];
}

const parameters: JSONSchema = {
  type: "object",
  properties: {
    tables: {
      type: "array",
      items: { type: "string" },
      description:
        "Table names to describe (1-8). Qualified ('SALESDB.TRANSACTION_JOBS') or bare " +
        "('TRANSACTION_JOBS'); matching is case-insensitive. A single string is also accepted.",
    },
  },
  required: ["tables"],
};

/**
 * Accept both `{ tables: [...] }` and `{ tables: "ONE_TABLE" }` — #774's point is
 * that a rejection the model cannot repair costs a whole turn, and coercing an
 * obviously-equivalent shape is cheaper than teaching it the difference.
 */
function validateArgs(args: unknown): DescribeTableArgs | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const raw = a.tables ?? a.table;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) return null;
  const tables = list
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().slice(0, MAX_NAME_CHARS))
    .filter((t) => t !== "")
    .slice(0, MAX_TABLES_PER_CALL);
  if (tables.length === 0) return null;
  return { tables };
}

/**
 * Resolve a requested name against the introspected schema, tolerating the
 * qualified/bare mismatch that the driver, the documents and the source code all
 * disagree about. An unqualified request matches on bare name; a qualified one
 * must match the qualified form.
 */
function findTable(tables: DbTableInfo[], requested: string): DbTableInfo | undefined {
  const want = requested.toLowerCase();
  return (
    tables.find((t) => tableQualifiedName(t).toLowerCase() === want) ??
    (want.includes(".") ? undefined : tables.find((t) => t.name.toLowerCase() === want))
  );
}

/** Names sharing a token with the miss, so a near-miss is repairable in one turn. */
function suggestNames(tables: DbTableInfo[], requested: string): string[] {
  const parts = requested
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 3);
  if (parts.length === 0) return [];
  return tables
    .filter((t) => {
      const qn = tableQualifiedName(t).toLowerCase();
      return parts.some((p) => qn.includes(p));
    })
    .map(tableQualifiedName)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SUGGESTIONS);
}

export interface DescribeTableDeps {
  /**
   * Resolve the project's schema, or `null` when it has no introspectable
   * connector. Bound to the run's actor by the caller, because `ToolContext`
   * carries no actor identity.
   */
  introspect: (projectId: string) => Promise<{ tables: DbTableInfo[] } | null>;
}

export function createDescribeTableTool(deps: DescribeTableDeps): AgentTool {
  // Memoised for the life of the tool instance (one per run) — describing N
  // tables must not cost N introspections.
  let cached: Promise<{ tables: DbTableInfo[] } | null> | undefined;

  async function execute(args: unknown, context: ToolContext): Promise<ToolResult> {
    const validated = validateArgs(args);
    if (!validated) {
      return {
        content: missingParamError({
          tool: "describe_table",
          param: "tables",
          expected: "array of 1-8 table-name strings",
          args,
          example: "TRANSACTION_JOBS",
        }),
        isError: true,
      };
    }

    let introspection: { tables: DbTableInfo[] } | null;
    try {
      cached ??= deps.introspect(context.projectId);
      introspection = await cached;
    } catch (err) {
      // Reset so a transient connector failure does not poison the whole run.
      cached = undefined;
      const detail = (err instanceof Error ? err.message : "unknown error").slice(
        0,
        MAX_ERROR_CHARS,
      );
      return {
        content: `Error: schema introspection failed (${detail}). The live schema is unavailable for this project.`,
        isError: true,
      };
    }

    if (!introspection || introspection.tables.length === 0) {
      // A capability limit, not evidence about any particular table — #773.
      return {
        content:
          "Error: this project has no introspectable database connector, so table definitions cannot be retrieved. Do not treat this as evidence that a table does not exist.",
        isError: true,
      };
    }

    const all = introspection.tables;
    const blocks: string[] = [];
    let found = 0;

    for (const requested of validated.tables) {
      const table = findTable(all, requested);
      if (table) {
        blocks.push(renderTableBlock(table));
        found += 1;
        continue;
      }
      // Evidence of ABSENCE (#773): the schema was read and this table is not in
      // it. That is a usable finding, so say it unambiguously.
      const suggestions = suggestNames(all, requested);
      const hint =
        suggestions.length > 0
          ? ` Similarly-named tables that DO exist: ${suggestions.join(", ")}.`
          : "";
      blocks.push(
        `TABLE ${requested} — NOT FOUND. No table with this name exists in the project's live schema (${all.length} table(s) introspected).${hint}`,
      );
    }

    return { content: blocks.join("\n\n"), resultCount: found };
  }

  return {
    name: "describe_table",
    description:
      "Get the real column definitions and foreign keys for one or more database tables from the " +
      "project's live schema. Use this before asserting that a column does or does not exist — " +
      "especially for a table listed by name only in the omitted-tables index of the schema " +
      "summary. Accepts qualified or bare names, case-insensitive.",
    parameters,
    execute,
  };
}
