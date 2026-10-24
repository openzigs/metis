/**
 * #1061 — the architecture document's Data Architecture section is its own
 * section, grounded in the schema inventory and checked against it.
 *
 * The first half pins the section definition (what the model is told for each
 * kind of schema source). The second drives the real synthesis loop with a
 * provider that writes an invented column and an invented table, and asserts on
 * the document that comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import type { AIConfig } from "../ai/config.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  factSlicesFor,
  buildSectionTopicQuery,
  SCHEMA_GROUNDING_VERSION,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import { NO_SCHEMA_INVENTORY, type SchemaInventory } from "./schema-inventory.js";
import { deriveDocStatus, summarizeWarnings } from "./grounding/degraded-warnings.js";
import { legacyGeneratedDocVersionManifest } from "./generated-doc-provenance.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../finops/index.js", () => ({ recordUsage: vi.fn() }));

const column = (name: string, dataType: string, key: "pk" | "fk" | "" = "") => ({
  name,
  dataType,
  nullable: key !== "pk",
  isPrimaryKey: key === "pk",
  isForeignKey: key === "fk",
});
const TABLES = [
  {
    schema: "public",
    name: "feeds",
    read: 0,
    columns: [column("id", "bigint", "pk"), column("user_id", "integer", "fk")],
    foreignKeys: [{ name: "feeds_user_id_fkey", columns: ["user_id"], refTable: "users" }],
  },
  {
    schema: "public",
    name: "users",
    read: 0,
    columns: [column("id", "integer", "pk"), column("gesture_nav", "text")],
    foreignKeys: [],
  },
];
/** One database, its `public` schema introspected in this run. */
const LIVE: SchemaInventory = {
  source: "live-schema",
  label: 'the live schema of "miniflux-pg" (public)',
  reads: [{ connector: "miniflux-pg", how: "live", schemas: ["public"] }],
  tables: TABLES,
};
/** The same tables from a stored graph: nothing may be removed against it. */
const STORED: SchemaInventory = {
  ...LIVE,
  source: "schema-graph",
  reads: [{ connector: "miniflux-pg", how: "stored", schemas: ["public"] }],
};
const REPO_SQL: SchemaInventory = {
  source: "repository-sql",
  label: "the SQL found in the repository (migrations, queries and mappings)",
  reads: [],
  tables: TABLES.map(({ read: _read, ...t }) => ({
    ...t,
    columns: t.columns.map((c) => ({ ...c, dataType: "" })),
  })),
};

const dataGroup = (inventory?: SchemaInventory) =>
  sectionGroupsFor("architecture", inventory ? { schemaInventory: inventory } : {}).find(
    (g) => g.id === "data-architecture",
  )!;

describe("the Data Architecture section definition (#1061)", () => {
  it("is its own section, after Component Breakdown", () => {
    const groups = sectionGroupsFor("architecture");
    expect(groups.map((g) => g.id)).toEqual([
      "overview-and-context",
      "components",
      "data-architecture",
      "concerns-and-integrations",
      "ops-and-stack",
    ]);
    const components = groups[1];
    expect(components.instructions).toContain("## Component Breakdown");
    expect(components.instructions).not.toContain("## Data Architecture");
    expect(components.schemaGrounding).toBeUndefined();
    expect(dataGroup().label).toBe("Data Architecture");
    expect(dataGroup().instructions).toContain("Produce ONE section.\n\n## Data Architecture\n");
  });

  it("reads the same fact slices the combined section read, and has its own keywords", () => {
    const [, components, data] = sectionGroupsFor("architecture");
    expect(factSlicesFor(data)).toEqual(["summary", "entities", "capabilities", "integrations"]);
    expect(factSlicesFor(components)).toEqual(factSlicesFor(data));
    expect(buildSectionTopicQuery(data, "Doc")).toContain("schema tables");
    expect(buildSectionTopicQuery(components, "Doc")).toContain("components modules");
  });

  it("is only added to the architecture document", () => {
    for (const docType of ["business-requirements", "user-guide"] as const) {
      const groups = sectionGroupsFor(docType, { schemaInventory: LIVE });
      expect(groups.some((g) => g.schemaGrounding)).toBe(false);
    }
  });

  it("with a typed schema: gives the schema, and has the model write the narrative only", () => {
    const { instructions, schemaGrounding } = dataGroup(LIVE);
    expect(schemaGrounding).toEqual({ inventory: LIVE, version: SCHEMA_GROUNDING_VERSION });
    expect(instructions).toContain("- Do NOT write a Mermaid `erDiagram`.");
    expect(instructions).toContain("- Do NOT write per-table field or column tables.");
    expect(instructions).toContain("| Table | Purpose | Written by |");
    expect(instructions).toContain(
      '=== DATABASE SCHEMA — from the live schema of "miniflux-pg" (public).',
    );
    expect(instructions).toContain("- users: id integer PK, gesture_nav text");
    expect(instructions).toContain("is described here as what it is, never as a table");
  });

  // #1061 review — only each database's default schema is read, so the prompt
  // says what the list covers and does not forbid what it does not cover.
  it("tells the model which schemas the list covers, and forbids nothing outside them", () => {
    const { instructions } = dataGroup(LIVE);
    expect(instructions).toContain(
      'WHAT THE SCHEMA BELOW COVERS:\n- "miniflux-pg": schema public, read from the database now.',
    );
    expect(instructions).toContain(
      "Only each database's default schema is read, and a read lists only what the connecting role may see.",
    );
    expect(instructions).toContain(
      "For the schemas it covers it is the authority for every table name",
    );
    expect(instructions).toContain(
      "- Within the schemas listed as covered, do not name a table or column that is not in the list.",
    );
    // #1061 second review — only when the facts NAME the schema: a package or
    // struct path is not one, and for an unread database the model is given no
    // schema name to write, so it is not asked for one.
    expect(instructions).toContain(
      "- The list is NOT the whole database. A table may be named from outside it in two cases " +
        "only. (1) The facts give the NAME of another schema that holds it: write the table with " +
        "that schema (`audit.events`). A package, module or struct path in the facts " +
        "(`worker.jobs`, `model.Job`) is not a schema. (2) A database is marked NOT read and the " +
        "facts state the table is in it: write the name as the facts give it and say which " +
        "database it is in. In both cases say that its columns were not read, and list no " +
        "columns for it.",
    );
    // The blanket prohibition is gone: it was false for every other schema.
    expect(instructions).not.toContain("Never name a table or column that is not in the schema");
    // The coverage statement comes before the list it describes.
    expect(instructions.indexOf("WHAT THE SCHEMA BELOW COVERS")).toBeLessThan(
      instructions.indexOf("=== DATABASE SCHEMA"),
    );

    const partial = dataGroup({
      ...STORED,
      reads: [
        { connector: "A", how: "stored", schemas: ["public"], storedOn: "2026-10-10" },
        { connector: "B", how: "unread", schemas: [] },
      ],
    }).instructions;
    expect(partial).toContain(
      '- "A": schema public, from a schema graph stored on 2026-10-10; it may be out of date.',
    );
    expect(partial).toContain('- "B": NOT read.');
  });

  it("with names from repository SQL: keeps the data dictionary, restricted to those names", () => {
    const { instructions } = dataGroup(REPO_SQL);
    expect(instructions).toContain("Include a Mermaid `erDiagram`");
    expect(instructions).toContain(
      "an H3 heading of exactly this form — ### Entity: `table_name` — followed by",
    );
    expect(instructions).toContain("| Field | Type | Constraint | Default |");
    expect(instructions).toContain(
      "Use a table or column name only when it is in that list or stated verbatim in the facts",
    );
    expect(instructions).toContain("- users: id, gesture_nav");
    expect(instructions).toContain("Types are not known");
  });

  it("with no schema source: says so, and tells the model not to list likely columns", () => {
    for (const group of [dataGroup(), dataGroup(NO_SCHEMA_INVENTORY)]) {
      expect(group.schemaGrounding?.inventory).toBe(NO_SCHEMA_INVENTORY);
      expect(group.instructions).toContain("No database schema is available for this project.");
      expect(group.instructions).toContain(
        "Where the facts do not give a table's columns, say so instead of listing likely ones.",
      );
      expect(group.instructions).not.toContain("=== ");
    }
  });

  // #1061 third panel — a database that could not be read is still a database
  // the project has: the model is told so, and the section says so.
  it("with no schema source but a database that could not be read: says the project has one", () => {
    const unread: SchemaInventory = {
      source: "none",
      label: "no schema source; 2 database(s) could not be read",
      reads: [
        { connector: "A", how: "unread", schemas: [] },
        { connector: "B", how: "unread", schemas: [] },
      ],
      tables: [],
    };
    const { instructions } = dataGroup(unread);
    expect(instructions).toContain(
      "- No database schema is available for this project. The project has 2 database(s) that " +
        "could not be read, so tables can exist that the facts do not mention. Name a table or a " +
        "column only when the facts state it verbatim",
    );
    expect(instructions).not.toContain("=== ");
    expect(dataGroup(NO_SCHEMA_INVENTORY).instructions).not.toContain("could not be read");
  });

  it("changes when the schema does, so a stored section is not reused across it", () => {
    const changed: SchemaInventory = {
      ...LIVE,
      tables: [...TABLES, { schema: "public", name: "icons", columns: [], foreignKeys: [] }],
    };
    expect(JSON.stringify(dataGroup(LIVE))).not.toBe(JSON.stringify(dataGroup(changed)));
    expect(JSON.stringify(dataGroup(LIVE))).toBe(JSON.stringify(dataGroup({ ...LIVE })));
  });
});

// ---------------------------------------------------------------------------
// End to end through synthesizeFinalDocument
// ---------------------------------------------------------------------------

const INVENTED = `## Data Architecture

One PostgreSQL database.

### Entity: \`users\`

| Field | Type | Description |
|---|---|---|
| \`id\` | int64 | Identifier |
| \`gesture_nav\` | bool | Gesture navigation |
| \`error_counter\` | int | Invented |

### Entity: \`jobs\`

| Field | Type | Description |
|---|---|---|
| \`feed_id\` | int64 | Invented |`;

/** The same section without the invented table. */
const ONE_ENTITY = INVENTED.slice(0, INVENTED.indexOf("### Entity: `jobs`")).trimEnd();
/** Every marker the check can write, removed. */
const withoutMarkers = (markdown: string): string =>
  markdown.replace(/ \*\(not in schema(?:; the schema has `[^`\n]*`)?\)\*/g, "");

const state: {
  dataSection: string;
  prompts: string[];
  /** How the model's stream for the Data Architecture section ends. */
  finish: "stop" | "length";
  /** When set, the fact-check finds a claim of that section unsupported. */
  unsupported: boolean;
  /** #1133 — what the model writes for another section, by group label. */
  other: Record<string, string>;
} = { dataSection: INVENTED, prompts: [], finish: "stop", unsupported: false, other: {} };
/** A claim only the Data Architecture section's fact-check is given. */
const UNSUPPORTED_CLAIM = "The scheduler persists refresh jobs.";
const loadConfig = vi.hoisted(() => vi.fn());
const provider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async (messages: Array<{ content: unknown }>) => {
    const text = messages.map((m) => String(m.content)).join("\n");
    const judge = text.includes("strict faithfulness judge");
    // The Data Architecture section is the one that holds its entity tables.
    const aboutData = text.includes("gesture_nav") || text.includes(UNSUPPORTED_CLAIM);
    const claim = state.unsupported && aboutData ? UNSUPPORTED_CLAIM : "Source facts.";
    return {
      content: JSON.stringify(
        judge
          ? { verdicts: [{ claim, supported: claim === "Source facts.", sourceIds: [] }] }
          : { claims: [{ claim, sourceIds: [] }] },
      ),
    };
  }),
  async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
    const prompt = String(messages.at(-1)?.content);
    if (prompt.includes("section group now")) {
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)![1];
      if (label === "Data Architecture") {
        state.prompts.push(String(messages[0]?.content));
        yield { type: "delta", content: state.dataSection };
        yield { type: "done", finishReason: state.finish };
        return;
      } else {
        yield { type: "delta", content: state.other[label] ?? `## ${label}\n\nSource facts.` };
      }
    } else {
      yield { type: "delta", content: "PURPOSE\n- Source facts." };
    }
    yield { type: "done", finishReason: "stop" };
  },
} as unknown as AIProvider;
vi.mock("../ai/index.js", () => ({
  loadAIConfig: loadConfig,
  buildProvider: ({ config }: { config: AIConfig }) => ({
    ...provider,
    key: config.provider,
    model: config.model,
  }),
}));

const meta = { name: "Project", language: "go", totalFiles: 1, totalSymbols: 3 };
const facts: ModuleFacts[] = [
  {
    modulePath: "internal/storage",
    moduleName: "storage",
    classCount: 1,
    methodCount: 2,
    facts: "Stores users and feeds.",
    formulas: [],
    topClasses: ["Storage"],
  },
];
const context = (): GroundingContext => ({
  sources: [
    {
      sourceId: "rag:reference:1",
      kind: "rag",
      label: "Reference",
      text: "Source facts.",
      documentId: "reference",
      chunkId: "1",
      evidenceClass: "project-reference",
    },
  ],
  sourceIds: new Set(["rag:reference:1"]),
  isEmpty: false,
});
function router(): Phase2Router {
  const tuning = docsGenTuning("bedrock", "fixture");
  return {
    primary: {
      kind: "bedrock",
      provider,
      tuning,
      factsCharCap: tuning.factsCharCap,
      supportsCaching: false,
    },
    hybrid: null,
  };
}
function synth(schemaInventory?: SchemaInventory) {
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    router(),
    "p",
    undefined,
    undefined,
    async () => context(),
    undefined,
    undefined,
    schemaInventory ? { schemaInventory } : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.dataSection = INVENTED;
  state.prompts = [];
  state.finish = "stop";
  state.unsupported = false;
  state.other = {};
  loadConfig.mockReturnValue({
    provider: "bedrock-gateway",
    model: "fixture",
    sdkProvider: { type: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" },
  });
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("synthesizeFinalDocument — a stored Data Architecture section and the schema (#1061)", () => {
  type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;
  const run = (schemaInventory: SchemaInventory, prior?: Result) =>
    synthesizeFinalDocument(
      facts,
      meta,
      "architecture",
      "Architecture",
      router(),
      "p",
      undefined,
      undefined,
      async () => context(),
      undefined,
      {
        previousManifest: prior
          ? {
              ...legacyGeneratedDocVersionManifest({
                projectId: "p",
                generatedDocumentId: "d",
                version: 1,
              }),
              sectionSynthesis: prior.sectionSynthesis,
            }
          : undefined,
        effectiveConfigHash: "fixture-config",
      },
      { schemaInventory },
    );

  const dataRecord = (result: Result) =>
    result.sectionSynthesis?.records.find((r) => r.sectionId === "data-architecture");

  // #1133 review — the clean line is written over the fitted text on every run,
  // so a stored section gets it without being written again (no model call),
  // and its stored record is not changed by it.
  it("gives a reused clean section its one line, with no model call and no change to its record", async () => {
    state.dataSection =
      "## Data Architecture\n\n| Table | Purpose |\n|---|---|\n| `users` | People |\n| `feeds` | Feeds |";
    const cold = await run(LIVE);
    expect(dataRecord(cold)?.markdown).not.toContain("> **Schema check.**");
    state.prompts = [];
    const warm = await run(LIVE, cold);
    expect(state.prompts).toEqual([]);
    expect(warm.regeneration?.mode).toBe("unchanged");
    expect(dataRecord(warm)).toEqual(dataRecord(cold));
    expect(warm.markdown).toContain(
      `> **Schema check.** 2 table and column names in this section were compared with ${LIVE.label}, and every one matched.`,
    );
    expect(warm.markdown).toBe(cold.markdown);
  });

  // #1061 second review — the first fix wrote such a section again on EVERY
  // later run, with no bound and no trace, for as long as the model named the
  // same thing. A mark is information: the section is reused like any other.
  it("reuses a section that carries marks, with its note, and calls no model", async () => {
    const cold = await run(LIVE);
    expect(cold.warnings.map((w) => w.kind)).toEqual(["schema-unverified"]);
    // The record holds what the reader saw: the marked section and its note.
    expect(dataRecord(cold)?.markdown).toContain("### Schema Reference");
    expect(dataRecord(cold)?.markdown).toContain("| `error_counter` *(not in schema)* | int |");
    expect(dataRecord(cold)?.warnings.map((w) => [w.kind, w.severity])).toEqual([
      ["schema-unverified", "info"],
    ]);
    expect(cold.sectionSynthesis?.records).toHaveLength(5);

    for (let later = 0; later < 3; later++) {
      state.prompts = [];
      const warm = await run({ ...LIVE, tables: [...TABLES] }, cold);
      expect(state.prompts).toEqual([]);
      expect(warm.regeneration).toEqual({ mode: "unchanged", changed: [] });
      expect(warm.markdown).toBe(cold.markdown);
      // The note travels with the section, and the document is still ready.
      expect(warm.warnings).toEqual(cold.warnings);
      expect(deriveDocStatus(warm.warnings)).toBe("ready");
    }
  });

  it("reports a reused section that carries marks as done, with no warning", async () => {
    const cold = await run(LIVE);
    const updates: Array<{ section: string; status: string; kind?: string }> = [];
    await synthesizeFinalDocument(
      facts,
      meta,
      "architecture",
      "Architecture",
      router(),
      "p",
      undefined,
      (u) => updates.push({ section: u.section, status: u.status, kind: u.warning?.kind }),
      async () => context(),
      undefined,
      {
        previousManifest: {
          ...legacyGeneratedDocVersionManifest({
            projectId: "p",
            generatedDocumentId: "d",
            version: 1,
          }),
          sectionSynthesis: cold.sectionSynthesis,
        },
        effectiveConfigHash: "fixture-config",
      },
      { schemaInventory: LIVE },
    );
    expect(
      updates.filter((u) => u.section === "Data Architecture" && u.status !== "generating"),
    ).toEqual([{ section: "Data Architecture", status: "done", kind: undefined }]);
  });

  it("rewrites only that section when the schema changes", async () => {
    const cold = await run(LIVE);
    state.prompts = [];
    const changed: SchemaInventory = {
      ...LIVE,
      tables: [
        TABLES[0],
        { ...TABLES[1], columns: [...TABLES[1].columns, column("error_counter", "integer")] },
      ],
    };
    const warm = await run(changed, cold);
    expect(state.prompts).toHaveLength(1);
    expect(warm.regeneration).toMatchObject({ mode: "sections", changed: ["data-architecture"] });
    // The column now exists, so the row the model wrote carries no mark.
    expect(warm.markdown).toContain("| `error_counter` | int | Invented |");
  });
});

// #1061 third panel — no test made the synthesizer itself emit the schema note
// AND a real warning for the same section, so a change that let the note stand
// in for the section's own warning (in the warnings, or in what the section
// reports live) passed. The note is information; it never replaces a warning.
describe("synthesizeFinalDocument — a schema note beside a real warning of the same section (#1061)", () => {
  type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;
  type Update = { section: string; status: string; kind?: string };
  const run = async (prior?: Result): Promise<{ result: Result; updates: Update[] }> => {
    const updates: Update[] = [];
    const result = await synthesizeFinalDocument(
      facts,
      meta,
      "architecture",
      "Architecture",
      router(),
      "p",
      undefined,
      (u) => updates.push({ section: u.section, status: u.status, kind: u.warning?.kind }),
      async () => context(),
      undefined,
      {
        previousManifest: prior
          ? {
              ...legacyGeneratedDocVersionManifest({
                projectId: "p",
                generatedDocumentId: "d",
                version: 1,
              }),
              sectionSynthesis: prior.sectionSynthesis,
            }
          : undefined,
        effectiveConfigHash: "fixture-config",
      },
      { schemaInventory: LIVE },
    );
    return { result, updates };
  };
  /** The section's warnings, in the order the document carries them. */
  const ofData = (result: Result): Array<[string, string]> =>
    result.warnings
      .filter((w) => w.section === "Data Architecture")
      .map((w) => [w.kind, w.severity ?? ""]);
  /** What the section reported when it finished. */
  const finished = (updates: Update[]): Update[] =>
    updates.filter((u) => u.section === "Data Architecture" && u.status !== "generating");

  const CASES = [
    {
      name: "a failed fact-check",
      arrange: (): void => void (state.unsupported = true),
      real: "section-ungrounded",
      order: ["section-ungrounded", "schema-unverified"],
    },
    {
      name: "a section cut off by the output cap",
      arrange: (): void => void (state.finish = "length"),
      real: "section-truncated",
      order: ["schema-unverified", "section-truncated"],
    },
  ] as const;

  for (const { name, arrange, real, order } of CASES) {
    it(`a new run keeps both, and the section reports its own warning: ${name}`, async () => {
      arrange();
      const { result, updates } = await run();
      // Both are in the document's warnings: the note did not replace the other.
      expect(ofData(result).map(([kind]) => kind)).toEqual(order);
      expect(ofData(result).find(([kind]) => kind === "schema-unverified")?.[1]).toBe("info");
      expect(result.warnings.every((w) => w.section === "Data Architecture")).toBe(true);
      expect(deriveDocStatus(result.warnings)).toBe("degraded");
      // The section is degraded, and what it shows live is the real warning.
      expect(finished(updates)).toEqual([
        { section: "Data Architecture", status: "degraded", kind: real },
      ]);
      // The marks are in the section all the same.
      expect(result.markdown).toContain("| `error_counter` *(not in schema)* | int | Invented |");
    });

    it(`a reused section keeps both, and reports its own warning: ${name}`, async () => {
      arrange();
      const cold = await run();
      const record = cold.result.sectionSynthesis?.records.find(
        (r) => r.sectionId === "data-architecture",
      );
      expect(record?.warnings.map((w) => w.kind)).toEqual(order);
      state.prompts = [];
      const warm = await run(cold.result);
      // Reused: the model was not asked again.
      expect(state.prompts).toEqual([]);
      expect(warm.result.regeneration).toEqual({ mode: "unchanged", changed: [] });
      expect(warm.result.warnings).toEqual(cold.result.warnings);
      expect(ofData(warm.result).map(([kind]) => kind)).toEqual(order);
      expect(finished(warm.updates)).toEqual([
        { section: "Data Architecture", status: "degraded", kind: real },
      ]);
    });
  }

  it("the note alone leaves the section done, on a new run and reused", async () => {
    const cold = await run();
    expect(ofData(cold.result)).toEqual([["schema-unverified", "info"]]);
    expect(finished(cold.updates)).toEqual([
      { section: "Data Architecture", status: "done", kind: undefined },
    ]);
    const warm = await run(cold.result);
    expect(finished(warm.updates)).toEqual([
      { section: "Data Architecture", status: "done", kind: undefined },
    ]);
  });
});

describe("synthesizeFinalDocument — Data Architecture is checked against the schema (#1061)", () => {
  it("sends the schema to the model in the section's prompt", async () => {
    await synth(LIVE);
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]).toContain("- users: id integer PK, gesture_nav text");
  });

  it("marks what it could not match, removes nothing, and renders the reference", async () => {
    const result = await synth(LIVE);
    const doc = result.markdown;
    expect(doc).toContain("| `error_counter` *(not in schema)* | int | Invented |");
    expect(doc).toContain("### Entity: `jobs` *(not in schema)*");
    // A type is said in the note, never written into the cell.
    expect(doc).toContain("| `gesture_nav` | bool | Gesture navigation |");
    expect(doc).toContain(
      "> - Types that differ from the schema: `users.gesture_nav` (written `bool`, schema `text`).",
    );
    expect(doc).toContain("### Schema Reference");
    expect(doc).toContain("| gesture_nav | text |  |");
    expect(doc).toContain('feeds }o--|| users : "feeds_user_id_fkey"');
    expect(doc).toContain(
      "> **Schema check.** The table and column names in this section's diagrams, entity " +
        'headings, field tables and table lists were compared with the live schema of "miniflux-pg" (public). ' +
        "Nothing was removed or changed:",
    );
    // One Data Architecture section, in its place.
    expect(doc.match(/^## Data Architecture$/gm)).toHaveLength(1);
    expect(doc.indexOf("## Component Breakdown")).toBeLessThan(doc.indexOf("## Data Architecture"));
    // Every line the model wrote is in the document, in order, as it wrote it.
    const lines = withoutMarkers(doc).split("\n");
    let from = 0;
    for (const line of INVENTED.split("\n")) {
      const at = lines.indexOf(line, from);
      expect(at, line).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  // #1061 second review — a mark is information for the reader. It does not
  // degrade the document, on any tier.
  // #1061 third panel — and it says what the names were compared with: the
  // message spoke of "the database schema" and of a database read on the
  // tiers where no database was read.
  for (const [name, inventory, what, caveat] of [
    ["live", LIVE, "the database schema", "A database read can be incomplete"],
    [
      "stored graph",
      STORED,
      "the stored schema",
      "A stored schema can be out of date, and the read it came from incomplete",
    ],
    [
      "repository SQL",
      REPO_SQL,
      "the SQL found in the repository",
      "The repository's SQL is not the database",
    ],
  ] as const) {
    it(`notes the unmatched names and leaves the document ready: ${name}`, async () => {
      const updates: Array<{ section: string; status: string; kind?: string }> = [];
      const result = await synthesizeFinalDocument(
        facts,
        meta,
        "architecture",
        "Architecture",
        router(),
        "p",
        undefined,
        (u) => updates.push({ section: u.section, status: u.status, kind: u.warning?.kind }),
        async () => context(),
        undefined,
        undefined,
        { schemaInventory: inventory },
      );
      expect(result.warnings).toEqual([
        {
          kind: "schema-unverified",
          section: "Data Architecture",
          severity: "info",
          message:
            `2 names in Data Architecture could not be matched to ${what} ` +
            `(jobs, users.error_counter). Compared with ${inventory.label}. They are marked or ` +
            "listed in the section's Schema check note; nothing was removed or changed. " +
            `${caveat}, so an unmatched name can be real.`,
        },
      ]);
      expect(deriveDocStatus(result.warnings)).toBe("ready");
      // Nothing to review: the summary a degraded document carries is empty.
      expect(summarizeWarnings(result.warnings)).toBe("");
      // And the section is reported `done`, with no warning, as it is written.
      expect(updates).toContainEqual({
        section: "Data Architecture",
        status: "done",
        kind: undefined,
      });
      expect(updates).not.toContainEqual(
        expect.objectContaining({ section: "Data Architecture", status: "degraded" }),
      );
    });
  }

  it("does not hide a real degradation of the same document", async () => {
    const result = await synth(LIVE);
    const failed = {
      kind: "section-failed" as const,
      section: "Overview",
      message: "x",
      severity: "error" as const,
    };
    expect(deriveDocStatus([...result.warnings, failed])).toBe("degraded");
    // The summary counts the failure and says nothing of the schema note.
    expect(summarizeWarnings([...result.warnings, failed])).toBe(summarizeWarnings([failed]));
  });

  it("raises no note for a type that differs or a name that was not checked", async () => {
    state.dataSection = `${ONE_ENTITY.replace("\n| `error_counter` | int | Invented |", "")}\n\n| Table | Purpose |\n|---|---|\n| \`audit.events\` | history |`;
    const result = await synth(LIVE);
    expect(result.warnings).toEqual([]);
    // Both are still said in the section itself.
    expect(result.markdown).toContain("> - Types that differ from the schema: `users.gesture_nav`");
    expect(result.markdown).toContain(
      "> - Not checked (outside the schemas that were read): `audit.events`.",
    );
  });

  it("names at most eight in the note and counts the rest", async () => {
    const rows = Array.from({ length: 11 }, (_, n) => `| \`ghost_${n}\` | int | x |`).join("\n");
    state.dataSection = `## Data Architecture\n\n### Entity: \`users\`\n\n| Field | Type | Description |\n|---|---|---|\n${rows}`;
    const result = await synth(STORED);
    const note = result.warnings.find((w) => w.kind === "schema-unverified")!;
    expect(note.message).toContain("11 names in Data Architecture could not be matched");
    expect(note.message).toContain("users.ghost_7 and 3 more).");
  });

  it("raises no note for a section that names only what exists", async () => {
    state.dataSection =
      "## Data Architecture\n\nOne database.\n\n### Data Stores\n\nPostgreSQL holds `users`.";
    const result = await synth(LIVE);
    expect(result.warnings).toEqual([]);
    expect(result.markdown).toContain("### Schema Reference");
    expect(result.markdown).not.toContain("Schema check.");
  });

  it("with a database that could not be read and nothing else: says that, not that there is none", async () => {
    const result = await synth({
      source: "none",
      label: "no schema source; 1 database(s) could not be read",
      reads: [{ connector: "miniflux-pg", how: "unread", schemas: [] }],
      tables: [],
    });
    expect(result.markdown).toContain(
      '> **Schema not verified.** The project\'s database ("miniflux-pg") could not be read, and',
    );
    expect(result.markdown).not.toContain("no connected database");
    expect(result.markdown).not.toContain("not in schema");
    expect(result.warnings).toEqual([]);
    expect(state.prompts[0]).toContain("The project has 1 database(s) that could not be read");
  });

  it("with no schema source: keeps every line the model wrote and says it was not verified", async () => {
    const result = await synth();
    expect(result.markdown).toContain(
      "> **Schema not verified.** No database schema was available",
    );
    for (const line of INVENTED.split("\n").filter(Boolean)) {
      expect(result.markdown).toContain(line);
    }
    expect(result.markdown).not.toContain("### Schema Reference");
    expect(result.markdown).not.toContain("not in schema");
    expect(result.warnings).toEqual([]);
    expect(state.prompts[0]).toContain("No database schema is available for this project.");
  });
});

// #1133 — walkthrough run 8: an invented `certificate_cache`, written as a
// PostgreSQL table twice outside Data Architecture, went unmarked.
describe("synthesizeFinalDocument — table names in the text of every section (#1133)", () => {
  const OPS = [
    "## Key Algorithms & Calculations",
    "",
    "Feeds are refreshed by priority.",
    "",
    "## Operational Considerations",
    "",
    "- **TLS:** ACME certificates are persisted through an `autocert.Cache` adapter backed by " +
      "PostgreSQL (`certificate_cache`), declared in `certificate_cache.go`.",
    "",
    "## Technology Stack",
    "",
    "- **Key tables:** `users`, `feeds` (one row per subscription), and `certificate_cache`[^src-8].",
  ].join("\n");
  const CLEAN_DATA = [
    "## Data Architecture",
    "",
    "### Tables and Their Roles",
    "",
    "| Table | Purpose | Written by |",
    "|---|---|---|",
    "| `users` | Accounts | storage |",
    "| `feeds` | Subscriptions | storage |",
  ].join("\n");

  it("marks the invented table in both sections, lists it, and records the check in provenance", async () => {
    state.dataSection = CLEAN_DATA;
    state.other["Algorithms, Operations & Stack"] = OPS;
    const result = await synth(LIVE);
    const doc = result.markdown;
    expect(doc).toContain("backed by PostgreSQL (`certificate_cache` *(not in schema)*)");
    expect(doc).toContain("and `certificate_cache` *(not in schema)*[^");
    // Code identifiers that are not tables are left alone.
    expect(doc).toContain("an `autocert.Cache` adapter");
    expect(doc).toContain("declared in `certificate_cache.go`.");
    expect(doc).not.toContain("`users` *(not in schema");
    // The Data Architecture section ran clean, and says so.
    expect(doc).toContain(
      `> **Schema check.** 2 table and column names in this section were compared with ${LIVE.label}, and every one matched.`,
    );
    const listed = result.warnings.filter((w) => w.kind === "schema-unverified");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      section: "Algorithms, Operations & Stack",
      severity: "info",
    });
    expect(listed[0].message).toContain("1 name written as a database table or column");
    expect(listed[0].message).toContain("(certificate_cache)");
    const ops = result.sections.find((s) => s.sectionLabel === "Algorithms, Operations & Stack");
    expect(ops?.schemaClaims).toEqual({
      judged: 3,
      unmatched: ["certificate_cache"],
      notChecked: 0,
    });
    const data = result.sections.find((s) => s.sectionLabel === "Data Architecture");
    expect(data?.schemaClaims).toEqual({ judged: 2, unmatched: [], notChecked: 0 });
    // Informational: the document is not degraded by it.
    expect(result.warnings.every((w) => w.severity === "info")).toBe(true);
  });

  it("checks nothing, and writes no record, when there is no schema to check against", async () => {
    state.other["Algorithms, Operations & Stack"] = OPS;
    const result = await synth();
    expect(result.markdown).not.toContain("not in schema");
    expect(result.sections.every((s) => s.schemaClaims === undefined)).toBe(true);
  });
});
