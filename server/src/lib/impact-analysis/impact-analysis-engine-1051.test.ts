/**
 * #1051 — the proposed columns the #791 gate ruled out are STORED with the run,
 * each with the covering write path's file and line, and read back.
 *
 * Before this they lived on the in-memory result and in one server log line:
 * once a run was stored, a reviewer could not see that `users.mark_read_delay`
 * had been considered and why it was not proposed. The run here is the verbatim
 * run-7 #4478 issue over the shared Miniflux lineage fixture, through the real
 * service (`executeImpactAnalysis`) and the real read path.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { executeImpactAnalysis, type ImpactServiceDeps } from "./impact-analysis-engine.js";
import { getImpactAnalysisDetail } from "./impact-analysis-read.js";
import type { SchemaImpactDataSource } from "./schema-impact.js";
import {
  column,
  ENTRY,
  graph,
  schemaDataSource,
  UI_HANDLER_SEEDS,
} from "../../../tests/helpers/miniflux-4478-lineage.js";

const here = dirname(fileURLToPath(import.meta.url));
const ISSUE_4478 = readFileSync(join(here, "__fixtures__", "miniflux-4478.md"), "utf8");

type Row = Record<string, unknown>;

/** A store that keeps what the service writes and serves it back to the read path. */
function store(sourceText: string) {
  const analysis: Row = { id: "ia", sourceText, documentId: null, startedAt: new Date() };
  const items: Row[] = [];
  const symbols: Row[] = [];
  const tables: Row[] = [];
  const proposals: Row[] = [];
  let seq = 0;
  const createMany =
    (into: Row[]) =>
    async ({ data }: { data: Row[] }) => {
      into.push(...data.map((d) => ({ id: `row-${++seq}`, ...d })));
      return { count: data.length };
    };
  const columnProposalCreateMany = vi.fn(createMany(proposals));
  const prisma = {
    impactAnalysis: {
      findFirst: async () => ({
        ...analysis,
        status: analysis.status ?? "pending",
        summary: analysis.summary ?? null,
        errorMessage: null,
        completedAt: null,
        totalImpactedSymbols: 0,
        projects: [{ projectId: "p1" }],
        items: items.map((item) => ({
          ...item,
          requirement: null,
          feedback: [],
          affectedSymbols: symbols.filter((s) => s.impactItemId === item.id),
          affectedTables: tables
            .filter((t) => t.impactItemId === item.id)
            .map((t) => ({ ...t, consumers: [] })),
          columnProposals: proposals.filter((p) => p.impactItemId === item.id),
        })),
      }),
      update: async ({ data }: { data: Row }) => Object.assign(analysis, data),
    },
    impactItem: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `item-${items.length + 1}`, ...data };
        items.push(row);
        return row;
      },
    },
    impactAffectedSymbol: { createMany: createMany(symbols) },
    impactAffectedTable: { createMany: createMany(tables) },
    impactAffectedTableConsumer: { createMany: async () => ({ count: 0 }) },
    impactColumnProposal: { createMany: columnProposalCreateMany },
    knowledgeChunk: { findMany: async () => [] },
    quarantineChunk: { findMany: async () => [] },
    document: {},
    codeSymbol: {},
    codeEdge: {},
  };
  return { prisma, proposals, tables, columnProposalCreateMany };
}

async function runIssue(
  text: string,
  proposer: NonNullable<ImpactServiceDeps["additiveColumnProposer"]>,
  source: SchemaImpactDataSource = schemaDataSource(),
) {
  const s = store(text);
  await executeImpactAnalysis("ia", ["p1"], {
    prisma: s.prisma as never,
    seedChange: async () => UI_HANDLER_SEEDS,
    dataSourceFor: () => graph,
    schemaDataSourceFor: () => source,
    consumerResolver: async () => [],
    identityResolverFor: async () => null,
    additiveColumnProposer: proposer,
  });
  const detail = await getImpactAnalysisDetail("ia", s.prisma as never);
  return { ...s, item: detail!.items[0]! };
}

describe("executeImpactAnalysis — ruled-out column proposals are stored and read back (#1051)", () => {
  it("stores an optional settings column with the covering writer's file and line", async () => {
    const { proposals, item, tables } = await runIssue(ISSUE_4478, async () => [
      column("users", "mark_read_delay", "INTEGER"),
    ]);

    expect(proposals).toEqual([
      expect.objectContaining({
        impactItemId: "item-1",
        disposition: "optional",
        tableName: "users",
        columnName: "mark_read_delay",
        columnType: "INTEGER",
        suggestedDdl: "ALTER TABLE users ADD COLUMN mark_read_delay INTEGER; -- SUGGESTED",
        writerQualifiedName: `${ENTRY}::MarkAllAsReadBeforeDate`,
        writerFilePath: ENTRY,
        writerStartLine: 523,
        writerEndLine: 533,
      }),
    ]);
    expect(String(proposals[0]!.reason)).toMatch(/^Optional: settings persistence\./);
    // It is NOT among the affected tables: not part of the migration.
    expect(tables.filter((t) => t.changeKind === "add-column")).toEqual([]);

    expect(item.optionalColumnProposals).toEqual([
      {
        id: expect.any(String),
        tableName: "users",
        columnName: "mark_read_delay",
        columnType: "INTEGER",
        suggestedDdl: "ALTER TABLE users ADD COLUMN mark_read_delay INTEGER; -- SUGGESTED",
        reason: proposals[0]!.reason,
        writer: {
          qualifiedName: `${ENTRY}::MarkAllAsReadBeforeDate`,
          filePath: ENTRY,
          startLine: 523,
          endLine: 533,
        },
      },
    ]);
    expect(item.droppedColumnProposals).toEqual([]);
    expect(item.affectedTables.filter((t) => t.changeKind === "add-column")).toEqual([]);
  });

  it("stores a rejected column as Not proposed, with the writer and the reason", async () => {
    // The verbatim issue without the sentence that asks to configure the value.
    const text = ISSUE_4478.replace(" Times could be configured in settings.", "");
    const { proposals, item } = await runIssue(text, async () => [
      column("users", "mark_read_delay", "INTEGER"),
    ]);

    expect(proposals.map((p) => p.disposition)).toEqual(["rejected"]);
    expect(item.optionalColumnProposals).toEqual([]);
    expect(item.droppedColumnProposals).toHaveLength(1);
    expect(item.droppedColumnProposals[0]).toMatchObject({
      tableName: "users",
      columnName: "mark_read_delay",
      writer: {
        qualifiedName: `${ENTRY}::MarkAllAsReadBeforeDate`,
        filePath: ENTRY,
        startLine: 523,
      },
    });
    expect(item.droppedColumnProposals[0]!.reason).toMatch(
      /^An existing write path may cover this:/,
    );
  });

  it("stores both kinds from one run, each under its own disposition", async () => {
    const text = ISSUE_4478.replace(" Times could be configured in settings.", "");
    const { item } = await runIssue(text, async () => ({
      proposals: [
        {
          row: column("users", "mark_read_delay", "INTEGER"),
          justification: "operation-needs-new-data" as const,
          coveredByWriterId: null,
          rationale: "",
        },
        {
          row: column("users", "mark_read_default", "TEXT"),
          justification: "user-preference" as const,
          coveredByWriterId: null,
          rationale: "",
        },
      ],
      coveringWriterIds: [],
    }));
    expect(item.droppedColumnProposals.map((p) => p.columnName)).toEqual(["mark_read_delay"]);
    expect(item.optionalColumnProposals.map((p) => p.columnName)).toEqual(["mark_read_default"]);
  });

  const ACCENT_ISSUE =
    // Not time-bounded, so the gate does not rule.
    "# [Feature]: Accent colour\n\n### Feature Summary\n\nLet a user pick an accent colour.\n\n### Proposed Solution\n\nA colour picker on the mark all as read page.";
  const accent = (justification: "user-preference" | "operation-needs-new-data") => async () => ({
    proposals: [
      {
        row: column("users", "accent_colour", "TEXT"),
        justification,
        coveredByWriterId: null,
        rationale: "",
      },
    ],
    coveringWriterIds: [],
  });

  it("stores an unchecked column with a null writer: it rests on no write path", async () => {
    // The column is core, and marked.
    const { proposals, item } = await runIssue(ACCENT_ISSUE, accent("operation-needs-new-data"));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      disposition: "unchecked",
      writerQualifiedName: null,
      writerFilePath: null,
      writerStartLine: null,
      writerEndLine: null,
    });
    expect(proposals[0]!.reason).toMatch(/^Not checked: the request is not bounded/);
    expect(item.optionalColumnProposals).toEqual([]);
    expect(item.uncheckedColumnProposals[0]!.writer).toBeNull();
  });

  it("stores a column the proposer labelled a preference as OPTIONAL there, with a null writer and why it was not checked (PR #1090 review 3)", async () => {
    const { proposals, item } = await runIssue(ACCENT_ISSUE, accent("user-preference"));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      disposition: "optional",
      columnName: "accent_colour",
      writerQualifiedName: null,
      writerFilePath: null,
      writerStartLine: null,
      writerEndLine: null,
    });
    expect(proposals[0]!.reason).toMatch(
      /^Optional: settings persistence\. The proposer classed this column as a user preference.* Not checked: the request is not bounded/,
    );
    expect(item.uncheckedColumnProposals).toEqual([]);
    expect(item.optionalColumnProposals.map((p) => p.columnName)).toEqual(["accent_colour"]);
    expect(item.optionalColumnProposals[0]!.writer).toBeNull();
    // Not in the migration: no add-column row for it.
    expect(item.affectedTables.filter((t) => t.changeKind === "add-column")).toEqual([]);
  });

  it("writes nothing when the gate rules nothing out", async () => {
    const { columnProposalCreateMany, item } = await runIssue(ISSUE_4478, async () => []);
    expect(columnProposalCreateMany).not.toHaveBeenCalled();
    expect(item.droppedColumnProposals).toEqual([]);
    expect(item.optionalColumnProposals).toEqual([]);
    expect(item.uncheckedColumnProposals).toEqual([]);
  });

  it("#791 — stores a column the gate could not check as `unchecked`, beside the affected table it stays in", async () => {
    // Describing the write paths fails: the gate has nothing to check against.
    const broken = schemaDataSource({
      getCodeSymbolTexts: async () => {
        throw new Error("db down");
      },
    });
    const { proposals, item, tables } = await runIssue(
      ISSUE_4478,
      async () => [column("users", "mark_read_delay", "INTEGER")],
      broken,
    );

    // Unchanged: the column is proposed.
    expect(
      tables
        .filter((t) => t.changeKind === "add-column")
        .map((t) => `${t.tableName}.${t.columnName}`),
    ).toEqual(["users.mark_read_delay"]);
    expect(
      item.affectedTables.filter((t) => t.changeKind === "add-column").map((t) => t.columnName),
    ).toEqual(["mark_read_delay"]);
    // New: and the run records that nothing checked it.
    expect(proposals).toEqual([
      expect.objectContaining({
        impactItemId: "item-1",
        disposition: "unchecked",
        tableName: "users",
        columnName: "mark_read_delay",
        writerQualifiedName: null,
        writerFilePath: null,
      }),
    ]);
    expect(item.uncheckedColumnProposals).toEqual([
      {
        id: expect.any(String),
        tableName: "users",
        columnName: "mark_read_delay",
        columnType: "INTEGER",
        suggestedDdl: "ALTER TABLE users ADD COLUMN mark_read_delay INTEGER; -- SUGGESTED",
        reason:
          "Not checked: looking up the existing write paths failed, so there was nothing to compare this column with. Review it as an unverified proposal.",
        writer: null,
      },
    ]);
    // It is under neither ruled-out heading.
    expect(item.droppedColumnProposals).toEqual([]);
    expect(item.optionalColumnProposals).toEqual([]);
  });
});
