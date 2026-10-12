/**
 * #1061 — the deterministic check on the Data Architecture section.
 *
 * The fixture is a cut-down Miniflux schema and a section carrying the eight
 * inventions the issue lists from walkthrough run 7, so each one is pinned by
 * name: caught, and handled the way the module's header says.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  applySchemaGrounding,
  checkSchemaClaims,
  codeSpans,
  parseHeading,
  renderSchemaCheckNotice,
  schemaCheckFindings,
  schemaCheckUnmatched,
  splitCells,
  typeFamily,
  typesDisagree,
} from "./schema-claim-check.js";
import {
  NO_SCHEMA_INVENTORY,
  type SchemaInventory,
  type SchemaInventoryTable,
} from "./schema-inventory.js";

function table(
  name: string,
  columns: Record<string, string>,
  where: { schema?: string; read?: number } = {},
): SchemaInventoryTable {
  return {
    schema: where.schema ?? "public",
    read: where.read ?? 0,
    name,
    columns: Object.entries(columns).map(([column, dataType]) => ({
      name: column,
      dataType,
      nullable: true,
      isPrimaryKey: column === "id",
      isForeignKey: column.endsWith("_id"),
    })),
    foreignKeys: [],
  };
}

const TABLES = [
  table("users", { id: "integer", username: "text", gesture_nav: "text", is_admin: "boolean" }),
  table("feeds", { id: "bigint", user_id: "integer", parsing_error_count: "integer" }),
  table("entries", { id: "bigint", feed_id: "bigint", status: "USER-DEFINED", tags: "ARRAY" }),
  table("acme_cache", { key: "character varying", data: "bytea" }),
  table("integrations", {
    user_id: "integer",
    fever_username: "text",
    googlereader_username: "text",
    googlereader_password: "text",
    rssbridge_enabled: "boolean",
  }),
];

/** An inventory read live: `reads[n]` is connector `n`, with the schemas it returned. */
function liveInventory(
  tables: SchemaInventoryTable[],
  reads: SchemaInventory["reads"] = [
    { connector: "miniflux-pg", how: "live", schemas: ["public"] },
  ],
): SchemaInventory {
  return { source: "live-schema", label: 'the live schema of "miniflux-pg"', reads, tables };
}

/** The one database, its `public` schema introspected in this run: columns may be removed. */
const LIVE = liveInventory(TABLES);
/** A stored graph: it may be out of date, so nothing is removed. */
const STORED: SchemaInventory = {
  ...LIVE,
  source: "schema-graph",
  reads: [{ connector: "miniflux-pg", how: "stored", schemas: ["public"] }],
};
/** Names from repository SQL: no types, and no database was read. */
const REPO_SQL: SchemaInventory = {
  source: "repository-sql",
  label: "the SQL found in the repository",
  reads: [],
  tables: TABLES.map(({ read: _read, ...t }) => ({
    ...t,
    columns: t.columns.map((c) => ({ ...c, dataType: "" })),
  })),
};

const RUN7 = `## Data Architecture

Miniflux persists to PostgreSQL.

\`\`\`mermaid
erDiagram
    USERS ||--o{ FEEDS : subscribes
    FEEDS ||--o{ ENTRIES : publishes
    ENTRIES ||--o{ ENTRY_TAGS : carries
    FEEDS ||--o{ JOBS : queued_for
\`\`\`

### Entity: \`users\`

| Field | Type | Constraint | Description |
|---|---|---|---|
| \`id\` | int64 | PK | User identifier |
| \`username\` | string | unique | Login name |
| \`gesture_nav\` | bool | — | Gesture navigation |

### Entity: \`feeds\`

| Field | Type | Constraint | Description |
|---|---|---|---|
| \`id\` | int64 | PK | Feed identifier |
| \`user_id\` | int64 | FK → \`users.id\` | Owner |
| \`error_counter\` | int | — | Consecutive polling errors |

### Entity: \`entries\`

| Field | Type | Constraint | Description |
|---|---|---|---|
| \`id\` | int64 | PK | Entry identifier |
| \`category_id\` | int64 | FK → \`categories.id\` | Denormalised |

### Entity: \`jobs\` (feed-refresh queue table)

| Field | Type | Constraint | Description |
|---|---|---|---|
| feed reference | int64 | FK → \`feeds.id\` | Feed to refresh |

### Entity: \`certificate_cache\` (ACME)

| Field | Type | Constraint | Description |
|---|---|---|---|
| — | — | — | A SQL-backed store for ACME TLS material |

### Entity: \`integrations\` (per-user settings)

| Field | Type | Constraint | Description |
|---|---|---|---|
| \`user_id\` | int64 | PK/FK → \`users.id\` | One row per user |
| \`fever_username\` / \`fever_password\` | string | — | Legacy Fever credentials |
| \`google_reader_username\` / \`google_reader_password\` | string | — | Legacy GReader credentials |
| \`rss_bridge_enabled\` | bool | — | Enables RSS-Bridge discovery |

### Data Stores

| Store | Technology | Role |
|---|---|---|
| Job queue | In-process Go channel (\`queue chan model.Job\`) | Feed-refresh dispatch |
`;

describe("checkSchemaClaims — the eight inventions of run 7 (#1061)", () => {
  const live = checkSchemaClaims(RUN7, LIVE);

  it("marks a table that does not exist, in the diagram and under its heading", () => {
    expect(live.report.unresolvedTables).toEqual([
      "ENTRY_TAGS",
      "JOBS",
      "jobs",
      "certificate_cache",
    ]);
    expect(live.markdown).toContain(
      "> **Not in the schema:** in the diagram above, `ENTRY_TAGS`, `JOBS` are not tables",
    );
    expect(live.markdown).toContain("> **Not in the schema:** `jobs` is not a table");
    expect(live.markdown).toContain("> **Not in the schema:** `certificate_cache` is not a table");
  });

  it("never guesses a table: `certificate_cache` is not rewritten to `acme_cache`", () => {
    expect(live.markdown).toContain("### Entity: `certificate_cache` (ACME)");
    expect(live.markdown).not.toContain("### Entity: `acme_cache`");
  });

  it("keeps the diagram and the entity blocks: a table-level name is never removed", () => {
    expect(live.markdown).toContain("ENTRIES ||--o{ ENTRY_TAGS : carries");
    expect(live.markdown).toContain(
      "| feed reference | int64 | FK → `feeds.id` | Feed to refresh |",
    );
    expect(live.markdown).toContain("A SQL-backed store for ACME TLS material");
  });

  it("removes a column its table does not have, when the schema was read live", () => {
    expect(live.report.removedColumns).toEqual([
      "feeds.error_counter",
      "entries.category_id",
      "integrations.fever_password",
    ]);
    expect(live.markdown).not.toContain("error_counter");
    expect(live.markdown).not.toContain("`category_id`");
    // Only the invented name leaves a shared cell.
    expect(live.markdown).toContain("| `fever_username` | string | — | Legacy Fever credentials |");
  });

  it("corrects a spelling that differs only by underscores, and nothing else", () => {
    expect(live.report.corrected).toEqual([
      {
        from: "integrations.google_reader_username",
        to: "integrations.googlereader_username",
      },
      {
        from: "integrations.google_reader_password",
        to: "integrations.googlereader_password",
      },
      { from: "integrations.rss_bridge_enabled", to: "integrations.rssbridge_enabled" },
    ]);
    expect(live.markdown).toContain("| `googlereader_username` / `googlereader_password` |");
    expect(live.markdown).toContain("| `rssbridge_enabled` | bool |");
  });

  it("annotates a type the schema contradicts", () => {
    expect(live.report.typeMismatches).toEqual([
      { column: "users.gesture_nav", written: "bool", schema: "text" },
    ]);
    expect(live.markdown).toContain("| `gesture_nav` | bool *(schema: `text`)* |");
  });

  it("flags nothing that is real", () => {
    for (const real of ["`id` | int64", "`username` | string", "`user_id` | int64"]) {
      expect(live.markdown).toContain(real);
    }
    expect(live.markdown).toContain("Job queue | In-process Go channel (`queue chan model.Job`)");
  });
});

describe("checkSchemaClaims — a schema that was not read live", () => {
  const stored = checkSchemaClaims(RUN7, STORED);

  it("marks instead of removing: the stored graph may be out of date", () => {
    expect(stored.report.removedColumns).toEqual([]);
    expect(stored.report.corrected).toEqual([]);
    expect(stored.report.flaggedColumns).toEqual([
      "feeds.error_counter",
      "entries.category_id",
      "integrations.fever_password",
      "integrations.google_reader_username",
      "integrations.google_reader_password",
      "integrations.rss_bridge_enabled",
    ]);
    expect(stored.markdown).toContain("| `error_counter` *(not in schema)* | int |");
    expect(stored.markdown).toContain("`fever_username` / `fever_password` *(not in schema)*");
  });

  it("suggests the schema's spelling without writing it in", () => {
    expect(stored.markdown).toContain(
      "`google_reader_username` *(not in schema; the schema has `googlereader_username`)* / " +
        "`google_reader_password` *(not in schema; the schema has `googlereader_password`)*",
    );
  });

  it("still reports the type, which a stored graph does carry", () => {
    expect(stored.report.typeMismatches).toHaveLength(1);
  });

  it("checks names but not types against repository SQL, which has none", () => {
    const repo = checkSchemaClaims(RUN7, REPO_SQL);
    expect(repo.report.typeMismatches).toEqual([]);
    expect(repo.report.flaggedColumns).toEqual(stored.report.flaggedColumns);
    expect(repo.report.removedColumns).toEqual([]);
  });

  it("is idempotent: a marked name is not marked twice", () => {
    const again = checkSchemaClaims(stored.markdown, STORED);
    expect(again.markdown).toBe(stored.markdown);
  });
});

describe("checkSchemaClaims — no schema to check against", () => {
  it("changes nothing and reports nothing when there is no inventory", () => {
    const result = checkSchemaClaims(RUN7, NO_SCHEMA_INVENTORY);
    expect(result.markdown).toBe(RUN7);
    expect(result.report.checked).toBe(false);
    expect(schemaCheckFindings(result.report)).toBe(0);
  });

  it("changes nothing when a live schema came back empty", () => {
    const empty: SchemaInventory = { ...LIVE, tables: [] };
    const result = checkSchemaClaims(RUN7, empty);
    expect(result.markdown).toBe(RUN7);
    expect(result.report.removedColumns).toEqual([]);
  });

  it("says so at the top of the section instead of inventing a verdict", () => {
    const { markdown, report } = applySchemaGrounding(RUN7, NO_SCHEMA_INVENTORY);
    expect(report.checked).toBe(false);
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("## Data Architecture");
    expect(lines[2]).toMatch(/^> \*\*Schema not verified\.\*\* No database schema was available/);
    // Everything the model wrote is still there.
    expect(markdown.replace(`\n${lines[2]}\n`, "")).toBe(RUN7);
    expect(markdown).not.toContain("### Schema Reference");
  });
});

describe("checkSchemaClaims — what is NOT a claim", () => {
  const check = (markdown: string) => checkSchemaClaims(markdown, LIVE);
  const untouched = (markdown: string) => {
    const result = check(markdown);
    expect(result.markdown).toBe(markdown);
    expect(schemaCheckFindings(result.report)).toBe(0);
  };

  it("prose naming a queue, a cache, a struct or an index", () => {
    untouched(
      "## Data Architecture\n\nJobs wait in the `jobs` queue, a `session_cache` in Redis, the " +
        "`Job` struct and the `entries_feed_idx` index. `entries.length` is read in a loop.",
    );
  });

  it("a table that is not a field table", () => {
    untouched(
      "### Data Stores\n\n| Store | Technology |\n|---|---|\n| `job_queue` | Go channel |\n" +
        "| `redis` | cache |",
    );
  });

  it("a struct documented under an unlabelled heading, even one named like a table", () => {
    untouched(
      "#### `Job` struct\n\n| Field | Type |\n|---|---|\n| `FeedID` | int64 |\n| `UserID` | int64 |",
    );
    // `Feed` would resolve to `feeds`; its `Entries` field is not a column, and
    // against a live schema a column that does not resolve is removed.
    untouched(
      "#### `Feed` struct\n\n| Field | Type |\n|---|---|\n| `ID` | int64 |\n| `Entries` | []Entry |",
    );
    untouched("#### `users`\n\n| Column | Type |\n|---|---|\n| `ghost` | int |");
    untouched("### Users\n\n| Field | Type |\n|---|---|\n| `users.ghost` | int |");
  });

  it("a field table under a sub-heading of an entity", () => {
    untouched(
      "### Entity: `users`\n\nThe account table.\n\n#### The `User` struct\n\n" +
        "| Field | Type |\n|---|---|\n| `Feeds` | []Feed |",
    );
  });

  it("an object path whose head is the singular of a table", () => {
    untouched(
      "### Entity: `users`\n\n| Field | Type | Constraint |\n|---|---|---|\n" +
        "| `user.posts` | list | see `feed.entries` |",
    );
  });

  it("a topic heading with a field table under it", () => {
    untouched("### Overview\n\n| Field | Type |\n|---|---|\n| `whatever` | string |");
  });

  it("a row whose first cell is not a name", () => {
    untouched(
      "### Entity: `users`\n\n| Field | Type |\n|---|---|\n| service flags and tokens | bool |",
    );
  });

  it("a qualified name whose qualifier is not a table", () => {
    untouched("### Entity: `users`\n\n| Field | Type |\n|---|---|\n| `model.Themes` | string |");
  });

  it("an erDiagram inside a non-mermaid fence, and other diagrams", () => {
    untouched("```text\nerDiagram\n    GHOSTS ||--o{ USERS : haunt\n```");
    untouched("```mermaid\ngraph LR\n    Ghosts --> Users\n```");
  });

  it("a singular entity name for a plural table", () => {
    untouched(
      "```mermaid\nerDiagram\n    USER ||--o{ FEED : subscribes\n    FEED ||--o{ ENTRY : has\n```",
    );
  });

  it("types that differ by design: a boolean in an integer, a time as text", () => {
    expect(typesDisagree("bool", "integer")).toBe(false);
    expect(typesDisagree("timestamp", "text")).toBe(false);
    expect(typesDisagree("JSON blob", "bytea")).toBe(false);
    expect(typesDisagree("string list", "ARRAY")).toBe(false);
    expect(typesDisagree("string", "USER-DEFINED")).toBe(false);
    expect(typesDisagree("bool", "tinyint(1)")).toBe(false);
  });
});

describe("checkSchemaClaims — structures", () => {
  it("marks a name that is no table in a table of tables, and removes nothing", () => {
    const roster =
      "### Tables and Their Roles\n\n| Table | Purpose |\n|---|---|\n| `users` | Accounts |\n" +
      "| `jobs` | Refresh queue |\n| The scheduler | Not a name |";
    for (const inventory of [LIVE, STORED]) {
      const { report, markdown } = checkSchemaClaims(roster, inventory);
      expect(report.unresolvedTables).toEqual(["jobs"]);
      expect(markdown).toContain("| `jobs` *(not in schema)* | Refresh queue |");
      expect(markdown).toContain("| `users` | Accounts |");
      expect(markdown).toContain("| The scheduler | Not a name |");
    }
  });

  it("reads attribute lines of an entity block", () => {
    const diagram =
      "```mermaid\nerDiagram\n    USERS {\n        int id PK\n        bool gesture_nav\n" +
      "        string ghost\n    }\n    GHOSTS {\n        int id\n    }\n```";
    const live = checkSchemaClaims(diagram, LIVE);
    expect(live.report.removedColumns).toEqual(["users.ghost"]);
    expect(live.report.unresolvedTables).toEqual(["GHOSTS"]);
    expect(live.markdown).not.toContain("string ghost");
    // The schema's type is written in: the column resolved exactly.
    expect(live.markdown).toContain("        text gesture_nav");
    // An unresolved entity's attributes are left alone.
    expect(live.markdown).toContain("    GHOSTS {\n        int id\n    }");

    const stored = checkSchemaClaims(diagram, STORED);
    expect(stored.markdown).toContain("string ghost");
    expect(stored.markdown).toContain("bool gesture_nav");
    expect(stored.markdown).toContain(
      '> **Not in the schema:** the diagram above shows `users.ghost`, which the live schema of "miniflux-pg" does not hold.',
    );
  });

  it("corrects a near miss in a diagram only against a live schema", () => {
    const diagram =
      "```mermaid\nerDiagram\n    INTEGRATIONS {\n        string google_reader_username\n    }\n```";
    expect(checkSchemaClaims(diagram, LIVE).markdown).toContain("string googlereader_username");
    const stored = checkSchemaClaims(diagram, STORED);
    expect(stored.markdown).toContain("string google_reader_username");
    expect(stored.report.flaggedColumns).toEqual(["integrations.google_reader_username"]);
  });

  it("checks qualified rows under a heading that names several tables", () => {
    const section =
      "### Entities: `users` and `feeds`\n\n| Field | Type |\n|---|---|\n| `users.id` | int |\n" +
      "| `feeds.ghost` | int |\n| `username` | string |\n| `nothing_here` | string |";
    const { report, markdown } = checkSchemaClaims(section, LIVE);
    // `feeds.ghost` names its table. A bare name under two tables does not, so
    // it is in neither and is marked, not removed.
    expect(report.removedColumns).toEqual(["feeds.ghost"]);
    expect(report.flaggedColumns).toEqual(["users.nothing_here"]);
    expect(markdown).toContain("| `nothing_here` *(not in schema)* | string |");
    expect(markdown).toContain("| `username` | string |");
  });

  it("does not judge bare rows when the heading also names something unknown", () => {
    const section =
      "### Entities: `users` and `ghosts`\n\n| Field | Type |\n|---|---|\n| `spooky` | int |\n" +
      "| `users.spooky` | int |";
    const { report, markdown } = checkSchemaClaims(section, LIVE);
    expect(report.unresolvedTables).toEqual(["ghosts"]);
    expect(markdown).toContain("| `spooky` | int |");
    expect(report.removedColumns).toEqual(["users.spooky"]);
  });

  it("marks an invented FK target and leaves the row in place", () => {
    const section =
      "### Entity: `feeds`\n\n| Field | Type | Constraint |\n|---|---|---|\n" +
      "| `user_id` | int | FK → `users.ghost_id` |";
    const { report, markdown } = checkSchemaClaims(section, LIVE);
    expect(report.flaggedColumns).toEqual(["users.ghost_id"]);
    expect(report.removedColumns).toEqual([]);
    expect(markdown).toContain("| `user_id` | int | FK → `users.ghost_id` *(not in schema)* |");
  });

  it("aligns slash-separated types with slash-separated names", () => {
    const section =
      "### Entity: `users`\n\n| Field | Type |\n|---|---|\n| `is_admin` / `gesture_nav` | bool/bool |\n" +
      "| `username` / `ghost` | string/int |";
    const { report, markdown } = checkSchemaClaims(section, LIVE);
    expect(report.typeMismatches).toEqual([
      { column: "users.gesture_nav", written: "bool", schema: "text" },
    ]);
    expect(markdown).toContain("bool/bool *(schema: `gesture_nav` is `text`)*");
    expect(markdown).toContain("| `username` | string |");
  });

  it("leaves an unclosed fence and a table at the end of the text intact", () => {
    const open = "```mermaid\nerDiagram\n    GHOSTS ||--o{ USERS : haunt";
    expect(checkSchemaClaims(open, LIVE).markdown.startsWith(open)).toBe(true);
    const tail = "### Entity: `users`\n\n| Field | Type |\n|---|---|";
    expect(checkSchemaClaims(tail, LIVE).markdown).toBe(tail);
  });
});

describe("parsing helpers", () => {
  it("parseHeading reads names only from a labelled heading", () => {
    expect(parseHeading("### Entity: `jobs` (feed-refresh queue table)")).toEqual({
      names: ["jobs"],
    });
    expect(parseHeading("### Entities: `icons` and `feed_icons`")).toEqual({
      names: ["icons", "feed_icons"],
    });
    expect(parseHeading("### Tables: users, feeds and entries")).toEqual({
      names: ["users", "feeds", "entries"],
    });
    expect(parseHeading("#### table: public.users")).toEqual({ names: ["public.users"] });
    for (const other of [
      "#### `users`",
      "### Sessions",
      "#### `Feed` struct",
      "### Data Stores and Selection Rationale",
      "### Entity: the job queue, briefly described here",
      "### Entity:",
    ]) {
      expect(parseHeading(other)).toEqual({ names: [] });
    }
    expect(parseHeading("# Title")).toBeNull();
    expect(parseHeading("####### too deep")).toBeNull();
    expect(parseHeading("#hashtag")).toBeNull();
    expect(parseHeading("plain text")).toBeNull();
  });

  it("splitCells honours an escaped pipe; codeSpans ignores an unclosed span", () => {
    expect(splitCells("| a \\| b | c |").map((cell) => cell.text)).toEqual([" a \\| b ", " c "]);
    expect(splitCells("no table here")).toEqual([]);
    expect(codeSpans("`a` and `b.c` and `open")).toEqual(["a", "b.c"]);
  });

  it("typeFamily reads model and database spellings", () => {
    expect(typeFamily("int64")).toBe("number");
    expect(typeFamily("*int64")).toBe("number");
    expect(typeFamily("uint32")).toBe("number");
    expect(typeFamily("numeric(10,2)")).toBe("number");
    expect(typeFamily("character varying(255)")).toBe("text");
    expect(typeFamily("timestamp with time zone")).toBe("temporal");
    expect(typeFamily("[]byte")).toBe("binary");
    expect(typeFamily("bytea")).toBe("binary");
    expect(typeFamily("jsonb")).toBe("json");
    expect(typeFamily("boolean")).toBe("boolean");
    for (const unknown of ["", "—", "ARRAY", "text[]", "_text", "USER-DEFINED", "tinyint", "x9"]) {
      expect(typeFamily(unknown)).toBeNull();
    }
    expect(typesDisagree("int", "text")).toBe(true);
    expect(typesDisagree("bool", "text")).toBe(true);
    expect(typesDisagree("string", "bytea")).toBe(true);
  });
});

describe("applySchemaGrounding", () => {
  it("puts the notice under the heading and the reference before the first sub-section", () => {
    const { markdown } = applySchemaGrounding(RUN7, LIVE);
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("## Data Architecture");
    expect(lines[2]).toBe(
      '> **Schema check.** The tables and columns in this section were checked against the live schema of "miniflux-pg".',
    );
    const reference = markdown.indexOf("### Schema Reference");
    expect(reference).toBeGreaterThan(markdown.indexOf("FEEDS ||--o{ JOBS"));
    expect(reference).toBeLessThan(markdown.indexOf("### Entity: `users`"));
    expect(markdown).toContain("#### `acme_cache`");
    expect(markdown).toContain("| key | character varying |");
  });

  it("lists every kind of finding in the notice", () => {
    const { report } = checkSchemaClaims(RUN7, LIVE);
    const notice = renderSchemaCheckNotice(report, LIVE);
    expect(notice).toContain("> - Named as tables but not in the schema: `ENTRY_TAGS`, `JOBS`");
    expect(notice).toContain(
      "> - Removed, because the table has no such column: `feeds.error_counter`",
    );
    expect(notice).toContain(
      "> - Types that differ from the schema: `users.gesture_nav` (written `bool`, schema `text`).",
    );
    expect(notice).toContain(
      "> - Spelling corrected to the schema's: `integrations.google_reader_username`",
    );
    const stored = renderSchemaCheckNotice(checkSchemaClaims(RUN7, STORED).report, STORED);
    expect(stored).toContain("> - Columns not found in the schema: `feeds.error_counter`");
  });

  it("adds the reference and no notice to a section with nothing wrong", () => {
    const clean = "## Data Architecture\n\nOne store.\n\n### Data Stores\n\nPostgreSQL.";
    const { markdown, report } = applySchemaGrounding(clean, LIVE);
    expect(schemaCheckFindings(report)).toBe(0);
    expect(markdown).not.toContain("Schema check.");
    expect(markdown.indexOf("### Schema Reference")).toBeLessThan(
      markdown.indexOf("### Data Stores"),
    );
  });

  it("appends the reference when there is no sub-section, and copes with no heading", () => {
    const flat = applySchemaGrounding("## Data Architecture\n\nOne store.", LIVE).markdown;
    expect(flat.startsWith("## Data Architecture\n\nOne store.\n\n### Schema Reference")).toBe(
      true,
    );
    expect(flat.endsWith("| rssbridge_enabled | boolean |  |")).toBe(true);
    const bare = applySchemaGrounding("One store.", NO_SCHEMA_INVENTORY).markdown;
    expect(bare.startsWith("> **Schema not verified.**")).toBe(true);
    expect(bare.endsWith("One store.")).toBe(true);
  });

  it("leaves a clean section alone against names-only repository SQL", () => {
    const clean = "## Data Architecture\n\nOne store.";
    expect(applySchemaGrounding(clean, REPO_SQL).markdown).toBe(clean);
  });

  it("does not take a `###` inside a code fence for a sub-section", () => {
    const fenced =
      "## Data Architecture\n\n```text\n### not a heading\n```\n\n### Data Stores\n\nPostgreSQL.";
    const { markdown } = applySchemaGrounding(fenced, LIVE);
    expect(markdown.indexOf("### Schema Reference")).toBeGreaterThan(
      markdown.indexOf("### not a heading"),
    );
  });

  it("caps how many names a note lists", () => {
    const rows = Array.from({ length: 20 }, (_, n) => `| \`ghost_${n}\` | int |`).join("\n");
    const section = `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n${rows}`;
    const { report } = checkSchemaClaims(section, LIVE);
    expect(report.removedColumns).toHaveLength(20);
    expect(renderSchemaCheckNotice(report, LIVE)).toContain("`users.ghost_11` and 8 more.");
  });
});

/**
 * "Read live" does not mean "read completely" (#1061 review, blocking). The
 * fixtures above have one connector and one schema, which is the one case where
 * the two are the same thing; these do not.
 */
describe("checkSchemaClaims — what the read proves decides what may be removed", () => {
  const USERS_COLUMNS = { id: "text", email: "text" };
  const entity = (name: string, rows: string[]): string =>
    `### Entity: \`${name}\`\n\n| Field | Type |\n|---|---|\n` +
    rows.map((row) => `| \`${row}\` | text |`).join("\n");
  const untouched = (markdown: string, inventory: SchemaInventory): void => {
    const checked = checkSchemaClaims(markdown, inventory);
    expect(checked.markdown).toBe(markdown);
    expect(schemaCheckFindings(checked.report)).toBe(0);
    // Nothing in the report, so the section carries no "Schema check" note.
    expect(renderSchemaCheckNotice(checked.report, inventory)).toBe("");
  };

  it("an empty result beside a non-empty one: the invented column is marked, not removed", () => {
    // Connector B answered with no tables (what a role without grants gets), so
    // it is unread. `users.ghost` may be B's, and nothing proves otherwise.
    const partial = liveInventory(
      [table("users", USERS_COLUMNS)],
      [
        { connector: "A", how: "live", schemas: ["public"] },
        { connector: "B", how: "unread", schemas: [] },
      ],
    );
    const { report, markdown } = checkSchemaClaims(entity("users", ["id", "ghost"]), partial);
    expect(report.removedColumns).toEqual([]);
    expect(report.flaggedColumns).toEqual(["users.ghost"]);
    expect(markdown).toContain("| `ghost` *(not in schema)* | text |");
    // The same section against A alone, fully read: now it is proven.
    const whole = liveInventory([table("users", USERS_COLUMNS)]);
    expect(
      checkSchemaClaims(entity("users", ["id", "ghost"]), whole).report.removedColumns,
    ).toEqual(["users.ghost"]);
  });

  it("a database known only from a stored graph beside a live one: marked, not removed", () => {
    const mixed: SchemaInventory = {
      ...liveInventory(
        [table("users", USERS_COLUMNS), table("orders", { id: "integer" }, { read: 1 })],
        [
          { connector: "A", how: "live", schemas: ["public"] },
          { connector: "B", how: "stored", schemas: ["public"] },
        ],
      ),
      source: "schema-graph",
    };
    const { report } = checkSchemaClaims(entity("users", ["ghost"]), mixed);
    expect(report.removedColumns).toEqual([]);
    expect(report.flaggedColumns).toEqual(["users.ghost"]);
  });

  it("a table whose own schema is not in what its connector returned is not live", () => {
    // The read record says `public` was read; a table claiming `audit` under
    // that read was not proven by it.
    const odd = liveInventory([table("users", USERS_COLUMNS, { schema: "audit" })]);
    const { report } = checkSchemaClaims(entity("users", ["ghost"]), odd);
    expect(report.removedColumns).toEqual([]);
    expect(report.flaggedColumns).toEqual(["users.ghost"]);
  });

  describe("two schemas with a same-named table, both read", () => {
    const both = liveInventory(
      [
        table("users", USERS_COLUMNS),
        table("users", { id: "text", actor_ip: "text" }, { schema: "audit" }),
      ],
      [{ connector: "A", how: "live", schemas: ["audit", "public"] }],
    );

    it("an unqualified name is ambiguous: judged against both, marked at most", () => {
      const { report, markdown } = checkSchemaClaims(
        entity("users", ["email", "actor_ip", "ghost"]),
        both,
      );
      // `email` is public.users', `actor_ip` is audit.users': both are real.
      expect(markdown).toContain("| `email` | text |");
      expect(markdown).toContain("| `actor_ip` | text |");
      expect(report.removedColumns).toEqual([]);
      expect(report.flaggedColumns).toEqual(["users.ghost"]);
    });

    it("a qualified name is resolved in its own schema only", () => {
      // The reproduction from the review: `audit.users.actor_ip` is real and
      // was removed, because the prefix was dropped and `public.users` judged.
      const audit = checkSchemaClaims(entity("audit.users", ["id", "actor_ip"]), both);
      expect(audit.markdown).toBe(entity("audit.users", ["id", "actor_ip"]));
      expect(schemaCheckFindings(audit.report)).toBe(0);
      // And the other way: `actor_ip` is NOT a column of `public.users`.
      const pub = checkSchemaClaims(entity("public.users", ["id", "actor_ip"]), both);
      expect(pub.report.removedColumns).toEqual(["users.actor_ip"]);
      expect(pub.markdown).not.toContain("actor_ip");
    });

    it("a qualified name in a schema that WAS read, and is not there, is marked", () => {
      const { report, markdown } = checkSchemaClaims(entity("audit.ghosts", ["id"]), both);
      expect(report.unresolvedTables).toEqual(["audit.ghosts"]);
      expect(markdown).toContain("> **Not in the schema:** `audit.ghosts` is not a table");
    });
  });

  it("same-named tables in two connectors: marked at most, never removed", () => {
    const two = liveInventory(
      [table("users", USERS_COLUMNS), table("users", { id: "integer", plan: "text" }, { read: 1 })],
      [
        { connector: "A", how: "live", schemas: ["public"] },
        { connector: "B", how: "live", schemas: ["public"] },
      ],
    );
    for (const name of ["users", "public.users"]) {
      const { report } = checkSchemaClaims(entity(name, ["plan", "ghost"]), two);
      expect(report.removedColumns).toEqual([]);
      expect(report.flaggedColumns).toEqual(["users.ghost"]);
    }
    // In a diagram too: the line stays, and no type is rewritten for a name
    // that means two tables.
    const diagram =
      "```mermaid\nerDiagram\n    USERS {\n        int ghost\n        int plan\n    }\n```";
    const checked = checkSchemaClaims(diagram, two);
    expect(checked.markdown).toContain("        int ghost");
    expect(checked.markdown).toContain("        int plan");
    expect(checked.report.typeMismatches).toEqual([]);
  });

  describe("a name qualified with a schema that was NOT read is not judged", () => {
    // LIVE read `public` of one database. Nothing is known about `audit`.
    it("in an entity heading and its rows: nothing removed, nothing marked, no note", () => {
      untouched(entity("audit.users", ["id", "actor_ip"]), LIVE);
      untouched(entity("audit.ghosts", ["anything"]), LIVE);
      // Nor against a stored graph or repository SQL.
      untouched(entity("audit.users", ["id", "actor_ip"]), STORED);
      untouched(entity("audit.users", ["id", "actor_ip"]), REPO_SQL);
    });

    it("in a roster row, a diagram and an FK cell", () => {
      untouched("| Table | Purpose |\n|---|---|\n| `audit.events` | Audit trail |", LIVE);
      untouched(
        '```mermaid\nerDiagram\n    "audit.events" {\n        int ghost\n    }\n' +
          '    USERS ||--o{ "audit.events" : logs\n```',
        LIVE,
      );
      untouched(
        "### Entity: `users`\n\n| Field | Type | Constraint |\n|---|---|---|\n" +
          "| `id` | int | referenced by `audit.events.user_id` |",
        LIVE,
      );
    });

    it("nor is a name qualified with a database, which no read identifies", () => {
      untouched(entity("warehouse.public.users", ["ghost"]), LIVE);
    });

    it("and the section raises no warning and gets no note", () => {
      const { markdown, report } = applySchemaGrounding(
        `## Data Architecture\n\n${entity("audit.users", ["id", "actor_ip"])}`,
        LIVE,
      );
      expect(schemaCheckUnmatched(report)).toEqual([]);
      expect(markdown).not.toContain("Schema check.");
      expect(markdown).not.toContain("not in schema");
      expect(markdown).toContain("| `actor_ip` | text |");
    });
  });

  it("a qualified name in a schema that was read is judged, and may be removed", () => {
    const { report, markdown } = checkSchemaClaims(entity("public.users", ["id", "ghost"]), LIVE);
    expect(report.removedColumns).toEqual(["users.ghost"]);
    expect(markdown).not.toContain("ghost");
    expect(
      checkSchemaClaims(entity("public.ghosts", ["id"]), LIVE).report.unresolvedTables,
    ).toEqual(["public.ghosts"]);
  });
});

describe("checkSchemaClaims — the heading's context covers one table (#1061 review)", () => {
  const settings = liveInventory([
    table("users", { id: "integer", email: "text", settings: "jsonb" }),
    table("settings", { id: "integer" }),
  ]);
  const untouched = (markdown: string): void => {
    const checked = checkSchemaClaims(markdown, settings);
    expect(checked.markdown).toBe(markdown);
    expect(schemaCheckFindings(checked.report)).toBe(0);
  };
  const HEAD = "### Entity: `users`\n\n| Field | Type |\n|---|---|\n| `id` | int |\n";

  it("a later field table in the same sub-section is not the heading's", () => {
    // The review's reproduction: `Token` was removed as `users.Token`.
    untouched(
      `${HEAD}\n**Go struct UserSession:**\n\n| Field | Type |\n|---|---|\n| \`Token\` | string |`,
    );
    untouched(`${HEAD}\n| Field | Type |\n|---|---|\n| \`Token\` | string |`);
  });

  it("a table with anything but blank lines between it and the heading is not read", () => {
    for (const between of [
      "**Go struct UserSession:**",
      "The session object, as the handler sees it.",
      "- one\n- two",
      "```go\ntype UserSession struct{}\n```",
    ]) {
      untouched(
        `### Entity: \`users\`\n\n${between}\n\n| Field | Type |\n|---|---|\n| \`Token\` | string |`,
      );
    }
  });

  it("but the heading's own name is still judged there, and only marked", () => {
    const section =
      "### Entity: `ghosts`\n\nA paragraph first.\n\n| Field | Type |\n|---|---|\n| `x` | int |";
    const { report, markdown } = checkSchemaClaims(section, settings);
    expect(report.unresolvedTables).toEqual(["ghosts"]);
    expect(markdown).toContain("| `x` | int |");
  });

  it("the first table directly under the heading IS read", () => {
    const { report } = checkSchemaClaims(`${HEAD}| \`ghost\` | int |`, settings);
    expect(report.removedColumns).toEqual(["users.ghost"]);
  });

  it("a path into a JSON column is not a column claim, even when a table has that name", () => {
    untouched(`${HEAD}| \`settings.theme\` | string |`);
    // Nor any dotted name whose qualifier is not the heading's table.
    untouched(`${HEAD}| \`settings.ghost\` | string |\n| \`model.Theme\` | string |`);
    // The heading's own table as qualifier is a claim.
    expect(
      checkSchemaClaims(`${HEAD}| \`users.ghost\` | string |`, settings).report.removedColumns,
    ).toEqual(["users.ghost"]);
  });

  it("a row whose Type says index, constraint or key is not a column claim", () => {
    for (const type of [
      "index",
      "unique index",
      "**Index**",
      "constraint",
      "primary key",
      "trigger",
    ]) {
      untouched(`${HEAD}| \`users_email_lookup\` | ${type} |`);
    }
  });

  it("a name shaped like an index or key is marked at most", () => {
    for (const name of ["idx_users_email", "users_pkey", "users_email_key", "fk_users_org"]) {
      const { report, markdown } = checkSchemaClaims(`${HEAD}| \`${name}\` | text |`, settings);
      expect(report.removedColumns).toEqual([]);
      expect(report.flaggedColumns).toEqual([`users.${name}`]);
      expect(markdown).toContain(`| \`${name}\` *(not in schema)* | text |`);
    }
  });
});

describe("checkSchemaClaims — entity names and views (#1061 review)", () => {
  const icons = liveInventory([
    table("feed_icons", { feed_id: "bigint", icon_id: "bigint" }),
    table("users", { id: "integer" }),
  ]);
  const clean = (markdown: string, inventory = icons): void => {
    const checked = checkSchemaClaims(markdown, inventory);
    expect(checked.markdown).toBe(markdown);
    expect(schemaCheckFindings(checked.report)).toBe(0);
  };

  it("resolves a PascalCase, singular or differently-cased entity name", () => {
    for (const name of ["FeedIcon", "FeedIcons", "FEED_ICON", "feed_icon", "feedIcons", "User"]) {
      clean(`\`\`\`mermaid\nerDiagram\n    ${name} ||--o{ USERS : belongs_to\n\`\`\``);
      clean(`| Table | Purpose |\n|---|---|\n| \`${name}\` | Something |`);
    }
    clean("### Entity: `FeedIcon`\n\n| Field | Type |\n|---|---|\n| `feed_id` | int64 |");
  });

  it("still marks an entity name that matches no table", () => {
    const { report } = checkSchemaClaims(
      "| Table | Purpose |\n|---|---|\n| `FeedIconCache` | Something |",
      icons,
    );
    expect(report.unresolvedTables).toEqual(["FeedIconCache"]);
  });

  it("two tables that differ only by underscores make the name ambiguous: no removal", () => {
    const twins = liveInventory([
      table("feed_icons", { feed_id: "bigint" }),
      table("feedicons", { icon_id: "bigint" }),
    ]);
    const { report } = checkSchemaClaims(
      "### Entity: `FeedIcon`\n\n| Field | Type |\n|---|---|\n| `ghost` | int |",
      twins,
    );
    expect(report.unresolvedTables).toEqual([]);
    expect(report.removedColumns).toEqual([]);
    expect(report.flaggedColumns).toEqual(["feed_icons.ghost"]);
  });

  it("does not judge a name the document itself calls a view", () => {
    clean("| Table | Purpose |\n|---|---|\n| `active_users` | View over `users` |");
    clean("| Table | Kind |\n|---|---|\n| `active_users` | materialized view |");
    clean(
      "### Entity: `active_users` (view)\n\n| Field | Type |\n|---|---|\n| `id` | int |\n| `x` | int |",
    );
    // "review" and "viewer" are not "view".
    const { report } = checkSchemaClaims(
      "| Table | Purpose |\n|---|---|\n| `reviews_queue` | Holds each reviewer's items |",
      icons,
    );
    expect(report.unresolvedTables).toEqual(["reviews_queue"]);
  });
});

describe("checkSchemaClaims — the near-miss rule needs exactly one column (#1061 panel)", () => {
  // Two columns that are the same once case and underscores are ignored.
  const twins = liveInventory([
    table("integrations", { google_reader_username: "text", googlereader_username: "text" }),
  ]);

  it("corrects nothing when two columns collide after squashing", () => {
    const section =
      "### Entity: `integrations`\n\n| Field | Type | Constraint |\n|---|---|---|\n" +
      "| `GoogleReaderUsername` | text | — |\n" +
      "| `google_reader_username` | text | see `integrations.GoogleReaderUser_name` |";
    const { report, markdown } = checkSchemaClaims(section, twins);
    expect(report.corrected).toEqual([]);
    // Neither spelling is written in for either name.
    expect(markdown).not.toContain("| `googlereader_username` |");
    expect(markdown).not.toContain("`integrations.google_reader_username`");
    expect(markdown).not.toContain("`integrations.googlereader_username`");
    expect(markdown).toContain("`integrations.GoogleReaderUser_name` *(not in schema)*");
    expect(report.removedColumns).toEqual(["integrations.GoogleReaderUsername"]);
    expect(report.flaggedColumns).toEqual(["integrations.GoogleReaderUser_name"]);
  });

  it("nor in a diagram", () => {
    const diagram =
      "```mermaid\nerDiagram\n    INTEGRATIONS {\n        string GoogleReaderUsername\n    }\n```";
    const { report } = checkSchemaClaims(diagram, twins);
    expect(report.corrected).toEqual([]);
  });

  it("and does correct when exactly one column matches", () => {
    const one = liveInventory([table("integrations", { googlereader_username: "text" })]);
    const { report } = checkSchemaClaims(
      "### Entity: `integrations`\n\n| Field | Type |\n|---|---|\n| `GoogleReaderUsername` | text |",
      one,
    );
    expect(report.corrected).toEqual([
      { from: "integrations.GoogleReaderUsername", to: "integrations.googlereader_username" },
    ]);
  });
});

describe("checkSchemaClaims is linear in model output (#1061)", () => {
  const SHAPES: Record<string, (size: number) => string> = {
    "one row of many names": (size) =>
      `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n| ${"`ghost` / ".repeat(size / 10)} | int |`,
    "one cell of many qualified names": (size) =>
      `### Entity: \`users\`\n\n| Field | Type | Constraint |\n|---|---|---|\n| \`id\` | int | ${"`users.ghost` ".repeat(size / 14)} |`,
    "many distinct invented columns": (size) =>
      `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n${Array.from({ length: size / 22 }, (_, n) => `| \`ghost_${n}\` | int |`).join("\n")}`,
    "many entity headings, each with a table": (size) =>
      "### Entity: `ghosts`\n\n| Field | Type |\n|---|---|\n| `a` | int |\n\n".repeat(size / 62),
    "many diagram entities": (size) =>
      `\`\`\`mermaid\nerDiagram\n${Array.from({ length: size / 30 }, (_, n) => `    G${n} ||--o{ USERS : haunts`).join("\n")}\n\`\`\``,
    "unclosed fences": (size) => "```mermaid\n".repeat(size / 11),
    "a wall of backticks": (size) =>
      `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n| ${"`".repeat(size)} | int |`,
    "a wall of pipes": (size) => `| Field | Type |\n|---|---|\n${"|".repeat(size)}`,
    "a wall of hashes": (size) => "#".repeat(size),
    "delimiter rows only": (size) => "|---|---|\n".repeat(size / 10),
  };
  for (const [name, build] of Object.entries(SHAPES)) {
    it(name, () => {
      expectLinearTime(name, (size) => {
        const input = build(size);
        return () => applySchemaGrounding(input, STORED);
      });
    });
  }
});
