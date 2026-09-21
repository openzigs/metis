/**
 * Epic #880 — Issue #881 — inspect_schema tool tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const inspectDbConnector = vi.fn();
vi.mock("../../connectors/db/db-service.js", () => ({
  inspectDbConnector: (...args: unknown[]) => inspectDbConnector(...args),
}));

import {
  INSPECT_SCHEMA_TOOL_NAME,
  inspectSchemaSchema,
  createInspectSchemaTool,
  registerInspectSchema,
} from "./inspect-schema.js";
import { ToolRegistry } from "../tool-registry.js";

const ctxA = { sessionId: "s1", userId: "u1", projectId: "proj-A" } as const;

function snapshot() {
  return {
    connectorId: "c1",
    driver: "postgres",
    tables: [
      {
        schema: "public",
        name: "users",
        columns: [
          { name: "id", dataType: "int", nullable: false, isPrimaryKey: true, isForeignKey: false },
          {
            name: "email",
            dataType: "text",
            nullable: true,
            isPrimaryKey: false,
            isForeignKey: false,
          },
        ],
        foreignKeys: [],
        indexes: [],
      },
    ],
    extractedAt: new Date().toISOString(),
    durationMs: 5,
  };
}

describe("inspect_schema tool", () => {
  beforeEach(() => {
    inspectDbConnector.mockReset();
  });

  it("schema requires a connectorId", () => {
    expect(inspectSchemaSchema.safeParse({}).success).toBe(false);
    expect(inspectSchemaSchema.safeParse({ connectorId: "c1" }).success).toBe(true);
  });

  it("returns a compact table/column projection scoped to the session project", async () => {
    inspectDbConnector.mockResolvedValue(snapshot());
    const tool = createInspectSchemaTool();
    const result = await tool.exec({ connectorId: "c1" }, ctxA);
    expect(inspectDbConnector).toHaveBeenCalledWith("proj-A", "c1", "u1", {});
    const data = result.data as { tables: Array<{ name: string; columns: unknown[] }> };
    expect(data.tables[0].name).toBe("users");
    expect(data.tables[0].columns).toHaveLength(2);
    expect(result.text).toContain("public.users");
    expect(result.text).toContain("id:int");
  });

  it("forwards an optional schema filter", async () => {
    inspectDbConnector.mockResolvedValue(snapshot());
    const tool = createInspectSchemaTool();
    await tool.exec({ connectorId: "c1", schema: "sales" }, ctxA);
    expect(inspectDbConnector).toHaveBeenCalledWith("proj-A", "c1", "u1", { schema: "sales" });
  });

  it("rejects when the session is not project-scoped", async () => {
    const tool = createInspectSchemaTool();
    await expect(
      tool.exec({ connectorId: "c1" }, { sessionId: "s1", userId: "u1" }),
    ).rejects.toThrow(/project-scoped/i);
    expect(inspectDbConnector).not.toHaveBeenCalled();
  });

  it("never reaches a connector outside the session project (delegated scope)", async () => {
    // db-service throws DB_CONNECTOR_NOT_FOUND when the connector isn't in the
    // project; the tool surfaces that rejection unchanged.
    inspectDbConnector.mockRejectedValue(new Error("database connector not found"));
    const tool = createInspectSchemaTool();
    await expect(tool.exec({ connectorId: "other-project-conn" }, ctxA)).rejects.toThrow(
      /not found/i,
    );
    expect(inspectDbConnector).toHaveBeenCalledWith("proj-A", "other-project-conn", "u1", {});
  });

  it("registers idempotently on the ToolRegistry as a medium-risk tool", () => {
    const reg = new ToolRegistry();
    registerInspectSchema(reg);
    registerInspectSchema(reg);
    expect(reg.has(INSPECT_SCHEMA_TOOL_NAME)).toBe(true);
    expect(reg.get(INSPECT_SCHEMA_TOOL_NAME)?.risk).toBe("medium");
  });
});
