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
    expect(instructions).toContain("Only each database's default schema is read.");
    expect(instructions).toContain(
      "For the schemas it covers it is the authority for every table name",
    );
    expect(instructions).toContain(
      "- Within the schemas listed as covered, do not name a table or column that is not in the list.",
    );
    expect(instructions).toContain(
      "- The list is NOT the whole database. A table that the facts place in another schema, or " +
        "in a database marked NOT read, may be named: write it with its schema (`audit.events`), " +
        "say that its columns were not read, and list no columns for it.",
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

/** The same section without the invented table: everything in it can be repaired. */
const REPAIRABLE = INVENTED.slice(0, INVENTED.indexOf("### Entity: `jobs`")).trimEnd();

const state: { dataSection: string; prompts: string[] } = { dataSection: INVENTED, prompts: [] };
const loadConfig = vi.hoisted(() => vi.fn());
const provider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async (messages: Array<{ content: unknown }>) => {
    const judge = messages.some((m) => String(m.content).includes("strict faithfulness judge"));
    return {
      content: JSON.stringify(
        judge
          ? { verdicts: [{ claim: "Source facts.", supported: true, sourceIds: [] }] }
          : { claims: [{ claim: "Source facts.", sourceIds: [] }] },
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
      } else {
        yield { type: "delta", content: `## ${label}\n\nSource facts.` };
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

  it("reuses a section whose findings were all repaired, while the schema is unchanged", async () => {
    state.dataSection = REPAIRABLE;
    const cold = await run(LIVE);
    // The record holds what the reader saw: the checked section, no warning.
    expect(dataRecord(cold)?.markdown).toContain("### Schema Reference");
    expect(dataRecord(cold)?.markdown).not.toContain("| `error_counter`");
    expect(dataRecord(cold)?.warnings).toEqual([]);

    state.prompts = [];
    const warm = await run({ ...LIVE, tables: [...TABLES] }, cold);
    expect(state.prompts).toEqual([]);
    expect(warm.regeneration).toEqual({ mode: "unchanged", changed: [] });
    expect(warm.markdown).toBe(cold.markdown);
    expect(warm.warnings).toEqual([]);
  });

  // #1061 review — reused, a section with unmatched names carried its marks and
  // its warning into every later run for as long as the schema was unchanged.
  it("writes a section left with unmatched names again, and only that section", async () => {
    const cold = await run(LIVE);
    expect(cold.warnings.map((w) => w.kind)).toEqual(["schema-unverified"]);
    // Its record is stored, so the snapshot is complete and the rest is reused.
    expect(dataRecord(cold)?.warnings.map((w) => w.kind)).toEqual(["schema-unverified"]);
    expect(cold.sectionSynthesis?.records).toHaveLength(5);

    // Same schema, same everything, and the model writes the same thing: the
    // section is written again (one call), and the warning is still true.
    state.prompts = [];
    const same = await run(LIVE, cold);
    expect(state.prompts).toHaveLength(1);
    expect(same.regeneration).toMatchObject({ mode: "sections", changed: ["data-architecture"] });
    expect(same.warnings.map((w) => w.kind)).toEqual(["schema-unverified"]);

    // The route back to a clean document: this time the model names only what
    // exists. One section is written, the warning is gone, and from then on the
    // section is reused like any other.
    state.prompts = [];
    state.dataSection = "## Data Architecture\n\nOne PostgreSQL database holding `users`.";
    const clean = await run(LIVE, same);
    expect(state.prompts).toHaveLength(1);
    expect(clean.warnings).toEqual([]);
    expect(clean.markdown).not.toContain("Not in the schema");
    expect(dataRecord(clean)?.warnings).toEqual([]);
    state.prompts = [];
    const settled = await run(LIVE, clean);
    expect(state.prompts).toEqual([]);
    expect(settled.regeneration).toEqual({ mode: "unchanged", changed: [] });
  });

  it("rewrites only that section when the schema changes", async () => {
    state.dataSection = REPAIRABLE;
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
    // The column now exists, so the row the model wrote is kept.
    expect(warm.markdown).toContain("| `error_counter` | int | Invented |");
  });
});

describe("synthesizeFinalDocument — Data Architecture is checked against the schema (#1061)", () => {
  it("sends the schema to the model in the section's prompt", async () => {
    await synth(LIVE);
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]).toContain("- users: id integer PK, gesture_nav text");
  });

  it("removes the invented column, marks the invented table, and renders the reference", async () => {
    const result = await synth(LIVE);
    const doc = result.markdown;
    expect(doc).not.toContain("error_counter` | int");
    expect(doc).toContain("| `gesture_nav` | bool *(schema: `text`)* | Gesture navigation |");
    expect(doc).toContain("> **Not in the schema:** `jobs` is not a table in the live schema");
    expect(doc).toContain("### Schema Reference");
    expect(doc).toContain("| gesture_nav | text |  |");
    expect(doc).toContain('feeds }o--|| users : "feeds_user_id_fkey"');
    expect(doc).toContain(
      '> **Schema check.** The tables and columns in this section were checked against the live schema of "miniflux-pg" (public).',
    );
    // One Data Architecture section, in its place.
    expect(doc.match(/^## Data Architecture$/gm)).toHaveLength(1);
    expect(doc.indexOf("## Component Breakdown")).toBeLessThan(doc.indexOf("## Data Architecture"));
  });

  it("warns about the names it could not match, and only those", async () => {
    const result = await synth(LIVE);
    const schemaWarnings = result.warnings.filter((w) => w.kind === "schema-unverified");
    expect(schemaWarnings).toHaveLength(1);
    // `jobs` is still in the section, marked. The removed column and the
    // annotated type were repaired and are not in the warning.
    expect(schemaWarnings[0]).toEqual({
      kind: "schema-unverified",
      section: "Data Architecture",
      severity: "warning",
      message:
        'Section "Data Architecture": 1 name could not be matched to the database schema (jobs). ' +
        'Checked against the live schema of "miniflux-pg" (public). Each is marked in the ' +
        "section and none was removed; a table in a schema or database that was not read can be real.",
    });
    expect(deriveDocStatus(result.warnings)).toBe("degraded");
    expect(summarizeWarnings(result.warnings)).toBe(
      "Needs review — 1 section(s) name tables or columns that could not be matched to the " +
        "database schema (marked in the section).",
    );
  });

  // #1061 review — a finding that was repaired is no longer in the document.
  it("does not degrade the document when every finding was repaired", async () => {
    state.dataSection = REPAIRABLE;
    const updates: Array<{ section: string; status: string }> = [];
    const result = await synthesizeFinalDocument(
      facts,
      meta,
      "architecture",
      "Architecture",
      router(),
      "p",
      undefined,
      (u) => updates.push({ section: u.section, status: u.status }),
      async () => context(),
      undefined,
      undefined,
      { schemaInventory: LIVE },
    );
    // The repairs happened, and the section says so itself.
    expect(result.markdown).not.toContain("error_counter` | int");
    expect(result.markdown).toContain("| `gesture_nav` | bool *(schema: `text`)* |");
    expect(result.markdown).toContain(
      "> - Removed, because the table has no such column: `users.error_counter`.",
    );
    expect(result.markdown).toContain("> - Types that differ from the schema: `users.gesture_nav`");
    // No warning, a clean document, and a section reported `done`.
    expect(result.warnings).toEqual([]);
    expect(deriveDocStatus(result.warnings)).toBe("ready");
    expect(updates).toContainEqual({ section: "Data Architecture", status: "done" });
    expect(updates).not.toContainEqual({ section: "Data Architecture", status: "degraded" });
  });

  it("marks instead of removing when the schema was not read live", async () => {
    const result = await synth(STORED);
    expect(result.markdown).toContain("| `error_counter` *(not in schema)* | int | Invented |");
    const warning = result.warnings.find((w) => w.kind === "schema-unverified")!;
    expect(warning.message).toContain(
      "2 names could not be matched to the database schema (jobs, users.error_counter).",
    );
    expect(warning.message).toContain("none was removed");
  });

  it("names at most eight in the warning and counts the rest", async () => {
    const rows = Array.from({ length: 11 }, (_, n) => `| \`ghost_${n}\` | int | x |`).join("\n");
    state.dataSection = `## Data Architecture\n\n### Entity: \`users\`\n\n| Field | Type | Description |\n|---|---|---|\n${rows}`;
    const result = await synth(STORED);
    const warning = result.warnings.find((w) => w.kind === "schema-unverified")!;
    expect(warning.message).toContain("11 names could not be matched");
    expect(warning.message).toContain("users.ghost_7 and 3 more).");
  });

  it("raises no warning for a section that names only what exists", async () => {
    state.dataSection =
      "## Data Architecture\n\nOne database.\n\n### Data Stores\n\nPostgreSQL holds `users`.";
    const result = await synth(LIVE);
    expect(result.warnings.filter((w) => w.kind === "schema-unverified")).toEqual([]);
    expect(result.markdown).toContain("### Schema Reference");
    expect(result.markdown).not.toContain("Schema check.");
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
    // Nothing to check against is not a degradation.
    expect(result.warnings.filter((w) => w.kind === "schema-unverified")).toEqual([]);
    expect(state.prompts[0]).toContain("No database schema is available for this project.");
  });

  it("reports the section live as degraded when the check found something", async () => {
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
      undefined,
      { schemaInventory: LIVE },
    );
    expect(updates).toContainEqual({
      section: "Data Architecture",
      status: "degraded",
      kind: "schema-unverified",
    });
  });
});
