/**
 * #1061 — the deterministic check on the Data Architecture section.
 *
 * The check MARKS and never removes, rewrites or corrects. The first block
 * pins that as a property over generated documents; the rest pin each rule of
 * the module header (what is judged, what is not, what is "not checked") by
 * name, on a cut-down Miniflux schema and the eight inventions the issue lists
 * from walkthrough run 7.
 */
import { Lexer, type Token, type Tokens } from "marked";
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  applySchemaGrounding,
  checkDataArchitectureText,
  checkProseSchemaClaims,
  checkSchemaClaims,
  codeSpans,
  isNonColumnType,
  isTypeWord,
  looksLikeIndexName,
  numberVariants,
  parseHeading,
  renderSchemaCheckNotice,
  schemaCheckFindings,
  schemaCheckJudged,
  schemaClaimsRecord,
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
 * Every marker the check can write, removed by pattern. Only for the fixed
 * documents below, which hold no text that looks like a marker; the property
 * tests use `withoutAdded`, which reads the output beside the input instead.
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
 * The strings the check may add after a name, written out from the module
 * header and the inventory: the plain marker, and the near-miss marker for
 * each column the schema has. Nothing here is imported from the module.
 */
function markersFor(inventory: SchemaInventory): string[] {
  const out = new Set([" *(not in schema)*"]);
  for (const entry of inventory.tables) {
    for (const column of entry.columns) {
      out.add(` *(not in schema; the schema has \`${column.name}\`)*`);
    }
  }
  return [...out];
}

/**
 * `output` with what the check ADDED taken out, and where each addition stood.
 *
 * It is found by reading `output` beside `input`, never by pattern alone: a
 * marker is the check's when `output` has it at a point where `input` does not.
 * So a lookalike the model wrote (`*(not in schema)*` is ordinary Markdown) is
 * model text, and stays. Everything else is copied, so if the check removed or
 * changed a single byte, the result differs from `input`.
 */
function withoutAdded(
  output: string,
  input: string,
  markers: readonly string[],
): { text: string; added: number[] } {
  const kept: string[] = [];
  const added: number[] = [];
  let from = 0;
  let i = 0;
  let j = 0;
  while (j < output.length) {
    if (output[j] === " " && output[j + 1] === "*") {
      const marker = markers.find((m) => output.startsWith(m, j) && !input.startsWith(m, i));
      if (marker) {
        kept.push(output.slice(from, j));
        added.push(j);
        j += marker.length;
        from = j;
        continue;
      }
    }
    i += 1;
    j += 1;
  }
  kept.push(output.slice(from));
  return { text: kept.join(""), added };
}

/**
 * What a CommonMark + GFM renderer shows as code, by a parser that shares
 * nothing with the check (`marked`, which the document export uses): fenced
 * and indented blocks, and code spans.
 */
function codeTexts(markdown: string): string[] {
  const out: string[] = [];
  const walk = (tokens: readonly Token[] | undefined): void => {
    for (const token of tokens ?? []) {
      if (token.type === "code" || token.type === "codespan") out.push(token.raw);
      if (token.type === "table") {
        const grid = token as Tokens.Table;
        for (const cell of grid.header) walk(cell.tokens);
        for (const row of grid.rows) for (const cell of row) walk(cell.tokens);
      } else if (token.type === "list") {
        for (const item of (token as Tokens.List).items) walk(item.tokens);
      } else if ("tokens" in token) {
        walk(token.tokens);
      }
    }
  };
  walk(Lexer.lex(markdown, { gfm: true }));
  return out;
}

/** The pieces of code that hold the marker text. */
function marksInCode(markdown: string): string[] {
  return codeTexts(markdown).filter((text) => text.includes("(not in schema"));
}

const TRAILING = [" ", "  ", "\t", " \t "];

/**
 * A document made of the structures the check reads and the ones it must leave
 * alone, with real, invented, near-miss, qualified and odd names in each.
 *
 * It emits every lexical shape the check branches on, because a byte-for-byte
 * property is only as wide as its generator (#1061 third review: the first
 * one wrote LF, backtick fences, full rows and no trailing white space, and
 * five text-deleting mutants passed it): LF, CRLF and mixed line endings; a
 * final newline or none; tabs; trailing white space on any line; backtick,
 * tilde and four-backtick fences, closed, unclosed and nested; indented code;
 * raw HTML; rows with fewer than two pipes, escaped pipes and empty cells;
 * one-, two- and three-backtick code spans, spans that hold a backtick,
 * unbalanced and escaped backticks; text that already looks like a marker;
 * headings with closing hashes; 20,000-character lines; non-ASCII text.
 */
function generatedDocument(seed: number): string {
  const random = seeded(seed);
  const chance = (p: number): boolean => random() < p;
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
    "Benutzerkonten — größe, 用户, naïve café 🙂 `größe`.",
    "The model wrote `jobs` *(not in schema)* here itself.",
    'Inline <br> HTML and <span class="x">`users.nope`</span>.',
    "A span holding a backtick: `` a`b `` and ``` `` ```, and a stray ` too.",
    "Tabs\tbetween\twords, an escaped \\` backtick and a trailing backslash \\",
  ];
  const name = (): string => pick(columns);
  /** A first cell: every way a name can be written in, beside or out of a code span. */
  const cell = (): string => {
    const shape = Math.floor(random() * 19);
    if (shape === 0) return `\`${name()}\``;
    if (shape === 1) return `\`${name()}\` / \`${name()}\``;
    if (shape === 2) return `\`${name()}\` (login) and \`${name()}\` — legacy`;
    if (shape === 3) return name();
    if (shape === 4) return "—";
    if (shape === 5) return `\`\`${name()}\`\``;
    if (shape === 6) return `\`\` \`${name()}\` \`\``;
    if (shape === 7) return `\`\`a\`${name()}\`\` and \`${name()}\``;
    if (shape === 8) return `\`${name()}`;
    if (shape === 9) return `\\\`${name()}\\\` and \\\`\`${name()}\``;
    if (shape === 10) return `\`${name()}\` *(not in schema)*`;
    if (shape === 11) return `\`${name()}\` *(not in schema; the schema has \`id\`)*`;
    if (shape === 12) return `\`${name()}\` as written *(not in schema)*`;
    if (shape === 13) return `\`${name()}\`*(not in schema)*`;
    if (shape === 14) return "";
    if (shape === 15) return `\`${name()}\\|x\` and \`${name()}\` \\| y`;
    if (shape === 16) return `<code>${name()}</code> \`${name()}\`<br>`;
    if (shape === 17) return `\`größe\` \`用户\` \`${name()}\``;
    return `\`\`\`${name()}\`\`\` \`\`${name()}\``;
  };
  /** A table row: full, short of pipes, tabbed, indented, very long. */
  const row = (rest: string): string => {
    const shape = Math.floor(random() * 14);
    if (shape === 0) return `| ${cell()}`;
    if (shape === 1) return `${cell()} | ${pick(types)}`;
    if (shape === 2) return pick(["|", "||", "| | |", "|  |"]);
    if (shape === 3) return `|\t${cell()}\t|\t${pick(types)}\t|`;
    if (shape === 4) return `  | ${cell()} | ${pick(types)} |${rest}`;
    if (shape === 5) return `    | ${cell()} | ${pick(types)} |${rest}`;
    if (shape === 6 && chance(0.2))
      return `| ${cell()} | ${pick(types)} | ${"wide ".repeat(4000)}|`;
    return `| ${cell()} | ${pick(types)} |${rest}`;
  };
  const heading = (): string => {
    const label = pick(["Entity", "Table", "Entities", "Tables"]);
    const table = pick(tables);
    const written = pick([
      `\`${table}\``,
      table,
      `\`${table}\` (audit schema)`,
      `\`${table}\` (public schema)`,
      `audit.\`${table}\``,
      `\`${table}\` and \`${pick(tables)}\``,
      `${table} and ${pick(tables)}`,
      `\`${table}\` (a view)`,
      `\`\`${table}\`\``,
      `\`${table}\` *(not in schema)*`,
      "`用户`",
    ]);
    const gap = pick([" ", " ", "\t", "  "]);
    const closing = pick(["", "", "", " ###", " #", " ##  ", "###"]);
    return `### ${label}:${gap}${written}${closing}`;
  };
  /** An entity heading and its field table: what the check judges when it is not code. */
  const entityBlock = (indent = ""): string[] => {
    const lines = [`${indent}${heading()}`, ""];
    if (chance(0.4)) lines.push(`${indent}${pick(prose)}`, "");
    lines.push(
      `${indent}${pick(["| Field | Type | Constraint | Description |", "| Field | Type | Constraint | Description |", "| Column | Type | Constraint | Description"])}`,
      `${indent}${pick(["|---|---|---|---|", "|---|---|---|---|", "| --- | :-- | --: | --- |", "|---|---|"])}`,
    );
    const rows = 1 + Math.floor(random() * 5);
    for (let r = 0; r < rows; r++) {
      lines.push(`${indent}${row(" FK → `users.id` | see `users.CreatedAt` |")}`);
    }
    return lines;
  };
  const erDiagram = (): string[] => {
    const lines = ["erDiagram"];
    for (let n = 0; n < 3; n++) {
      const entityId = pick(tables).toUpperCase().split(".").join("_");
      lines.push(`    ${entityId} ||--o{ ${pick(tables).toUpperCase()} : has`);
      lines.push(`    ${entityId}${chance(0.3) ? '["audit.users"]' : ""} {`);
      for (let a = 0; a < 3; a++) {
        const attribute = pick(columns);
        lines.push(
          chance(0.5) ? `        ${pick(types)} ${attribute} PK` : `        ${attribute} bigint`,
        );
      }
      lines.push("    }");
    }
    return lines;
  };
  /** `body` in a fence: backticks or tildes, three or more, closed by as many or more. */
  const fenced = (info: string, body: readonly string[]): string[] => {
    const char = pick(["`", "`", "~"]);
    const length = pick([3, 3, 4, 5]);
    const open = char.repeat(length);
    const close = char.repeat(length + pick([0, 0, 1]));
    return [`${open}${info}`, ...body, close];
  };

  const out: string[] = ["## Data Architecture", ...(chance(0.8) ? [""] : []), pick(prose), ""];
  const blocks = 3 + Math.floor(random() * 6);
  for (let b = 0; b < blocks; b++) {
    const kind = Math.floor(random() * 12);
    if (kind === 0) {
      out.push(...fenced("mermaid", erDiagram()), "");
    } else if (kind === 1 || kind === 2) {
      out.push(...entityBlock(), "");
    } else if (kind === 3) {
      out.push("### Tables and Their Roles", "", "| Table | Purpose |", "|---|---|");
      for (let r = 0; r < 3; r++) {
        out.push(
          chance(0.2)
            ? `| \`\`${pick(tables)}\`\` | ${pick(prose)} |`
            : `| \`${pick(tables)}\` | ${pick(prose)} |`,
        );
      }
      out.push("");
    } else if (kind === 4) {
      out.push("#### `Feed` struct", "", "| Field | Type |", "|---|---|");
      out.push(row(""), "");
    } else if (kind === 5) {
      out.push(...fenced("go", ["type Job struct { ID int64 }", "", ...entityBlock()]), "");
    } else if (kind === 6) {
      // A longer fence that holds shorter ones, of both kinds: none closes it.
      const inner = ["```", ...entityBlock(), "```", "~~~", ...entityBlock(), "~~~", "```go"];
      const char = pick(["`", "~"]);
      out.push(`${char.repeat(4)}markdown`, ...inner, char.repeat(4), "");
    } else if (kind === 7) {
      // Indented far enough to be a code block, alone or under a real heading.
      const indent = pick(["    ", "\t", "     ", "  \t"]);
      if (chance(0.5)) out.push(heading(), "");
      out.push(...entityBlock(indent).filter((line) => line.trim() !== ""), "");
      if (chance(0.5)) out.push("| Field | Type |", "|---|---|", row(""), "");
    } else if (kind === 8) {
      const shape = Math.floor(random() * 4);
      if (shape === 0) out.push("<pre>", ...entityBlock(), "</pre>", "");
      else if (shape === 1)
        out.push(
          "<details>",
          "<summary>Tables</summary>",
          "",
          ...entityBlock(),
          "",
          "</details>",
          "",
        );
      else if (shape === 2) out.push("<!--", ...entityBlock(), "-->", "");
      else
        out.push(
          '<div class="note">',
          ...entityBlock().filter((line) => line !== ""),
          "</div>",
          "",
        );
    } else if (kind === 9) {
      out.push("- a step", "", "    ```sql", "    | Field | Type |", "    ```", "");
    } else if (kind === 10 && chance(0.3)) {
      out.push(`${"A very long line of prose with `jobs` in it. ".repeat(450)}`, "");
    } else {
      out.push(pick(prose), "");
    }
  }
  // A block the text never closes: everything after it is code to a renderer.
  if (chance(0.15)) {
    out.push(pick(["```sql", "~~~", "````text", "<pre>", "<!-- unfinished"]), ...entityBlock());
  }
  if (chance(0.5)) out.push("");

  const mode = seed % 3;
  let text = "";
  out.forEach((line, at) => {
    const written = chance(0.2) ? `${line}${pick(TRAILING)}` : line;
    const last = at === out.length - 1;
    const eol = mode === 0 ? "\n" : mode === 1 ? "\r\n" : chance(0.5) ? "\r\n" : "\n";
    text += last ? written : `${written}${eol}`;
  });
  return text;
}

/**
 * Whether `output` is `input` plus the whole-line blocks `applySchemaGrounding`
 * may insert (the note, the reference), each once, each with at most one blank
 * line of its own on either side, plus markers. Every way of taking a block and
 * its blank lines out is tried; one of them has to give back `input` exactly.
 */
function isInputPlusBlocks(
  output: string,
  input: string,
  inserted: readonly string[],
  markers: readonly string[],
): boolean {
  let candidates: string[][] = [output.split("\n")];
  for (const block of inserted.filter(Boolean).map((text) => text.split("\n"))) {
    const next: string[][] = [];
    for (const lines of candidates) {
      const starts: number[] = [];
      for (let at = 0; at + block.length <= lines.length; at++) {
        if (block.every((line, k) => lines[at + k] === line)) starts.push(at);
      }
      // Inserted once.
      if (starts.length !== 1) continue;
      const [at] = starts;
      for (const before of [0, 1]) {
        for (const after of [0, 1]) {
          if (before && lines[at - 1] !== "") continue;
          if (after && lines[at + block.length] !== "") continue;
          next.push([...lines.slice(0, at - before), ...lines.slice(at + block.length + after)]);
        }
      }
    }
    candidates = next;
  }
  return candidates.some((lines) => withoutAdded(lines.join("\n"), input, markers).text === input);
}

describe("the check only marks (#1061 second and third review)", () => {
  /** Two schemas read, so a heading's `(audit schema)` names one that was. */
  const TWO_SCHEMAS = liveInventory(
    [...TABLES, table("events", { id: "bigint", actor_ip: "inet" }, { schema: "audit" })],
    [{ connector: "miniflux-pg", how: "live", schemas: ["audit", "public"] }],
  );
  const INVENTORIES: Record<string, SchemaInventory> = {
    live: LIVE,
    stored: STORED,
    "repository SQL": REPO_SQL,
    "one database unread": ONE_UNREAD,
    "two schemas read": TWO_SCHEMAS,
  };
  const SEEDS = Array.from({ length: 180 }, (_, n) => n + 1);
  const DOCUMENTS = SEEDS.map((seed) => ({
    seed,
    input: generatedDocument(seed),
  }));

  it("the generator emits every lexical shape the check branches on", () => {
    const all = DOCUMENTS.map((document) => document.input);
    const some = (test: (text: string) => boolean): number => all.filter(test).length;
    const shapes: Record<string, number> = {
      "LF only": some((t) => !t.includes("\r")),
      "CRLF only": some((t) => t.includes("\r\n") && !/[^\r]\n/.test(t)),
      "mixed line endings": some((t) => t.includes("\r\n") && /[^\r]\n/.test(t)),
      "a final newline": some((t) => t.endsWith("\n")),
      "no final newline": some((t) => !t.endsWith("\n")),
      "a tab": some((t) => t.includes("\t")),
      "trailing white space on a heading": some((t) => /^#{2,4} .*[ \t]\r?$/m.test(t)),
      "trailing white space on a table row": some((t) => /^\|.*\|[ \t]+\r?$/m.test(t)),
      "trailing white space on a fence": some((t) => /^(```|~~~)\w*[ \t]+\r?$/m.test(t)),
      "trailing white space on a blank line": some((t) => /^[ \t]+\r?$/m.test(t)),
      "a tilde fence": some((t) => /^~~~/m.test(t)),
      "a four-backtick fence holding a three-backtick line": some((t) =>
        /^````markdown\r?\n```[ \t]*\r?$/m.test(t),
      ),
      "an unclosed fence": some((t) =>
        /\n(```sql|~~~|````text)[ \t]*\r?\n(?![\s\S]*\n(```|~~~)[ \t]*\r?(\n|$))/.test(t),
      ),
      "an indented code block": some((t) => /^( {4}|\t)\| /m.test(t)),
      "a row with fewer than two pipes": some((t) => /^\| [^|\n]*$/m.test(t)),
      "an escaped pipe": some((t) => t.includes("\\|")),
      "an empty cell": some((t) => /^\|\s*\|/m.test(t)),
      "a double-backtick span": some((t) => /``[a-z_.]+``/i.test(t)),
      "a span holding a backtick": some((t) => /`` `[a-z_.]+` ``/i.test(t)),
      "a marker lookalike the model wrote": some((t) => t.includes("*(not in schema)*")),
      "a heading with closing hashes": some((t) => /^### .*#[ \t]*\r?$/m.test(t)),
      "raw HTML": some((t) => /^<(pre|details|div|!--)/m.test(t)),
      "a 20,000-character line": some((t) => t.split("\n").some((line) => line.length >= 20_000)),
      "non-ASCII text": some((t) => t.includes("用户") && t.includes("größe")),
    };
    for (const [shape, count] of Object.entries(shapes)) {
      expect(count, shape).toBeGreaterThan(0);
    }
  });

  for (const [name, inventory] of Object.entries(INVENTORIES)) {
    const markers = markersFor(inventory);

    it(`what the check added removed, the output is the input byte for byte: ${name}`, () => {
      let marked = 0;
      for (const { seed, input } of DOCUMENTS) {
        const { markdown } = checkSchemaClaims(input, inventory);
        if (markdown !== input) marked += 1;
        expect(withoutAdded(markdown, input, markers).text, `seed ${seed}`).toBe(input);
      }
      // The generator does produce documents the check marks.
      expect(marked).toBeGreaterThan(SEEDS.length / 30);
    });

    it(`no marker lands inside code, by an independent parser: ${name}`, () => {
      for (const { seed, input } of DOCUMENTS) {
        const { markdown } = checkSchemaClaims(input, inventory);
        if (markdown === input) continue;
        expect(marksInCode(markdown), `seed ${seed}`).toEqual(marksInCode(input));
      }
    });

    it(`with the note and the reference taken out as well: ${name}`, () => {
      for (const { seed, input } of DOCUMENTS) {
        const { markdown, report } = applySchemaGrounding(input, inventory);
        const notice = renderSchemaCheckNotice(report, inventory);
        const reference = renderSchemaReference(inventory);
        expect(
          isInputPlusBlocks(markdown, input, [notice, reference], markers),
          `seed ${seed}`,
        ).toBe(true);
        // Neither is put where a renderer would show it as code.
        const code = codeTexts(markdown).join("\n");
        if (notice) expect(code, `seed ${seed}`).not.toContain("**Schema check.**");
        if (reference) expect(code, `seed ${seed}`).not.toContain("### Schema Reference");
      }
    });

    it(`is idempotent, checked again it adds nothing: ${name}`, () => {
      for (const { seed, input } of DOCUMENTS) {
        const once = checkSchemaClaims(input, inventory).markdown;
        expect(checkSchemaClaims(once, inventory).markdown, `seed ${seed}`).toBe(once);
      }
    });
  }

  it("keeps every line, in order, and adds none", () => {
    const markers = markersFor(LIVE);
    for (const { seed, input } of DOCUMENTS) {
      const before = input.split("\n");
      const output = checkSchemaClaims(input, LIVE).markdown.split("\n");
      expect(output).toHaveLength(before.length);
      output.forEach((line, at) => {
        // A line is the one the model wrote, or that line with markers in it.
        expect(withoutAdded(line, before[at], markers).text, `seed ${seed} line ${at}`).toBe(
          before[at],
        );
      });
    }
  });

  // The idempotence rule, which is also how a lookalike is told from a mark:
  // a name directly followed by ` *(not in schema` is taken as already marked
  // and nothing is added there. The check cannot tell a marker it wrote on an
  // earlier pass from the same words written by the model, and does not need
  // to: either way the reader sees the name marked once.
  it("takes a name the model already marked as marked, and adds no second mark", () => {
    const written = entity("users", "| `nope` *(not in schema)* | int |\n| `nope2` | int |");
    const { markdown, report } = check(written);
    expect(markdown).toBe(written.replace("| `nope2` |", "| `nope2` *(not in schema)* |"));
    expect(report.flaggedColumns).toEqual(["users.nope", "users.nope2"]);
    // The model's own words elsewhere in the row or in prose are not a mark.
    const apart = entity("users", "| `nope` as written *(not in schema)* | int |");
    expect(check(apart).markdown).toBe(
      apart.replace("`nope` as written", "`nope` *(not in schema)* as written"),
    );
    const { text, added } = withoutAdded(check(apart).markdown, apart, markersFor(LIVE));
    expect(text).toBe(apart);
    expect(added).toHaveLength(1);
    // A lookalike after a REAL name is the model's text and is left alone.
    const real = entity("users", "| `id` *(not in schema)* | int |");
    expect(check(real).markdown).toBe(real);
  });

  it("is idempotent on a heading that names its schema in a parenthesis", () => {
    const section = `### Entity: \`events\` (public schema)\n\n${FIELD}| \`nope\` | int |`;
    const once = check(section, TWO_SCHEMAS).markdown;
    expect(once).toContain("### Entity: `events` *(not in schema)* (public schema)");
    // Checked again, the name is still `public.events`: the marker's own
    // parenthesis is not taken for the heading's, so `events` is not looked
    // for (and found) in the other schema, and its rows are not judged.
    expect(check(once, TWO_SCHEMAS).markdown).toBe(once);
    const bare = `### Entities: users and jobs\n\n${FIELD}| \`users.nope\` | int |`;
    const marked = check(bare).markdown;
    expect(marked).toContain("### Entities: users and jobs *(not in schema)*");
    expect(check(marked).markdown).toBe(marked);
    expect(check(marked).report.unresolvedTables).toEqual(["jobs"]);
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

  it("a read the driver reports as cut is not taken to hold every table (#1096)", () => {
    const truncated = liveInventory(TABLES, [
      {
        connector: "ora",
        how: "live",
        schemas: ["public"],
        truncation: { tablesRead: 3, tablesTotal: 4000 },
      },
    ]);
    const { report } = check("| Table | Purpose |\n|---|---|\n| `zz_last` | — |", truncated);
    expect(report.unresolvedTables).toEqual([]);
    expect(notChecked(report, "unread")).toEqual(["zz_last"]);
    expect(renderSchemaCheckNotice(report, truncated)).toContain(
      '> - The schema was read partially: "ora" 3 of 4,000 tables were read, so tables are ' +
        "missing from it.",
    );
  });

  it("a cut read is noted even when every name matched (#1096)", () => {
    const truncated = liveInventory(TABLES, [
      { connector: "ora", how: "live", schemas: ["public"], truncation: { tablesRead: 3 } },
    ]);
    const { report } = check("| Table | Purpose |\n|---|---|\n| `users` | — |", truncated);
    expect(report.unresolvedTables).toEqual([]);
    const notice = renderSchemaCheckNotice(report, truncated);
    expect(notice).toContain("**Schema check.**");
    expect(notice).toContain('"ora" 3 tables (the total could not be counted) were read');
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
    // Repository SQL is not a database read, and the note does not call it one.
    const fromSql = renderSchemaCheckNotice(check(RUN7, REPO_SQL).report, REPO_SQL);
    expect(fromSql.split("\n")[0]).toContain(
      "compared with the SQL found in the repository. Nothing was removed or changed: a name " +
        "that could not be matched is marked **not in schema** where it stands. The repository's " +
        "SQL is not the database (it can lack objects, and can include ones a later migration " +
        "dropped), so a marked name is one to verify, not necessarily a mistake.",
    );
    expect(fromSql).not.toContain("A database read can be incomplete");
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
    const clean = entity("users", "| `id` | int |\n| `username` | text |");
    const { report } = check(clean);
    expect(report.matched).toBe(3);
    // The clean section's line is `checkDataArchitectureText`'s, written over
    // the fitted text, so that it counts the section's sentences too (#1133).
    expect(renderSchemaCheckNotice(report, LIVE)).toBe("");
  });

  it("counts a name once however often it is written, and only names that matched", () => {
    const twice =
      entity("users", "| `id` | int |\n| `ghost` | int |") +
      "\n\n" +
      entity("users", "| `id` | int |");
    const { report } = check(twice);
    expect(report.matched).toBe(2);
    expect(report.flaggedColumns).toEqual(["users.ghost"]);
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
// Where a marker may go (#1061 third review)
// ---------------------------------------------------------------------------

describe("a marker never lands inside code", () => {
  /** Unchanged, and to the independent parser no code holds a marker. */
  const expectUntouched = (section: string, inventory: SchemaInventory = LIVE): void => {
    expect(check(section, inventory).markdown).toBe(section);
  };

  it("goes after the whole closing run of a double-backtick span", () => {
    const { markdown, report } = check(entity("users", "| ``nope`` | int |"));
    expect(markdown).toContain("| ``nope`` *(not in schema)* | int |");
    expect(report.flaggedColumns).toEqual(["users.nope"]);
    expect(marksInCode(markdown)).toEqual([]);
    // Padded with a space on each side, the name is the same name.
    expect(check(entity("users", "| `` nope `` | int |")).markdown).toContain(
      "| `` nope `` *(not in schema)* | int |",
    );
    expect(check(entity("users", "| `` id `` | int |")).report.flaggedColumns).toEqual([]);
  });

  it("does not take the inside of a span that holds backticks for a span of its own", () => {
    // Read as pairs of single backticks, `nope` is a span and the marker would
    // go between the span's two closing backticks.
    for (const cell of ["`` `nope` ``", "``a`nope``", "``` ``nope`` ```", "``nope`x``"]) {
      const section = entity("users", `| ${cell} | int |`);
      expectUntouched(section);
      expect(check(section).report.flaggedColumns).toEqual([]);
    }
    // A real span beside one still gets its mark, after its own closing backtick.
    const { markdown } = check(entity("users", "| ``a`b`` and `nope` | int |"));
    expect(markdown).toContain("| ``a`b`` and `nope` *(not in schema)* | int |");
    expect(marksInCode(markdown)).toEqual([]);
  });

  it("reads a backtick behind a backslash, or without a partner, as text", () => {
    expectUntouched(entity("users", "| \\`nope\\` | int |"));
    expectUntouched(entity("users", "| `nope | int |"));
    // The escaped backtick opens nothing, so the span is the one after it.
    const { markdown } = check(entity("users", "| \\``nope` | int |"));
    expect(markdown).toContain("| \\``nope` *(not in schema)* | int |");
    expect(marksInCode(markdown)).toEqual([]);
    // Two backslashes are a backslash, and the backtick after them opens a span.
    expect(check(entity("users", "| \\\\`nope` | int |")).markdown).toContain(
      "| \\\\`nope` *(not in schema)* | int |",
    );
  });

  it("codeSpans delimits a span by a run of the same length", () => {
    expect(codeSpans("``a`b`` and `c` and ``` `` ``` and `d")).toEqual(["a`b", "c", "``"]);
    expect(codeSpans("`` ` ``")).toEqual(["`"]);
    expect(codeSpans("\\`a\\` `b`")).toEqual(["b"]);
    expect(codeSpans("`a``b`")).toEqual(["a``b"]);
  });

  it("leaves a field table indented as a code block alone, under an Entity heading too", () => {
    for (const indent of ["    ", "\t", "  \t", "     "]) {
      const table = `${indent}| Field | Type |\n${indent}|---|---|\n${indent}| \`nope\` | int |`;
      const section = `### Entity: \`users\`\n\n${table}`;
      expectUntouched(section);
      expect(schemaCheckFindings(check(section).report)).toBe(0);
    }
    // Three spaces is still a table.
    const three = "### Entity: `users`\n\n   | Field | Type |\n   |---|---|\n   | `nope` | int |";
    expect(check(three).markdown).toContain("   | `nope` *(not in schema)* | int |");
  });

  it("an indented field table is still the heading's first table: it takes the heading with it", () => {
    const section = [
      "### Entity: `ghosts`",
      "",
      "    | Field | Type |",
      "    |---|---|",
      "    | `nope` | int |",
      "",
      "| Field | Type |",
      "|---|---|",
      "| `later` | int |",
    ].join("\n");
    const { markdown, report } = check(section);
    // The heading is not code: its own name is judged and marked.
    expect(markdown).toBe(section.replace("`ghosts`", "`ghosts` *(not in schema)*"));
    expect(report.unresolvedTables).toEqual(["ghosts"]);
    // The later table is not judged as the heading's.
    const known = check(section.replace("ghosts", "users"));
    expect(known.markdown).toBe(section.replace("ghosts", "users"));
    expect(known.report.flaggedColumns).toEqual([]);
    // Indented with a tab, which is four columns, it does the same.
    const tabbed = section.replace("ghosts", "users").split("    |").join("\t|");
    expect(tabbed).toContain("\t| `nope` | int |");
    expect(check(tabbed).markdown).toBe(tabbed);
    expect(check(tabbed).report.flaggedColumns).toEqual([]);
  });

  it("an indented row ends the table it follows", () => {
    const section = entity("users", "| `nope` | int |\n    | `nope2` | int |\n| `nope3` | int |");
    const { markdown } = check(section);
    expect(markdown).toBe(section.replace("| `nope` |", "| `nope` *(not in schema)* |"));
  });

  it("a four-backtick fence is not closed by a three-backtick line inside it", () => {
    const inner = `${entity("users", "| `nope` | int |")}`;
    for (const [open, close] of [
      ["````markdown", "````"],
      ["````", "`````"],
      ["~~~~", "~~~~"],
    ]) {
      const section = `${open}\n\`\`\`\n${inner}\n\`\`\`\n${close}\n\nAfter.`;
      expectUntouched(section);
      expect(schemaCheckFindings(check(section).report)).toBe(0);
    }
    // Closed properly, what follows the fence is judged again.
    const after = `\`\`\`\`\n\`\`\`\n\`\`\`\`\n\n${inner}`;
    expect(check(after).report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("a fence is closed only by its own character, with nothing after it", () => {
    const inner = entity("users", "| `nope` | int |");
    // A tilde fence is not closed by backticks, nor a fence by one that opens another.
    expectUntouched(`~~~\n\`\`\`\n${inner}\n~~~`);
    expectUntouched(`\`\`\`\n\`\`\`go\n${inner}\n\`\`\``);
    expectUntouched(`\`\`\`\n~~~\n${inner}`);
    // Fewer than three, or indented four spaces, opens nothing.
    expect(check(`\`\`\n\n${inner}`).report.flaggedColumns).toEqual(["users.nope"]);
    expect(check(`    \`\`\`\n\n${inner}`).report.flaggedColumns).toEqual(["users.nope"]);
    // Backticks later on the line make it a code span, not a fence.
    expect(check(`\`\`\`a\`\`\` text\n\n${inner}`).report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("where the viewer's parser and the export's disagree on a closing fence, it is code", () => {
    const inner = entity("users", "| `nope` | int |");
    // A tab after the fence closes it for CommonMark and not for `marked`.
    const tab = `\`\`\`\ncode\n\`\`\`\t\n\n${inner}`;
    expectUntouched(tab);
    expect(marksInCode(check(tab).markdown)).toEqual([]);
    // A run that goes on in the other character closes it for `marked` only.
    const mixed = `\`\`\`\ncode\n\`\`\`~\n\n${inner}\n\n\`\`\`\n\n${inner}`;
    expectUntouched(mixed);
    // Trailing spaces close it for both.
    expect(check(`\`\`\`\ncode\n\`\`\`  \n\n${inner}`).report.flaggedColumns).toEqual([
      "users.nope",
    ]);
    // A diagram in a fence closed that way is still read, as the viewer draws it.
    const drawn = `\`\`\`mermaid\nerDiagram\n    USERS ||--o{ GHOSTS : x\n\`\`\`\t\n\n${inner}`;
    expectUntouched(drawn);
    expect(check(drawn).report.unresolvedTables).toEqual(["GHOSTS"]);
  });

  it("leaves raw HTML blocks alone", () => {
    const inner = entity("users", "| `nope` | int |");
    // To the closing tag, blank lines included.
    expectUntouched(`<pre>\n${inner}\n</pre>`);
    expectUntouched(`<PRE class="x">\n${inner}`);
    expectUntouched(`<!--\n${inner}\n-->`);
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- test input for the claim check, which must copy a raw HTML block as written; the string is never rendered.
    expectUntouched(`<script>\n\n${inner}\n</script>`);
    // Any other tag: to the next blank line.
    expectUntouched(`<div>\n${inner.split("\n").filter(Boolean).join("\n")}\n</div>`);
    const details = `<details>\n<summary>x</summary>\n\n${inner}\n\n</details>`;
    expect(check(details).report.flaggedColumns).toEqual(["users.nope"]);
    // After the block ends, the text is judged again.
    expect(check(`<pre>\ncode\n</pre>\n\n${inner}`).report.flaggedColumns).toEqual(["users.nope"]);
    expect(check(`<!-- note -->\n\n${inner}`).report.flaggedColumns).toEqual(["users.nope"]);
    // A `<` that starts no tag is text.
    expect(
      check(`### Entity: \`users\`\n\n< 5 rows each\n${FIELD}| \`nope\` | int |`).report
        .flaggedColumns,
    ).toEqual(["users.nope"]);
    expect(check(`<preface>\n\n${inner}`).report.flaggedColumns).toEqual(["users.nope"]);
  });

  it("judges nothing in lines no renderer draws as a table", () => {
    // Header and delimiter rows of different cell counts are a paragraph, where
    // a code span can run across the pipes.
    const two = "### Entity: `users`\n\n| Field | Type | `` |\n|---|---|\n| `nope` `` | int |";
    expectUntouched(two);
    const one = "### Entity: `users`\n\n| Field | Type |\n|---|\n| `nope` | int |";
    expectUntouched(one);
    // An escaped pipe is no pipe when the cells are counted.
    const escaped = "### Entity: `users`\n\n| Field | Type \\| x |\n|---|---|\n| `nope` | int |";
    expect(check(escaped).report.flaggedColumns).toEqual(["users.nope"]);
    // A delimiter row is dashes and colons between pipes, with spaces only.
    for (const delimiter of ["|---|---|\t", "|\t---|---|", "|---|:|", "|---|- -|", "| | |"]) {
      expectUntouched(
        `### Entity: \`users\`\n\n| Field | Type |\n${delimiter}\n| \`nope\` | int |`,
      );
    }
    for (const delimiter of ["| :--- | ---: |", "|:-:|-|  ", "   |---|---|", "|---|---"]) {
      const section = `### Entity: \`users\`\n\n| Field | Type |\n${delimiter}\n| \`nope\` | int |`;
      expect(check(section).report.flaggedColumns, delimiter).toEqual(["users.nope"]);
    }
  });
});

describe("line endings and heading shapes", () => {
  it("judges a CRLF document as it does the LF one, and keeps every carriage return", () => {
    const crlf = RUN7.split("\n").join("\r\n");
    const lf = check(RUN7);
    const { markdown, report } = check(crlf);
    expect(report).toEqual(lf.report);
    expect(markdown).toBe(lf.markdown.split("\n").join("\r\n"));
    // A name written without backticks ends before the carriage return.
    const bare = check(`### Entity: ghosts\r\n\r\n${FIELD}| \`a\` | int |`);
    expect(bare.markdown.split("\n")[0]).toBe("### Entity: ghosts *(not in schema)*\r");
  });

  it("reads a heading's names before its closing hashes and trailing white space", () => {
    expect(parseHeading("### Entity: users ###")?.names).toEqual([{ name: "users", end: 17 }]);
    expect(parseHeading("### Entity: users #  \t")?.names).toEqual([{ name: "users", end: 17 }]);
    expect(parseHeading("### Entity: `users` ##")?.names).toEqual([{ name: "users", end: 19 }]);
    expect(parseHeading("### Tables: users and ghosts ##\r")?.names.map((n) => n.name)).toEqual([
      "users",
      "ghosts",
    ]);
    // Hashes that are part of a word are not a closing run.
    expect(parseHeading("### Entity: users#")?.names).toEqual([]);
    const { markdown } = check(`### Entity: ghosts ###\n\n${FIELD}| \`a\` | int |`);
    expect(markdown.split("\n")[0]).toBe("### Entity: ghosts *(not in schema)* ###");
  });
});

// ---------------------------------------------------------------------------
// Never judged against nothing, per table (#1061 third panel)
// ---------------------------------------------------------------------------

describe("a table whose columns are not known is not judged by column", () => {
  /** `orders` is known by name only, as an ORM call site leaves it. */
  const NAME_ONLY: SchemaInventory = {
    ...REPO_SQL,
    tables: [...REPO_SQL.tables, { schema: "", name: "orders", columns: [], foreignKeys: [] }],
  };

  it("marks none of its field-table rows, and lists the table once", () => {
    const section = entity(
      "orders",
      "| `id` | int |\n| `total` | numeric |\n| `placed_at` | date |",
    );
    const { markdown, report } = check(section, NAME_ONLY);
    expect(markdown).toBe(section);
    expect(schemaCheckUnmatched(report)).toEqual([]);
    expect(report.notChecked).toEqual([{ name: "orders", why: "no-columns" }]);
    expect(renderSchemaCheckNotice(report, NAME_ONLY).split("\n").slice(1)).toEqual([
      "> - Columns not checked (no column list for this table): `orders`.",
    ]);
  });

  it("still judges the table's name, and the columns of every other table", () => {
    const section = [
      entity("orders", "| `id` | int |"),
      entity("users", "| `nope` | int |"),
      entity("ghosts", "| `a` | int |"),
    ].join("\n\n");
    const { report } = check(section, NAME_ONLY);
    expect(report.flaggedColumns).toEqual(["users.nope"]);
    expect(report.unresolvedTables).toEqual(["ghosts"]);
    expect(notChecked(report, "no-columns")).toEqual(["orders"]);
  });

  it("does the same in a diagram", () => {
    const section = diagram(
      "    ORDERS {",
      "        int id",
      "        numeric total",
      "    }",
      "    USERS {",
      "        int nope",
      "    }",
    );
    const { markdown, report } = check(section, NAME_ONLY);
    expect(markdown).toBe(section);
    expect(report.flaggedColumns).toEqual(["users.nope"]);
    expect(report.inDiagram).toEqual(["users.nope"]);
    expect(notChecked(report, "no-columns")).toEqual(["orders"]);
  });

  it("on every tier: a table a live read returned without columns", () => {
    const inventory = liveInventory([...TABLES, table("orders", {})]);
    const { markdown, report } = check(entity("orders", "| `id` | int |"), inventory);
    expect(markdown).toBe(entity("orders", "| `id` | int |"));
    expect(notChecked(report, "no-columns")).toEqual(["orders"]);
  });

  it("when a heading names two tables and one has no columns, a name that fits neither is not judged", () => {
    const section = `### Entities: \`users\` and \`orders\`\n\n${FIELD}| \`id\` | int |\n| \`total\` | numeric |\n| \`users.nope\` | int |\n| \`orders.total\` | int |`;
    const { markdown, report } = check(section, NAME_ONLY);
    // `total` may be a column of `orders`; `users.nope` can only be one of `users`.
    expect(markdown).toBe(
      section.replace("| `users.nope` |", "| `users.nope` *(not in schema)* |"),
    );
    expect(report.flaggedColumns).toEqual(["users.nope"]);
    expect(notChecked(report, "no-columns")).toEqual(["orders"]);
  });
});

// ---------------------------------------------------------------------------
// A dataset is not a table (#1061 third review, low 5)
// ---------------------------------------------------------------------------

describe("repository SQL: an entity the prompt asked for that is a dataset", () => {
  const WITH_DATASETS: SchemaInventory = {
    ...REPO_SQL,
    datasets: ["work.sales", "claims_raw"],
  };

  it("lists a dataset's heading as not checked instead of marking it", () => {
    const section = [
      entity("claims_raw", "| `claim_id` | num |"),
      entity("SALES", "| `amount` | num |"),
      entity("work.sales", "| `amount` | num |"),
      entity("ghosts", "| `a` | int |"),
    ].join("\n\n");
    const { markdown, report } = check(section, WITH_DATASETS);
    // Only the name that is neither a table nor a dataset is marked.
    expect(markdown).toBe(section.replace("`ghosts`", "`ghosts` *(not in schema)*"));
    expect(report.unresolvedTables).toEqual(["ghosts"]);
    expect(notChecked(report, "dataset")).toEqual(["claims_raw", "SALES", "work.sales"]);
    expect(schemaCheckUnmatched(report)).toEqual(["ghosts"]);
    expect(renderSchemaCheckNotice(report, WITH_DATASETS)).toContain(
      "> - Not checked (a dataset in the code's data lineage, not a database table): " +
        "`claims_raw`, `SALES`, `work.sales`.",
    );
  });

  it("in a diagram and in a table of tables too", () => {
    const drawn = check(diagram("    SALES ||--o{ GHOSTS : feeds"), WITH_DATASETS);
    expect(drawn.report.unresolvedTables).toEqual(["GHOSTS"]);
    expect(notChecked(drawn.report, "dataset")).toEqual(["SALES"]);
    const roster = "| Table | Purpose |\n|---|---|\n| `claims_raw` | input |\n| `ghosts` | — |";
    const listed = check(roster, WITH_DATASETS);
    expect(listed.markdown).toBe(roster.replace("`ghosts`", "`ghosts` *(not in schema)*"));
    expect(notChecked(listed.report, "dataset")).toEqual(["claims_raw"]);
  });

  it("a table of that name is still a table, and without datasets nothing changes", () => {
    const both: SchemaInventory = { ...REPO_SQL, datasets: ["users"] };
    expect(check(entity("users", "| `nope` | int |"), both).report.flaggedColumns).toEqual([
      "users.nope",
    ]);
    const section = entity("claims_raw", "| `claim_id` | num |");
    expect(check(section, REPO_SQL).report.unresolvedTables).toEqual(["claims_raw"]);
    expect(check(section, { ...REPO_SQL, datasets: [" ", ""] }).report.unresolvedTables).toEqual([
      "claims_raw",
    ]);
  });
});
// ---------------------------------------------------------------------------
// Where the note and the reference go (#1061 third review)
// ---------------------------------------------------------------------------

describe("applySchemaGrounding: the reference is never put inside the model's code", () => {
  const REFERENCE = renderSchemaReference(LIVE);

  it("with an unclosed fence and no sub-section, goes under the heading, before the body", () => {
    for (const open of ["```sql", "~~~", "````text", "<pre>", "<!-- never closed"]) {
      const body = `Stored in PostgreSQL.\n\n${open}\nselect * from users;`;
      const { markdown } = applySchemaGrounding(`## Data Architecture\n\n${body}`, LIVE);
      // At the end it would be inside the open block, and drawn as code.
      expect(markdown, open).toBe(`## Data Architecture\n\n${REFERENCE}\n\n${body}`);
      expect(codeTexts(markdown).join("\n"), open).not.toContain("### Schema Reference");
    }
  });

  it("puts the note first, then the reference, then the body the model wrote", () => {
    const body = `### Entity: \`ghosts\`\n\n${FIELD}| \`a\` | int |\n\n\`\`\`sql\nselect 1;`;
    const section = `## Data Architecture\n\n${body}`;
    const { markdown, report } = applySchemaGrounding(section, LIVE);
    const notice = renderSchemaCheckNotice(report, LIVE);
    // A sub-section outside the fence: the reference goes before it, as ever.
    expect(markdown).toBe(
      `## Data Architecture\n\n${notice}\n\n${REFERENCE}\n\n${body.replace("`ghosts`", "`ghosts` *(not in schema)*")}`,
    );
    // No sub-section outside the fence: under the heading and the note.
    const fenced = `## Data Architecture\n\nOne store.\n\n\`\`\`md\n${body}`;
    const open = applySchemaGrounding(fenced, ONE_UNREAD);
    expect(open.markdown).toBe(
      `## Data Architecture\n\n${renderSchemaReference(ONE_UNREAD)}\n\nOne store.\n\n\`\`\`md\n${body}`,
    );
  });

  it("with no heading at all, goes to the top", () => {
    const body = "```sql\nselect * from users;";
    expect(applySchemaGrounding(body, LIVE).markdown).toBe(`${REFERENCE}\n\n${body}`);
  });

  it("with every fence closed, still goes to the end", () => {
    const body = "## Data Architecture\n\nOne store.\n\n```sql\nselect 1;\n```";
    expect(applySchemaGrounding(body, LIVE).markdown).toBe(`${body}\n\n${REFERENCE}`);
    // A fence the export's parser leaves open (a tab after it) counts as open.
    const tab = "## Data Architecture\n\nOne store.\n\n```sql\nselect 1;\n```\t";
    expect(applySchemaGrounding(tab, LIVE).markdown).toBe(
      `## Data Architecture\n\n${REFERENCE}\n\nOne store.\n\n\`\`\`sql\nselect 1;\n\`\`\`\t`,
    );
  });

  it("does not take a `###` in a longer fence, an indented block or raw HTML for a sub-section", () => {
    for (const hidden of [
      "````md\n```\n### Not a heading\n```\n````",
      "    ### Not a heading",
      "<pre>\n### Not a heading\n</pre>",
    ]) {
      const section = `## Data Architecture\n\n${hidden}\n\n### Data Stores\n\nPostgreSQL.`;
      const { markdown } = applySchemaGrounding(section, LIVE);
      expect(markdown, hidden).toBe(
        `## Data Architecture\n\n${hidden}\n\n${REFERENCE}\n\n### Data Stores\n\nPostgreSQL.`,
      );
    }
  });

  it("does not take a `###` that only one of the two parsers reads as a heading", () => {
    // CommonMark: one fence, closed by the last line but one, then a heading.
    // `marked`: closed by "```~", then a heading, then a fence left open.
    const section =
      "## Data Architecture\n\n```\ncode\n```~\n### Code to CommonMark\n```\n\n### Code to marked";
    const { markdown } = applySchemaGrounding(section, LIVE);
    // Neither is a sub-section to both, and the text ends in code for one of
    // them: the reference goes under the heading.
    expect(markdown).toBe(section.replace("\n\n```\ncode", `\n\n${REFERENCE}\n\n\`\`\`\ncode`));
  });

  it("keeps the note a block of its own when the body starts on the next line", () => {
    const section = `## Data Architecture\nOne store.\n\n### Entity: \`ghosts\`\n\n${FIELD}| \`a\` | int |`;
    const { markdown, report } = applySchemaGrounding(section, REPO_SQL);
    const notice = renderSchemaCheckNotice(report, REPO_SQL);
    // Without the blank line after it, "One store." would be drawn inside the
    // note's quote (a paragraph continues a block quote).
    expect(markdown.startsWith(`## Data Architecture\n\n${notice}\n\nOne store.\n\n`)).toBe(true);
    // With a blank line already there, none is added.
    const spaced = applySchemaGrounding(section.replace("\nOne", "\n\nOne"), REPO_SQL).markdown;
    expect(spaced.startsWith(`## Data Architecture\n\n${notice}\n\nOne store.\n\n`)).toBe(true);
    // A CRLF blank line is a blank line.
    const crlf = applySchemaGrounding(section.split("\n").join("\r\n"), REPO_SQL).markdown;
    expect(crlf.startsWith(`## Data Architecture\r\n\n${notice}\n\nOne store.\r\n\r\n`)).toBe(true);
  });
});

describe("no schema to check against, with a database that could not be read", () => {
  const unread = (...connectors: string[]): SchemaInventory => ({
    source: "none",
    label: `no schema source; ${connectors.length} database(s) could not be read`,
    reads: connectors.map((connector) => ({
      connector,
      how: "unread",
      schemas: [],
    })),
    tables: [],
  });

  it("says the database could not be read, not that there is none", () => {
    const { markdown, report } = applySchemaGrounding(RUN7, unread("miniflux-pg"));
    expect(report.checked).toBe(false);
    expect(markdown.split("\n")[2]).toBe(
      '> **Schema not verified.** The project\'s database ("miniflux-pg") could not be read, and ' +
        "there is no database document and no SQL schema in the code graph, so the table and " +
        "column names in this section come from the code analysis alone and were not checked.",
    );
    expect(markdown).not.toContain("no connected database");
    expect(markdown).not.toContain("not in schema");
    expect(renderSchemaCheckNotice(report, unread("a", "b"))).toContain(
      'The project\'s databases ("a", "b") could not be read, and',
    );
  });

  it("with no database at all, still says there is none", () => {
    expect(
      renderSchemaCheckNotice(check(RUN7, NO_SCHEMA_INVENTORY).report, NO_SCHEMA_INVENTORY),
    ).toBe(
      "> **Schema not verified.** No database schema was available for this project (no " +
        "connected database, no database document and no SQL schema in the code graph), so the " +
        "table and column names in this section come from the code analysis alone and were not " +
        "checked.",
    );
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
    "backtick runs of every length": (size) => {
      let text = "";
      for (let run = 1; text.length < size; run++) text += `${"`".repeat(run)}a`;
      return `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n| ${text} | int |`;
    },
    "escaped backticks": (size) =>
      `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n| ${"\\\\\\`".repeat(size / 4)} | int |`,
    "a wall of backslashes before a span": (size) =>
      `### Entity: \`users\`\n\n| Field | Type |\n|---|---|\n| ${"\\".repeat(size)}\`a\` | int |`,
    "fences of both kinds, none closing the other": (size) => "```\n~~~\n````\n".repeat(size / 13),
    "fences closed for one parser only": (size) => "```\n```\t\n```~\n".repeat(size / 13),
    "raw HTML lines": (size) => "<div>\n<pre>\n<!--\n".repeat(size / 16),
    "indented lines": (size) => "    | `a` | int |\n".repeat(size / 18),
    "headings with closing hashes": (size) => `### Entity: users ${"#".repeat(size)}`,
    "a heading already marked many times": (size) =>
      `### Entity: \`ghosts\`${" *(not in schema)*".repeat(size / 18)}\n\n| Field | Type |\n|---|---|\n| \`a\` | int |`,
    "delimiter rows of many cells": (size) =>
      `| Field | Type |\n${"|---".repeat(size / 4)}|\n| \`a\` | int |`,
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

// ---------------------------------------------------------------------------
// #1133 — names written as tables or columns in the text of any section
// ---------------------------------------------------------------------------

describe("checkProseSchemaClaims (#1133)", () => {
  const prose = (markdown: string, inventory: SchemaInventory = LIVE) =>
    checkProseSchemaClaims(markdown, inventory);
  const M = " *(not in schema)*";

  describe("walkthrough run 8: `certificate_cache`, outside Data Architecture", () => {
    // The two lines of the exported `architecture.md` (2077 and 2223), as written.
    const OPERATIONS =
      "- **TLS:** HTTPS can be configured automatically via Let's Encrypt (ACME) or with custom " +
      "certificates; HTTP/2 is supported when TLS is enabled. ACME certificates are persisted " +
      "through an `autocert.Cache` adapter backed by PostgreSQL (`certificate_cache`), with rows " +
      "upserted using `updated_at = now()`, and conformance is asserted at compile time via " +
      "`var _ autocert.Cache = (*certificateCache)(nil)`[^src-24].";
    const STACK =
      '- **Key tables:** `users`, `categories` (a default `"All"` category per user), ' +
      "`integrations` (one default row per user), `api_keys`, `webauthn_credentials`, " +
      "`web_sessions`, `entries`, `feeds`, `enclosures`, `icons` / `feed_icons`, " +
      "`entry_tombstones`, and `certificate_cache`[^src-8][^src-65].";
    const MINIFLUX = liveInventory(
      [
        "acme_cache",
        "api_keys",
        "categories",
        "enclosures",
        "entries",
        "entry_tombstones",
        "feed_icons",
        "feeds",
        "icons",
        "integrations",
        "schema_version",
        "users",
        "web_sessions",
        "webauthn_credentials",
      ].map((name) => table(name, { id: "bigint" })),
    );

    it("marks it in Operational Considerations, and nothing else on the line", () => {
      const { markdown, report } = prose(
        `## Operational Considerations\n\n${OPERATIONS}`,
        MINIFLUX,
      );
      expect(markdown).toContain(`backed by PostgreSQL (\`certificate_cache\`${M}), with rows`);
      expect(markdown.split(M)).toHaveLength(2);
      expect(report.unresolvedTables).toEqual(["certificate_cache"]);
      expect(report.matched).toBe(0);
    });

    it("marks it in the Technology Stack's list of key tables, and matches the twelve real ones", () => {
      const { markdown, report } = prose(`## Technology Stack\n\n${STACK}`, MINIFLUX);
      expect(markdown).toContain(`and \`certificate_cache\`${M}[^src-8][^src-65].`);
      expect(markdown.split(M)).toHaveLength(2);
      expect(report.unresolvedTables).toEqual(["certificate_cache"]);
      expect(report.matched).toBe(12);
      expect(schemaCheckJudged(report)).toBe(13);
    });

    it("only inserts markers: removing them gives back the text exactly", () => {
      const text = `## Ops\n\n${OPERATIONS}\n\n## Stack\n\n${STACK}`;
      expect(withoutMarkers(prose(text, MINIFLUX).markdown)).toBe(text);
    });

    it("changes nothing on a second pass", () => {
      const once = prose(`${OPERATIONS}\n${STACK}`, MINIFLUX).markdown;
      const twice = prose(once, MINIFLUX);
      expect(twice.markdown).toBe(once);
      expect(twice.report.unresolvedTables).toEqual([]);
    });
  });

  describe("what the words beside a name make a claim", () => {
    it.each([
      ["the `ghosts` table", "the `ghosts`" + M + " table"],
      ["table `ghosts` holds rows", "table `ghosts`" + M + " holds rows"],
      ["the **`ghosts`** table", "the **`ghosts`" + M + "** table"],
      ["the `users` and `ghosts` tables", "the `users` and `ghosts`" + M + " tables"],
      ["tables such as `ghosts`, `users`", "tables such as `ghosts`" + M + ", `users`"],
      ["Tables: `users`; `ghosts`", "Tables: `users`; `ghosts`" + M],
      ["stored in the database (`ghosts`)", "stored in the database (`ghosts`" + M + ")"],
      ["the `users.ghost` column", "the `users.ghost`" + M + " column"],
      ["columns `users.id` and `users.ghost`", "columns `users.id` and `users.ghost`" + M],
      ["the `ghosts.id` column", "the `ghosts.id`" + M + " column"],
      // With no word beside it, on a line about columns: the first part is
      // exactly a table of the schema (a genuine missing column).
      [
        "login sets `users.ghost`, a column it adds",
        "login sets `users.ghost`" + M + ", a column it adds",
      ],
      // #1133 review — a negation of something else does not hide the claim.
      [
        "Not only the `ghosts` table but also `users`",
        "Not only the `ghosts`" + M + " table but also `users`",
      ],
    ])("%s", (line, marked) => {
      expect(prose(line).markdown).toBe(marked);
    });

    it("marks a near miss with the schema's spelling", () => {
      expect(prose("the `users.GestureNav` column").markdown).toBe(
        "the `users.GestureNav` *(not in schema; the schema has `gesture_nav`)* column",
      );
    });

    it("matches a name the schema has, in either number and any case", () => {
      const { markdown, report } = prose(
        "the `user` table, the `FEEDS` table, the `users.gesture_nav` column",
      );
      expect(markdown).not.toContain("not in schema");
      expect(report.matched).toBe(3);
    });
  });

  describe("code identifiers that are not tables are never judged", () => {
    it.each([
      "an `autocert.Cache` adapter persists certificates",
      "declared in `certificate_cache.go`",
      "`entries.go` holds the queries",
      "exports `feeds.opml` as an attachment",
      "a hash table `ghosts` in memory",
      "a lookup table `ghosts`",
      "not a table: `ghosts` holds options",
      "`ghostOptions` isn't a table: `ghosts` is a map",
      "this is not the `ghosts` table",
      "there is no `ghosts` table",
      // #1133 review — config keys, YAML paths and API fields that start with a
      // table's name are not columns.
      "Set `users.max_count` in `config.yaml`",
      "the YAML key `feeds.refresh_interval`",
      "The API returns `users.display_name` in the JSON response",
      "it sets `users.ghost` on login",
      "the column list is in `users.ghost` of the settings file",
      // #1133 review — a heading is a title: no marker in it.
      "## The `ghosts` table",
      "### Table `ghosts`",
      "the table stores a `ghost_type`",
      "the `users` table's `ghost` column",
      "tables are written by `ghostWriter`",
      "uses PostgreSQL (`pgx`)",
      "PostgreSQL (`lib/pq`) is the driver",
      "`Users.Ghost` is a field",
      "the `ghosts` view",
    ])("%s", (line) => {
      const { markdown, report } = prose(line);
      expect(markdown).toBe(line);
      expect(schemaCheckUnmatched(report)).toEqual([]);
    });
  });

  // #1469 — the column word has to be beside the dotted name, not anywhere on
  // the line: a column word that belongs to another name is not a cue.
  describe("a column word elsewhere on the line is not a cue (#1469)", () => {
    it.each([
      "Set `users.max_count` to 10 so the `username` column stays short.",
      "Set `users.max_count` to 10 so the username column stays short.",
      "`users.max_count` is 10; the `username` column is short.",
      "`users.max_count` is 10. The username column is short.",
      "`users.max_count` limits logins: the column `username` is short.",
      "The `username` column is short, so set `users.max_count` to 10.",
      "Columns are short when `users.max_count` is set to a small number like ten here.",
      "`users.max_count` is ten, but the column is short.",
      // Too far from the column word to be its name.
      "`users.max_count` is set in the admin page under the column heading.",
      // Five words, no determiner: one past the bound.
      "`users.max_count` is ten for my username column.",
      // #1469 cycle 2 — the wider determiners open another clause after "and"/"or".
      "Set `users.max_count` and those columns overflow.",
      "Set `users.max_count` and its column overflows.",
      "Set `users.max_count` or each column overflows.",
      "Set `users.max_count` and these columns overflow.",
      "Set `users.max_count` or every column overflows.",
      "Set `users.max_count` and their columns overflow.",
      // #1469 review — the column word belongs to the other code name; only
      // the "no other span between" rule stops these.
      "Set `users.max_count` to 10 and the `username` column stays short.",
      "Size `users.max_count` like the `username` column.",
      // "and"/"or" before a determiner opens another clause.
      "Set `users.max_count` to 10 and the username column stays short.",
      "Set `users.max_count` or the column will overflow.",
      "Raise `users.max_count` and a column is added.",
      // Too many words describing the column after the determiner.
      "`users.max_count` is set by a very long winded admin column.",
      // A colon is a definition only of a short phrase that ENDS with the column word.
      "`users.max_count`: the column `username` is short.",
      "`users.max_count`: set it in the column editor.",
      "`users.max_count`: max column width",
      "`users.max_count`: so the column is short.",
      "`users.max_count`: see the column.",
      // The colon must follow the name directly.
      "`users.max_count` 10: the text column.",
      // Before the name, too, the column word is the other name's, or in another clause.
      "the column `username` stays short with `users.max_count`.",
      "Shorten the username column and the `users.max_count` limit.",
    ])("%s", (line) => {
      const { markdown, report } = prose(line);
      expect(markdown).toBe(line);
      expect(schemaCheckUnmatched(report)).toEqual([]);
    });

    it.each([
      // The genuine column on the same kind of line is still marked; the decoy is not.
      [
        "Set `users.max_count` to 10 so the `users.ghost` column stays short.",
        "Set `users.max_count` to 10 so the `users.ghost`" + M + " column stays short.",
      ],
      [
        "Set `users.max_count` to 10 so the `username` column and `users.ghost`, a column it adds, stay short.",
        "Set `users.max_count` to 10 so the `username` column and `users.ghost`" +
          M +
          ", a column it adds, stay short.",
      ],
      [
        "a column, `users.ghost`, is added; set `users.max_count` to 10.",
        "a column, `users.ghost`" + M + ", is added; set `users.max_count` to 10.",
      ],
      ["`users.ghost` is a new column", "`users.ghost`" + M + " is a new column"],
      // The decoy after the genuine name, across a clause word.
      [
        "`users.ghost` is a column, so set `users.max_count` to 10.",
        "`users.ghost`" + M + " is a column, so set `users.max_count` to 10.",
      ],
      // #1469 review — every name of a list before the predicate shares its cue.
      [
        "`users.alpha` and `users.beta` are columns",
        "`users.alpha`" + M + " and `users.beta`" + M + " are columns",
      ],
      [
        "`users.alpha`, `users.beta` and `users.gamma` are new columns",
        "`users.alpha`" + M + ", `users.beta`" + M + " and `users.gamma`" + M + " are new columns",
      ],
      [
        "`users.alpha`, `users.beta`, and `users.gamma` are columns",
        "`users.alpha`" + M + ", `users.beta`" + M + ", and `users.gamma`" + M + " are columns",
      ],
      [
        "The migration adds `users.alpha`, `users.beta` and `users.gamma` as columns.",
        "The migration adds `users.alpha`" +
          M +
          ", `users.beta`" +
          M +
          " and `users.gamma`" +
          M +
          " as columns.",
      ],
      // A list does not run across a sentence or onto a name with a clause between.
      [
        "Set `users.max_count`. `users.ghost` is a column.",
        "Set `users.max_count`. `users.ghost`" + M + " is a column.",
      ],
      [
        "Set `users.max_count` to 10 so `users.ghost` is a column.",
        "Set `users.max_count` to 10 so `users.ghost`" + M + " is a column.",
      ],
      // A definition: a colon, then a short phrase ending in the column word.
      ["`users.alpha`: a text column", "`users.alpha`" + M + ": a text column"],
      ["- **`users.alpha`**: text column.", "- **`users.alpha`" + M + "**: text column."],
      // Up to four words between, and a determiner as the fourth.
      ["`users.ghost` is now stored as columns", "`users.ghost`" + M + " is now stored as columns"],
      [
        "`users.ghost` is now stored as a column",
        "`users.ghost`" + M + " is now stored as a column",
      ],
      // Words describing the column after a determiner do not count toward the four.
      [
        "`users.alpha` is a new nullable text column",
        "`users.alpha`" + M + " is a new nullable text column",
      ],
      // #1469 cycle 2 — "its" opens the phrase too.
      [
        "`users.ghost` is stored in its own text column",
        "`users.ghost`" + M + " is stored in its own text column",
      ],
      // A definition can give the type in parentheses after the phrase.
      ["`users.a1`: a column (text).", "`users.a1`" + M + ": a column (text)."],
      // #1469 cycle 2 — a column word BEFORE a list cues every name of it.
      [
        "Two columns (`users.a1` and `users.a2`) are added.",
        "Two columns (`users.a1`" + M + " and `users.a2`" + M + ") are added.",
      ],
      [
        "New columns (`users.a1`, `users.a2`) are added.",
        "New columns (`users.a1`" + M + ", `users.a2`" + M + ") are added.",
      ],
      [
        "The column `users.a1` and `users.a2` are new.",
        "The column `users.a1`" + M + " and `users.a2`" + M + " are new.",
      ],
      // ...but not past a sentence end or onto a name outside the parentheses.
      [
        "A column, `users.a1`. `users.max_count` is ten.",
        "A column, `users.a1`" + M + ". `users.max_count` is ten.",
      ],
      [
        "New columns (`users.a1`) and `users.max_count` are added.",
        "New columns (`users.a1`" + M + ") and `users.max_count` are added.",
      ],
    ])("%s", (line, marked) => {
      expect(prose(line).markdown).toBe(marked);
    });

    // Known limits on the other side, kept on purpose: a column word too far
    // from the name to tell it from a decoy leaves a genuine column unchecked.
    it.each([
      "`users.ghost` holds the user's email in a text column",
      "`users.ghost` is the new nullable varchar text column",
    ])("known limit, not checked: %s", (line) => {
      expect(prose(line).markdown).toBe(line);
    });

    it("counts a listed name that matches, and marks only the one that does not", () => {
      const { markdown, report } = prose("`users.username` and `users.ghost` are columns");
      expect(markdown).toBe("`users.username` and `users.ghost`" + M + " are columns");
      expect(report.matched).toBe(1);
    });

    // A known limit, kept on purpose: a comma splice cannot be told from an
    // apposition ("login sets `users.ghost`, a column it adds"), which must
    // stay marked, so this decoy is still read as a column.
    it("known limit: a comma splice still cues the name", () => {
      expect(prose("Set `users.max_count` to 10, the column stays short.").markdown).toBe(
        "Set `users.max_count`" + M + " to 10, the column stays short.",
      );
    });
  });

  describe("what the read cannot speak for, and code, as in the section check", () => {
    it("lists, and does not mark, a name in a schema that was not read", () => {
      const { markdown, report } = prose("the `audit.ghosts` table");
      expect(markdown).toBe("the `audit.ghosts` table");
      expect(report.notChecked).toEqual([{ name: "audit.ghosts", why: "unread" }]);
    });

    it("lists a table that is not found while a database went unread", () => {
      const { report } = prose("the `ghosts` table", ONE_UNREAD);
      expect(report.notChecked).toEqual([{ name: "ghosts", why: "unread" }]);
    });

    it("never reads code: fences, indented blocks and raw HTML", () => {
      const code = [
        `${FENCE}sql`,
        "-- the `ghosts` table",
        FENCE,
        "",
        "    the `ghosts` table",
        "",
        "<pre>",
        "the `ghosts` table",
        "</pre>",
      ].join("\n");
      expect(prose(code).markdown).toBe(code);
    });

    it("skips the Data Architecture section's own note, which reports its names already", () => {
      const note = [
        "> **Schema check.** The table and column names ...",
        "> - Columns not in the schema: `users.ghost`.",
        "",
        "the `users.ghost` column",
      ].join("\n");
      const { markdown, report } = prose(note);
      expect(markdown.split(M)).toHaveLength(2);
      expect(markdown).toContain("> - Columns not in the schema: `users.ghost`.\n");
      expect(report.flaggedColumns).toEqual(["users.ghost"]);
    });

    it("judges nothing against an empty schema", () => {
      expect(prose("the `ghosts` table", NO_SCHEMA_INVENTORY)).toEqual({
        markdown: "the `ghosts` table",
        report: expect.objectContaining({ checked: false, matched: 0 }),
      });
    });

    it("with `structured`, also reads a section's table list, into the same report", () => {
      const roster = "| Table | Purpose |\n|---|---|\n| `ghosts` | Invented |\n\nthe `users` table";
      const { markdown, report } = checkProseSchemaClaims(roster, LIVE, { structured: true });
      expect(markdown).toContain(`| \`ghosts\`${M} | Invented |`);
      expect(report.unresolvedTables).toEqual(["ghosts"]);
      expect(report.matched).toBe(1);
      expect(prose(roster).report.unresolvedTables).toEqual([]);
    });
  });

  describe("checkDataArchitectureText: the Data Architecture section as it reaches the document", () => {
    const ROSTER = "| Table | Purpose |\n|---|---|\n| `users` | People |\n| `feeds` | Feeds |";
    const grounded = (body: string) =>
      applySchemaGrounding(`## Data Architecture\n\n${body}`, STORED).markdown;

    it("says in one line that every name matched, counting its lists and its text together", () => {
      const section = grounded(`${ROSTER}\n\nEach feed row belongs to the \`users\` table.`);
      const { markdown, report } = checkDataArchitectureText(section, STORED);
      expect(report.matched).toBe(2);
      expect(markdown).toContain(
        `> **Schema check.** 2 table and column names in this section were compared with ${STORED.label}, and every one matched.`,
      );
      expect(markdown.indexOf("> **Schema check.**")).toBeLessThan(markdown.indexOf("| Table |"));
      // The Schema Reference is rendered from the schema and is not counted.
      expect(section).toContain("### Schema Reference");
    });

    it("does not say every name matched when its text has a mark", () => {
      const section = grounded(`${ROSTER}\n\nCertificates are kept in the \`ghosts\` table.`);
      const { markdown, report } = checkDataArchitectureText(section, STORED);
      expect(report.unresolvedTables).toEqual(["ghosts"]);
      expect(markdown).toContain(
        "3 table and column names in this section were compared with " +
          `${STORED.label}; 1 could not be matched and is marked **not in schema** where it stands.`,
      );
      expect(markdown).not.toContain("every one matched");
      expect(markdown).toContain(`the \`ghosts\`${M} table`);
    });

    // #1469 — "every one matched" is never said beside a name that could not be checked.
    it("says how many matched and how many could not be checked, never 'every one'", () => {
      const section = grounded(`${ROSTER}\n\nAudit rows go to the \`audit.ghosts\` table.`);
      const { markdown, report } = checkDataArchitectureText(section, STORED);
      expect(report.notChecked).toEqual([{ name: "audit.ghosts", why: "unread" }]);
      expect(markdown).not.toContain("every one matched");
      expect(markdown).toContain(
        `> **Schema check.** 2 table and column names in this section were compared with ${STORED.label}; ` +
          "2 matched; 1 more could not be checked (outside the schemas that were read).",
      );
    });

    it("says what could not be checked beside a mark too (#1469)", () => {
      const section = grounded(
        `${ROSTER}\n\nThe \`ghosts\` table, the \`audit.ghosts\` table and the \`audit.spooks\` table.`,
      );
      const { markdown } = checkDataArchitectureText(section, STORED);
      expect(markdown).toContain(
        "1 could not be matched and is marked **not in schema** where it stands. ",
      );
      expect(markdown).toContain(
        "so a marked name is one to verify, not necessarily a mistake. " +
          "2 more could not be checked (outside the schemas that were read).",
      );
    });

    it("adds nothing when the section's own note is there, and counts the marked names in it", () => {
      const section = grounded(`| Table | Purpose |\n|---|---|\n| \`ghosts\` | Invented |`);
      expect(section).toContain("> **Schema check.** The table and column names");
      const { markdown, report } = checkDataArchitectureText(section, STORED);
      expect(markdown).toBe(section);
      expect(report.unresolvedTables).toEqual(["ghosts"]);
    });

    it("says nothing for a section that names no table, and is the same on a second pass", () => {
      const plain = grounded("One PostgreSQL database.");
      expect(checkDataArchitectureText(plain, STORED).markdown).toBe(plain);
      const once = checkDataArchitectureText(grounded(ROSTER), STORED).markdown;
      expect(checkDataArchitectureText(once, STORED).markdown).toBe(once);
    });
  });

  it("records the report for provenance, capped", () => {
    const many = Array.from({ length: 60 }, (_, n) => `the \`ghost_${n}\` table`).join("\n");
    const record = schemaClaimsRecord(prose(`${many}\nthe \`users\` table`).report, LIVE);
    expect(record.judged).toBe(61);
    expect(record.unmatched).toHaveLength(50);
    // #1469 — the true count, and what the names were compared with.
    expect(record.unmatchedCount).toBe(60);
    expect(record.source).toBe("live-schema");
    expect(record.notChecked).toBe(0);
    expect(record.notCheckedWhy).toEqual([]);
  });

  it("records why names could not be checked, each reason once, and the source (#1469)", () => {
    const text = "the `audit.ghosts` table, the `audit.spooks` table";
    const record = schemaClaimsRecord(prose(text, STORED).report, STORED);
    expect(record).toEqual({
      judged: 0,
      unmatched: [],
      unmatchedCount: 0,
      notChecked: 2,
      notCheckedWhy: ["unread"],
      source: "schema-graph",
    });
  });

  describe("reads a line in linear time", () => {
    const SHAPES: Record<string, (size: number) => string> = {
      "a long list of tables": (size) =>
        `Key tables: ${Array.from({ length: size / 12 }, (_, n) => `\`t${n}\``).join(", ")}.`,
      "a table word before every span": (size) => "table `ghosts` ".repeat(size / 15),
      "table words and no spans": (size) => `\`users\` ${"tables ".repeat(size / 7)}`,
      "deep parentheses": (size) =>
        `tables: \`users\` ${"(".repeat(size / 2)}\`a\`${")".repeat(size / 2)}`,
      "storage verbs with no parenthesis": (size) => "stored in PostgreSQL ".repeat(size / 21),
      "dotted names everywhere": (size) => "`users.ghost` ".repeat(size / 14),
      "footnote openers": (size) => `tables: \`users\`${"[^".repeat(size / 2)}`,
    };
    for (const [name, build] of Object.entries(SHAPES)) {
      it(name, () => {
        expectLinearTime(name, (size) => {
          const input = build(size);
          return () => checkProseSchemaClaims(input, STORED);
        });
      });
    }
  });
});
