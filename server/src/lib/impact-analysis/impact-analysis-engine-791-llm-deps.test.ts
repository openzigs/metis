/**
 * #791 — the gate's invariant, checked THROUGH THE ENGINE with every optional
 * LLM dependency switched on (PR #1090 review 3).
 *
 * The sweep in `column-proposal-gate.test.ts` proves that no answer of the
 * proposer makes a column core in a covered request. It is a sweep over one pure
 * function, so it is exactly as wide as that function's inputs — and one of
 * them, the writer list, was scoped in the engine by an EARLIER model: the #936
 * table-relevance filter. One filter answer (`entries` is tangential) left the
 * verbatim #4478 request "uncovered" and its `users` column core, with every
 * gate-level test green.
 *
 * So this file asserts the claim where it is made: at `computeProjectImpact`,
 * on the verbatim #4478 text, with each optional LLM dependency of the engine
 * answering adversarially.
 *
 *   tableRelevanceFilter      (#936)  — closed: the gate looks its writers up on
 *                                       every table the crossing reached.
 *   tableRecoveryJudge        (#1029) — closed by construction: it runs only
 *                                       when no primary table is left, and then
 *                                       the proposer is not called.
 *   clauseCoverageReconciler  (#1005) — runs after the gate; advisory only.
 *   additiveColumnProposer    (#1001) — the model the gate exists for.
 *   mapRequirement            (#931, #1002: LLM seeding) — NOT closed. The seeds
 *                                       decide which tables the crossing reaches.
 *                                       Pinned below as the stated limit.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Nothing in this file may query the module-global client.
vi.mock("../prisma.js", () => {
  const refuse = async (): Promise<never> => {
    throw new Error("the module-global Prisma client was queried");
  };
  return {
    prisma: {
      codeSymbol: { findMany: refuse, aggregate: refuse },
      codeGraph: { aggregate: refuse },
      codeEdge: { findMany: refuse },
    },
  };
});

const { NO_WRITERS_REASON, uncheckedPreferenceReason } = await import("./column-proposal-gate.js");
const { computeProjectImpact, WRITERS_FAILED_REASON } = await import("./impact-analysis-engine.js");
const { extractChangesByShape } = await import("./change-request.js");
const { column, ENTRY, graph, schemaDataSource, SYMBOLS, UI_HANDLER_SEEDS } =
  await import("../../../tests/helpers/miniflux-4478-lineage.js");

type ComputeDeps = Parameters<typeof computeProjectImpact>[2];
type Proposer = NonNullable<ComputeDeps["additiveColumnProposer"]>;
type Filter = NonNullable<ComputeDeps["tableRelevanceFilter"]>;
type Tables = Parameters<Filter>[1];
type Result = Awaited<ReturnType<typeof computeProjectImpact>>;

const here = dirname(fileURLToPath(import.meta.url));
const ISSUE_4478 = readFileSync(join(here, "__fixtures__", "miniflux-4478.md"), "utf8");

function run(over: Partial<ComputeDeps> = {}): Promise<Result> {
  const changes = extractChangesByShape(ISSUE_4478);
  expect(changes).toHaveLength(1);
  return computeProjectImpact(changes[0]!, "proj-1", {
    mapRequirement: async () => [],
    seedChange: async () => UI_HANDLER_SEEDS,
    dataSourceFor: () => graph,
    schemaDataSourceFor: () => schemaDataSource(),
    ...over,
  });
}

const addColumns = (result: Result) =>
  result.affectedTables
    .filter((t) => t.changeKind === "add-column")
    .map((t) => `${t.tableName}.${t.columnName}`);
const named = (rows: { row: { tableName: string; columnName: string | null } }[]) =>
  rows.map((r) => `${r.row.tableName}.${r.row.columnName}`);

/** Everything the proposer has answered with on this request, runs 3 to 7, and worse. */
const ANSWERS: Array<readonly [label: string, proposer: Proposer]> = [
  [
    "bare users.mark_read_delay INTEGER",
    async () => [column("users", "mark_read_delay", "INTEGER")],
  ],
  [
    "run 7's three columns",
    async () => [
      column("users", "mark_read_time_options", "TEXT"),
      column("users", "mark_read_delay", "INTEGER"),
      column("users", "mark_read_times", "TEXT"),
    ],
  ],
  [
    "a typed timestamp on users, declared needed, citing a users writer",
    async () => ({
      proposals: [
        {
          row: column("users", "mark_read_before", "TIMESTAMPTZ"),
          justification: "operation-needs-new-data" as const,
          coveredByWriterId: "UserByID",
          rationale: "the operation needs it",
        },
      ],
      coveringWriterIds: ["UserByID", "ghost"],
    }),
  ],
  [
    "a column on entries and one on a table nobody surfaced",
    async () => [
      column("entries", "mark_read_older_than_days", "INTEGER"),
      column("user_settings", "mark_read_delay", "INTEGER"),
    ],
  ],
  [
    "labelled a preference",
    async () => ({
      proposals: [
        {
          row: column("users", "mark_read_delay", "INTEGER"),
          justification: "user-preference" as const,
          coveredByWriterId: null,
          rationale: "",
        },
      ],
      coveringWriterIds: [],
    }),
  ],
];

/** A filter's answer. The engine reads the two buckets and nothing else. */
const sorted = (primary: Tables, secondary: Tables): Awaited<ReturnType<Filter>> => ({
  primary,
  secondary,
  decisions: [],
  applied: true,
});
const isEntries = (t: Tables[number]) => t.tableName === "entries";
const invented = column("user_settings", "mark_read_delay", "INTEGER");

/**
 * What the #936 filter could answer. Each keeps at least one primary table —
 * with none, the proposer is never called (covered separately below).
 */
const FILTERS: Array<readonly [label: string, filter: Filter]> = [
  [
    "entries is tangential (the review's repro)",
    async (_text, tables) =>
      sorted(
        tables.filter((t) => !isEntries(t)),
        tables.filter(isEntries),
      ),
  ],
  [
    "only users is relevant",
    async (_text, tables) =>
      sorted(
        tables.filter((t) => t.tableName === "users"),
        tables.filter((t) => t.tableName !== "users"),
      ),
  ],
  [
    "the entries TABLE row is tangential, its column rows are not",
    async (_text, tables) =>
      sorted(
        tables.filter((t) => !(isEntries(t) && t.objectKind === "table")),
        tables.filter((t) => isEntries(t) && t.objectKind === "table"),
      ),
  ],
  [
    "entries is dropped from BOTH buckets (a filter that loses rows)",
    async (_text, tables) =>
      sorted(
        tables.filter((t) => !isEntries(t)),
        [],
      ),
  ],
  [
    "an invented table is primary, entries secondary",
    async (_text, tables) =>
      sorted(
        [...tables.filter((t) => !isEntries(t)), { ...invented, changeKind: "reference" }],
        tables.filter(isEntries),
      ),
  ],
  [
    "everything is primary, twice over",
    async (_text, tables) => sorted([...tables, ...tables], []),
  ],
  [
    "the filter throws",
    async () => {
      throw new Error("provider down");
    },
  ],
];

describe("computeProjectImpact — #4478 has no core proposed column, whatever the #936 table filter answers (#791, PR #1090 review 3)", () => {
  it("the crossing reaches both tables: the filter has something to demote", async () => {
    const result = await run();
    expect([...new Set(result.affectedTables.map((t) => t.tableName))].sort()).toEqual([
      "entries",
      "users",
    ]);
  });

  it("with no filter: optional, citing MarkAllAsReadBeforeDate (the baseline)", async () => {
    const result = await run({ additiveColumnProposer: ANSWERS[0]![1] });
    expect(addColumns(result)).toEqual([]);
    expect(named(result.optionalColumnProposals)).toEqual(["users.mark_read_delay"]);
  });

  describe.each(FILTERS)("filter: %s", (_label, tableRelevanceFilter) => {
    it.each(ANSWERS)(
      "proposer: %s — no add-column row, nothing unchecked",
      async (_name, proposer) => {
        const asked = vi.fn(proposer);
        const result = await run({ tableRelevanceFilter, additiveColumnProposer: asked });
        expect(asked).toHaveBeenCalledTimes(1);
        const proposed = named(
          (await proposer("", [], { projectId: "p", liveIndex: null, writers: [] }).then((out) =>
            Array.isArray(out) ? out.map((row) => ({ row })) : out.proposals,
          )) as { row: { tableName: string; columnName: string | null } }[],
        );

        expect(addColumns(result)).toEqual([]);
        expect(result.uncheckedColumnProposals).toEqual([]);
        // Every proposal is accounted for, and each ruling rests on the writer the
        // lineage names — the one on the table the filter may have demoted.
        const ruled = [...result.optionalColumnProposals, ...result.droppedColumnProposals];
        expect(named(ruled).sort()).toEqual([...proposed].sort());
        for (const r of ruled) {
          expect(r.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
          expect(r.reason).not.toContain("named no write path");
        }
      },
    );
  });

  it("same ruling with the filter as without it: the filter's answer does not reach the gate", async () => {
    for (const [name, proposer] of ANSWERS) {
      const without = await run({ additiveColumnProposer: proposer });
      for (const [label, tableRelevanceFilter] of FILTERS) {
        const withFilter = await run({ tableRelevanceFilter, additiveColumnProposer: proposer });
        expect(withFilter.optionalColumnProposals, `${name} / ${label}`).toEqual(
          without.optionalColumnProposals,
        );
        expect(withFilter.droppedColumnProposals, `${name} / ${label}`).toEqual(
          without.droppedColumnProposals,
        );
      }
    }
  });

  it("the symbols LISTED stay scoped to the primary set: a demoted table contributes no writer row", async () => {
    const result = await run({
      tableRelevanceFilter: FILTERS[0]![1],
      additiveColumnProposer: ANSWERS[0]![1],
    });
    expect(result.affectedSymbols.filter((s) => s.relation === "data-writer")).toEqual([]);
    expect(result.affectedTablesSecondary.map((t) => t.tableName)).toContain("entries");
  });

  it("the proposer is still shown the primary set's writers only", async () => {
    const seen: string[][] = [];
    const proposer: Proposer = async (_text, _tables, context) => {
      seen.push((context?.writers ?? []).map((w) => w.id));
      return [column("users", "mark_read_delay", "INTEGER")];
    };
    await run({ additiveColumnProposer: proposer });
    await run({ tableRelevanceFilter: FILTERS[0]![1], additiveColumnProposer: proposer });
    expect(seen).toEqual([["MarkAllAsRead", "MarkAllAsReadBeforeDate"], []]);
  });

  it("when the filter leaves no primary table the proposer is never called", async () => {
    const proposer = vi.fn<Proposer>(async () => [column("users", "mark_read_delay", "INTEGER")]);
    const result = await run({
      tableRelevanceFilter: async (_text, tables) => sorted([], tables),
      additiveColumnProposer: proposer,
    });
    expect(proposer).not.toHaveBeenCalled();
    expect(addColumns(result)).toEqual([]);
  });

  it("a fault in the gate's own lookup is a failed lookup, and says so: unlabelled core, labelled optional", async () => {
    // The first lookup (primary set, no entries) succeeds; the gate's fails.
    const failingSecondLookup = () => {
      let calls = 0;
      const base = schemaDataSource();
      return schemaDataSource({
        getColumnsOfTables: async (tables) => {
          calls++;
          if (calls > 1) throw new Error("db down");
          return base.getColumnsOfTables!(tables);
        },
      });
    };
    const unlabelled = await run({
      tableRelevanceFilter: FILTERS[0]![1],
      additiveColumnProposer: ANSWERS[0]![1],
      schemaDataSourceFor: failingSecondLookup,
    });
    expect(addColumns(unlabelled)).toEqual(["users.mark_read_delay"]);
    expect(unlabelled.uncheckedColumnProposals.map((u) => u.reason)).toEqual([
      WRITERS_FAILED_REASON,
    ]);

    const labelled = await run({
      tableRelevanceFilter: FILTERS[0]![1],
      additiveColumnProposer: ANSWERS[4]![1],
      schemaDataSourceFor: failingSecondLookup,
    });
    expect(addColumns(labelled)).toEqual([]);
    expect(labelled.uncheckedColumnProposals).toEqual([]);
    expect(labelled.optionalColumnProposals).toEqual([
      {
        row: column("users", "mark_read_delay", "INTEGER"),
        writer: null,
        reason: uncheckedPreferenceReason(WRITERS_FAILED_REASON),
      },
    ]);
  });
});

describe("computeProjectImpact — #4478 with the writer lookup failing: a labelled preference is optional (owner decision, review 3)", () => {
  const broken = () =>
    schemaDataSource({
      getWriterEdgesTo: async () => {
        throw new Error("db down");
      },
    });

  it("labelled `user-preference`: optional, no add-column row", async () => {
    const result = await run({
      additiveColumnProposer: ANSWERS[4]![1],
      schemaDataSourceFor: broken,
    });
    expect(addColumns(result)).toEqual([]);
    expect(named(result.optionalColumnProposals)).toEqual(["users.mark_read_delay"]);
    expect(result.optionalColumnProposals[0]!.reason).toBe(
      uncheckedPreferenceReason(WRITERS_FAILED_REASON),
    );
  });

  it("not labelled: core and unchecked, as before", async () => {
    const result = await run({
      additiveColumnProposer: ANSWERS[0]![1],
      schemaDataSourceFor: broken,
    });
    expect(addColumns(result)).toEqual(["users.mark_read_delay"]);
    expect(result.uncheckedColumnProposals.map((u) => u.reason)).toEqual([WRITERS_FAILED_REASON]);
  });
});

describe("computeProjectImpact — the #1029 recovery judge cannot reach the gate (#791, PR #1090 review 3)", () => {
  const judge = (rows: Tables) =>
    vi.fn<NonNullable<ComputeDeps["tableRecoveryJudge"]>>(async () => rows);
  const usersRow: Tables[number] = {
    objectKind: "table",
    tableName: "users",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "sqlglot",
    reconciliation: null,
    confidence: 0.5,
  };

  it("does not run while a primary table is left, so it changes nothing", async () => {
    const tableRecoveryJudge = judge([usersRow, { ...usersRow, tableName: "user_settings" }]);
    for (const [, proposer] of ANSWERS) {
      const result = await run({ tableRecoveryJudge, additiveColumnProposer: proposer });
      expect(addColumns(result)).toEqual([]);
      expect(result.uncheckedColumnProposals).toEqual([]);
    }
    for (const [, tableRelevanceFilter] of FILTERS) {
      const result = await run({
        tableRecoveryJudge,
        tableRelevanceFilter,
        additiveColumnProposer: ANSWERS[0]![1],
      });
      expect(addColumns(result)).toEqual([]);
    }
    expect(tableRecoveryJudge).not.toHaveBeenCalled();
  });

  it("when it does run (no primary table left) the proposer does not: a recovered `users` gets no proposed column", async () => {
    const tableRecoveryJudge = judge([usersRow]);
    const proposer = vi.fn<Proposer>(async () => [column("users", "mark_read_delay", "INTEGER")]);
    const result = await run({
      tableRelevanceFilter: async (_text, tables) => sorted([], tables),
      tableRecoveryJudge,
      additiveColumnProposer: proposer,
    });
    expect(tableRecoveryJudge).toHaveBeenCalledTimes(1);
    expect(proposer).not.toHaveBeenCalled();
    expect(result.affectedTables.map((t) => t.tableName)).toEqual(["users"]);
    expect(addColumns(result)).toEqual([]);
  });
});

describe("computeProjectImpact — the #1005 clause reconciler runs after the gate (#791, PR #1090 review 3)", () => {
  it("whatever it answers, the ruling is the one made without it", async () => {
    const without = await run({ additiveColumnProposer: ANSWERS[1]![1] });
    const reconciler = vi.fn<NonNullable<ComputeDeps["clauseCoverageReconciler"]>>(async () => []);
    const withIt = await run({
      additiveColumnProposer: ANSWERS[1]![1],
      clauseCoverageReconciler: reconciler,
      tableRelevanceFilter: FILTERS[0]![1],
    });
    expect(reconciler).toHaveBeenCalledTimes(1);
    expect(addColumns(withIt)).toEqual([]);
    expect(withIt.optionalColumnProposals).toEqual(without.optionalColumnProposals);
    expect(withIt.droppedColumnProposals).toEqual(without.droppedColumnProposals);
  });
});

describe("computeProjectImpact — THE STATED LIMIT: model-chosen SEEDS decide which tables the crossing reaches (#791, PR #1090 review 3)", () => {
  // `IMPACT_LLM_SEEDING` / `IMPACT_LLM_ENTITY_SEEDS` replace the default search
  // seeding with a mapper a model ranks. The engine then has no `seedChange`.
  const match = (id: string) => {
    const s = SYMBOLS.find((x) => x.id === id)!;
    return {
      codeSymbolId: id,
      filePath: s.filePath,
      qualifiedName: s.qualifiedName,
      startLine: s.startLine,
      endLine: s.endLine,
      confidence: 1,
    };
  };
  const seeded = (ids: string[], proposer: Proposer) =>
    run({
      seedChange: undefined,
      mapRequirement: async () => ids.map(match),
      additiveColumnProposer: proposer,
    });

  it("a mapper that seeds the handler: covered, exactly as with the default seeding", async () => {
    const result = await seeded(["markAllAsRead"], ANSWERS[0]![1]);
    expect(addColumns(result)).toEqual([]);
    expect(named(result.optionalColumnProposals)).toEqual(["users.mark_read_delay"]);
  });

  it("a mapper that seeds only code reading `users`: entries is never reached, the request is uncovered, the column is core — and says why truthfully", async () => {
    const result = await seeded(["UserByID"], ANSWERS[0]![1]);
    expect([...new Set(result.affectedTables.map((t) => t.tableName))]).toEqual(["users"]);
    expect(addColumns(result)).toEqual(["users.mark_read_delay"]);
    // True of this run: no write path on the one table it reached.
    expect(result.uncheckedColumnProposals.map((u) => u.reason)).toEqual([NO_WRITERS_REASON]);
    expect(NO_WRITERS_REASON).toContain("on the tables this analysis reached");
  });

  it("…and there the preference label still keeps a `users` column out of the migration", async () => {
    const result = await seeded(["UserByID"], ANSWERS[4]![1]);
    expect(addColumns(result)).toEqual([]);
    expect(named(result.optionalColumnProposals)).toEqual(["users.mark_read_delay"]);
  });
});
