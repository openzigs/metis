/**
 * #791 review — a proposed column the existing-writer check drops must be
 * visible on the impact RESULT, not only in a server log; a borderline one it
 * keeps must carry the lower confidence and the reason. The data-path writer
 * expansion is stubbed to name `MarkAllAsReadBeforeDate`, so this exercises
 * only the engine's handling of the check's output.
 */
import { describe, expect, it, vi } from "vitest";
import type { CodeGraphDataSource, GraphSymbol } from "../code-graph/query-service.js";
import type { AffectedTableInput } from "./schema-impact.js";

const WRITER = "internal/storage/entry.go::MarkAllAsReadBeforeDate";

vi.mock("./data-path-writers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./data-path-writers.js")>();
  return {
    ...actual,
    addDataPathWriters: async <T extends { relation: string }>(symbols: T[]) => [
      ...symbols,
      {
        codeSymbolId: "W",
        filePath: "internal/storage/entry.go",
        qualifiedName: WRITER,
        startLine: 1,
        endLine: 10,
        relation: "data-writer",
        depth: 1,
        confidence: 0.6,
      },
    ],
  };
});

const { computeProjectImpact } = await import("./impact-analysis-engine.js");

const A: GraphSymbol = {
  id: "A",
  qualifiedName: "pkg.A",
  kind: "function",
  filePath: "A.ts",
  language: "ts",
  startLine: 1,
  endLine: 10,
};

const graph: CodeGraphDataSource = {
  getSymbol: async (id) => (id === "A" ? A : null),
  getEdgesFrom: async () => [],
  getEdgesTo: async () => [],
  getSymbolsByFile: async () => [],
  getSymbolsByIds: async (ids) => (ids.includes("A") ? [A] : []),
};

const schemaSymbols = [
  {
    id: "tbl-1",
    kind: "table" as const,
    name: "users",
    qualifiedName: "users",
    source: "sqlglot" as const,
  },
];

const proposal: AffectedTableInput = {
  objectKind: "column",
  tableName: "users",
  columnName: "mark_read_days",
  columnType: "INTEGER",
  changeKind: "add-column",
  suggestedDdl: "ALTER TABLE users ADD COLUMN mark_read_days INTEGER; -- SUGGESTED",
  source: "sqlglot",
  reconciliation: null,
  confidence: 0.5,
};

function run(body: string) {
  return computeProjectImpact(
    { requirementId: null, title: "Mark all as read", body, changeType: "added", bodyDelta: 50 },
    "proj-1",
    {
      mapRequirement: async () => [
        {
          codeSymbolId: "A",
          filePath: "A.ts",
          qualifiedName: "pkg.A",
          startLine: 1,
          endLine: 10,
          confidence: 0.9,
        },
      ],
      dataSourceFor: () => graph,
      schemaDataSourceFor: () => ({
        getSchemaEdgesFrom: async (ids: string[]) =>
          ids.includes("A")
            ? [{ fromSymbolId: "A", toSymbolId: "tbl-1", kind: "reads" as const }]
            : [],
        getSchemaSymbolsByIds: async (ids: string[]) =>
          schemaSymbols.filter((s) => ids.includes(s.id)),
      }),
      additiveColumnProposer: async () => [proposal],
    },
  );
}

describe("computeProjectImpact — #791 dropped column proposals", () => {
  it("puts a dropped proposal on the result with its writer and reason", async () => {
    const result = await run("Let entries older than X days be marked as read.");
    expect(result.affectedTables.filter((t) => t.changeKind === "add-column")).toEqual([]);
    expect(result.droppedColumnProposals).toHaveLength(1);
    const [d] = result.droppedColumnProposals;
    expect(`${d!.row.tableName}.${d!.row.columnName}`).toBe("users.mark_read_days");
    expect(d!.writer).toBe(WRITER);
    expect(d!.reason).toContain("MarkAllAsReadBeforeDate");
  });

  it("keeps the proposal, annotated, when the requirement asks to remember the days", async () => {
    const result = await run(
      "Mark all as read older than X days, and remember the chosen days per user.",
    );
    expect(result.droppedColumnProposals).toEqual([]);
    const added = result.affectedTables.filter((t) => t.changeKind === "add-column");
    expect(added.map((t) => t.columnName)).toEqual(["mark_read_days"]);
    expect(added[0]!.confidence).toBeLessThan(proposal.confidence);
    expect(added[0]!.relevanceRationale).toMatch(/existing write path may cover this/i);
  });
});
