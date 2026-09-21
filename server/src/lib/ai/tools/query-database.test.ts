/**
 * Epic #880 — Issue #887 — query_database tool tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const queryDbConnector = vi.fn();
vi.mock("../../connectors/db/db-service.js", () => ({
  queryDbConnector: (...args: unknown[]) => queryDbConnector(...args),
}));

import {
  QUERY_DATABASE_TOOL_NAME,
  queryDatabaseSchema,
  createQueryDatabaseTool,
  registerQueryDatabase,
} from "./query-database.js";
import { ToolRegistry } from "../tool-registry.js";

const ctxA = { sessionId: "s1", userId: "u1", projectId: "proj-A" } as const;

function queryResult(rows: Array<Record<string, unknown>>, truncated = false) {
  return {
    columns: rows.length ? Object.keys(rows[0]) : ["id"],
    rows,
    rowCount: rows.length,
    truncated,
    durationMs: 3,
  };
}

describe("query_database tool", () => {
  beforeEach(() => {
    queryDbConnector.mockReset();
  });

  it("schema requires connectorId and sql", () => {
    expect(queryDatabaseSchema.safeParse({ connectorId: "c1" }).success).toBe(false);
    expect(queryDatabaseSchema.safeParse({ connectorId: "c1", sql: "select 1" }).success).toBe(
      true,
    );
  });

  it("schema rejects maxRows above the hard cap", () => {
    expect(
      queryDatabaseSchema.safeParse({ connectorId: "c1", sql: "select 1", maxRows: 100_000 })
        .success,
    ).toBe(false);
  });

  it("runs the query scoped to the session project and returns rows", async () => {
    queryDbConnector.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }]));
    const tool = createQueryDatabaseTool();
    const result = await tool.exec({ connectorId: "c1", sql: "SELECT id FROM t" }, ctxA);
    expect(queryDbConnector).toHaveBeenCalledWith("proj-A", "c1", "u1", "SELECT id FROM t");
    const data = result.data as { rowCount: number; rows: unknown[] };
    expect(data.rowCount).toBe(2);
    expect(data.rows).toHaveLength(2);
  });

  it("applies a client-side maxRows cap and marks truncation", async () => {
    queryDbConnector.mockResolvedValue(queryResult([{ id: 1 }, { id: 2 }, { id: 3 }]));
    const tool = createQueryDatabaseTool();
    const result = await tool.exec(
      { connectorId: "c1", sql: "SELECT id FROM t", maxRows: 2 },
      ctxA,
    );
    const data = result.data as { rowCount: number; truncated: boolean };
    expect(data.rowCount).toBe(2);
    expect(data.truncated).toBe(true);
  });

  it("rejects when the session is not project-scoped", async () => {
    const tool = createQueryDatabaseTool();
    await expect(
      tool.exec({ connectorId: "c1", sql: "select 1" }, { sessionId: "s1", userId: "u1" }),
    ).rejects.toThrow(/project-scoped/i);
    expect(queryDbConnector).not.toHaveBeenCalled();
  });

  it("surfaces non-SELECT rejection from the validator unchanged", async () => {
    // queryDbConnector → validateSelectOnly throws NON_SELECT for writes.
    queryDbConnector.mockRejectedValue(new Error("only SELECT statements are allowed"));
    const tool = createQueryDatabaseTool();
    await expect(tool.exec({ connectorId: "c1", sql: "DELETE FROM users" }, ctxA)).rejects.toThrow(
      /only SELECT/i,
    );
  });

  it("registers idempotently on the ToolRegistry as a high-risk tool", () => {
    const reg = new ToolRegistry();
    registerQueryDatabase(reg);
    registerQueryDatabase(reg);
    expect(reg.has(QUERY_DATABASE_TOOL_NAME)).toBe(true);
    expect(reg.get(QUERY_DATABASE_TOOL_NAME)?.risk).toBe("high");
  });
});
