/**
 * #1030 — chat's read-only, project-scoped requirement tools.
 *
 * Driven against a hand-rolled Prisma stub (no real DB): the stub applies the
 * `where` the tool sends, so a query that drops the project scope is caught by
 * a cross-project row leaking into the result.
 */
import { describe, expect, it, vi } from "vitest";
import type { RequirementTraceabilityChain } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { ToolRegistry } from "../ai/tool-registry.js";
import type { ToolContext } from "../ai/types.js";
import {
  GET_REQUIREMENT_TOOL_NAME,
  LIST_REQUIREMENTS_TOOL_NAME,
  createGetRequirementTool,
  createListRequirementsTool,
  registerRequirementTools,
  type RequirementToolsDeps,
} from "./requirements-chat-tools.js";

interface Row {
  id: string;
  projectId: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string;
  reviewStatus: string | null;
  acceptanceCriteria: string;
  verdict: string | null;
  coverage: string | null;
  externalUrl: string | null;
  implementedByPr: number | null;
  deletedAt: Date | null;
  updatedAt: Date;
  _count: { codeMappings: number };
  dataMappings: Array<{
    deletedAt?: Date | null;
    schemaName: string | null;
    tableName: string;
    columnName: string | null;
    dbConnector: { label: string };
  }>;
}

function row(over: Partial<Row> & { id: string }): Row {
  return {
    projectId: "p1",
    title: `Requirement ${over.id}`,
    body: "body",
    type: "feature",
    priority: "medium",
    labels: "[]",
    reviewStatus: null,
    acceptanceCriteria: "[]",
    verdict: null,
    coverage: null,
    externalUrl: null,
    implementedByPr: null,
    deletedAt: null,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    _count: { codeMappings: 0 },
    dataMappings: [],
    ...over,
  };
}

type Where = { id?: string; projectId?: string; deletedAt?: null };

function matches(r: Row, where: Where): boolean {
  if (where.id !== undefined && r.id !== where.id) return false;
  if (where.projectId !== undefined && r.projectId !== where.projectId) return false;
  if (where.deletedAt === null && r.deletedAt !== null) return false;
  return true;
}

type DmWhere = { deletedAt?: null };

function liveMappings(r: Row, where: DmWhere | undefined) {
  return r.dataMappings.filter((m) => !(where?.deletedAt === null && m.deletedAt));
}

interface Select {
  body?: boolean;
  _count?: { select: { dataMappings: { where?: DmWhere } } };
  dataMappings?: { where?: DmWhere };
}

/** Applies the top-level where, `take`, and the nested dataMappings where and `body` select. */
function stubPrisma(rows: Row[]) {
  const findMany = vi.fn(async (args: { where: Where; select: Select; take?: number }) =>
    rows
      .filter((r) => matches(r, args.where))
      .slice(0, args.take)
      .map((r) => {
        const out: Record<string, unknown> = {
          ...r,
          _count: {
            ...r._count,
            dataMappings: liveMappings(r, args.select._count?.select.dataMappings.where).length,
          },
        };
        if (!args.select.body) delete out.body;
        return out;
      }),
  );
  const findFirst = vi.fn(async (args: { where: Where; select: Select }) => {
    const r = rows.find((x) => matches(x, args.where));
    return r ? { ...r, dataMappings: liveMappings(r, args.select.dataMappings?.where) } : null;
  });
  return {
    prisma: { requirement: { findMany, findFirst } } as unknown as RequirementToolsDeps["prisma"],
    findMany,
    findFirst,
  };
}

function emptyChain(id: string): RequirementTraceabilityChain {
  return {
    requirementId: id,
    requirementTitle: "t",
    projectId: "p1",
    specs: [],
    directCode: [],
    testedBy: [],
  };
}

const ctx: ToolContext = { sessionId: "s", userId: "u", projectId: "p1" };

const ROWS: Row[] = [
  row({
    id: "r-db",
    title: "Store orders in the database",
    body: "Orders persist to the orders table.",
    reviewStatus: "approved",
    labels: JSON.stringify(["persistence", "finding:abc"]),
    _count: { codeMappings: 2 },
    dataMappings: [
      { tableName: "orders", schemaName: null, columnName: null, dbConnector: { label: "main" } },
      // Soft-deleted: must be neither counted nor listed.
      {
        tableName: "gone",
        schemaName: null,
        columnName: null,
        dbConnector: { label: "main" },
        deletedAt: new Date(),
      },
    ],
  }),
  row({
    id: "r-ui",
    title: "Show a login form",
    body: "The user signs in.",
    reviewStatus: "approved",
    labels: JSON.stringify(["auth"]),
  }),
  row({
    id: "r-legacy",
    title: "Export a database backup nightly",
    body: "Backups.",
    reviewStatus: null,
    labels: JSON.stringify(["review:approved", "ops"]),
  }),
  row({ id: "r-draft", title: "Database tuning", body: "Indexes.", reviewStatus: "draft" }),
  row({
    id: "r-deleted",
    title: "Deleted database thing",
    reviewStatus: "approved",
    deletedAt: new Date(),
  }),
  row({
    id: "r-other",
    projectId: "p2",
    title: "Other project database",
    reviewStatus: "approved",
  }),
];

describe("list_requirements (#1030)", () => {
  it("lists the session project's live requirements only", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({}, ctx);
    expect(res.isError).toBeFalsy();
    const ids = (res.data as { requirements: Array<{ id: string }> }).requirements.map((r) => r.id);
    expect(ids.sort()).toEqual(["r-db", "r-draft", "r-legacy", "r-ui"]);
    expect(res.resultCount).toBe(4);
    expect(res.text).not.toContain("Other project");
    expect(res.text).not.toContain("Deleted database");
  });

  it("filters by review status, reading the legacy review:* label when the column is null", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({ status: "approved" }, ctx);
    const ids = (res.data as { requirements: Array<{ id: string }> }).requirements.map((r) => r.id);
    expect(ids.sort()).toEqual(["r-db", "r-legacy", "r-ui"]);
  });

  it("filters by visible label, case-insensitively, and never exposes hidden labels", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({ label: "Persistence" }, ctx);
    const ids = (res.data as { requirements: Array<{ id: string }> }).requirements.map((r) => r.id);
    expect(ids).toEqual(["r-db"]);
    expect(res.text).not.toContain("finding:");
    // A hidden label is not a label the caller can filter on.
    const hidden = await tool.exec({ label: "finding:abc" }, ctx);
    expect(hidden.resultCount).toBe(0);
  });

  it("searches title and body case-insensitively, combining with the status filter", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({ status: "approved", query: "DATABASE" }, ctx);
    const ids = (res.data as { requirements: Array<{ id: string }> }).requirements.map((r) => r.id);
    expect(ids.sort()).toEqual(["r-db", "r-legacy"]);
    expect(res.text).toContain("r-db");
    expect(res.text).toContain("Store orders in the database");
    expect(res.text).toContain("approved");
    expect(res.text).toContain("code links: 2");
    expect(res.text).toContain("data mappings: 1");
  });

  it("caps the listing at the limit and says how many matched", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({ limit: 1 }, ctx);
    expect((res.data as { requirements: unknown[] }).requirements).toHaveLength(1);
    expect((res.data as { total: number }).total).toBe(4);
    expect(res.text).toContain("Showing 1 of 4");
  });

  it("an empty match states the project's status totals instead of implying none exist", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({ status: "rejected" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.resultCount).toBe(0);
    expect(res.text).toContain("No requirement matched");
    expect(res.text).toContain("4 requirements");
    expect(res.text).toContain("approved: 3");
  });

  it("does not count a soft-deleted data mapping", async () => {
    const { prisma } = stubPrisma(ROWS);
    const res = await createListRequirementsTool({ prisma }).exec({ query: "orders" }, ctx);
    expect(res.text).toContain("data mappings: 1");
  });

  it("reads the body only when there is a query to match it against", async () => {
    const { prisma, findMany } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    await tool.exec({}, ctx);
    expect(findMany.mock.calls[0]![0].select.body).toBe(false);
    await tool.exec({ query: "orders" }, ctx);
    expect(findMany.mock.calls[1]![0].select.body).toBe(true);
  });

  it("says when the scan hit its ceiling so totals are not read as complete", async () => {
    const many = Array.from({ length: 5001 }, (_, i) => row({ id: `r${i}` }));
    const { prisma } = stubPrisma(many);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({ status: "rejected" }, ctx);
    expect(res.text).toContain("5000 requirements in total");
    expect(res.text).toContain("partial");
    const full = await tool.exec({ limit: 1 }, ctx);
    expect(full.text).toContain("partial");
    const { prisma: small } = stubPrisma(ROWS);
    const ok = await createListRequirementsTool({ prisma: small }).exec({ limit: 1 }, ctx);
    expect(ok.text).not.toContain("partial");
  });

  it("refuses an unscoped session without touching the database", async () => {
    const { prisma, findMany } = stubPrisma(ROWS);
    const tool = createListRequirementsTool({ prisma });
    const res = await tool.exec({}, { sessionId: "s", userId: "u" });
    expect(res.isError).toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown status in its schema", () => {
    const tool = createListRequirementsTool();
    expect(tool.schema.safeParse({ status: "approved" }).success).toBe(true);
    expect(tool.schema.safeParse({ status: "bogus" }).success).toBe(false);
    expect(tool.risk).toBe("low");
  });
});

describe("get_requirement (#1030)", () => {
  it("reads one requirement with acceptance criteria, code links, data mappings and trace", async () => {
    const { prisma } = stubPrisma([
      row({
        id: "r-db",
        title: "Store orders in the database",
        body: "Orders persist to the orders table.",
        reviewStatus: "approved",
        labels: JSON.stringify(["persistence", "finding:abc"]),
        acceptanceCriteria: JSON.stringify(["An order survives a restart"]),
        verdict: "implemented",
        coverage: "grounded_in_code",
        implementedByPr: 42,
        dataMappings: [
          {
            schemaName: "public",
            tableName: "orders",
            columnName: null,
            dbConnector: { label: "main" },
          },
        ],
      }),
    ]);
    const chain = vi.fn(async (projectId: string, id: string) => ({
      ...emptyChain(id),
      projectId,
      directCode: [
        {
          codeSymbolId: null,
          filePath: "src/orders/repo.ts",
          startLine: 10,
          endLine: 40,
          confidence: 0.9,
          source: "manual" as const,
          isTest: false,
        },
      ],
      specs: [
        {
          specDocumentId: "d1",
          specTitle: "Orders spec",
          confidence: 0.8,
          source: "derived" as const,
          code: [],
        },
      ],
      testedBy: [
        {
          codeSymbolId: null,
          filePath: "src/orders/repo.test.ts",
          symbol: "src/orders/repo.test.ts::persists",
          name: "persists",
        } as unknown as RequirementTraceabilityChain["testedBy"][number],
      ],
    }));
    const tool = createGetRequirementTool({ prisma, chain });
    const res = await tool.exec({ requirementId: "r-db" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.resultCount).toBe(1);
    expect(chain).toHaveBeenCalledWith("p1", "r-db");
    expect(res.text).toContain("Store orders in the database");
    expect(res.text).toContain("Status: approved");
    expect(res.text).toContain("An order survives a restart");
    expect(res.text).toContain("src/orders/repo.ts:10-40");
    expect(res.text).toContain("main: public.orders");
    expect(res.text).toContain("Orders spec");
    expect(res.text).toContain("src/orders/repo.test.ts");
    expect(res.text).toContain("PR #42");
    expect(res.text).not.toContain("finding:");
  });

  it("says plainly when acceptance criteria and links are absent", async () => {
    const { prisma } = stubPrisma([row({ id: "r1" })]);
    const tool = createGetRequirementTool({ prisma, chain: async (_p, id) => emptyChain(id) });
    const res = await tool.exec({ requirementId: "r1" }, ctx);
    expect(res.text).toContain("Acceptance criteria: none derived");
    expect(res.text).toContain("Code links: none");
    expect(res.text).toContain("Status: draft");
  });

  it("does not read another project's requirement by id", async () => {
    const { prisma, findFirst } = stubPrisma(ROWS);
    const chain = vi.fn(async (_p: string, id: string) => emptyChain(id));
    const tool = createGetRequirementTool({ prisma, chain });
    const res = await tool.exec({ requirementId: "r-other" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("No requirement");
    expect(findFirst.mock.calls[0]![0].where).toMatchObject({ projectId: "p1", deletedAt: null });
    expect(chain).not.toHaveBeenCalled();
  });

  it("does not list a soft-deleted data mapping", async () => {
    const { prisma } = stubPrisma(ROWS);
    const tool = createGetRequirementTool({ prisma, chain: async (_p, id) => emptyChain(id) });
    const res = await tool.exec({ requirementId: "r-db" }, ctx);
    expect(res.text).toContain("main: orders");
    expect(res.text).not.toContain("gone");
  });

  it("answers 'not found' when the requirement is deleted between the read and the trace", async () => {
    const { prisma } = stubPrisma(ROWS);
    const chain = async () => {
      throw new AppError(404, "REQUIREMENT_NOT_FOUND", "gone");
    };
    const res = await createGetRequirementTool({ prisma, chain }).exec(
      { requirementId: "r-db" },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.text).toContain("No requirement with id r-db");
  });

  it("rethrows any other trace failure", async () => {
    const { prisma } = stubPrisma(ROWS);
    const chain = async () => {
      throw new Error("db down");
    };
    await expect(
      createGetRequirementTool({ prisma, chain }).exec({ requirementId: "r-db" }, ctx),
    ).rejects.toThrow("db down");
  });

  it("refuses an unscoped session", async () => {
    const { prisma, findFirst } = stubPrisma(ROWS);
    const tool = createGetRequirementTool({ prisma });
    const res = await tool.exec({ requirementId: "r-db" }, { sessionId: "s", userId: "u" });
    expect(res.isError).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("registerRequirementTools (#1030)", () => {
  it("registers both tools idempotently at low risk", () => {
    const reg = new ToolRegistry();
    registerRequirementTools(reg);
    registerRequirementTools(reg);
    const names = reg.describeAll().map((v) => v.name);
    expect(names.filter((n) => n === LIST_REQUIREMENTS_TOOL_NAME)).toHaveLength(1);
    expect(names.filter((n) => n === GET_REQUIREMENT_TOOL_NAME)).toHaveLength(1);
    expect(reg.describeAll().every((v) => v.risk === "low")).toBe(true);
  });
});
