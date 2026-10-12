/**
 * #1061 — the deterministic check on the Data Architecture section.
 *
 * The check MARKS and never removes, rewrites or corrects. The first block
 * pins that as a property over generated documents; the rest pin each rule of
 * the module header (what is judged, what is not, what is "not checked") by
 * name, on a cut-down Miniflux schema and the eight inventions the issue lists
 * from walkthrough run 7.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  applySchemaGrounding,
  checkSchemaClaims,
  codeSpans,
  isNonColumnType,
  isTypeWord,
  looksLikeIndexName,
  numberVariants,
  parseHeading,
  renderSchemaCheckNotice,
  schemaCheckFindings,
  schemaCheckUnmatched,
  splitCells,
  typeFamily,
  typesDisagree,
  type SchemaCheckReport,
} from "./schema-claim-check.js";
import {
  NO_SCHEMA_INVENTORY,
  renderSchemaReference,
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

const LIVE = liveInventory(TABLES);
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
/** One database read live, and a second that could not be read at all. */
const ONE_UNREAD = liveInventory(TABLES, [
  { connector: "miniflux-pg", how: "live", schemas: ["public"] },
  { connector: "warehouse", how: "unread", schemas: [] },
]);

const FENCE = "```";
const FIELD = "| Field | Type |\n|---|---|\n";
const entity = (name: string, rows: string, between = ""): string =>
  `### Entity: \`${name}\`\n\n${between}${FIELD}${rows}`;
const diagram = (...lines: string[]): string =>
  [`${FENCE}mermaid`, "erDiagram", ...lines, FENCE].join("\n");

const check = (markdown: string, inventory: SchemaInventory = LIVE) =>
  checkSchemaClaims(markdown, inventory);
const notChecked = (report: SchemaCheckReport, why: string): string[] =>
  report.notChecked.filter((entry) => entry.why === why).map((entry) => entry.name);

/**
 * Every marker the check can write, removed. Written here from the module's
 * header, not imported from it, so the test does not agree with the code by
 * construction.
 */
function withoutMarkers(markdown: string): string {
  return markdown.replace(/ \*\(not in schema(?:; the schema has `[^`\n]*`)?\)\*/g, "");
}

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

The \`batchBuilder\` selects refresh jobs from a database table.

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

// ---------------------------------------------------------------------------
// Mark-only
// ---------------------------------------------------------------------------

/** A small seeded generator (mulberry32), so a failure is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A document made of the structures the check reads and the ones it must leave
 * alone, with real, invented, near-miss, qualified and odd names in each.
 */
function generatedDocument(seed: number): string {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const tables = ["users", "feeds", "entries", "jobs", "Stat", "audit.users", "FeedIcon", "x.y.z"];
  const columns = [
    "id",
    "username",
    "user_id",
    "error_counter",
    "google_reader_username",
    "GestureNav",
    "users.id",
    "users.nope",
    "settings.theme",
    "idx_users_email",
    "feeds.go",
  ];
  const types = ["int64", "string", "bool", "btree", "UNIQUE (email)", "relation", "—", "text[]"];
  const prose = [
    "Stores accounts.",
    "The `users.Len` call iterates; see `feeds.error_counter`.",
    "**Go struct `UserSession`:**",
    "> A note with `jobs` in it.",
    "- a list item naming `certificate_cache`",
    "",
  ];
  const cell = (): string => {
    const shape = Math.floor(random() * 5);
    if (shape === 0) return `\`${pick(columns)}\``;
    if (shape === 1) return `\`${pick(columns)}\` / \`${pick(columns)}\``;
    if (shape === 2) return `\`${pick(columns)}\` (login) and \`${pick(columns)}\` — legacy`;
    if (shape === 3) return pick(columns);
    return "—";
  };
  const out: string[] = ["## Data Architecture", "", pick(prose), ""];
  const blocks = 3 + Math.floor(random() * 6);
  for (let b = 0; b < blocks; b++) {
    const kind = Math.floor(random() * 6);
    if (kind === 0) {
      out.push("```mermaid", "erDiagram");
      for (let n = 0; n < 3; n++) {
        const name = pick(tables).toUpperCase().split(".").join("_");
        out.push(`    ${name} ||--o{ ${pick(tables).toUpperCase()} : has`);
        out.push(`    ${name}${random() < 0.3 ? '["audit.users"]' : ""} {`);
        for (let a = 0; a < 3; a++) {
          const attribute = pick(columns);
          out.push(
            random() < 0.5
              ? `        ${pick(types)} ${attribute} PK`
              : `        ${attribute} bigint`,
          );
        }
        out.push("    }");
      }
      out.push("```", "");
    } else if (kind === 1) {
      const label = pick(["Entity", "Table", "Entities", "Tables"]);
      const name = pick(tables);
      const written = pick([
        `\`${name}\``,
        name,
        `\`${name}\` (audit schema)`,
        `audit.\`${name}\``,
        `\`${name}\` and \`${pick(tables)}\``,
        `\`${name}\` (a view)`,
      ]);
      out.push(`### ${label}: ${written}`, "");
      if (random() < 0.5) out.push(pick(prose), "");
      out.push("| Field | Type | Constraint | Description |", "|---|---|---|---|");
      const rows = 1 + Math.floor(random() * 5);
      for (let r = 0; r < rows; r++) {
        out.push(`| ${cell()} | ${pick(types)} | FK → \`users.id\` | see \`users.CreatedAt\` |`);
      }
      out.push("");
    } else if (kind === 2) {
      out.push("### Tables and Their Roles", "", "| Table | Purpose |", "|---|---|");
      for (let r = 0; r < 3; r++) out.push(`| \`${pick(tables)}\` | ${pick(prose)} |`);
      out.push("");
    } else if (kind === 3) {
      out.push("#### `Feed` struct", "", "| Field | Type |", "|---|---|");
      out.push(`| ${cell()} | ${pick(types)} |`, "");
    } else if (kind === 4) {
      out.push("```go", "type Job struct { ID int64 }", "```", "");
    } else {
      out.push(pick(prose), "");
    }
  }
  return out.join("\n");
}

describe("the check only marks (#1061 second review)", () => {
  const INVENTORIES: Record<string, SchemaInventory> = {
    live: LIVE,
    stored: STORED,
    "repository SQL": REPO_SQL,
    "one database unread": ONE_UNREAD,
  };
  const SEEDS = Array.from({ length: 150 }, (_, n) => n + 1);

  for (const [name, inventory] of Object.entries(INVENTORIES)) {
    it(`markers removed, the output is the input: ${name}`, () => {
      let marked = 0;
      for (const seed of SEEDS) {
        const input = generatedDocument(seed);
        const { markdown } = checkSchemaClaims(input, inventory);
        if (markdown !== input) marked += 1;
        expect(withoutMarkers(markdown), `seed ${seed}`).toBe(input);
      }
      // The generator does produce documents the check marks.
      expect(marked).toBeGreaterThan(SEEDS.length / 10);
    });

    it(`with the note and the reference taken out as well: ${name}`, () => {
      for (const seed of SEEDS) {
        const input = generatedDocument(seed);
        const { markdown, report } = applySchemaGrounding(input, inventory);
        const notice = renderSchemaCheckNotice(report, inventory);
        const reference = renderSchemaReference(inventory);
        let rest = markdown;
        // Each is inserted as whole lines, once.
        if (notice) {
          expect(rest.split(`\n\n${notice}`).length, `seed ${seed}`).toBe(2);
          rest = rest.replace(`\n\n${notice}`, "");
        }
        if (reference) {
          // Before the first sub-section, or at the end when there is none.
          const before = rest.split(`${reference}\n\n`).length - 1;
          const atEnd = rest.endsWith(`\n\n${reference}`) ? 1 : 0;
          expect(before + atEnd, `seed ${seed}`).toBe(1);
          rest = before
            ? rest.replace(`${reference}\n\n`, "")
            : rest.slice(0, -`\n\n${reference}`.length);
        }
        expect(withoutMarkers(rest), `seed ${seed}`).toBe(input);
      }
    });
  }

  it("keeps every line, in order, and adds none", () => {
    for (const seed of SEEDS) {
      const input = generatedDocument(seed).split("\n");
      const output = checkSchemaClaims(input.join("\n"), LIVE).markdown.split("\n");
      expect(output).toHaveLength(input.length);
      output.forEach((line, at) => {
        // A line is the one the model wrote, or that line with markers in it.
        expect(withoutMarkers(line), `seed ${seed} line ${at}`).toBe(input[at]);
      });
    }
  });

  it("leaves a diagram byte for byte as written, whatever it finds in it", () => {
    const body = [
      "    USERS ||--o{ GHOSTS : haunts",
      "    USERS {",
      "        int64 id PK",
      "        string no_such_column",
      "        google_reader_id text",
      "        bool gesture_nav",
      "    }",
    ];
    const section = diagram(...body);
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(report.unresolvedTables).toEqual(["GHOSTS"]);
    expect(report.flaggedColumns).toEqual(["users.no_such_column", "users.google_reader_id"]);
    expect(report.inDiagram).toEqual(["GHOSTS", "users.no_such_column", "users.google_reader_id"]);
  });

  it("is idempotent: a marked name is not marked twice", () => {
    for (const inventory of [LIVE, STORED, REPO_SQL]) {
      const once = checkSchemaClaims(RUN7, inventory).markdown;
      expect(checkSchemaClaims(once, inventory).markdown).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// Run 7
// ---------------------------------------------------------------------------

describe("the eight inventions of run 7 (#1061): all visible, none removed", () => {
  const { markdown, report } = check(RUN7);
  const notice = renderSchemaCheckNotice(report, LIVE);

  it("a `jobs` table: marked in its heading, with prose between heading and table", () => {
    expect(markdown).toContain("### Entity: `jobs` *(not in schema)* (feed-refresh queue table)");
    expect(report.unresolvedTables).toContain("jobs");
  });

  it("an `ENTRY_TAGS` entity: in a diagram, so listed in the note", () => {
    expect(report.unresolvedTables).toContain("ENTRY_TAGS");
    expect(report.inDiagram).toEqual(["ENTRY_TAGS", "JOBS"]);
    expect(notice).toContain(
      "> - Of these, in a diagram, which is left exactly as written and so carries no mark: `ENTRY_TAGS`, `JOBS`.",
    );
  });

  it("`feeds.error_counter` and `entries.category_id`: marked where they stand", () => {
    expect(markdown).toContain("| `error_counter` *(not in schema)* | int | — |");
    expect(markdown).toContain("| `category_id` *(not in schema)* | int64 |");
  });

  it("`certificate_cache`: marked, and never guessed to be `acme_cache`", () => {
    expect(markdown).toContain("### Entity: `certificate_cache` *(not in schema)* (ACME)");
    expect(markdown).not.toContain("`acme_cache`");
  });

  it("`fever_password`: marked beside the real name that shares its cell", () => {
    expect(markdown).toContain(
      "| `fever_username` / `fever_password` *(not in schema)* | string |",
    );
  });

  it("`google_reader_*` and `rss_bridge_*`: marked, with the schema's spelling beside", () => {
    expect(markdown).toContain(
      "| `google_reader_username` *(not in schema; the schema has `googlereader_username`)* / " +
        "`google_reader_password` *(not in schema; the schema has `googlereader_password`)* | string |",
    );
    expect(markdown).toContain(
      "| `rss_bridge_enabled` *(not in schema; the schema has `rssbridge_enabled`)* | bool |",
    );
    expect(report.suggestions).toContainEqual({
      column: "integrations.rss_bridge_enabled",
      schema: "rssbridge_enabled",
    });
  });

  it("`gesture_nav` typed bool: said in the note, and the cell is as written", () => {
    expect(markdown).toContain("| `gesture_nav` | bool | — | Gesture navigation |");
    expect(report.typeMismatches).toEqual([
      { column: "users.gesture_nav", written: "bool", schema: "text" },
    ]);
    expect(notice).toContain(
      "> - Types that differ from the schema: `users.gesture_nav` (written `bool`, schema `text`).",
    );
  });

  it("nothing that is real is marked, and nothing at all is removed", () => {
    expect(report.flaggedColumns).toEqual([
      "feeds.error_counter",
      "entries.category_id",
      "integrations.fever_password",
      "integrations.google_reader_username",
      "integrations.google_reader_password",
      "integrations.rss_bridge_enabled",
    ]);
    expect(report.unresolvedTables).toEqual(["ENTRY_TAGS", "JOBS", "jobs", "certificate_cache"]);
    expect(withoutMarkers(markdown)).toBe(RUN7);
  });

  it("marks the same names against a stored graph and against repository SQL", () => {
    for (const inventory of [STORED, REPO_SQL]) {
      const other = check(RUN7, inventory);
      expect(other.report.flaggedColumns).toEqual(report.flaggedColumns);
      expect(other.report.unresolvedTables).toEqual(report.unresolvedTables);
      expect(other.markdown).toBe(markdown);
    }
    // Repository SQL carries no types, so no type is compared.
    expect(check(RUN7, REPO_SQL).report.typeMismatches).toEqual([]);
    expect(check(RUN7, STORED).report.typeMismatches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What is judged
// ---------------------------------------------------------------------------

describe("judged: a Mermaid erDiagram", () => {
  it("an entity named in a relationship line or as a block", () => {
    const { report } = check(
      diagram("    USERS ||--o{ GHOSTS : haunts", "    SPECTRES {", "        int id", "    }"),
    );
    expect(report.unresolvedTables).toEqual(["GHOSTS", "SPECTRES"]);
  });

  it("an attribute in Mermaid's order, type first", () => {
    const { report } = check(
      diagram("    USERS {", "        int64 id PK", "        string nope", "    }"),
    );
    expect(report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("an attribute written name first: real columns are not taken for types (B2)", () => {
    const section = diagram(
      "    USERS {",
      "        id bigint PK",
      "        username text",
      "        is_admin boolean",
      "        nope text",
      "    }",
    );
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(report.flaggedColumns).toEqual(["users.nope"]);
    expect(report.notChecked).toEqual([]);
  });

  it("a line that does not say which token is the name is not judged, and is listed", () => {
    const { report } = check(
      diagram(
        "    USERS {",
        "        widget gadget",
        "        text uuid",
        "        id username",
        "    }",
      ),
    );
    expect(report.flaggedColumns).toEqual([]);
    // Neither a column nor a type; two type words. Two columns: nothing to say.
    expect(notChecked(report, "diagram-line")).toEqual([
      "users: widget gadget",
      "users: text uuid",
    ]);
  });

  it("a line of two column names says nothing, whatever the tokens could be read as", () => {
    // `text` is a column here, and a type word: which of the two is the name is
    // not known, so `id` is not reported as typed `text`.
    const inventory = liveInventory([table("notes", { id: "integer", text: "text" })]);
    const { report } = check(diagram("    NOTES {", "        text id", "    }"), inventory);
    expect(schemaCheckFindings(report)).toBe(0);
  });

  it("a type that cannot describe the column, in either order", () => {
    const typeFirst = check(diagram("    USERS {", "        bool gesture_nav", "    }"));
    const nameFirst = check(diagram("    USERS {", "        gesture_nav bool", "    }"));
    for (const { report } of [typeFirst, nameFirst]) {
      expect(report.typeMismatches).toEqual([
        { column: "users.gesture_nav", written: "bool", schema: "text" },
      ]);
    }
  });

  it("nothing in a block whose entity did not resolve, in another diagram or another fence", () => {
    expect(
      check(diagram("    GHOSTS {", "        string nope", "    }")).report.flaggedColumns,
    ).toEqual([]);
    const flow = `${FENCE}mermaid\ngraph LR\n    GHOSTS --> USERS\n${FENCE}`;
    const text = `${FENCE}text\nerDiagram\n    GHOSTS ||--o{ USERS : x\n${FENCE}`;
    for (const section of [flow, text]) expect(schemaCheckFindings(check(section).report)).toBe(0);
  });
});

describe("judged: an Entity/Table heading and the field table under it", () => {
  it("the heading's table name, marked in the heading line", () => {
    const { markdown, report } = check(entity("ghosts", "| `a` | int |"));
    expect(markdown.split("\n")[0]).toBe("### Entity: `ghosts` *(not in schema)*");
    expect(report.unresolvedTables).toEqual(["ghosts"]);
    // Its rows cannot be judged against a table that is not there.
    expect(report.flaggedColumns).toEqual([]);
  });

  it("a name written without backticks, and one of several", () => {
    expect(check(`### Table: ghosts\n\n${FIELD}| \`a\` | int |`).markdown.split("\n")[0]).toBe(
      "### Table: ghosts *(not in schema)*",
    );
    const several = check(
      `### Entities: \`users\` and \`ghosts\`\n\n${FIELD}| \`users.id\` | int |`,
    );
    expect(several.markdown.split("\n")[0]).toBe(
      "### Entities: `users` and `ghosts` *(not in schema)*",
    );
  });

  it("a backticked name in the first cell is a column of the heading's table", () => {
    const { markdown, report } = check(entity("users", "| `id` | int |\n| `nope` | int |"));
    expect(markdown).toContain("| `nope` *(not in schema)* | int |");
    expect(report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("prose between the heading and its table changes nothing (M-b)", () => {
    const rows = "| `id` | bigint |\n| `error_counter` | int |";
    const direct = check(entity("feeds", rows));
    const withProse = check(entity("feeds", rows, "Stores subscriptions.\n\n"));
    expect(withProse.report).toEqual(direct.report);
    expect(withProse.report.flaggedColumns).toEqual(["feeds.error_counter"]);
    expect(withProse.markdown).toContain("| `error_counter` *(not in schema)* | int |");
  });

  it("every name of a shared cell, and the words around them stay (was: rebuilt)", () => {
    const row = "| `username` (login) and `fever_password` — legacy | text |";
    const { markdown } = check(entity("users", row));
    expect(markdown).toContain(
      "| `username` (login) and `fever_password` *(not in schema)* — legacy | text |",
    );
  });

  it("a dotted name whose qualifier is one of the heading's own tables", () => {
    const section = `### Entities: \`users\` and \`feeds\`\n\n${FIELD}| \`users.id\` | int |\n| \`feeds.external_icon_id\` | string |\n| \`public.feeds.nope\` | int |`;
    const { markdown, report } = check(section);
    expect(report.flaggedColumns).toEqual(["feeds.external_icon_id", "feeds.nope"]);
    expect(markdown).toContain("| `feeds.external_icon_id` *(not in schema)* | string |");
  });

  it("a bare name is not attributed when the heading also names something unknown", () => {
    const section = `### Entities: \`users\` and \`ghosts\`\n\n${FIELD}| \`haunted\` | int |\n| \`users.nope\` | int |`;
    // `haunted` may be a column of `ghosts`, which is not in the schema.
    expect(check(section).report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("a type that cannot describe the column: in the note, never in the cell", () => {
    const section = entity("users", "| `gesture_nav` | bool |\n| `is_admin` | int |");
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(report.typeMismatches).toEqual([
      { column: "users.gesture_nav", written: "bool", schema: "text" },
    ]);
  });

  it("a type is compared only when the name means one table (panel: untested guard)", () => {
    const twins = liveInventory(
      [
        table("users", { id: "integer", flag: "text" }, { read: 0 }),
        table("users", { id: "integer", flag: "boolean" }, { read: 1 }),
      ],
      [
        { connector: "a", how: "live", schemas: ["public"] },
        { connector: "b", how: "live", schemas: ["public"] },
      ],
    );
    expect(check(entity("users", "| `flag` | bool |"), twins).report.typeMismatches).toEqual([]);
    expect(
      check(diagram("    USERS {", "        bool flag", "    }"), twins).report.typeMismatches,
    ).toEqual([]);
    // And is compared when it means one.
    const one = liveInventory([twins.tables[0]]);
    expect(check(entity("users", "| `flag` | bool |"), one).report.typeMismatches).toHaveLength(1);
  });
});

describe("judged: a table of tables", () => {
  it("a backticked name in the first cell of a table headed Table", () => {
    const section =
      "| Table | Purpose |\n|---|---|\n| `users` | accounts |\n| `audit_log` | history |\n| plain text | — |";
    const { markdown, report } = check(section);
    expect(markdown).toContain("| `audit_log` *(not in schema)* | history |");
    expect(markdown).toContain("| `users` | accounts |");
    expect(report.unresolvedTables).toEqual(["audit_log"]);
  });
});

// ---------------------------------------------------------------------------
// What is not judged
// ---------------------------------------------------------------------------

describe("not judged, and left exactly as written", () => {
  it("every cell but the first: a Go expression, a JSON path, a file name (panel)", () => {
    const inventory = liveInventory([...TABLES, table("settings", { id: "integer" })]);
    const section =
      "### Entity: `users`\n\n| Field | Type | Constraint | Description |\n|---|---|---|---|\n" +
      "| `id` | int | FK → `users.ghost_id` | iterated as `users.Len`; see `users.CreatedAt`, `settings.theme` and `feeds.go` |";
    const { markdown, report } = check(section, inventory);
    expect(markdown).toBe(section);
    expect(schemaCheckFindings(report)).toBe(0);
  });

  it("a row whose Type says index, constraint, key or relation: listed, not marked (M-a)", () => {
    const rows = [
      "| `index_users_on_email` | btree |",
      "| `users_email_unique` | UNIQUE (email) |",
      "| `users_org_id_foreign` | FK |",
      "| `enclosures` | relation |",
      "| `whatever` | unique index |",
      "| `id` | primary key |",
    ].join("\n");
    const section = entity("users", rows);
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(report.flaggedColumns).toEqual([]);
    expect(notChecked(report, "not-a-column")).toEqual([
      "users.index_users_on_email",
      "users.users_email_unique",
      "users.users_org_id_foreign",
      "users.enclosures",
      "users.whatever",
    ]);
  });

  it("but a column type that only mentions an index or a key is still a column (M-b)", () => {
    const rows = "| `error_counter` | integer (indexed) |\n| `nope` | BIGSERIAL PRIMARY KEY |";
    expect(check(entity("users", rows)).report.flaggedColumns).toEqual([
      "users.error_counter",
      "users.nope",
    ]);
  });

  it("a name shaped like an index or a key, with or without a Type column (M-a)", () => {
    const typed = check(entity("users", "| `users_pkey` | — |\n| `idx_users_email` | — |"));
    expect(typed.report.flaggedColumns).toEqual([]);
    expect(notChecked(typed.report, "not-a-column")).toEqual([
      "users.users_pkey",
      "users.idx_users_email",
    ]);
    const untyped = check(
      "### Entity: `users`\n\n| Field | Description |\n|---|---|\n| `unique_email` | UNIQUE constraint on email |",
    );
    expect(untyped.report.flaggedColumns).toEqual([]);
    expect(notChecked(untyped.report, "not-a-column")).toEqual(["users.unique_email"]);
  });

  it("a dotted name whose qualifier is not the heading's table: listed, not marked", () => {
    const inventory = liveInventory([...TABLES, table("settings", { id: "integer" })]);
    const section = entity("users", "| `settings.theme` | string |\n| `model.Job` | struct |");
    const { markdown, report } = check(section, inventory);
    expect(markdown).toBe(section);
    expect(notChecked(report, "not-a-column")).toEqual(["settings.theme", "model.Job"]);
  });

  it("a first cell that is not a name, or has no backticks", () => {
    const section = entity("users", "| nope | int |\n| `UNIQUE(email)` | — |\n| — | — |");
    expect(schemaCheckFindings(check(section).report)).toBe(0);
  });

  it("a later field table in the same sub-section, and one under any other heading", () => {
    const later = `${entity("users", "| `id` | int |")}\n\n**Go struct \`UserSession\`:**\n\n${FIELD}| \`Token\` | string |`;
    expect(schemaCheckFindings(check(later).report)).toBe(0);
    for (const heading of ["#### `Feed` struct", "### Sessions", "### users"]) {
      const section = `${heading}\n\n${FIELD}| \`nope\` | int |`;
      expect(schemaCheckFindings(check(section).report)).toBe(0);
    }
  });

  it("a field table after another heading: the Entity heading's context ends there", () => {
    const section = `### Entity: \`users\`\n\nAccounts.\n\n#### \`UserSession\` struct\n\n${FIELD}| \`Token\` | string |`;
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(schemaCheckFindings(report)).toBe(0);
  });

  it("the type of a cell that names several columns: which one it describes is not known", () => {
    const section = entity("users", "| `id` / `gesture_nav` | int |");
    expect(check(section).report.typeMismatches).toEqual([]);
    // Alone in its cell, the same type is compared.
    expect(check(entity("users", "| `gesture_nav` | int |")).report.typeMismatches).toHaveLength(1);
  });

  it("a heading with no field table under it, and a table that is not a field table", () => {
    expect(schemaCheckFindings(check("### Table: Feature comparison\n\nProse.").report)).toBe(0);
    const stores = "### Entity: `ghosts`\n\n| Store | Role |\n|---|---|\n| `ghosts` | none |";
    expect(schemaCheckFindings(check(stores).report)).toBe(0);
  });

  it("a name its own heading or row calls a view: listed, not marked", () => {
    const heading = check(`### Entity: \`active_users\` (view)\n\n${FIELD}| \`id\` | int |`);
    expect(heading.report.unresolvedTables).toEqual([]);
    expect(notChecked(heading.report, "view")).toEqual(["active_users"]);
    const roster = check("| Table | Purpose |\n|---|---|\n| `active_users` | a view over users |");
    expect(roster.report.unresolvedTables).toEqual([]);
    expect(notChecked(roster.report, "view")).toEqual(["active_users"]);
    // Without the word it is judged.
    const plain = check("| Table | Purpose |\n|---|---|\n| `active_users` | recent logins |");
    expect(plain.report.unresolvedTables).toEqual(["active_users"]);
  });

  it("free prose", () => {
    const prose =
      "The `jobs` queue is an in-memory channel; `certificate_cache` wraps storage.\n\n- `ghosts.id` is not a thing";
    expect(schemaCheckFindings(check(prose).report)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Not checked
// ---------------------------------------------------------------------------

describe("not checked: a name the read cannot speak for", () => {
  const AUDIT_SHAPES: Record<string, string> = {
    "inside the code span": "### Entity: `audit.users`",
    "before the code span (B3)": "### Table: audit.`users`",
    "in a parenthesis after it (B3)": "### Entity: `users` (audit schema)",
    "each part in its own backticks (B3)": "### Entity: `audit`.`users`",
    "without backticks": "### Table: audit.users",
  };
  for (const [name, heading] of Object.entries(AUDIT_SHAPES)) {
    it(`a heading with a schema that was not read, ${name}`, () => {
      const section = `${heading}\n\n${FIELD}| \`id\` | bigint |\n| \`actor_ip\` | inet |`;
      const { markdown, report } = check(section);
      // `public.users` has no `actor_ip`; the prefix is not dropped to say so.
      expect(markdown).toBe(section);
      expect(schemaCheckUnmatched(report)).toEqual([]);
      expect(notChecked(report, "unread")).toEqual(["audit.users"]);
    });
  }

  it("a diagram entity whose alias names another schema (B3)", () => {
    const section = diagram('    USERS["audit.users"] {', "        inet actor_ip", "    }");
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(schemaCheckUnmatched(report)).toEqual([]);
    expect(notChecked(report, "unread")).toEqual(["audit.users"]);
  });

  it("an alias that is a caption, not a name, leaves the entity's own id", () => {
    const section = diagram('    USERS["User accounts"] {', "        string nope", "    }");
    expect(check(section).report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("a roster name in an unread schema: listed, so it is not silently accepted (M-d)", () => {
    const section = "| Table | Purpose |\n|---|---|\n| `worker.jobs` | refresh queue |";
    const { markdown, report } = check(section);
    expect(markdown).toBe(section);
    expect(schemaCheckUnmatched(report)).toEqual([]);
    expect(notChecked(report, "unread")).toEqual(["worker.jobs"]);
    expect(renderSchemaCheckNotice(report, LIVE)).toContain(
      "> - Not checked (outside the schemas that were read): `worker.jobs`.",
    );
  });

  it("a name qualified with a database, which no read identifies", () => {
    const { report } = check("| Table | Purpose |\n|---|---|\n| `warehouse.public.facts` | — |");
    expect(schemaCheckUnmatched(report)).toEqual([]);
    expect(notChecked(report, "unread")).toEqual(["warehouse.public.facts"]);
  });

  it("a qualified name in a schema that WAS read, and is not there, is marked", () => {
    const { report } = check("| Table | Purpose |\n|---|---|\n| `public.ghosts` | — |");
    expect(report.unresolvedTables).toEqual(["public.ghosts"]);
    expect(report.notChecked).toEqual([]);
  });

  it("a qualified name is looked for in its own schema only", () => {
    const inventory = liveInventory(
      [
        table("users", { id: "integer", email: "text" }),
        table("users", { id: "integer", actor_ip: "inet" }, { schema: "audit" }),
      ],
      [{ connector: "pg", how: "live", schemas: ["audit", "public"] }],
    );
    const audit = check(
      entity("audit.users", "| `actor_ip` | inet |\n| `email` | text |"),
      inventory,
    );
    expect(audit.report.flaggedColumns).toEqual(["users.email"]);
    // Unqualified, it can mean either: judged against both.
    const either = check(entity("users", "| `actor_ip` | inet |\n| `email` | text |"), inventory);
    expect(either.report.flaggedColumns).toEqual([]);
  });

  it("an unqualified name that does not resolve, with a database unread (panel)", () => {
    const section = "| Table | Purpose |\n|---|---|\n| `b_table` | — |\n| `public.b_table` | — |";
    const unread = check(section, ONE_UNREAD);
    expect(unread.markdown).toBe(section);
    expect(schemaCheckUnmatched(unread.report)).toEqual([]);
    expect(notChecked(unread.report, "unread")).toEqual(["b_table", "public.b_table"]);
    // Every database read: the same names are marked.
    expect(check(section).report.unresolvedTables).toEqual(["b_table", "public.b_table"]);
  });

  it("the same in a heading and in a diagram", () => {
    const heading = check(entity("ghosts", "| `a` | int |"), ONE_UNREAD);
    expect(heading.report.unresolvedTables).toEqual([]);
    expect(notChecked(heading.report, "unread")).toEqual(["ghosts"]);
    const drawn = check(diagram("    USERS ||--o{ GHOSTS : haunts"), ONE_UNREAD);
    expect(drawn.report.unresolvedTables).toEqual([]);
    expect(notChecked(drawn.report, "unread")).toEqual(["GHOSTS"]);
  });

  it("a read that may have been cut short is not taken to hold every table", () => {
    const truncated = liveInventory(TABLES, [
      { connector: "ora", how: "live", schemas: ["public"], possiblyTruncated: true },
    ]);
    const { report } = check("| Table | Purpose |\n|---|---|\n| `zz_last` | — |", truncated);
    expect(report.unresolvedTables).toEqual([]);
    expect(notChecked(report, "unread")).toEqual(["zz_last"]);
    expect(renderSchemaCheckNotice(report, truncated)).toContain(
      '> - The read of "ora" reached the driver\'s row limit and may have been cut short',
    );
  });

  it("a name that resolves is judged against what it resolved to, unread database or not", () => {
    const { report } = check(entity("users", "| `nope` | int |"), ONE_UNREAD);
    expect(report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("repository SQL knows no schema: a qualified name can be any table of that name", () => {
    const tables = REPO_SQL.tables.map((t) => ({ ...t, schema: "" }));
    const inventory: SchemaInventory = { ...REPO_SQL, tables };
    const { report } = check(
      "| Table | Purpose |\n|---|---|\n| `public.users` | — |\n| `public.ghosts` | — |",
      inventory,
    );
    expect(report.unresolvedTables).toEqual([]);
    expect(notChecked(report, "unread")).toEqual(["public.ghosts"]);
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("matching a table-level name", () => {
  const roster = (...names: string[]): string =>
    `| Table | Purpose |\n|---|---|\n${names.map((name) => `| \`${name}\` | — |`).join("\n")}`;

  it("ignores case and underscores, and takes a singular for its plural", () => {
    const inventory = liveInventory([
      table("feed_icons", { id: "integer" }),
      table("categories", { id: "integer" }),
      table("boxes", { id: "integer" }),
      table("user", { id: "integer" }),
    ]);
    const names = ["FeedIcon", "FEED_ICONS", "feedicons", "Category", "box", "users", "User"];
    expect(check(roster(...names), inventory).report.unresolvedTables).toEqual([]);
  });

  it("`Stat` is not `states` and `Plan` is not `planes` (L1)", () => {
    const inventory = liveInventory([
      table("states", { id: "integer", name: "text" }),
      table("planes", { id: "integer", tail_number: "text" }),
    ]);
    const { report } = check(roster("Stat", "Plan"), inventory);
    expect(report.unresolvedTables).toEqual(["Stat", "Plan"]);
    // So their rows are not judged against the wrong table.
    const rows = check(entity("Stat", "| `Hits` | int |"), inventory);
    expect(rows.report.flaggedColumns).toEqual([]);
    expect(rows.report.unresolvedTables).toEqual(["Stat"]);
  });

  it("needs one result: two tables a plural could mean leave the name unresolved", () => {
    const inventory = liveInventory([
      table("boxs", { id: "integer" }),
      table("boxes", { id: "integer" }),
    ]);
    expect(check(roster("box"), inventory).report.unresolvedTables).toEqual(["box"]);
    // The exact name always wins.
    expect(check(roster("boxes", "boxs"), inventory).report.unresolvedTables).toEqual([]);
  });

  it("numberVariants gives the conventional forms only", () => {
    expect(numberVariants("stat")).toEqual(["stats"]);
    expect(numberVariants("plan")).toEqual(["plans"]);
    expect(numberVariants("box")).toEqual(["boxs", "boxes"]);
    expect(numberVariants("category")).toEqual(["categorys", "categories"]);
    expect(numberVariants("categories")).toEqual([
      "categoriess",
      "categorie",
      "category",
      "categorieses",
    ]);
    expect(numberVariants("boxes")).toEqual(["boxess", "boxe", "boxeses", "box"]);
    // `stat` does not take `es`, so `states` is never read back to it.
    expect(numberVariants("states")).toEqual(["statess", "state", "stateses"]);
  });
});

describe("matching a column: the near-miss rule", () => {
  it("marks with the schema's spelling, and writes nothing into the name", () => {
    const section = entity("integrations", "| `GoogleReaderUsername` | string |");
    const { markdown, report } = check(section);
    expect(markdown).toContain(
      "| `GoogleReaderUsername` *(not in schema; the schema has `googlereader_username`)* | string |",
    );
    expect(report.flaggedColumns).toEqual(["integrations.GoogleReaderUsername"]);
    expect(renderSchemaCheckNotice(report, LIVE)).toContain(
      "> - Columns not in the schema: `integrations.GoogleReaderUsername` (the schema has `googlereader_username`).",
    );
  });

  it("suggests nothing when two columns collide after squashing", () => {
    const inventory = liveInventory([table("t", { user_id: "integer", user__id: "integer" })]);
    const { markdown, report } = check(entity("t", "| `UserId` | int |"), inventory);
    expect(markdown).toContain("| `UserId` *(not in schema)* | int |");
    expect(report.suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No schema
// ---------------------------------------------------------------------------

describe("no schema to check against", () => {
  it("changes nothing and reports nothing", () => {
    for (const inventory of [NO_SCHEMA_INVENTORY, liveInventory([])]) {
      const { markdown, report } = checkSchemaClaims(RUN7, inventory);
      expect(markdown).toBe(RUN7);
      expect(report.checked).toBe(false);
      expect(schemaCheckFindings(report)).toBe(0);
    }
  });

  it("says so at the top of the section instead of inventing a verdict", () => {
    const { markdown } = applySchemaGrounding(RUN7, NO_SCHEMA_INVENTORY);
    expect(markdown.split("\n")[2]).toMatch(/^> \*\*Schema not verified\.\*\* No database schema/);
    expect(markdown).not.toContain("not in schema");
  });
});

// ---------------------------------------------------------------------------
// The note and the section
// ---------------------------------------------------------------------------

describe("renderSchemaCheckNotice: one note says everything", () => {
  it("says that nothing was removed, and why a mark is not a verdict", () => {
    const notice = renderSchemaCheckNotice(check(RUN7).report, LIVE);
    expect(notice.split("\n")[0]).toBe(
      "> **Schema check.** The table and column names in this section's diagrams, entity " +
        'headings, field tables and table lists were compared with the live schema of "miniflux-pg". ' +
        "Nothing was removed or changed: a name that could not be matched is marked **not in schema** " +
        "where it stands. A database read can be incomplete (it covers one schema, and a role may " +
        "not see every column), so a marked name is one to verify, not necessarily a mistake.",
    );
    expect(notice).not.toMatch(/[Rr]emoved,|corrected/);
  });

  it("lists each kind of finding, and each reason a name was not checked", () => {
    const section = [
      diagram("    USERS ||--o{ GHOSTS : haunts", "    USERS {", "        widget gadget", "    }"),
      entity("users", "| `nope` | int |\n| `users_pkey` | — |\n| `gesture_nav` | bool |"),
      "| Table | Purpose |\n|---|---|\n| `audit.events` | — |\n| `recent` | a view |",
    ].join("\n\n");
    const notice = renderSchemaCheckNotice(check(section).report, LIVE);
    expect(notice.split("\n").slice(1)).toEqual([
      "> - Named as tables, not in the schema: `GHOSTS`.",
      "> - Columns not in the schema: `users.nope`.",
      "> - Of these, in a diagram, which is left exactly as written and so carries no mark: `GHOSTS`.",
      "> - Types that differ from the schema: `users.gesture_nav` (written `bool`, schema `text`).",
      "> - Not checked (outside the schemas that were read): `audit.events`.",
      "> - Not checked (an index, constraint, key or relation row, or a name that is not a plain column name): `users.users_pkey`.",
      "> - Not checked (described as a view, which the schema that was read does not list as one): `recent`.",
      "> - Not checked (a diagram line whose column name could not be told from its type): `users: widget gadget`.",
    ]);
  });

  it("is empty when the check has nothing to say", () => {
    const clean = entity("users", "| `id` | int |");
    expect(renderSchemaCheckNotice(check(clean).report, LIVE)).toBe("");
  });

  it("caps how many names a line lists", () => {
    const rows = Array.from({ length: 20 }, (_, n) => `| \`ghost_${n}\` | int |`).join("\n");
    const { report } = check(entity("users", rows));
    expect(report.flaggedColumns).toHaveLength(20);
    expect(renderSchemaCheckNotice(report, LIVE)).toContain("`users.ghost_11` and 8 more.");
  });

  it("counts: unmatched is what is marked; findings also count types and not-checked", () => {
    const section = `${entity("users", "| `nope` | int |\n| `gesture_nav` | bool |")}\n\n| Table | Purpose |\n|---|---|\n| \`audit.events\` | — |\n| \`ghosts\` | — |`;
    const { report } = check(section);
    expect(schemaCheckUnmatched(report)).toEqual(["ghosts", "users.nope"]);
    expect(schemaCheckFindings(report)).toBe(4);
  });
});

describe("applySchemaGrounding", () => {
  it("puts the note under the heading and the reference before the first sub-section", () => {
    const { markdown } = applySchemaGrounding(RUN7, LIVE);
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("## Data Architecture");
    expect(lines[2]).toMatch(/^> \*\*Schema check\.\*\* /);
    const reference = markdown.indexOf("### Schema Reference");
    expect(reference).toBeGreaterThan(markdown.indexOf("FEEDS ||--o{ JOBS"));
    expect(reference).toBeLessThan(markdown.indexOf("### Entity: `users`"));
    expect(markdown).toContain("#### `acme_cache`");
    expect(markdown).toContain("| key | character varying |");
  });

  it("adds the reference and no note to a section with nothing wrong", () => {
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

  it("leaves an unclosed fence and a table at the end of the text intact", () => {
    const unclosed = "```mermaid\nerDiagram\n    USERS ||--o{ GHOSTS : x";
    expect(check(unclosed).markdown).toBe(unclosed);
    expect(check(unclosed).report.unresolvedTables).toEqual(["GHOSTS"]);
    const tail = entity("users", "| `nope` | int |");
    expect(check(tail).markdown.endsWith("| `nope` *(not in schema)* | int |")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("parsing helpers", () => {
  const names = (line: string): string[] | null =>
    parseHeading(line)?.names.map((entry) => entry.name) ?? null;

  it("parseHeading reads names only from a labelled heading", () => {
    expect(names("### Entity: `users`")).toEqual(["users"]);
    expect(names("### Entities: `icons` and `feed_icons`")).toEqual(["icons", "feed_icons"]);
    expect(names("#### Table: users")).toEqual(["users"]);
    expect(names("### Tables: users, feeds & entries")).toEqual(["users", "feeds", "entries"]);
    expect(names("### Entity: `jobs` (feed-refresh queue table)")).toEqual(["jobs"]);
    expect(names("### Entity: The user account record itself")).toEqual([]);
    expect(names("### Entity: `not a name`")).toEqual([]);
    expect(names("#### `Feed` struct")).toEqual([]);
    expect(names("### Sessions")).toEqual([]);
    for (const line of ["# Title", "####### deep", "###nospace", "plain", "| a | b |"]) {
      expect(parseHeading(line)).toBeNull();
    }
  });

  it("parseHeading reads the schema from the whole heading, not only the code span", () => {
    expect(names("### Table: audit.`users`")).toEqual(["audit.users"]);
    expect(names("### Entity: `audit`.`users`")).toEqual(["audit.users"]);
    expect(names("### Entity: `users` (audit schema)")).toEqual(["audit.users"]);
    expect(names("### Entity: `users` (in the audit schema)")).toEqual(["audit.users"]);
    expect(names("### Entity: `users` (schema: audit)")).toEqual(["audit.users"]);
    expect(names("### Entity: `users` (schema `audit`)")).toEqual(["audit.users"]);
    // Names no schema, or already has one, or there are several names.
    expect(names("### Entity: `users` (the default schema)")).toEqual(["users"]);
    expect(names("### Entity: `app.users` (audit schema)")).toEqual(["app.users"]);
    expect(names("### Entities: `a` and `b` (audit schema)")).toEqual(["a", "b"]);
  });

  it("parseHeading says where each name ends, which is where a marker goes", () => {
    const line = "### Entities: `icons` and feed_icons";
    expect(parseHeading(line)?.names).toEqual([{ name: "icons", end: 21 }]);
    const bare = "### Tables: users, feeds";
    expect(parseHeading(bare)?.names.map((entry) => bare.slice(0, entry.end))).toEqual([
      "### Tables: users",
      "### Tables: users, feeds",
    ]);
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
    // By design somewhere: a boolean in an integer, a time as text.
    expect(typesDisagree("bool", "integer")).toBe(false);
    expect(typesDisagree("timestamp", "text")).toBe(false);
  });

  it("isTypeWord decides on the whole word, so a name that contains a type is a name", () => {
    for (const type of ["text", "BIGINT", "int64", "varchar(255)", "[]byte", "jsonb", "uuid"]) {
      expect(isTypeWord(type), type).toBe(true);
    }
    for (const type of ["timestamp_with_time_zone", "character_varying", "user_defined"]) {
      expect(isTypeWord(type), type).toBe(true);
    }
    for (const name of ["date_added", "settings_json", "int", "id", "widget", "", "x9"]) {
      expect(isTypeWord(name), name).toBe(name === "int");
    }
  });

  it("isNonColumnType reads the Type cell, not a parenthesis in it", () => {
    for (const cell of ["btree", "UNIQUE (email)", "FK", " `index` ", "unique index", "relation"]) {
      expect(isNonColumnType(cell), cell).toBe(true);
    }
    for (const cell of ["integer (indexed)", "BIGSERIAL PRIMARY KEY", "bigint PK", "—", ""]) {
      expect(isNonColumnType(cell), cell).toBe(false);
    }
  });

  it("looksLikeIndexName knows the usual shapes", () => {
    for (const name of ["idx_users_email", "users_pkey", "index_users_on_email", "unique_email"]) {
      expect(looksLikeIndexName(name), name).toBe(true);
    }
    for (const name of ["users_email_unique", "users_org_id_foreign", "entries_id_seq"]) {
      expect(looksLikeIndexName(name), name).toBe(true);
    }
    for (const name of ["email", "indexed_at", "keyboard_shortcuts"]) {
      expect(looksLikeIndexName(name), name).toBe(false);
    }
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
    "a heading of many code spans": (size) =>
      `### Entities: ${"`a`.".repeat(size / 4)}\n\n| Field | Type |\n|---|---|\n| \`a\` | int |`,
    "a heading with a long schema prefix": (size) =>
      `### Table: ${"a".repeat(size)}.\`users\` (${"schema ".repeat(size / 7)}\n\n| Field | Type |\n|---|---|\n| \`a\` | int |`,
    "many diagram entities": (size) =>
      `\`\`\`mermaid\nerDiagram\n${Array.from({ length: size / 30 }, (_, n) => `    G${n} ||--o{ USERS : haunts`).join("\n")}\n\`\`\``,
    "many diagram attributes": (size) =>
      `\`\`\`mermaid\nerDiagram\n    USERS {\n${"        widget gadget\n".repeat(size / 22)}    }\n\`\`\``,
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
