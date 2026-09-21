/**
 * Issue #1312 — describe_table tool.
 */
import { describe, expect, it, vi } from "vitest";
import type { DbTableInfo } from "@metis/shared";
import { createDescribeTableTool } from "./describe-table.js";
import type { ToolContext } from "./types.js";

const ctx: ToolContext = { projectId: "p1" };

function table(overrides: Partial<DbTableInfo> = {}): DbTableInfo {
  return {
    schema: "SALESDB",
    name: "TRANSACTION_JOBS",
    columns: [
      {
        name: "JOB_ID",
        dataType: "number",
        nullable: false,
        isPrimaryKey: true,
        isForeignKey: false,
      },
      {
        name: "HUB_NAME",
        dataType: "varchar2",
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
      },
    ],
    foreignKeys: [],
    indexes: [],
    ...overrides,
  };
}

const schema = [
  table(),
  table({ name: "TRANSACTION_JOBS_OLD" }),
  table({ schema: "ADMIN", name: "AUDIT_LOG" }),
];

function toolWith(tables: DbTableInfo[] | null) {
  return createDescribeTableTool({
    introspect: vi.fn(async () => (tables === null ? null : { tables })),
  });
}

describe("#1312 — describe_table resolves names to real columns", () => {
  it("describes a table by its qualified name", async () => {
    const res = await toolWith(schema).execute({ tables: ["SALESDB.TRANSACTION_JOBS"] }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.resultCount).toBe(1);
    expect(res.content).toContain("TABLE SALESDB.TRANSACTION_JOBS");
    expect(res.content).toContain("JOB_ID (number, pk)");
    expect(res.content).toContain("HUB_NAME");
  });

  it("describes a table by its bare name, case-insensitively", async () => {
    const res = await toolWith(schema).execute({ tables: ["transaction_jobs"] }, ctx);
    expect(res.resultCount).toBe(1);
    expect(res.content).toContain("TABLE SALESDB.TRANSACTION_JOBS");
  });

  it("accepts a single string instead of an array", async () => {
    const res = await toolWith(schema).execute({ tables: "TRANSACTION_JOBS" }, ctx);
    expect(res.resultCount).toBe(1);
  });

  it("accepts the singular `table` alias", async () => {
    const res = await toolWith(schema).execute({ table: "TRANSACTION_JOBS" }, ctx);
    expect(res.resultCount).toBe(1);
  });

  it("describes several tables in one call", async () => {
    const res = await toolWith(schema).execute(
      { tables: ["TRANSACTION_JOBS", "ADMIN.AUDIT_LOG"] },
      ctx,
    );
    expect(res.resultCount).toBe(2);
    expect(res.content).toContain("TABLE SALESDB.TRANSACTION_JOBS");
    expect(res.content).toContain("TABLE ADMIN.AUDIT_LOG");
  });

  it("caps how many tables one call may describe", async () => {
    const res = await toolWith(schema).execute(
      { tables: Array.from({ length: 30 }, () => "TRANSACTION_JOBS") },
      ctx,
    );
    expect(res.resultCount).toBe(8);
  });

  it("does not match a bare request against a different schema's qualified name", async () => {
    const res = await toolWith(schema).execute({ tables: ["OTHER.TRANSACTION_JOBS"] }, ctx);
    expect(res.resultCount).toBe(0);
    expect(res.content).toContain("NOT FOUND");
  });

  it("introspects once no matter how many tables are described", async () => {
    const introspect = vi.fn(async () => ({ tables: schema }));
    const tool = createDescribeTableTool({ introspect });
    await tool.execute({ tables: ["TRANSACTION_JOBS"] }, ctx);
    await tool.execute({ tables: ["ADMIN.AUDIT_LOG"] }, ctx);
    expect(introspect).toHaveBeenCalledTimes(1);
  });
});

describe("#1312 / #773 — absence and failure are structurally distinct", () => {
  it("reports a genuinely absent table as evidence of absence, not an error", async () => {
    const res = await toolWith(schema).execute({ tables: ["NO_SUCH_TABLE"] }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.resultCount).toBe(0);
    expect(res.content).toContain("NOT FOUND");
    expect(res.content).toContain("3 table(s) introspected");
  });

  it("offers near-miss names so a typo is repairable in one turn", async () => {
    const res = await toolWith(schema).execute({ tables: ["TRANSACTION_JOB_CURVE"] }, ctx);
    expect(res.content).toContain("Similarly-named tables that DO exist");
    expect(res.content).toContain("SALESDB.TRANSACTION_JOBS");
  });

  it("counts only the tables actually found in a mixed call", async () => {
    const res = await toolWith(schema).execute({ tables: ["TRANSACTION_JOBS", "NOPE"] }, ctx);
    expect(res.resultCount).toBe(1);
    expect(res.content).toContain("TABLE SALESDB.TRANSACTION_JOBS");
    expect(res.content).toContain("TABLE NOPE — NOT FOUND");
  });

  it("marks a project with no connector as a capability limit, not absence", async () => {
    const res = await toolWith(null).execute({ tables: ["TRANSACTION_JOBS"] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no introspectable database connector");
    expect(res.content).toContain("Do not treat this as evidence");
  });

  it("marks an empty schema as a capability limit too", async () => {
    const res = await toolWith([]).execute({ tables: ["TRANSACTION_JOBS"] }, ctx);
    expect(res.isError).toBe(true);
  });

  it("marks an introspection failure as an error and retries on the next call", async () => {
    const introspect = vi
      .fn<(projectId: string) => Promise<{ tables: DbTableInfo[] } | null>>()
      .mockRejectedValueOnce(new Error("ORA-12541"))
      .mockResolvedValueOnce({ tables: schema });
    const tool = createDescribeTableTool({ introspect });

    const failed = await tool.execute({ tables: ["TRANSACTION_JOBS"] }, ctx);
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("ORA-12541");

    // A transient connector failure must not poison the rest of the run.
    const recovered = await tool.execute({ tables: ["TRANSACTION_JOBS"] }, ctx);
    expect(recovered.resultCount).toBe(1);
  });
});

describe("#1312 / #774 — argument rejections are self-repairable", () => {
  it.each([
    ["missing entirely", {}],
    ["wrong type", { tables: 42 }],
    ["empty array", { tables: [] }],
    ["blank strings only", { tables: ["   "] }],
    ["not an object", null],
  ])("rejects %s with a repairable message", async (_label, args) => {
    const res = await toolWith(schema).execute(args, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("describe_table");
    expect(res.content).toContain("tables");
  });

  it("does not introspect when the arguments are invalid", async () => {
    const introspect = vi.fn(async () => ({ tables: schema }));
    await createDescribeTableTool({ introspect }).execute({}, ctx);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("bounds an absurdly long name before echoing it back", async () => {
    const res = await toolWith(schema).execute({ tables: ["A".repeat(50_000)] }, ctx);
    expect(res.content).toContain("NOT FOUND");
    expect(res.content.length).toBeLessThan(1_000);
  });

  it("bounds a reflected driver error", async () => {
    const tool = createDescribeTableTool({
      introspect: vi.fn(async () => {
        throw new Error("x".repeat(50_000));
      }),
    });
    const res = await tool.execute({ tables: ["TRANSACTION_JOBS"] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content.length).toBeLessThan(1_000);
  });
});
