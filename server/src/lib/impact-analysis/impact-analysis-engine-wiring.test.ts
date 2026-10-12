/**
 * The engine's WIRING between the impact stages (#1036, #791), asserted at the
 * engine and not one layer down.
 *
 * Each stage has unit tests of its own, and the adversarial panel on PR #1090
 * found that the lines JOINING them could be reverted with every suite green:
 * the callee names `loadProjectGraph` hands the structural-twin stage, the schema
 * seeds handed to the lineage-writer lookup, the proposer's declared covering
 * writers handed to the gate, and the writers and growing tables handed to role
 * assignment. Every test here goes through `computeProjectImpact` (or the loader
 * it is given) with real stages; only the model-shaped collaborators are stubbed.
 *
 * Also here, for the same reason: the default seeding searches the SAME Prisma
 * client it hydrates from, and says when it ran without the vector channel.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { impactSymbolRole } from "@metis/shared";

// The module-global client. Nothing in this file may query it: every caller
// below injects its own.
const globalQuery = vi.fn(async (): Promise<never> => {
  throw new Error("the module-global Prisma client was queried");
});
vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany: globalQuery, aggregate: globalQuery },
    codeGraph: { aggregate: globalQuery },
    codeEdge: { findMany: globalQuery },
  },
}));

const { NO_WRITERS_REASON } = await import("./column-proposal-gate.js");
const {
  bm25OnlyNotice,
  computeProjectImpact,
  defaultSeedChange,
  loadProjectGraph,
  WRITERS_FAILED_REASON,
} = await import("./impact-analysis-engine.js");
const { extractChangesByShape } = await import("./change-request.js");
const { column, EDGES, ENTRY, graph, schemaDataSource, SYMBOLS, UI, UI_HANDLER_SEEDS } =
  await import("../../../tests/helpers/miniflux-4478-lineage.js");

type ComputeDeps = Parameters<typeof computeProjectImpact>[2];
type Proposer = NonNullable<ComputeDeps["additiveColumnProposer"]>;

const here = dirname(fileURLToPath(import.meta.url));
const ISSUE_4478 = readFileSync(join(here, "__fixtures__", "miniflux-4478.md"), "utf8");

beforeEach(() => {
  globalQuery.mockClear();
});

function run(issue: string, over: Partial<ComputeDeps> = {}) {
  const changes = extractChangesByShape(issue);
  expect(changes).toHaveLength(1);
  return computeProjectImpact(changes[0]!, "proj-1", {
    mapRequirement: async () => [],
    seedChange: async () => UI_HANDLER_SEEDS,
    dataSourceFor: () => graph,
    schemaDataSourceFor: () => schemaDataSource(),
    ...over,
  });
}

const addColumns = (
  tables: { changeKind: string; tableName: string; columnName: string | null }[],
) =>
  tables.filter((t) => t.changeKind === "add-column").map((t) => `${t.tableName}.${t.columnName}`);

function code(id: string, filePath: string, confidence = 1) {
  const s = SYMBOLS.find((x) => x.id === id)!;
  return {
    codeSymbolId: id,
    filePath,
    qualifiedName: s.qualifiedName,
    startLine: s.startLine,
    endLine: s.endLine,
    confidence,
  };
}

describe("loadProjectGraph → structural twins (#1036, PR #1090 panel)", () => {
  // Two handlers built alike (seven of eight callee names shared) and one that
  // only IMPORTS those names. The calls are unresolved — a name, no target — as
  // the Go parser stores `h.store.X()`.
  const SHARED = ["a", "b", "c", "d", "e", "f", "g"];
  const symbols = ["seed", "twin", "importer"].map((id) => ({
    id,
    qualifiedName: `ui/${id}.ts::${id}`,
    kind: "function",
    filePath: `ui/${id}.ts`,
    language: "ts",
    startLine: 1,
    endLine: 9,
    projectId: "p1",
  }));
  const edge = (fromSymbolId: string, toQualifiedName: string, kind: string, i: number) => ({
    id: `${fromSymbolId}-${kind}-${i}`,
    projectId: "p1",
    fromSymbolId,
    toSymbolId: null as string | null,
    toQualifiedName,
    kind,
    filePath: `ui/${fromSymbolId}.ts`,
  });
  const edges = [
    ...[...SHARED, "x"].map((n, i) => edge("seed", n, "calls", i)),
    ...[...SHARED, "y"].map((n, i) => edge("twin", n, "calls", i)),
    ...[...SHARED, "x"].map((n, i) => edge("importer", n, "imports", i)),
    // Another project's call must not leak in.
    { ...edge("seed", "zzz", "calls", 99), projectId: "p2" },
  ];
  /** Just enough of Prisma's `where` for the three queries the loader makes. */
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, want]) => {
      const have = row[key];
      if (want === null || typeof want !== "object") return have === want;
      const cond = want as { in?: unknown[]; not?: unknown; endsWith?: string };
      if (cond.in) return cond.in.includes(have);
      if ("not" in cond) return have !== cond.not;
      if (cond.endsWith) return typeof have === "string" && have.endsWith(cond.endsWith);
      return false;
    });
  const edgeFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    edges.filter((e) => matches(e, where)),
  );
  const prisma = {
    codeSymbol: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        symbols.filter((s) => matches(s, where)),
    },
    codeEdge: { findMany: edgeFindMany },
  };

  it("carries each function's callee NAMES, from `calls` edges only, resolved or not", async () => {
    const loaded = await loadProjectGraph(prisma as never, "p1");
    const names = loaded.calleeNameSets();
    expect([...names.get("seed")!].sort()).toEqual([...SHARED, "x"].sort());
    expect([...names.get("twin")!].sort()).toEqual([...SHARED, "y"].sort());
    // An import is not a call, and another project's edge is not this project's.
    expect(names.has("importer")).toBe(false);
    expect(names.get("seed")!.has("zzz")).toBe(false);
    // The query that feeds it asks for calls by name, in this project.
    expect(edgeFindMany).toHaveBeenCalledWith({
      where: { projectId: "p1", kind: "calls", toQualifiedName: { not: null } },
      select: { fromSymbolId: true, toQualifiedName: true },
    });
  });

  it("so the engine lists the twin of a retrieved function for review, off the loaded graph", async () => {
    const loaded = await loadProjectGraph(prisma as never, "p1");
    const result = await computeProjectImpact(
      { requirementId: null, title: "t", body: "b", changeType: "added", bodyDelta: 1 },
      "p1",
      {
        mapRequirement: async () => [],
        seedChange: async () => ({
          editCandidates: [
            {
              codeSymbolId: "seed",
              filePath: "ui/seed.ts",
              qualifiedName: "ui/seed.ts::seed",
              startLine: 1,
              endLine: 9,
              confidence: 1,
            },
          ],
          related: [],
          schemaSeeds: [],
        }),
        dataSourceFor: () => loaded,
        includeSchemaImpact: false,
      },
    );
    const twin = result.affectedSymbols.find((s) => s.codeSymbolId === "twin");
    expect(twin?.relation).toBe("related");
    expect(impactSymbolRole(twin!)).toBe("blast-radius");
    // The importer shares the names and calls nothing: it is no twin.
    expect(result.affectedSymbols.map((s) => s.codeSymbolId)).not.toContain("importer");
  });
});

describe("computeProjectImpact — a schema seed reaches the lineage-writer lookup (#1036, PR #1090 panel)", () => {
  // The seeding selected a function with no data path of its own, and found the
  // `entries.status` COLUMN among its best hits. The request names no column.
  const seeds = {
    editCandidates: [code("UserByID", "internal/storage/user.go")],
    related: [],
    schemaSeeds: [
      {
        codeSymbolId: "entries.status",
        filePath: "internal/database/migrations.go",
        qualifiedName: "entries.status",
        startLine: 1,
        endLine: 1,
        confidence: 0.9,
      },
    ],
  };
  const TEXT =
    "# [Feature]: Bulk flag\n\n### Feature Summary\n\nLet a reader flag every item at once.\n\n### Proposed Solution\n\nA button on the list page.";

  it("names the functions that write the seeded column", async () => {
    const result = await run(TEXT, { seedChange: async () => seeds });
    const writers = result.affectedSymbols
      .filter((s) => s.relation === "data-writer")
      .map((s) => s.qualifiedName)
      .sort();
    expect(writers).toEqual([`${ENTRY}::MarkAllAsRead`, `${ENTRY}::MarkAllAsReadBeforeDate`]);
  });

  it("names none when the seeding found no schema symbol — the seed is what led there", async () => {
    const result = await run(TEXT, {
      seedChange: async () => ({ ...seeds, schemaSeeds: [] }),
    });
    expect(result.affectedSymbols.filter((s) => s.relation === "data-writer")).toEqual([]);
  });
});

describe("computeProjectImpact — the proposer's declared covering writers reach the gate (#791, PR #1090 panel)", () => {
  // A lineage that records no time filter anywhere: structurally, nothing takes
  // an age, so a `users` column is core unless the proposer's own answer says a
  // listed write path already performs the request.
  const noPredicate = () =>
    schemaDataSource({
      getSchemaEdgesFrom: async (ids) =>
        EDGES.filter(
          (e) => ids.includes(e.fromSymbolId) && e.toSymbolId !== "entries.published_at",
        ),
    });
  const answer =
    (coveringWriterIds: string[]): Proposer =>
    async () => ({
      proposals: [
        {
          row: column("users", "mark_read_delay", "INTEGER"),
          justification: "operation-needs-new-data",
          coveredByWriterId: null,
          rationale: "",
        },
      ],
      coveringWriterIds,
    });

  it("is core with no declaration", async () => {
    const result = await run(ISSUE_4478, {
      schemaDataSourceFor: noPredicate,
      additiveColumnProposer: answer([]),
    });
    expect(addColumns(result.affectedTables)).toEqual(["users.mark_read_delay"]);
    expect(result.optionalColumnProposals).toEqual([]);
  });

  it("moves OUT of core when the proposer declares a listed writer as covering", async () => {
    const result = await run(ISSUE_4478, {
      schemaDataSourceFor: noPredicate,
      additiveColumnProposer: answer(["MarkAllAsReadBeforeDate"]),
    });
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(result.optionalColumnProposals.map((o) => o.row.columnName)).toEqual([
      "mark_read_delay",
    ]);
    expect(result.optionalColumnProposals[0]!.writer?.qualifiedName).toBe(
      `${ENTRY}::MarkAllAsReadBeforeDate`,
    );
    expect(result.optionalColumnProposals[0]!.reason).toContain("was named by the proposer");
  });

  it("a declared writer on the proposal's OWN table does not make it core (the review repro, end to end)", async () => {
    // "`users` writers are plausible members of the list whenever `users` is a
    // candidate table": here one is. `UpdateUser` writes `users.settings`, a
    // column the verbatim issue names ("configured in settings"), so the real
    // lineage lookup lists it beside MarkAllAsReadBeforeDate.
    const UPDATE_USER = {
      id: "UpdateUser",
      kind: "function",
      name: "UpdateUser",
      qualifiedName: "internal/storage/user.go::UpdateUser",
      filePath: "internal/storage/user.go",
      startLine: 180,
      endLine: 199,
      language: "go",
    };
    const SETTINGS = {
      id: "users.settings",
      kind: "column" as const,
      name: "settings",
      qualifiedName: "users.settings",
      source: "sqlglot" as const,
    };
    const extra = [
      { fromSymbolId: "UpdateUser", toSymbolId: "users", kind: "writes" as const },
      { fromSymbolId: "UpdateUser", toSymbolId: "users.settings", kind: "writes" as const },
      { fromSymbolId: "UpdateUser", toSymbolId: "users.id", kind: "reads" as const },
    ];
    const base = schemaDataSource();
    const withUserWriter = schemaDataSource({
      getSchemaEdgesFrom: async (ids) => [
        ...(await base.getSchemaEdgesFrom(ids)),
        ...extra.filter((e) => ids.includes(e.fromSymbolId)),
      ],
      getSchemaSymbolsByIds: async (ids) => [
        ...(await base.getSchemaSymbolsByIds(ids)),
        ...(ids.includes(SETTINGS.id) ? [SETTINGS] : []),
      ],
      getColumnsOfTables: async (tables) => [
        ...(await base.getColumnsOfTables!(tables)),
        ...(tables.includes("users") ? [SETTINGS] : []),
      ],
      getWriterEdgesTo: async (ids) => [
        ...(await base.getWriterEdgesTo!(ids)),
        ...extra.filter((e) => ids.includes(e.toSymbolId) && e.kind === "writes"),
      ],
      getCodeSymbolDetails: async (ids) => [
        ...(await base.getCodeSymbolDetails!(ids)),
        ...(ids.includes("UpdateUser") ? [UPDATE_USER] : []),
      ],
    });
    let listed: { id: string; writeTables: string[] }[] = [];
    const proposer: Proposer = async (text, tables, context) => {
      listed = context.writers;
      return answer(["UpdateUser"])(text, tables, context);
    };
    const result = await run(ISSUE_4478, {
      schemaDataSourceFor: () => withUserWriter,
      additiveColumnProposer: proposer,
    });
    // The premise: the proposer really was shown a writer of `users`, and declared it.
    expect(listed.find((w) => w.id === "UpdateUser")?.writeTables).toEqual(["users"]);
    expect(listed.map((w) => w.id)).toContain("MarkAllAsReadBeforeDate");
    // The outcome: still not a core `users` column.
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(result.optionalColumnProposals.map((o) => o.row.columnName)).toEqual([
      "mark_read_delay",
    ]);
    expect(result.optionalColumnProposals[0]!.writer?.qualifiedName).toBe(
      `${ENTRY}::MarkAllAsReadBeforeDate`,
    );
  });

  it("never moves INTO core: with the real lineage, no declaration changes the #4478 outcome", async () => {
    for (const declared of [[], ["MarkAllAsRead"], ["MarkAllAsRead", "MarkAllAsRead", "ghost"]]) {
      const result = await run(ISSUE_4478, { additiveColumnProposer: answer(declared) });
      expect(addColumns(result.affectedTables), declared.join(",")).toEqual([]);
      expect(result.optionalColumnProposals).toHaveLength(1);
    }
  });
});

describe("computeProjectImpact — lineage writers and growing tables reach role assignment (#1036, PR #1090 panel)", () => {
  const writerRows = (result: Awaited<ReturnType<typeof run>>) =>
    Object.fromEntries(
      result.affectedSymbols
        .filter((s) => s.relation === "data-writer")
        .map((s) => [s.qualifiedName.split("::").pop(), impactSymbolRole(s)]),
    );

  it("leaves a lineage writer in the blast radius when nothing but the lineage points at it", async () => {
    // Seeded at the UI handler; the request names no column and no table grows.
    const result = await run(ISSUE_4478);
    expect(writerRows(result)).toEqual({
      MarkAllAsRead: "blast-radius",
      MarkAllAsReadBeforeDate: "blast-radius",
    });
  });

  it("promotes the writers of a table that GAINS a column to edit candidates", async () => {
    // Same seeding, same request; the proposer adds a column to `entries`, which
    // both writers write. A column on the writer's own table is core.
    const result = await run(ISSUE_4478, {
      additiveColumnProposer: async () => [column("entries", "read_at", "TIMESTAMP")],
    });
    expect(addColumns(result.affectedTables)).toEqual(["entries.read_at"]);
    expect(writerRows(result)).toEqual({
      MarkAllAsRead: "edit-candidate",
      MarkAllAsReadBeforeDate: "edit-candidate",
    });
    // They are edit candidates in the storage file, which the seeding never selected.
    const editFiles = new Set(
      result.affectedSymbols.filter((s) => s.depth === 0).map((s) => s.filePath),
    );
    expect([...editFiles].sort()).toEqual([ENTRY, UI]);
  });

  it("promotes a writer of a column the request names as an identifier, with no table growing", async () => {
    const text = ISSUE_4478.replace(
      "Times could be configured in settings.",
      "Times could be configured in settings. It must also bump `changed_at`.",
    );
    const result = await run(text);
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(writerRows(result)).toEqual({
      MarkAllAsRead: "edit-candidate",
      MarkAllAsReadBeforeDate: "edit-candidate",
    });
  });
});

describe("computeProjectImpact — the gate is fail-open, and the result says so (#791, PR #1090 review)", () => {
  const proposer: Proposer = async () => [column("users", "mark_read_delay", "INTEGER")];

  it("marks a column unchecked, with the fault, when the write paths could not be described", async () => {
    const broken = schemaDataSource({
      getCodeSymbolTexts: async () => {
        throw new Error("db down");
      },
    });
    const result = await run(ISSUE_4478, {
      additiveColumnProposer: proposer,
      schemaDataSourceFor: () => broken,
    });
    // Unchanged behaviour: it passes.
    expect(addColumns(result.affectedTables)).toEqual(["users.mark_read_delay"]);
    // New: it is marked.
    expect(result.uncheckedColumnProposals).toEqual([
      {
        row: column("users", "mark_read_delay", "INTEGER"),
        writer: null,
        reason: WRITERS_FAILED_REASON,
      },
    ]);
    expect(WRITERS_FAILED_REASON).toMatch(
      /^Not checked: looking up the existing write paths failed/,
    );
  });

  it("marks it with the fault when the writer lookup itself throws", async () => {
    const broken = schemaDataSource({
      getWriterEdgesTo: async () => {
        throw new Error("db down");
      },
    });
    const result = await run(ISSUE_4478, {
      additiveColumnProposer: proposer,
      schemaDataSourceFor: () => broken,
    });
    expect(result.uncheckedColumnProposals.map((u) => u.reason)).toEqual([WRITERS_FAILED_REASON]);
  });

  it("marks it 'no write path named' when the lineage simply has none", async () => {
    // A data source without the lineage hooks: no writer is ever named.
    const bare = schemaDataSource({
      getWriterEdgesTo: undefined,
      getColumnsOfTables: undefined,
    });
    const result = await run(ISSUE_4478, {
      additiveColumnProposer: proposer,
      schemaDataSourceFor: () => bare,
    });
    expect(addColumns(result.affectedTables)).toEqual(["users.mark_read_delay"]);
    expect(result.uncheckedColumnProposals.map((u) => u.reason)).toEqual([NO_WRITERS_REASON]);
  });

  it("marks nothing when the gate had writers to check against", async () => {
    const result = await run(ISSUE_4478, { additiveColumnProposer: proposer });
    expect(result.uncheckedColumnProposals).toEqual([]);
    expect(result.optionalColumnProposals).toHaveLength(1);
  });
});

describe("computeProjectImpact — a cue word in a context section does not reach the gate (#791, PR #1090 review)", () => {
  const proposer: Proposer = async () => [column("users", "mark_read_delay", "INTEGER")];

  it.each([
    [
      "the problem statement",
      "24 hours, 1 week, 1 month",
      "It should track what each user has read.",
    ],
    [
      "a rejected alternative",
      "be better in the UI",
      "That tool stores a read delay for every user.",
    ],
  ])("stays optional with a record verb in %s", async (_where, anchor, sentence) => {
    const text = ISSUE_4478.replace(anchor, `${anchor}. ${sentence}`);
    expect(text).not.toBe(ISSUE_4478);
    const result = await run(text, { additiveColumnProposer: proposer });
    expect(addColumns(result.affectedTables)).toEqual([]);
    expect(result.optionalColumnProposals.map((o) => o.row.columnName)).toEqual([
      "mark_read_delay",
    ]);
  });

  it("is core when the request itself instructs it — the same sentence, in the proposed solution", async () => {
    const text = ISSUE_4478.replace(
      "configured in settings.",
      "configured in settings. It should also store the read delay for every user.",
    );
    const result = await run(text, { additiveColumnProposer: proposer });
    expect(addColumns(result.affectedTables)).toEqual(["users.mark_read_delay"]);
  });
});

describe("computeProjectImpact — the DDL fast path reads what the request asks, not what it quotes (#791, PR #1090 review)", () => {
  const DDL = "ALTER TABLE entries ADD COLUMN read_at TIMESTAMPTZ;";
  const issue = (solution: string, alternatives: string) =>
    [
      "# [Feature]: Show when an entry was read",
      "### Feature Summary",
      "Show when an entry was read.",
      "### Proposed Solution",
      solution,
      "### Alternatives Considered",
      alternatives,
    ].join("\n\n");

  it("proposes the column when the request itself states the DDL", async () => {
    const result = await run(issue(`Run this migration:\n\n${DDL}`, "A browser extension."));
    expect(result.affectedTables.map((t) => t.suggestedDdl).join("\n")).toContain(
      "ADD COLUMN read_at",
    );
  });

  it("does not propose a column whose DDL is only quoted under Alternatives considered", async () => {
    const result = await run(issue("A column in the entry list.", `Someone suggested:\n\n${DDL}`));
    expect(result.affectedTables.length).toBeGreaterThan(0);
    expect(result.affectedTables.map((t) => t.suggestedDdl).join("\n")).not.toContain("read_at");
  });
});

describe("defaultSeedChange — one client for the search and the hydrate (#1036, PR #1090 review)", () => {
  const rows = [
    { id: "s1", name: "MarkAllAsRead", kind: "function", language: "go" },
    { id: "s2", name: "RefreshFeed", kind: "function", language: "go" },
  ].map((r) => ({
    ...r,
    qualifiedName: `storage/entry.go::${r.name}`,
    filePath: "storage/entry.go",
    startLine: 1,
    endLine: 9,
    projectId: "p1",
  }));
  function injected() {
    const findMany = vi.fn(
      async ({ where }: { where: { projectId: string; id?: { in: string[] } } }) =>
        rows.filter(
          (r) => r.projectId === where.projectId && (!where.id || where.id.in.includes(r.id)),
        ),
    );
    return { client: { codeSymbol: { findMany } }, findMany };
  }
  const change = {
    requirementId: null,
    title: "mark all as read",
    body: "",
    changeType: "added" as const,
    bodyDelta: 1,
  };
  const noVectors = {
    vectorStore: { search: async () => [] },
    embedService: { embed: async () => ({ vectors: [] }) },
  };

  it("searches the injected client's symbols, and never the module-global client", async () => {
    const { client, findMany } = injected();
    const seedChange = defaultSeedChange(client as never, noVectors as never);
    const seeds = await seedChange(change, "p1");
    expect(seeds.editCandidates.map((m) => m.qualifiedName)).toEqual([
      "storage/entry.go::MarkAllAsRead",
    ]);
    // One full load for the lexical index, one lookup to hydrate the hits.
    expect(findMany.mock.calls.map((c) => Object.keys(c[0].where).sort())).toEqual([
      ["projectId"],
      ["id", "projectId"],
    ]);
    expect(globalQuery).not.toHaveBeenCalled();
  });

  it("loads the lexical index once per project for the run, however many changes are seeded", async () => {
    const { client, findMany } = injected();
    const seedChange = defaultSeedChange(client as never, noVectors as never);
    await seedChange(change, "p1");
    await seedChange({ ...change, title: "refresh feed" }, "p1");
    expect(findMany.mock.calls.filter((c) => !c[0].where.id)).toHaveLength(1);
  });

  it("says bm25-only when the project has no vectors yet", async () => {
    const { client } = injected();
    const seeds = await defaultSeedChange(client as never, noVectors as never)(change, "p1");
    expect(seeds.retrievalMode).toBe("bm25-only");
  });

  it("says bm25-only when the embedder faults, and still returns the keyword hits", async () => {
    const { client } = injected();
    const faulting = {
      vectorStore: { search: async () => [] },
      embedService: {
        embed: async () => {
          throw new Error("model not loaded");
        },
      },
    };
    const seeds = await defaultSeedChange(client as never, faulting as never)(change, "p1");
    expect(seeds.retrievalMode).toBe("bm25-only");
    expect(seeds.editCandidates).toHaveLength(1);
  });

  it("says hybrid when the vector channel answered", async () => {
    const { client } = injected();
    const withVectors = {
      vectorStore: {
        search: async () => [{ id: "v1", score: 0.9, metadata: { symbolId: "s1" } }],
      },
      embedService: { embed: async () => ({ vectors: [[0.1, 0.2]] }) },
    };
    const seeds = await defaultSeedChange(client as never, withVectors as never)(change, "p1");
    expect(seeds.retrievalMode).toBe("hybrid");
  });

  it("carries the mode onto the impact result", async () => {
    const { client } = injected();
    const result = await computeProjectImpact(change, "p1", {
      mapRequirement: async () => [],
      seedChange: defaultSeedChange(client as never, noVectors as never),
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
    });
    expect(result.retrievalMode).toBe("bm25-only");
    // An injected mapper reports nothing.
    const mapped = await computeProjectImpact(change, "p1", {
      mapRequirement: async () => [],
      dataSourceFor: () => graph,
      includeSchemaImpact: false,
    });
    expect(mapped.retrievalMode).toBeNull();
  });
});

describe("bm25OnlyNotice (#1036)", () => {
  it("names the scope in words a reader of the run can use", () => {
    expect(bm25OnlyNotice(1, 1)).toMatch(
      /^Code search ran on keywords only \(BM25\) for this project:/,
    );
    expect(bm25OnlyNotice(2, 2)).toContain("for all 2 projects:");
    expect(bm25OnlyNotice(1, 3)).toContain("for 1 of 3 projects:");
    expect(bm25OnlyNotice(1, 1)).toContain("symbol embeddings were missing or still building");
  });
});
