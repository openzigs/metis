/**
 * #791 — the engine never turns "mark all as read older than X" into a core
 * `users` column, whatever the proposer answers.
 *
 * Nothing here is mocked below the engine: the lineage writers come from the real
 * `expandDataPathWriters` over a schema graph shaped like Miniflux v2.3.3 after
 * #807, they are profiled by the real `profileDataPathWriters`, and the proposals
 * pass the real gate. Only the two model-shaped collaborators are stubbed — the
 * seeding (one UI handler) and the proposer, which answers with the columns it
 * actually returned in walkthrough runs 3 to 7.
 *
 * The requirement is the VERBATIM run-7 #4478 issue. #1045's fixture condensed
 * it, passed, and regressed 3 runs in 3 in production.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SchemaEdgeKind } from "@metis/shared";
import { extractChangesByShape } from "./change-request.js";
import type { ProposedColumn, ProposerOutput } from "./column-proposal-gate.js";
import {
  computeProjectImpact,
  InMemoryCodeGraphDataSource,
  type ComputeImpactDeps,
} from "./impact-analysis-engine.js";
import type { AffectedTableInput, SchemaImpactDataSource } from "./schema-impact.js";

const here = dirname(fileURLToPath(import.meta.url));
const ISSUE_4478 = readFileSync(join(here, "__fixtures__", "miniflux-4478.md"), "utf8");
const ISSUE_4336 = readFileSync(join(here, "__fixtures__", "miniflux-4336.md"), "utf8");

const ENTRY = "internal/storage/entry.go";
const UI = "internal/ui/unread_mark_all_read.go";

interface Sym {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}
const fn = (name: string, filePath: string, startLine: number): Sym => ({
  id: name,
  kind: "function",
  name,
  qualifiedName: `${filePath}::${name}`,
  filePath,
  startLine,
  endLine: startLine + 10,
  language: "go",
});
const schema = (qualifiedName: string): Sym => {
  const [table, column] = qualifiedName.split(".");
  return {
    id: qualifiedName,
    kind: column ? "column" : "table",
    name: column ?? table!,
    qualifiedName,
    filePath: "internal/database/migrations.go",
    startLine: 1,
    endLine: 1,
    language: "sql",
  };
};

const SYMBOLS: Sym[] = [
  fn("markAllAsRead", UI, 13),
  fn("MarkAllAsRead", ENTRY, 506),
  fn("MarkAllAsReadBeforeDate", ENTRY, 523),
  fn("UserByID", "internal/storage/user.go", 200),
  ...[
    "entries",
    "entries.status",
    "entries.changed_at",
    "entries.published_at",
    "entries.user_id",
  ].map(schema),
  ...["users", "users.id"].map(schema),
];
const EDGES: { fromSymbolId: string; toSymbolId: string; kind: SchemaEdgeKind }[] = [
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries", kind: "writes" },
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries.status", kind: "writes" },
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries.changed_at", kind: "writes" },
  { fromSymbolId: "MarkAllAsRead", toSymbolId: "entries.user_id", kind: "reads" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries", kind: "writes" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.status", kind: "writes" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.changed_at", kind: "writes" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.published_at", kind: "reads" },
  { fromSymbolId: "MarkAllAsReadBeforeDate", toSymbolId: "entries.user_id", kind: "reads" },
  { fromSymbolId: "UserByID", toSymbolId: "users", kind: "reads" },
  { fromSymbolId: "UserByID", toSymbolId: "users.id", kind: "reads" },
];
/** The UI handler calls the storage layer through `h.store.X()`. */
const CALLS = [
  { fromSymbolId: "markAllAsRead", toSymbolId: "MarkAllAsRead" },
  { fromSymbolId: "markAllAsRead", toSymbolId: "UserByID" },
];
/** `CodeSymbolEmbedding.text` of the run-7 graph, verbatim. */
const TEXTS: Record<string, string> = {
  MarkAllAsReadBeforeDate: [
    "function MarkAllAsReadBeforeDate in internal/storage/entry.go",
    "func (s *Storage) MarkAllAsReadBeforeDate(userID int64, before time.Time) error {",
    "\tquery := `",
    "\t\tUPDATE",
    "\t\t\tentries",
    "\t\tSET",
    "\t\t\tstatus=$1,",
    "\t\t\tchanged_at=now()",
    "\t\tWHERE",
    "\t\t\tuser_id=$2 AND status=$3 AND published_at < $4",
    "\t`",
  ].join("\n"),
};

function schemaDataSource(over: Partial<SchemaImpactDataSource> = {}): SchemaImpactDataSource {
  const schemaRow = (s: Sym) => ({
    id: s.id,
    kind: s.kind as "table" | "column",
    name: s.name,
    qualifiedName: s.qualifiedName,
    source: "sqlglot" as const,
  });
  return {
    getSchemaEdgesFrom: async (ids) => EDGES.filter((e) => ids.includes(e.fromSymbolId)),
    getSchemaSymbolsByIds: async (ids) =>
      SYMBOLS.filter((s) => ids.includes(s.id) && s.language === "sql").map(schemaRow),
    getDownstreamCallEdgesFrom: async (ids) => CALLS.filter((c) => ids.includes(c.fromSymbolId)),
    getColumnsOfTables: async (tables) =>
      SYMBOLS.filter(
        (s) => s.kind === "column" && tables.includes(s.qualifiedName.split(".")[0]!),
      ).map(schemaRow),
    getWriterEdgesTo: async (ids) =>
      EDGES.filter((e) => ids.includes(e.toSymbolId) && e.kind === "writes"),
    getCodeSymbolDetails: async (ids) => SYMBOLS.filter((s) => ids.includes(s.id)),
    getCodeSymbolTexts: async (ids) =>
      ids.flatMap((id) => (TEXTS[id] ? [{ id, text: TEXTS[id]! }] : [])),
    ...over,
  };
}

const graph = new InMemoryCodeGraphDataSource(
  SYMBOLS.filter((s) => s.language === "go").map(({ name: _name, ...rest }) => rest),
  [],
);

function column(tableName: string, columnName: string, columnType: string): AffectedTableInput {
  return {
    objectKind: "column",
    tableName,
    columnName,
    columnType,
    changeKind: "add-column",
    suggestedDdl: `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}; -- SUGGESTED`,
    source: "sqlglot",
    reconciliation: null,
    confidence: 0.5,
  };
}

type Proposer = NonNullable<ComputeImpactDeps["additiveColumnProposer"]>;

function run(
  issue: string,
  proposer: Proposer,
  over: Partial<ComputeImpactDeps> = {},
  source: SchemaImpactDataSource = schemaDataSource(),
) {
  const changes = extractChangesByShape(issue);
  expect(changes).toHaveLength(1);
  return computeProjectImpact(changes[0]!, "proj-1", {
    mapRequirement: async () => [],
    seedChange: async () => ({
      editCandidates: [
        {
          codeSymbolId: "markAllAsRead",
          filePath: UI,
          qualifiedName: `${UI}::markAllAsRead`,
          startLine: 13,
          endLine: 20,
          confidence: 1,
        },
      ],
      related: [],
      schemaSeeds: [],
    }),
    dataSourceFor: () => graph,
    schemaDataSourceFor: () => source,
    additiveColumnProposer: proposer,
    ...over,
  });
}

const addColumns = (tables: AffectedTableInput[]) =>
  tables.filter((t) => t.changeKind === "add-column").map((t) => `${t.tableName}.${t.columnName}`);

describe("computeProjectImpact — the verbatim #4478 issue, three runs (#791)", () => {
  // What the proposer returned on `users` in run 7 (UI run, re-run, fresh POST),
  // plus the name it used in runs 3, 4 and 6.
  const RUNS: AffectedTableInput[][] = [
    [column("users", "mark_read_time_options", "TEXT")],
    [column("users", "mark_read_delay", "INTEGER")],
    [
      column("users", "mark_read_times", "TEXT"),
      column("users", "mark_read_older_than_days", "INTEGER"),
    ],
  ];

  it("proposes no core users column in any of the three runs", async () => {
    for (const proposals of RUNS) {
      const result = await run(ISSUE_4478, async () => proposals);
      expect(addColumns(result.affectedTables)).toEqual([]);
      expect(addColumns(result.affectedTablesSecondary)).toEqual([]);
    }
  });

  it("puts each one under Optional: settings persistence, with the covering writer's file and line", async () => {
    for (const proposals of RUNS) {
      const result = await run(ISSUE_4478, async () => proposals);
      expect(result.droppedColumnProposals).toEqual([]);
      expect(result.optionalColumnProposals.map((o) => o.row)).toEqual(proposals);
      for (const optional of result.optionalColumnProposals) {
        expect(optional.writer).toEqual({
          qualifiedName: `${ENTRY}::MarkAllAsReadBeforeDate`,
          filePath: ENTRY,
          startLine: 523,
          endLine: 533,
        });
        expect(optional.reason).toContain("Optional: settings persistence.");
        expect(optional.reason).toContain("(before time.Time)");
      }
    }
  });

  it("holds when the proposer answers in the structured form and insists it is needed data", async () => {
    const insist = (row: AffectedTableInput): ProposedColumn => ({
      row,
      justification: "operation-needs-new-data",
      coveredByWriterId: null,
      rationale: "the operation needs to know the delay",
    });
    const result = await run(ISSUE_4478, async () => ({
      proposals: RUNS[1]!.map(insist),
      coveringWriterIds: [],
    }));
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(result.optionalColumnProposals).toHaveLength(1);
  });

  it("rejects it outright when the request does not ask to configure anything", async () => {
    // The verbatim issue without its "Times could be configured in settings." sentence.
    const noSettings = ISSUE_4478.replace(" Times could be configured in settings.", "");
    expect(noSettings).not.toBe(ISSUE_4478);
    const result = await run(noSettings, async () => RUNS[1]!);
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(result.optionalColumnProposals).toEqual([]);
    expect(result.droppedColumnProposals).toHaveLength(1);
    expect(result.droppedColumnProposals[0]!.writer?.qualifiedName).toBe(
      `${ENTRY}::MarkAllAsReadBeforeDate`,
    );
    expect(result.droppedColumnProposals[0]!.reason).toMatch(
      /^An existing write path covers this:/,
    );
  });

  it("runs the proposer once for the whole issue, not once per section", async () => {
    const proposer = vi.fn<Proposer>(async () => []);
    await run(ISSUE_4478, proposer);
    expect(proposer).toHaveBeenCalledTimes(1);
  });

  it("hands the proposer the lineage writers with what each one does", async () => {
    const proposer = vi.fn<Proposer>(async () => []);
    await run(ISSUE_4478, proposer);
    const { writers } = proposer.mock.calls[0]![2];
    const before = writers.find((w) => w.id === "MarkAllAsReadBeforeDate")!;
    expect(before).toMatchObject({
      filePath: ENTRY,
      startLine: 523,
      writeTables: ["entries"],
      predicateColumns: ["entries.published_at", "entries.user_id"],
      parameters: ["userID int64", "before time.Time"],
    });
    expect(before.sql).toContain("published_at < $4");
    // A writer the seeded code reaches directly is listed too.
    expect(writers.map((w) => w.id)).toContain("MarkAllAsRead");
  });

  it("still lists MarkAllAsReadBeforeDate as the code that already does it", async () => {
    const result = await run(ISSUE_4478, async () => RUNS[0]!);
    expect(
      result.affectedSymbols
        .filter((s) => s.relation === "data-writer")
        .map((s) => s.qualifiedName),
    ).toContain(`${ENTRY}::MarkAllAsReadBeforeDate`);
  });
});

describe("computeProjectImpact — what stays a core migration (#791)", () => {
  it("keeps entries.read_at for the verbatim #4336 issue", async () => {
    const result = await run(ISSUE_4336, async () => [column("entries", "read_at", "TIMESTAMP")]);
    expect(addColumns(result.affectedTables)).toContain("entries.read_at");
    expect(result.droppedColumnProposals).toEqual([]);
    expect(result.optionalColumnProposals).toEqual([]);
  });

  it("keeps a users column when the lineage names no time-bounded writer", async () => {
    // No `published_at` predicate anywhere: nothing already takes an age.
    const noPredicate = schemaDataSource({
      getSchemaEdgesFrom: async (ids) =>
        EDGES.filter(
          (e) => ids.includes(e.fromSymbolId) && e.toSymbolId !== "entries.published_at",
        ),
    });
    const result = await run(
      ISSUE_4478,
      async () => [column("users", "mark_read_delay", "INTEGER")],
      {},
      noPredicate,
    );
    expect(addColumns(result.affectedTables)).toEqual(["users.mark_read_delay"]);
  });
});

describe("computeProjectImpact — the gate is best-effort around its collaborators (#791)", () => {
  it("proposes without write paths when profiling them fails, and gates nothing", async () => {
    const proposer = vi.fn<Proposer>(async () => [column("users", "mark_read_delay", "INTEGER")]);
    const broken = schemaDataSource({
      getCodeSymbolTexts: async () => {
        throw new Error("db down");
      },
    });
    const result = await run(ISSUE_4478, proposer, {}, broken);
    expect(proposer.mock.calls[0]![2].writers).toEqual([]);
    // With no writer profile there is nothing to cover the column: it passes.
    expect(addColumns(result.affectedTables)).toEqual(["users.mark_read_delay"]);
  });

  it("keeps the crossing output when the proposer throws", async () => {
    const result = await run(ISSUE_4478, async () => {
      throw new Error("provider down");
    });
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(result.droppedColumnProposals).toEqual([]);
    expect(result.optionalColumnProposals).toEqual([]);
    expect(result.affectedTables.map((t) => t.tableName)).toContain("entries");
  });

  it("does not call the proposer when the crossing surfaced no table", async () => {
    const proposer = vi.fn<Proposer>(async (): Promise<ProposerOutput> => []);
    const empty = schemaDataSource({ getDownstreamCallEdgesFrom: async () => [] });
    await run(ISSUE_4478, proposer, {}, empty);
    expect(proposer).not.toHaveBeenCalled();
  });

  it("does not propose on a table the recovery judge added afterwards", async () => {
    const proposer = vi.fn<Proposer>(async (): Promise<ProposerOutput> => []);
    const empty = schemaDataSource({ getDownstreamCallEdgesFrom: async () => [] });
    const recovered: AffectedTableInput = {
      objectKind: "table",
      tableName: "users",
      columnName: null,
      columnType: null,
      changeKind: "reference",
      suggestedDdl: null,
      source: "sqlglot",
      reconciliation: null,
      confidence: 0.4,
      relevanceTier: "possible",
    };
    const result = await run(
      ISSUE_4478,
      proposer,
      { tableRecoveryJudge: async () => [recovered] },
      empty,
    );
    expect(result.affectedTables.map((t) => t.tableName)).toEqual(["users"]);
    expect(proposer).not.toHaveBeenCalled();
  });
});
